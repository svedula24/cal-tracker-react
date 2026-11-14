"""The OAuth 2.1 authorization server ChatGPT signs in through (included only when PUBLIC_URL is set).

GET  /.well-known/oauth-authorization-server   metadata (RFC 8414)
GET  /oauth/authorize                           the sign-in page: asks for the app's pairing code
POST /oauth/authorize                           checks the code, redirects back with an authorization code
POST /oauth/token                               authorization_code (PKCE S256) and refresh_token grants
POST /oauth/register                            stateless dynamic client registration (a fallback to CIMD)

The protected-resource document and the 401 challenge for /mcp come from the MCP SDK, not from here.

Logging: nothing here logs. uvicorn's access log prints each request's path with its query string,
so a GET /oauth/authorize line shows client_id, redirect_uri, state and code_challenge: none of them
is a secret (the challenge is a hash; the pairing code is POSTed, never in a URL). Codes and tokens
travel only in POST bodies and in the Location header of the redirect, which are not logged.

The authorize page keeps no server-side state and sets no cookie: the request it was opened with
travels in hidden fields, HMAC-signed with KALO_SECRET and stamped with the time, valid 10 minutes.
"""

from __future__ import annotations

import base64
import hashlib
import html
import json
import math
import time
from typing import Annotated
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

from app.api.deps import DbSession
from app.services import oauth, pairing
from app.settings import Settings

router = APIRouter(tags=["oauth"])

PAGE_LIFETIME = 600  # seconds a rendered authorize page may be submitted
# Pairing-code attempts (limiters made in app/main.py, on app.state.pairing_attempts and
# app.state.pairing_attempts_overall): per client address per 15 minutes, and from everyone per hour, so
# 40-bit codes stay out of reach.
ATTEMPTS_PER_ADDRESS = (10, 15 * 60)
ATTEMPTS_OVERALL = (60, 3600)
MAX_PARAM = 2048  # longest accepted state, challenge, URI or client id
WHERE_TO_GET_A_CODE = "Open Kalo, go to Goals → Connect ChatGPT and tap Get code."

STYLE = """
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f6f6f4;color:#1c1c1a;
margin:0;padding:24px 16px}
main{max-width:420px;margin:40px auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 1px 3px #0002}
h1{font-size:20px;margin:0 0 8px}p{line-height:1.45;margin:8px 0}
label{display:block;font-weight:600;margin:20px 0 6px}
input[type=text]{box-sizing:border-box;width:100%;font:600 24px ui-monospace,Menlo,monospace;letter-spacing:4px;
padding:12px;border:1px solid #bbb;border-radius:10px;text-transform:uppercase}
.check{display:flex;gap:10px;align-items:flex-start;font-weight:400;margin-top:16px}
.error{background:#fdecea;color:#8a1c12;padding:10px 12px;border-radius:10px}
.buttons{display:flex;gap:12px;margin-top:24px}
button{flex:1;font-size:16px;padding:12px;border-radius:10px;border:1px solid #1c1c1a;background:#fff}
button[value=allow]{background:#1c1c1a;color:#fff}
.muted{color:#666;font-size:14px}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}main{background:#1d1d1b;box-shadow:none}
input[type=text]{background:#111;color:#eee;border-color:#555}button{background:#1d1d1b;color:#eee;border-color:#eee}
button[value=allow]{background:#eee;color:#111}.muted{color:#aaa}.error{background:#4a1d18;color:#ffd7d0}}
"""
_STYLE_HASH = base64.b64encode(hashlib.sha256(STYLE.encode()).digest()).decode()
PAGE_HEADERS = {
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    # No scripts at all; the one inline stylesheet by its hash. form-action covers the redirect back to
    # ChatGPT that follows the form's POST (browsers check redirects after a form submission against it).
    "Content-Security-Policy": (
        f"default-src 'none'; style-src 'sha256-{_STYLE_HASH}'; form-action 'self' https://chatgpt.com; "
        "frame-ancestors 'none'; base-uri 'none'"
    ),
}
JSON_NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}
SIGNED_FIELDS = ("client_id", "redirect_uri", "state", "code_challenge", "scope", "resource", "iat")


def _settings(request: Request) -> Settings:
    return request.app.state.settings


async def form_fields(request: Request) -> dict[str, str] | None:
    """The urlencoded body's fields; None for another body type or a field sent twice (RFC 6749 3.1)."""
    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if content_type != "application/x-www-form-urlencoded":
        return None
    items = (await request.form()).multi_items()
    fields = {key: value for key, value in items if isinstance(value, str)}
    return fields if len(fields) == len(items) else None


FormFields = Annotated[dict[str, str] | None, Depends(form_fields)]
BAD_FORM = oauth.OAuthError("invalid_request", "send each parameter once, as application/x-www-form-urlencoded")


def _oauth_error_json(exc: oauth.OAuthError) -> JSONResponse:
    body = {"error": exc.error, "error_description": exc.description}
    return JSONResponse(body, status_code=400, headers=JSON_NO_STORE)


# ---- Discovery ----


@router.get("/.well-known/oauth-authorization-server")
def metadata(request: Request) -> JSONResponse:
    issuer = _settings(request).public_url
    document = {
        "issuer": issuer,
        "authorization_endpoint": f"{issuer}/oauth/authorize",
        "token_endpoint": f"{issuer}/oauth/token",
        "registration_endpoint": f"{issuer}/oauth/register",
        "scopes_supported": list(oauth.SCOPES),
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "client_id_metadata_document_supported": True,
        "authorization_response_iss_parameter_supported": True,
    }
    return JSONResponse(document, headers={"Cache-Control": "public, max-age=3600"})


# ---- The authorize page ----


def _page(title: str, body: str, status: int = 200, headers: dict[str, str] | None = None) -> HTMLResponse:
    document = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{html.escape(title)}</title><style>{STYLE}</style></head><body><main>{body}</main></body></html>"
    )
    return HTMLResponse(document, status_code=status, headers={**PAGE_HEADERS, **(headers or {})})


def _error_page(message: str, status: int = 400) -> HTMLResponse:
    """For a request that cannot be sent back to the client (bad client or redirect URI, or a tampered page)."""
    body = f"<h1>Can't connect to Kalo</h1><p>{html.escape(message)}</p>"
    return _page("Kalo: can't connect", body, status)


def _redirect(settings: Settings, redirect_uri: str, params: dict[str, str]) -> RedirectResponse:
    """Back to the client, with `iss` (RFC 9207). 303, so the browser follows a POST with a GET."""
    query = urlencode({**params, "iss": settings.public_url or ""})
    separator = "&" if "?" in redirect_uri else "?"
    return RedirectResponse(f"{redirect_uri}{separator}{query}", status_code=303, headers=PAGE_HEADERS)


def _error_redirect(
    settings: Settings, redirect_uri: str, state: str | None, error: str, description: str
) -> RedirectResponse:
    params = {"error": error, "error_description": description}
    if state:
        params["state"] = state
    return _redirect(settings, redirect_uri, params)


def _sig_payload(fields: dict[str, str]) -> str:
    return json.dumps([fields.get(name, "") for name in SIGNED_FIELDS], separators=(",", ":"))


def _form(client: oauth.Client, fields: dict[str, str], *, error: str | None = None) -> str:
    hidden = "".join(
        f'<input type="hidden" name="{name}" value="{html.escape(fields.get(name, ""))}">'
        for name in (*SIGNED_FIELDS, "sig")
    )
    name = html.escape(client.client_name)
    write = oauth.SCOPE_WRITE in fields.get("scope", "").split()
    write_box = (
        '<label class="check"><input type="checkbox" name="allow_write" value="1" checked>'
        "<span>Also let it log, edit and delete food and change goals</span></label>"
        if write
        else ""
    )
    alert = f'<p class="error" role="alert">{html.escape(error)}</p>' if error else ""
    return (
        f"<h1>Connect {name} to Kalo</h1>"
        f"<p><strong>{name}</strong> wants to read your Kalo food log.</p>"
        f"{alert}"
        '<form method="post" action="/oauth/authorize">'
        f"{hidden}"
        '<label for="pairing_code">Code from the Kalo app</label>'
        '<input type="text" id="pairing_code" name="pairing_code" placeholder="XXXX-XXXX" maxlength="16" '
        'autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" '
        f'required autofocus><p class="muted">{html.escape(WHERE_TO_GET_A_CODE)}</p>'
        f"{write_box}"
        '<div class="buttons"><button type="submit" name="action" value="deny" formnovalidate>Cancel</button>'
        '<button type="submit" name="action" value="allow">Connect</button></div>'
        "</form>"
        '<p class="muted">You can disconnect it at any time in Kalo → Goals → Connect ChatGPT.</p>'
    )


@router.get("/oauth/authorize")
def authorize_page(request: Request) -> Response:
    settings = _settings(request)
    q = request.query_params
    client_id = q.get("client_id", "")
    redirect_uri = q.get("redirect_uri", "")
    if len(client_id) > MAX_PARAM or (client := oauth.resolve_client(settings, client_id)) is None:
        return _error_page("This app is not allowed to connect to Kalo.")
    if len(redirect_uri) > MAX_PARAM or not oauth.redirect_allowed(settings, client, redirect_uri):
        return _error_page("The address this app asked to return to is not allowed.")
    # From here on errors go back to the client.
    state = q.get("state")
    if state is not None and len(state) > MAX_PARAM:
        return _error_redirect(settings, redirect_uri, None, "invalid_request", "state is too long")

    def fail(error: str, description: str) -> Response:
        return _error_redirect(settings, redirect_uri, state, error, description)

    if q.get("response_type") != "code":
        return fail("unsupported_response_type", "only response_type=code is supported")
    if q.get("code_challenge_method") != "S256":
        return fail("invalid_request", "PKCE with code_challenge_method=S256 is required")
    challenge = q.get("code_challenge", "")
    if not oauth.CHALLENGE_RE.fullmatch(challenge):
        return fail("invalid_request", "code_challenge must be a base64url SHA-256 (43 characters)")
    resource = q.get("resource")
    if resource is not None and resource.rstrip("/") != settings.resource:
        return fail("invalid_target", f"the only resource is {settings.resource}")
    try:
        scopes = oauth.parse_scopes(q.get("scope"))
    except oauth.OAuthError as exc:
        return fail(exc.error, exc.description)
    fields = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "state": state or "",
        "code_challenge": challenge,
        "scope": oauth.scope_string(scopes),
        "resource": settings.resource,
        "iat": str(int(time.time())),
    }
    fields["sig"] = oauth.sign(settings.secret, "authorize", _sig_payload(fields))
    return _page(f"Connect {client.client_name} to Kalo", _form(client, fields))


@router.post("/oauth/authorize")
def authorize(request: Request, session: DbSession, form: FormFields) -> Response:
    settings = _settings(request)
    if form is None:
        return _error_page("This sign-in page is not valid. Go back to ChatGPT and try connecting again.")
    fields = {name: form.get(name, "") for name in (*SIGNED_FIELDS, "sig")}
    if not oauth.verify(settings.secret, "authorize", _sig_payload(fields), fields["sig"]):
        return _error_page("This sign-in page is not valid. Go back to ChatGPT and try connecting again.")
    age = time.time() - int(fields["iat"])
    if not -60 <= age <= PAGE_LIFETIME:
        return _error_page("This sign-in page has expired. Go back to ChatGPT and try connecting again.")
    client = oauth.resolve_client(settings, fields["client_id"])
    if client is None or not oauth.redirect_allowed(settings, client, fields["redirect_uri"]):
        return _error_page("This app is not allowed to connect to Kalo.")
    state = fields["state"] or None
    if form.get("action") == "deny":
        return _error_redirect(settings, fields["redirect_uri"], state, "access_denied", "the user cancelled")

    address = request.client.host if request.client else "unknown"
    wait = request.app.state.pairing_attempts.retry_after(address)
    if wait is None:
        wait = request.app.state.pairing_attempts_overall.retry_after("all")
    if wait is not None:
        minutes = max(1, math.ceil(wait / 60))
        message = f"Too many tries. Wait {minutes} minute{'s' if minutes > 1 else ''} and try again."
        page = _form(client, fields, error=message)
        return _page("Kalo: too many tries", page, 429, {"Retry-After": str(math.ceil(wait))})

    user_id = pairing.consume(session, form.get("pairing_code", ""))
    if user_id is None:
        message = f"That code didn't work: it may be mistyped, expired or already used. {WHERE_TO_GET_A_CODE}"
        return _page(f"Connect {client.client_name} to Kalo", _form(client, fields, error=message), 400)
    asked = frozenset(fields["scope"].split())
    scopes = asked if form.get("allow_write") == "1" else frozenset({oauth.SCOPE_READ})
    code = oauth.create_code(
        session,
        user_id=user_id,
        client=client,
        scopes=scopes,
        resource=fields["resource"],
        redirect_uri=fields["redirect_uri"],
        code_challenge=fields["code_challenge"],
    )
    session.commit()
    params = {"code": code}
    if state:
        params["state"] = state
    return _redirect(settings, fields["redirect_uri"], params)


# ---- Token and registration ----


@router.post("/oauth/token")
def token(session: DbSession, form: FormFields) -> JSONResponse:
    if form is None:
        return _oauth_error_json(BAD_FORM)
    client_id = form.get("client_id")
    try:
        if not client_id:
            raise oauth.OAuthError("invalid_request", "client_id is required")
        grant_type = form.get("grant_type")
        if grant_type == "authorization_code":
            if not form.get("code"):
                raise oauth.OAuthError("invalid_request", "code is required")
            pair = oauth.exchange_code(
                session,
                code=form["code"],
                client_id=client_id,
                redirect_uri=form.get("redirect_uri"),
                code_verifier=form.get("code_verifier"),
                resource=_resource(form.get("resource")),
            )
        elif grant_type == "refresh_token":
            if not form.get("refresh_token"):
                raise oauth.OAuthError("invalid_request", "refresh_token is required")
            pair = oauth.refresh(
                session,
                refresh_token=form["refresh_token"],
                client_id=client_id,
                scope=form.get("scope"),
                resource=_resource(form.get("resource")),
            )
        else:
            raise oauth.OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token")
    except oauth.OAuthError as exc:
        return _oauth_error_json(exc)
    session.commit()
    body = {
        "access_token": pair.access_token,
        "token_type": "Bearer",
        "expires_in": pair.expires_in,
        "refresh_token": pair.refresh_token,
        "scope": pair.scope,
    }
    return JSONResponse(body, headers=JSON_NO_STORE)


def _resource(value: str | None) -> str | None:
    return value.rstrip("/") if value else None


def _strings_within(value: object, allowed: set[str]) -> bool:
    """Absent, empty, or a list of strings from `allowed` (registration metadata is client-supplied JSON)."""
    if value is None:
        return True
    return isinstance(value, list) and all(isinstance(v, str) and v in allowed for v in value)


@router.post("/oauth/register", status_code=201)
async def register(request: Request) -> JSONResponse:
    settings = _settings(request)
    try:
        body = await request.json()
    except ValueError:
        body = None
    try:
        if not isinstance(body, dict):
            raise oauth.OAuthError("invalid_client_metadata", "the body must be a JSON object")
        method = body.get("token_endpoint_auth_method", "none")
        if method != "none":
            raise oauth.OAuthError("invalid_client_metadata", "token_endpoint_auth_method must be none")
        if not _strings_within(body.get("grant_types"), {"authorization_code", "refresh_token"}):
            raise oauth.OAuthError("invalid_client_metadata", "grant_types: authorization_code, refresh_token")
        if not _strings_within(body.get("response_types"), {"code"}):
            raise oauth.OAuthError("invalid_client_metadata", "response_types: code")
        client = oauth.register_client(settings, body.get("redirect_uris"), body.get("client_name"))
    except oauth.OAuthError as exc:
        return _oauth_error_json(exc)
    document = {
        "client_id": client.client_id,
        "client_id_issued_at": int(time.time()),
        "client_name": client.client_name,
        "redirect_uris": list(client.redirect_uris),
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
    }
    return JSONResponse(document, status_code=201, headers=JSON_NO_STORE)
