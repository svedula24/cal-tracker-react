"""The OAuth authorization server ChatGPT signs in through (app/api/oauth.py, app/services/oauth.py).

Tests that need Postgres depend on `migrated_url` and skip without DATABASE_URL; the rest (settings,
discovery, registration, the sign-in page's refusals) run without it. The client ID metadata document
is never fetched: `fetch_metadata` is replaced by a stub.
"""

import re
import secrets
import time
import uuid
from datetime import UTC, datetime, timedelta
from html.parser import HTMLParser
from urllib.parse import parse_qs, urlencode, urlsplit

import psycopg
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.limits import SlidingWindow
from app.db.session import make_engine
from app.main import create_app
from app.services import oauth, pairing
from app.settings import DEFAULT_CLIENT_IDS, DEFAULT_REDIRECT_URIS, Settings, get_settings

PUBLIC = "https://kalo.example"
RESOURCE = f"{PUBLIC}/mcp"
SECRET = b"s" * 32
SETTINGS = Settings(public_url=PUBLIC, secret=SECRET)
CHATGPT = DEFAULT_CLIENT_IDS[0]
REDIRECT = DEFAULT_REDIRECT_URIS[0]
READ, WRITE = oauth.SCOPE_READ, oauth.SCOPE_WRITE
TOKEN_RE = re.compile(r"kalo_(at|rt)_[A-Za-z0-9_-]{43}")


def make_app(url: str | None = None, settings: Settings = SETTINGS):
    return create_app(url, settings=settings)


@pytest.fixture(autouse=True)
def cimd(monkeypatch):
    """ChatGPT's client metadata document, served by a stub; the list records every URL "fetched"."""
    fetched = []

    def fetch(url):
        fetched.append(url)
        return {"client_id": url, "client_name": "ChatGPT", "redirect_uris": [REDIRECT, "https://chatgpt.com/cb2"]}

    monkeypatch.setattr(oauth, "fetch_metadata", fetch)
    oauth.clear_client_cache()
    yield fetched
    oauth.clear_client_cache()


@pytest.fixture
def bare():
    """The app without its lifespan (no database): enough for discovery, registration and refusals."""
    return TestClient(make_app("postgresql://nowhere.invalid/none"), follow_redirects=False)


@pytest.fixture
def client(migrated_url):
    with TestClient(make_app(migrated_url), follow_redirects=False) as c:
        yield c


@pytest.fixture
def db(migrated_url):
    """A second connection to the same scratch schema: it sees only what the app committed."""
    with psycopg.connect(migrated_url, autocommit=True) as conn:
        yield conn


# ---- Helpers: a scripted ChatGPT ----


class _Fields(HTMLParser):
    def __init__(self):
        super().__init__()
        self.inputs = {}
        self.form = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "form":
            self.form = a
        if tag == "input":
            self.inputs[a.get("name")] = a


def parse_page(html):
    parser = _Fields()
    parser.feed(html)
    return parser


def device(client):
    r = client.post("/api/v1/devices", json={"platform": "ios"})
    assert r.status_code == 201, r.text
    return r.json()["token"]


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def new_code(client, device_token):
    r = client.post("/api/v1/pairing-codes", headers=auth(device_token))
    assert r.status_code == 201, r.text
    return r.json()["code"]


def pkce():
    verifier = secrets.token_urlsafe(48)
    return verifier, oauth.s256(verifier)


def authorize_query(challenge, **overrides):
    params = {
        "response_type": "code",
        "client_id": CHATGPT,
        "redirect_uri": REDIRECT,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": "st-123",
        "scope": f"{READ} {WRITE}",
        "resource": RESOURCE,
    }
    params.update(overrides)
    return urlencode({k: v for k, v in params.items() if v is not None})


def hidden(page_html):
    return {name: a.get("value", "") for name, a in parse_page(page_html).inputs.items() if a.get("type") == "hidden"}


def submit(client, fields, code, allow_write=True, action="allow"):
    body = {**fields, "pairing_code": code, "action": action}
    if allow_write:
        body["allow_write"] = "1"
    return client.post("/oauth/authorize", data=body)


def query_of(location):
    parts = urlsplit(location)
    return f"{parts.scheme}://{parts.netloc}{parts.path}", {k: v[0] for k, v in parse_qs(parts.query).items()}


def get_auth_code(client, device_token, allow_write=True, challenge=None, **overrides):
    page = client.get(f"/oauth/authorize?{authorize_query(challenge, **overrides)}")
    assert page.status_code == 200, page.text
    r = submit(client, hidden(page.text), new_code(client, device_token), allow_write=allow_write)
    assert r.status_code == 303, r.text
    base, params = query_of(r.headers["location"])
    assert base == REDIRECT
    return params


def exchange(client, auth_code, verifier, **overrides):
    body = {
        "grant_type": "authorization_code",
        "code": auth_code,
        "client_id": CHATGPT,
        "redirect_uri": REDIRECT,
        "code_verifier": verifier,
        "resource": RESOURCE,
    }
    body.update(overrides)
    return client.post("/oauth/token", data={k: v for k, v in body.items() if v is not None})


def refresh(client, refresh_token, **overrides):
    body = {"grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": CHATGPT, **overrides}
    return client.post("/oauth/token", data=body)


def connect(client, device_token=None, allow_write=True, client_id=CHATGPT):
    """The whole flow; returns the token response and the device token."""
    device_token = device_token or device(client)
    verifier, challenge = pkce()
    params = get_auth_code(client, device_token, allow_write=allow_write, challenge=challenge, client_id=client_id)
    r = exchange(client, params["code"], verifier, client_id=client_id)
    assert r.status_code == 200, r.text
    return r.json(), device_token


def resolve(migrated_url, token, resource=RESOURCE):
    engine = make_engine(migrated_url)
    try:
        with Session(engine) as s:
            grant = oauth.resolve_access_token(s, token, resource)
            s.commit()
            return grant
    finally:
        engine.dispose()


# ---- Settings ----


def test_settings_from_the_environment():
    assert get_settings({}) == Settings()
    assert get_settings({}).public_url is None
    s = get_settings({"PUBLIC_URL": f" {PUBLIC}/ ", "KALO_SECRET": "k" * 32, "OAUTH_REDIRECT_URIS": "a, b"})
    assert (s.public_url, s.secret, s.resource) == (PUBLIC, b"k" * 32, RESOURCE)
    assert s.oauth_client_ids == ("https://chatgpt.com/oauth/client.json",)
    assert s.oauth_redirect_uris == ("a", "b")
    with pytest.raises(ValueError, match="KALO_SECRET"):
        get_settings({"PUBLIC_URL": PUBLIC})
    with pytest.raises(ValueError, match="KALO_SECRET"):
        get_settings({"PUBLIC_URL": PUBLIC, "KALO_SECRET": "short"})
    with pytest.raises(ValueError, match="https"):
        get_settings({"PUBLIC_URL": "http://kalo.example", "KALO_SECRET": "k" * 32})


@pytest.mark.parametrize(
    ("value", "allowed"),
    [(None, True), ("", True), (" ", True), ("true", True), ("1", True), ("On", True),
     ("false", False), ("FALSE", False), ("0", False), ("no", False), (" off ", False)],
)  # fmt: skip
def test_allow_registration_from_the_environment(value, allowed):
    env = {} if value is None else {"ALLOW_REGISTRATION": value}
    assert get_settings(env).allow_registration is allowed


def test_a_mistyped_allow_registration_is_refused():
    with pytest.raises(ValueError, match="ALLOW_REGISTRATION"):
        get_settings({"ALLOW_REGISTRATION": "flase"})


# ---- Pairing codes (pure) ----


def test_pairing_codes_use_crockford_base32_and_forgive_typing():
    for _ in range(200):
        code = pairing.new_code()
        assert len(code) == 8 and not set(code) & set("ILOU")
        assert pairing.normalise(pairing.display(code)) == code
    assert pairing.display("K7QM4XPA") == "K7QM-4XPA"
    assert pairing.normalise(" k7qm-4xpa ") == "K7QM4XPA"
    assert pairing.normalise("K7QM 4XPA") == "K7QM4XPA"
    assert pairing.normalise("O1IL-ABCD") == "0111ABCD"
    for bad in ("", "K7QM4XP", "K7QM4XPAB", "K7QM-4XPU", "K7QM!XPA"):
        assert pairing.normalise(bad) is None


# ---- Discovery and registration (no database) ----


def test_discovery_document(bare):
    r = bare.get("/.well-known/oauth-authorization-server")
    assert r.status_code == 200
    assert r.json() == {
        "issuer": PUBLIC,
        "authorization_endpoint": f"{PUBLIC}/oauth/authorize",
        "token_endpoint": f"{PUBLIC}/oauth/token",
        "registration_endpoint": f"{PUBLIC}/oauth/register",
        "scopes_supported": ["nutrition:read", "nutrition:write"],
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "client_id_metadata_document_supported": True,
        "authorization_response_iss_parameter_supported": True,
    }


def test_registration_signs_a_client_id_for_allowlisted_redirects_only(bare):
    r = bare.post("/oauth/register", json={"redirect_uris": [REDIRECT], "client_name": "ChatGPT dev"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["client_id"].startswith(oauth.DCR_PREFIX)
    assert (body["client_name"], body["redirect_uris"]) == ("ChatGPT dev", [REDIRECT])
    assert body["token_endpoint_auth_method"] == "none"
    assert r.headers["cache-control"] == "no-store"

    for uris in (["https://evil.example/cb"], ["https://chatgpt.com/not-listed"], [], "x", [REDIRECT, 1]):
        r = bare.post("/oauth/register", json={"redirect_uris": uris})
        assert r.status_code == 400 and r.json()["error"] == "invalid_redirect_uri", uris
    r = bare.post(
        "/oauth/register", json={"redirect_uris": [REDIRECT], "token_endpoint_auth_method": "client_secret_post"}
    )
    assert r.json()["error"] == "invalid_client_metadata"
    assert bare.post("/oauth/register", content=b"nope").json()["error"] == "invalid_client_metadata"


@pytest.mark.parametrize("field", ["grant_types", "response_types"])
@pytest.mark.parametrize("value", [5, "code", [{}], [None], ["implicit"], {"a": 1}])
def test_registration_refuses_malformed_types(bare, field, value):
    r = bare.post("/oauth/register", json={"redirect_uris": [REDIRECT], field: value})
    assert (r.status_code, r.json()["error"]) == (400, "invalid_client_metadata")


def test_registration_accepts_the_types_it_supports(bare):
    for body in (
        {"grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"]},
        {"grant_types": [], "response_types": []},
        {"grant_types": None},
    ):
        assert bare.post("/oauth/register", json={"redirect_uris": [REDIRECT], **body}).status_code == 201, body


def test_a_registered_client_can_open_the_page_and_a_forged_one_cannot(bare, cimd):
    client_id = bare.post("/oauth/register", json={"redirect_uris": [REDIRECT], "client_name": "Dev"}).json()[
        "client_id"
    ]
    _, challenge = pkce()
    r = bare.get(f"/oauth/authorize?{authorize_query(challenge, client_id=client_id)}")
    assert r.status_code == 200 and "<strong>Dev</strong> wants to read your Kalo food log" in r.text
    payload, _, sig = client_id.removeprefix(oauth.DCR_PREFIX).partition(".")
    forged = f"{oauth.DCR_PREFIX}{payload}.{sig[:-2]}AA"
    r = bare.get(f"/oauth/authorize?{authorize_query(challenge, client_id=forged)}")
    assert r.status_code == 400 and "location" not in r.headers
    assert cimd == []  # neither is a URL that gets fetched


def test_a_non_ascii_client_id_signature_is_an_error_page(bare):
    _, challenge = pkce()
    r = bare.get(f"/oauth/authorize?{authorize_query(challenge, client_id=f'{oauth.DCR_PREFIX}abc.é')}")
    assert r.status_code == 400 and "Can't connect to Kalo" in r.text and "location" not in r.headers


# ---- The sign-in page ----


def test_the_page_asks_for_the_code_with_signed_fields_and_strict_headers(bare, cimd):
    _, challenge = pkce()
    r = bare.get(f"/oauth/authorize?{authorize_query(challenge)}")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["referrer-policy"] == "no-referrer"
    csp = r.headers["content-security-policy"]
    assert "frame-ancestors 'none'" in csp and "form-action 'self' https://chatgpt.com" in csp
    assert "script" not in r.text.lower()
    assert "<strong>ChatGPT</strong> wants to read your Kalo food log" in r.text
    page = parse_page(r.text)
    assert page.form == {"method": "post", "action": "/oauth/authorize"}
    code_input = page.inputs["pairing_code"]
    assert (code_input["type"], code_input["autocomplete"], code_input["placeholder"]) == (
        "text",
        "one-time-code",
        "XXXX-XXXX",
    )
    assert page.inputs["allow_write"]["type"] == "checkbox" and "checked" in page.inputs["allow_write"]
    fields = hidden(r.text)
    assert set(fields) == {"client_id", "redirect_uri", "state", "code_challenge", "scope", "resource", "iat", "sig"}
    assert fields["scope"] == f"{READ} {WRITE}" and fields["resource"] == RESOURCE
    assert abs(int(fields["iat"]) - time.time()) < 5
    assert cimd == [CHATGPT]
    bare.get(f"/oauth/authorize?{authorize_query(challenge)}")
    assert cimd == [CHATGPT]  # cached


def test_a_read_only_request_offers_no_write_box(bare):
    _, challenge = pkce()
    r = bare.get(f"/oauth/authorize?{authorize_query(challenge, scope=READ)}")
    assert "allow_write" not in parse_page(r.text).inputs


@pytest.mark.parametrize(
    "overrides",
    [
        {"client_id": "https://evil.example/client.json"},
        {"client_id": None},
        {"redirect_uri": "https://evil.example/cb"},
        {"redirect_uri": "https://chatgpt.com.evil.example/connector_platform_oauth_redirect"},
        {"redirect_uri": "https://chatgpt.com/not-listed"},
        {"redirect_uri": None},
    ],
)
def test_a_bad_client_or_redirect_uri_gets_an_error_page_never_a_redirect(bare, cimd, overrides):
    _, challenge = pkce()
    r = bare.get(f"/oauth/authorize?{authorize_query(challenge, **overrides)}")
    assert r.status_code == 400
    assert "location" not in r.headers
    assert "Can't connect to Kalo" in r.text
    assert "https://evil.example/client.json" not in cimd  # an unlisted client id is never fetched


def test_a_redirect_uri_from_the_client_document_is_accepted(bare):
    _, challenge = pkce()
    assert (
        bare.get(f"/oauth/authorize?{authorize_query(challenge, redirect_uri='https://chatgpt.com/cb2')}").status_code
        == 200
    )


def test_an_unreachable_client_document_falls_back_to_the_allowlist(bare, monkeypatch):
    def fail(url):
        raise OSError("down")

    monkeypatch.setattr(oauth, "fetch_metadata", fail)
    _, challenge = pkce()
    r = bare.get(f"/oauth/authorize?{authorize_query(challenge)}")
    assert r.status_code == 200 and "<strong>ChatGPT</strong>" in r.text
    assert (
        bare.get(f"/oauth/authorize?{authorize_query(challenge, redirect_uri='https://chatgpt.com/cb2')}").status_code
        == 400
    )


def test_a_document_for_another_client_is_not_trusted(bare, monkeypatch):
    monkeypatch.setattr(
        oauth,
        "fetch_metadata",
        lambda url: {"client_id": "https://x.example", "client_name": "Evil", "redirect_uris": []},
    )
    _, challenge = pkce()
    r = bare.get(f"/oauth/authorize?{authorize_query(challenge)}")
    assert "Evil" not in r.text and "<strong>ChatGPT</strong>" in r.text


@pytest.mark.parametrize(
    "overrides, error",
    [
        ({"response_type": "token"}, "unsupported_response_type"),
        ({"code_challenge_method": "plain"}, "invalid_request"),
        ({"code_challenge_method": None}, "invalid_request"),
        ({"code_challenge": None}, "invalid_request"),
        ({"code_challenge": "short"}, "invalid_request"),
        ({"resource": "https://elsewhere.example/mcp"}, "invalid_target"),
        ({"scope": "nutrition:read admin"}, "invalid_scope"),
    ],
)
def test_other_errors_go_back_to_the_client_with_state_and_iss(bare, overrides, error):
    _, challenge = pkce()
    r = bare.get(f"/oauth/authorize?{authorize_query(challenge, **overrides)}")
    assert r.status_code == 303
    base, params = query_of(r.headers["location"])
    assert base == REDIRECT
    assert (params["error"], params["state"], params["iss"]) == (error, "st-123", PUBLIC)


def test_a_tampered_or_expired_page_is_refused(client):
    bare = client
    _, challenge = pkce()
    fields = hidden(bare.get(f"/oauth/authorize?{authorize_query(challenge, scope=READ)}").text)
    tampered = {**fields, "scope": f"{READ} {WRITE}"}
    r = submit(bare, tampered, "ABCD-EFGH")
    assert r.status_code == 400 and "not valid" in r.text and "location" not in r.headers

    r = submit(bare, {**fields, "sig": "é"}, "ABCD-EFGH")  # not ASCII: still just not valid
    assert r.status_code == 400 and "not valid" in r.text

    old = {**fields, "iat": str(int(time.time()) - 601)}
    old["sig"] = oauth.sign(SECRET, "authorize", oauth_page_payload(old))
    r = submit(bare, old, "ABCD-EFGH")
    assert r.status_code == 400 and "expired" in r.text


def oauth_page_payload(fields):
    from app.api.oauth import _sig_payload

    return _sig_payload(fields)


def test_cancel_goes_back_with_access_denied(client):
    bare = client
    _, challenge = pkce()
    fields = hidden(bare.get(f"/oauth/authorize?{authorize_query(challenge)}").text)
    r = submit(bare, fields, "", action="deny")
    assert r.status_code == 303
    _, params = query_of(r.headers["location"])
    assert (params["error"], params["state"], params["iss"]) == ("access_denied", "st-123", PUBLIC)


# ---- The whole flow (database) ----


def test_the_full_flow(client, db, migrated_url):
    device_token = device(client)
    verifier, challenge = pkce()
    page = client.get(f"/oauth/authorize?{authorize_query(challenge)}")
    code = new_code(client, device_token)
    r = submit(client, hidden(page.text), code.lower().replace("-", " "))
    assert r.status_code == 303
    assert r.headers["cache-control"] == "no-store"
    _, params = query_of(r.headers["location"])
    assert set(params) == {"code", "state", "iss"}
    assert (params["state"], params["iss"]) == ("st-123", PUBLIC)

    r = exchange(client, params["code"], verifier)
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    tokens = r.json()
    assert set(tokens) == {"access_token", "token_type", "expires_in", "refresh_token", "scope"}
    assert (tokens["token_type"], tokens["expires_in"], tokens["scope"]) == ("Bearer", 3600, f"{READ} {WRITE}")
    assert tokens["access_token"].startswith("kalo_at_") and TOKEN_RE.fullmatch(tokens["access_token"])
    assert tokens["refresh_token"].startswith("kalo_rt_") and TOKEN_RE.fullmatch(tokens["refresh_token"])

    grant = resolve(migrated_url, tokens["access_token"])
    me = client.get("/api/v1/me", headers=auth(device_token)).json()
    assert grant.user_id == uuid.UUID(me["user_id"])
    assert (grant.client_id, grant.client_name, grant.scopes, grant.resource) == (
        CHATGPT,
        "ChatGPT",
        frozenset({READ, WRITE}),
        RESOURCE,
    )
    assert timedelta(minutes=59) < grant.expires_at - datetime.now(UTC) <= timedelta(hours=1, seconds=5)

    # Refresh rotates: a new pair, the old refresh token spent, the grant the same.
    r = refresh(client, tokens["refresh_token"])
    assert r.status_code == 200, r.text
    rotated = r.json()
    assert rotated["refresh_token"] != tokens["refresh_token"]
    assert rotated["access_token"] != tokens["access_token"]
    assert resolve(migrated_url, rotated["access_token"]).grant_id == grant.grant_id
    # Presented again within 30 seconds, its successor never used: a client retrying after it lost the
    # response. It gets a new pair; the pair it lost is deleted, and the connection stays.
    r = refresh(client, tokens["refresh_token"], client_id="https://evil.example/client.json")
    assert r.json()["error"] == "invalid_grant"  # a retry with the wrong client is refused, changes nothing
    r = refresh(client, tokens["refresh_token"])
    assert r.status_code == 200, r.text
    retried = r.json()
    assert retried["refresh_token"] not in (tokens["refresh_token"], rotated["refresh_token"])
    assert resolve(migrated_url, rotated["access_token"]) is None
    assert refresh(client, rotated["refresh_token"]).json()["error"] == "invalid_grant"
    assert resolve(migrated_url, retried["access_token"]).grant_id == grant.grant_id
    assert refresh(client, retried["refresh_token"]).status_code == 200

    # Nothing secret is stored in the clear.
    stored = " ".join(
        str(row) for t in ("pairing_codes", "oauth_codes", "oauth_tokens") for row in db.execute(f"SELECT * FROM {t}")
    )
    for secret in (code.replace("-", ""), params["code"], tokens["access_token"], tokens["refresh_token"]):
        assert secret not in stored


def test_a_refresh_token_reused_long_after_rotation_revokes_the_connection(client, db, migrated_url):
    tokens, _ = connect(client)
    newer = refresh(client, tokens["refresh_token"]).json()
    db.execute("UPDATE oauth_tokens SET rotated_at = now() - interval '3 minutes' WHERE rotated_at IS NOT NULL")
    r = refresh(client, tokens["refresh_token"])
    assert r.json()["error"] == "invalid_grant"
    assert resolve(migrated_url, newer["access_token"]) is None
    assert refresh(client, newer["refresh_token"]).json()["error"] == "invalid_grant"
    assert db.execute("SELECT revoked_at IS NOT NULL FROM oauth_grants").fetchall() == [(True,)]


def test_a_replay_after_the_client_used_the_new_token_revokes_the_connection(client, db, migrated_url):
    """Inside the 30 seconds, but the client already refreshed with what the first rotation gave it: it
    did not lose that response, so the old token is in someone else's hands."""
    tokens, _ = connect(client)
    newer = refresh(client, tokens["refresh_token"]).json()
    newest = refresh(client, newer["refresh_token"]).json()
    r = refresh(client, tokens["refresh_token"])
    assert r.json()["error"] == "invalid_grant"
    assert resolve(migrated_url, newest["access_token"]) is None
    assert refresh(client, newest["refresh_token"]).json()["error"] == "invalid_grant"
    assert db.execute("SELECT revoked_at IS NOT NULL FROM oauth_grants").fetchall() == [(True,)]


def test_a_thief_replaying_within_30_seconds_takes_the_pair_and_the_client_must_reconnect(client, db, migrated_url):
    """The documented trade-off of the retry grace (services/oauth.py refresh): a stolen spent token,
    replayed before the client next refreshes, is taken for a retry. The thief gets a working pair, the
    client's pair is deleted, and the connection is not revoked: the client has to connect again."""
    tokens, _ = connect(client)
    clients = refresh(client, tokens["refresh_token"]).json()  # the real client rotates
    thiefs = refresh(client, tokens["refresh_token"]).json()  # the thief replays the spent token at once
    assert resolve(migrated_url, thiefs["access_token"]) is not None
    assert resolve(migrated_url, clients["access_token"]) is None
    assert refresh(client, clients["refresh_token"]).json()["error"] == "invalid_grant"
    assert db.execute("SELECT revoked_at IS NULL FROM oauth_grants").fetchall() == [(True,)]


def test_a_read_only_grant(client, migrated_url):
    tokens, _ = connect(client, allow_write=False)
    assert tokens["scope"] == READ
    assert resolve(migrated_url, tokens["access_token"]).scopes == frozenset({READ})
    # A refresh cannot widen it.
    r = refresh(client, tokens["refresh_token"], scope=f"{READ} {WRITE}")
    assert r.json()["error"] == "invalid_scope"


def test_a_refresh_naming_fewer_scopes_keeps_and_reports_the_grants(client, migrated_url):
    """Tokens carry no scopes of their own, so a refresh does not narrow: it reports what the grant allows."""
    tokens, _ = connect(client)
    r = refresh(client, tokens["refresh_token"], scope=READ)
    assert r.status_code == 200, r.text
    rotated = r.json()
    assert rotated["scope"] == f"{READ} {WRITE}"
    assert resolve(migrated_url, rotated["access_token"]).scopes == frozenset({READ, WRITE})
    r = refresh(client, rotated["refresh_token"], scope=f"{READ} admin")
    assert (r.status_code, r.json()["error"]) == (400, "invalid_scope")
    assert refresh(client, rotated["refresh_token"]).status_code == 200  # the refused refresh spent nothing


def test_a_read_only_request_is_read_only_even_with_the_box(client, migrated_url):
    device_token = device(client)
    verifier, challenge = pkce()
    params = get_auth_code(client, device_token, challenge=challenge, scope=READ)
    assert exchange(client, params["code"], verifier).json()["scope"] == READ


def test_a_wrong_expired_or_reused_pairing_code_shows_the_form_again(client, db):
    device_token = device(client)
    _, challenge = pkce()
    fields = hidden(client.get(f"/oauth/authorize?{authorize_query(challenge)}").text)

    def try_code(code):
        r = submit(client, fields, code)
        if r.status_code != 303:
            assert r.status_code == 400
            assert "That code didn&#x27;t work" in r.text and "Goals → Connect ChatGPT" in r.text
            assert "pairing_code" in parse_page(r.text).inputs  # the form again, same fields
            assert hidden(r.text) == fields
        return r.status_code

    assert try_code("ZZZZ-ZZZZ") == 400
    assert try_code("not a code") == 400
    expired = new_code(client, device_token)
    db.execute("UPDATE pairing_codes SET expires_at = now() - interval '1 second'")
    assert try_code(expired) == 400
    code = new_code(client, device_token)
    assert try_code(code) == 303
    assert try_code(code) == 400  # single use
    # A new code replaces the user's earlier ones.
    first = new_code(client, device_token)
    second = new_code(client, device_token)
    assert try_code(first) == 400
    assert try_code(second) == 303


def test_pairing_attempts_are_rate_limited_per_address(client):
    _, challenge = pkce()
    fields = hidden(client.get(f"/oauth/authorize?{authorize_query(challenge)}").text)
    for _ in range(10):
        assert submit(client, fields, "ZZZZ-ZZZZ").status_code == 400
    code = new_code(client, device(client))
    r = submit(client, fields, code)
    assert r.status_code == 429
    assert "Too many tries" in r.text and "pairing_code" in parse_page(r.text).inputs
    assert int(r.headers["retry-after"]) > 0


def test_pairing_attempts_are_rate_limited_overall(client):
    client.app.state.pairing_attempts_overall = SlidingWindow(3, per_seconds=3600)
    _, challenge = pkce()
    fields = hidden(client.get(f"/oauth/authorize?{authorize_query(challenge)}").text)
    # A right code does not count overall: only wrong ones do.
    for _ in range(3):
        assert submit(client, fields, new_code(client, device(client))).status_code == 303
    for _ in range(3):
        assert submit(client, fields, "ZZZZ-ZZZZ").status_code == 400
    assert submit(client, fields, "ZZZZ-ZZZZ").status_code == 429
    # While limited, a right code is refused too (and not spent).
    code = new_code(client, device(client))
    r = submit(client, fields, code)
    assert r.status_code == 429 and "Too many tries" in r.text
    client.app.state.pairing_attempts_overall = SlidingWindow(3, per_seconds=3600)
    assert submit(client, fields, code).status_code == 303


@pytest.mark.parametrize(
    "overrides, error",
    [
        ({"code_verifier": "x" * 43}, "invalid_grant"),
        ({"code_verifier": None}, "invalid_request"),
        ({"code_verifier": "short"}, "invalid_grant"),
        ({"redirect_uri": "https://chatgpt.com/cb2"}, "invalid_grant"),
        ({"redirect_uri": None}, "invalid_grant"),
        ({"client_id": "https://other.example/client.json"}, "invalid_grant"),
        ({"client_id": None}, "invalid_request"),
        ({"resource": "https://elsewhere.example/mcp"}, "invalid_target"),
        ({"code": "kalo_ac_unknown"}, "invalid_grant"),
        ({"grant_type": "password"}, "unsupported_grant_type"),
    ],
)
def test_a_bad_token_request_is_refused(client, overrides, error):
    device_token = device(client)
    verifier, challenge = pkce()
    params = get_auth_code(client, device_token, challenge=challenge)
    r = exchange(client, params["code"], verifier, **overrides)
    assert r.status_code == 400
    assert r.json()["error"] == error
    assert r.headers["cache-control"] == "no-store"


def test_the_token_endpoint_takes_form_bodies_only(client):
    r = client.post("/oauth/token", json={"grant_type": "authorization_code"})
    assert (r.status_code, r.json()["error"]) == (400, "invalid_request")
    r = client.post("/oauth/token", content="grant_type=a&grant_type=b", headers={
        "Content-Type": "application/x-www-form-urlencoded"})  # fmt: skip
    assert r.json()["error"] == "invalid_request"


def test_an_expired_authorization_code_is_refused(client, db):
    device_token = device(client)
    verifier, challenge = pkce()
    params = get_auth_code(client, device_token, challenge=challenge)
    db.execute("UPDATE oauth_codes SET expires_at = now() - interval '1 second'")
    assert exchange(client, params["code"], verifier).json()["error"] == "invalid_grant"


def test_a_replayed_authorization_code_revokes_what_it_created(client, migrated_url):
    device_token = device(client)
    verifier, challenge = pkce()
    params = get_auth_code(client, device_token, challenge=challenge)
    tokens = exchange(client, params["code"], verifier).json()
    assert resolve(migrated_url, tokens["access_token"]) is not None
    r = exchange(client, params["code"], verifier)
    assert (r.status_code, r.json()["error"]) == (400, "invalid_grant")
    assert resolve(migrated_url, tokens["access_token"]) is None
    assert refresh(client, tokens["refresh_token"]).json()["error"] == "invalid_grant"


# ---- resolve_access_token ----


def test_resolve_access_token(client, db, migrated_url):
    tokens, device_token = connect(client)
    access = tokens["access_token"]
    assert db.execute("SELECT last_used_at FROM oauth_grants").fetchone()[0] is None
    grant = resolve(migrated_url, access)
    assert grant is not None
    touched = db.execute("SELECT last_used_at FROM oauth_grants").fetchone()[0]
    assert touched is not None
    resolve(migrated_url, access)  # within the minute: no write
    assert db.execute("SELECT last_used_at FROM oauth_grants").fetchone()[0] == touched

    assert resolve(migrated_url, access, resource=f"{PUBLIC}/other") is None
    assert resolve(migrated_url, tokens["refresh_token"]) is None
    assert resolve(migrated_url, device_token) is None
    assert resolve(migrated_url, "kalo_at_" + "A" * 43) is None

    db.execute("UPDATE oauth_tokens SET expires_at = now() - interval '1 second' WHERE kind = 'access'")
    assert resolve(migrated_url, access) is None


def test_resolve_access_token_refuses_a_revoked_grant(client, db, migrated_url):
    tokens, _ = connect(client)
    db.execute("UPDATE oauth_grants SET revoked_at = now()")
    assert resolve(migrated_url, tokens["access_token"]) is None


def test_an_oauth_token_is_not_a_device_token(client):
    tokens, _ = connect(client)
    for token in (tokens["access_token"], tokens["refresh_token"]):
        assert client.get("/api/v1/me", headers=auth(token)).status_code == 401
