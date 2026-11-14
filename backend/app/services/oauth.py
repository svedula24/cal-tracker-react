"""The OAuth 2.1 authorization server's logic: clients, codes, tokens, grants.

A grant is a connection: one client (ChatGPT) allowed into one user's data with some scopes, bound
to one resource (the MCP endpoint's URL). Authorization codes live 60 s and are used once; access
tokens 1 h; refresh tokens 90 days and are rotated on every use. Codes and tokens are opaque random
strings, stored only as their SHA-256 (256 bits of entropy, so a plain hash is enough, as for device
tokens in app/services/users.py). They live in their own tables: the REST API's `user_for_token`
never finds an OAuth token, and `resolve_access_token` never finds a device token.

Clients: only allowlisted client ids (settings.oauth_client_ids, client ID metadata document URLs)
are fetched, so no other URL is ever requested; or a client id this server signed when it registered
the client (stateless dynamic client registration). A redirect URI must start with
https://chatgpt.com/ and be in settings.oauth_redirect_uris or the client's own metadata.

Nothing here commits, except where a function says so; the route commits once.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import threading
import time
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import delete, func, insert, or_, select, update
from sqlalchemy.orm import Session

from app.models.oauth import OAuthCode, OAuthGrant, OAuthToken
from app.settings import Settings

SCOPE_READ = "nutrition:read"
SCOPE_WRITE = "nutrition:write"
SCOPES = (SCOPE_READ, SCOPE_WRITE)

CODE_LIFETIME = timedelta(seconds=60)
ACCESS_LIFETIME = timedelta(hours=1)
REFRESH_LIFETIME = timedelta(days=90)
# A refresh token presented again within this of its rotation is refused (a client retrying after a
# lost response); later than this it is taken as stolen and the grant is revoked.
REUSE_GRACE = timedelta(minutes=2)
# A used or expired code is kept this long, so a replay can still revoke what the code created.
CODE_KEPT = timedelta(minutes=10)
# last_used_at is rewritten at most this often (as for device tokens).
TOUCH_EVERY = timedelta(minutes=1)

ACCESS_PREFIX = "kalo_at_"
REFRESH_PREFIX = "kalo_rt_"
CODE_PREFIX = "kalo_ac_"
DCR_PREFIX = "kalo_dcr."
REDIRECT_ORIGIN = "https://chatgpt.com/"
# PKCE (RFC 7636): a verifier is 43 to 128 unreserved characters; an S256 challenge is 43 base64url.
VERIFIER_RE = re.compile(r"[A-Za-z0-9\-._~]{43,128}")
CHALLENGE_RE = re.compile(r"[A-Za-z0-9\-_]{43}")


class OAuthError(Exception):
    """An OAuth error response: `error` is the RFC 6749 code; the description never echoes a secret."""

    def __init__(self, error: str, description: str) -> None:
        super().__init__(description)
        self.error = error
        self.description = description


def hash_secret(value: str) -> bytes:
    return hashlib.sha256(value.encode()).digest()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sign(secret: bytes, purpose: str, payload: str) -> str:
    """An HMAC-SHA256 of `payload` for one `purpose` (so a signature made for one use is useless for another)."""
    return _b64(hmac.new(secret, f"{purpose}\n{payload}".encode(), hashlib.sha256).digest())


def same(a: str, b: str) -> bool:
    """Constant-time equality of two strings. Compared as bytes: compare_digest raises TypeError for a str
    that is not ASCII, and a forged signature or client id may be anything."""
    return hmac.compare_digest(a.encode(), b.encode())


def verify(secret: bytes, purpose: str, payload: str, signature: str) -> bool:
    return same(sign(secret, purpose, payload), signature)


def s256(verifier: str) -> str:
    return _b64(hashlib.sha256(verifier.encode("ascii")).digest())


# ---- Clients ----


@dataclass(frozen=True)
class Client:
    client_id: str
    client_name: str
    redirect_uris: tuple[str, ...]  # what the client itself lists (its metadata document or registration)


def _fetch_metadata(url: str) -> dict:
    """GET a client ID metadata document: 3 s timeout, no redirects, at most 64 KB. Raises on any failure."""
    import httpx2  # only the CIMD fetch needs it; imported here, where it is used

    with (
        httpx2.Client(timeout=3.0, follow_redirects=False) as http,
        http.stream("GET", url, headers={"Accept": "application/json"}) as response,
    ):
        response.raise_for_status()
        body = b""
        for chunk in response.iter_bytes():
            body += chunk
            if len(body) > METADATA_MAX_BYTES:
                raise ValueError("client metadata document too large")
    document = json.loads(body)
    if not isinstance(document, dict):
        raise ValueError("client metadata document is not an object")
    return document


METADATA_MAX_BYTES = 64 * 1024
METADATA_TTL = 24 * 3600.0
METADATA_RETRY = 60.0  # a failed fetch is retried after this long
# Tests replace this (and call clear_client_cache).
fetch_metadata: Callable[[str], dict] = _fetch_metadata
_cache: dict[str, tuple[float, Client]] = {}
_cache_lock = threading.Lock()


def clear_client_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _metadata_client(client_id: str) -> Client:
    """The client an allowlisted metadata URL describes, from the cache or fetched (one process's memory).

    When the document cannot be fetched or is not usable, the client still works with the allowlisted
    redirect URIs and a name from its host, and the fetch is retried a minute later.
    """
    now = time.monotonic()
    with _cache_lock:
        cached = _cache.get(client_id)
    if cached is not None and cached[0] > now:
        return cached[1]
    fallback = Client(client_id, _host_name(client_id), ())
    try:
        document = fetch_metadata(client_id)
        uris = document.get("redirect_uris")
        name = document.get("client_name")
        if document.get("client_id") != client_id or not isinstance(uris, list):
            raise ValueError("client metadata document does not describe this client")
        client = Client(
            client_id,
            name.strip()[:100] if isinstance(name, str) and name.strip() else fallback.client_name,
            tuple(u for u in uris if isinstance(u, str)),
        )
        expires = now + METADATA_TTL
    except Exception:  # noqa: BLE001 - any failure (network, JSON, shape) falls back to the allowlist
        client, expires = fallback, now + METADATA_RETRY
    with _cache_lock:
        _cache[client_id] = (expires, client)
    return client


def _host_name(url: str) -> str:
    host = url.split("://", 1)[-1].split("/", 1)[0]
    return "ChatGPT" if host in ("chatgpt.com", "www.chatgpt.com") else host


def register_client(settings: Settings, redirect_uris: object, client_name: object) -> Client:
    """Dynamic client registration without storage: the client id carries its redirect URIs and name,
    signed with the server's secret. Only allowlisted redirect URIs are accepted."""
    if not isinstance(redirect_uris, list) or not redirect_uris or not all(isinstance(u, str) for u in redirect_uris):
        raise OAuthError("invalid_redirect_uri", "redirect_uris must be a non-empty list of strings")
    for uri in redirect_uris:
        if not (uri.startswith(REDIRECT_ORIGIN) and uri in settings.oauth_redirect_uris):
            raise OAuthError("invalid_redirect_uri", "a redirect URI is not allowed by this server")
    if client_name is not None and not isinstance(client_name, str):
        raise OAuthError("invalid_client_metadata", "client_name must be a string")
    name = (client_name or "").strip()[:100] or "ChatGPT"
    payload = _b64(json.dumps({"n": name, "r": list(dict.fromkeys(redirect_uris))}, separators=(",", ":")).encode())
    client_id = f"{DCR_PREFIX}{payload}.{sign(settings.secret, 'dcr', payload)}"
    return Client(client_id, name, tuple(dict.fromkeys(redirect_uris)))


def _registered_client(settings: Settings, client_id: str) -> Client | None:
    payload, _, signature = client_id.removeprefix(DCR_PREFIX).partition(".")
    if not payload or not signature or not verify(settings.secret, "dcr", payload, signature):
        return None
    try:
        data = json.loads(_unb64(payload))
        return Client(client_id, str(data["n"]), tuple(str(u) for u in data["r"]))
    except (ValueError, KeyError, TypeError):
        return None


def resolve_client(settings: Settings, client_id: str) -> Client | None:
    """The client `client_id` names, or None for one this server does not accept. Fetches nothing for
    a client id that is not allowlisted."""
    if client_id in settings.oauth_client_ids:
        return _metadata_client(client_id)
    if client_id.startswith(DCR_PREFIX):
        return _registered_client(settings, client_id)
    return None


def redirect_allowed(settings: Settings, client: Client, redirect_uri: str) -> bool:
    """A redirect URI on chatgpt.com that this server's allowlist or the client's own metadata lists.
    A registered (DCR) client is held to the allowlist as it is now, not as it was at registration."""
    if not redirect_uri.startswith(REDIRECT_ORIGIN):
        return False
    if redirect_uri in settings.oauth_redirect_uris:
        return True
    return not client.client_id.startswith(DCR_PREFIX) and redirect_uri in client.redirect_uris


def parse_scopes(scope: str | None) -> frozenset[str]:
    """The scopes asked for (all of them when none are named); OAuthError for an unknown one."""
    if scope is None or not scope.strip():
        return frozenset(SCOPES)
    asked = frozenset(scope.split())
    if not asked <= set(SCOPES):
        raise OAuthError("invalid_scope", f"supported scopes: {' '.join(SCOPES)}")
    return asked


def scope_string(scopes: Iterable[str]) -> str:
    return " ".join(s for s in SCOPES if s in set(scopes))


# ---- Codes and tokens ----


def create_code(
    session: Session,
    *,
    user_id: uuid.UUID,
    client: Client,
    scopes: frozenset[str],
    resource: str,
    redirect_uri: str,
    code_challenge: str,
) -> str:
    """An authorization code for what the user approved (returned in the clear, stored hashed). Clears
    codes that expired a while ago. Does not commit."""
    session.execute(delete(OAuthCode).where(OAuthCode.expires_at < func.now() - CODE_KEPT))
    code = CODE_PREFIX + secrets.token_urlsafe(32)
    session.execute(
        insert(OAuthCode).values(
            code_hash=hash_secret(code),
            user_id=user_id,
            client_id=client.client_id,
            client_name=client.client_name,
            scopes=sorted(scopes | {SCOPE_READ}),
            resource=resource,
            redirect_uri=redirect_uri,
            code_challenge=code_challenge,
            expires_at=func.now() + CODE_LIFETIME,
        )
    )
    return code


@dataclass(frozen=True)
class TokenPair:
    access_token: str
    refresh_token: str
    expires_in: int
    scope: str


def _issue(session: Session, grant_id: uuid.UUID, scopes: Iterable[str]) -> TokenPair:
    """A new access and refresh token for the grant. Clears the grant's expired tokens. Does not commit."""
    session.execute(delete(OAuthToken).where(OAuthToken.grant_id == grant_id, OAuthToken.expires_at < func.now()))
    access = ACCESS_PREFIX + secrets.token_urlsafe(32)
    refresh = REFRESH_PREFIX + secrets.token_urlsafe(32)
    session.execute(
        insert(OAuthToken).values(
            [
                {"token_hash": hash_secret(token), "grant_id": grant_id, "kind": kind, "expires_at": func.now() + life}
                for token, kind, life in ((access, "access", ACCESS_LIFETIME), (refresh, "refresh", REFRESH_LIFETIME))
            ]
        )
    )
    return TokenPair(access, refresh, int(ACCESS_LIFETIME.total_seconds()), scope_string(scopes))


def _revoke(session: Session, grant_id: uuid.UUID) -> None:
    session.execute(
        update(OAuthGrant)
        .where(OAuthGrant.id == grant_id, OAuthGrant.revoked_at.is_(None))
        .values(revoked_at=func.now())
    )
    session.execute(delete(OAuthToken).where(OAuthToken.grant_id == grant_id))


def exchange_code(
    session: Session,
    *,
    code: str,
    client_id: str,
    redirect_uri: str | None,
    code_verifier: str | None,
    resource: str | None,
) -> TokenPair:
    """Trade an authorization code for a new grant and its first tokens. The new grant replaces the user's
    earlier ones for the same client (connecting again is a reconnect): those are revoked. Does not commit,
    except that a replayed code's revocation is committed before the OAuthError is raised (the route
    commits nothing when it fails)."""
    found = session.execute(
        select(OAuthCode, OAuthCode.expires_at <= func.now())
        .where(OAuthCode.code_hash == hash_secret(code))
        .with_for_update()
    ).one_or_none()
    if found is None:
        raise OAuthError("invalid_grant", "unknown or expired authorization code")
    row, expired = found
    if row.used_at is not None:
        # Used before: whoever presents it now may have stolen it, so what it created is revoked.
        if row.grant_id is not None:
            _revoke(session, row.grant_id)
        session.commit()
        raise OAuthError("invalid_grant", "authorization code already used")
    if expired:
        raise OAuthError("invalid_grant", "unknown or expired authorization code")
    if not same(client_id, row.client_id):
        raise OAuthError("invalid_grant", "the code was issued to another client")
    if redirect_uri != row.redirect_uri:
        raise OAuthError("invalid_grant", "redirect_uri does not match the authorization request")
    if not code_verifier:
        raise OAuthError("invalid_request", "code_verifier is required")
    if not VERIFIER_RE.fullmatch(code_verifier) or not same(s256(code_verifier), row.code_challenge):
        raise OAuthError("invalid_grant", "code_verifier does not match the code challenge")
    if resource is not None and resource != row.resource:
        raise OAuthError("invalid_target", "resource does not match the authorization request")
    grant_id = session.execute(
        insert(OAuthGrant)
        .values(
            user_id=row.user_id,
            client_id=row.client_id,
            client_name=row.client_name,
            scopes=row.scopes,
            resource=row.resource,
        )
        .returning(OAuthGrant.id)
    ).scalar_one()
    session.execute(
        update(OAuthCode).where(OAuthCode.code_hash == row.code_hash).values(used_at=func.now(), grant_id=grant_id)
    )
    replaced = session.scalars(
        select(OAuthGrant.id).where(
            OAuthGrant.user_id == row.user_id,
            OAuthGrant.client_id == row.client_id,
            OAuthGrant.revoked_at.is_(None),
            OAuthGrant.id != grant_id,
        )
    ).all()
    for old_id in replaced:
        _revoke(session, old_id)
    return _issue(session, grant_id, row.scopes)


def refresh(
    session: Session, *, refresh_token: str, client_id: str, scope: str | None, resource: str | None
) -> TokenPair:
    """Rotate a refresh token: the old one is spent, a new access and refresh token are issued for the same
    grant, with the grant's scopes. A `scope` may name the grant's scopes or fewer, but the tokens are not
    narrowed (they carry no scopes of their own: access is checked against the grant); naming one the
    grant lacks is invalid_scope. Does not commit, except a revocation for a reused token (committed
    before the OAuthError)."""
    token_hash = hash_secret(refresh_token)
    rotated = session.execute(
        update(OAuthToken)
        .where(
            OAuthToken.token_hash == token_hash,
            OAuthToken.kind == "refresh",
            OAuthToken.rotated_at.is_(None),
            OAuthToken.expires_at > func.now(),
        )
        .values(rotated_at=func.now())
        .returning(OAuthToken.grant_id)
    ).scalar_one_or_none()
    if rotated is None:
        old = session.execute(
            select(OAuthToken.grant_id, OAuthToken.rotated_at < func.now() - REUSE_GRACE).where(
                OAuthToken.token_hash == token_hash, OAuthToken.kind == "refresh", OAuthToken.rotated_at.is_not(None)
            )
        ).one_or_none()
        if old is not None and old[1]:
            _revoke(session, old[0])
            session.commit()
        raise OAuthError("invalid_grant", "unknown, expired or already used refresh token")
    grant = session.execute(
        select(OAuthGrant).where(OAuthGrant.id == rotated, OAuthGrant.revoked_at.is_(None))
    ).scalar_one_or_none()
    if grant is None:
        raise OAuthError("invalid_grant", "the connection was removed")
    if not same(client_id, grant.client_id):
        raise OAuthError("invalid_grant", "the refresh token was issued to another client")
    if resource is not None and resource != grant.resource:
        raise OAuthError("invalid_target", "resource does not match the connection")
    if scope is not None and scope.strip() and not parse_scopes(scope) <= set(grant.scopes):
        raise OAuthError("invalid_scope", "a refresh cannot add scopes")
    return _issue(session, grant.id, grant.scopes)


# ---- What the MCP server and the app use ----


@dataclass(frozen=True)
class Grant:
    grant_id: uuid.UUID
    user_id: uuid.UUID
    client_id: str
    client_name: str
    scopes: frozenset[str]  # subset of {"nutrition:read", "nutrition:write"}
    resource: str
    expires_at: datetime  # the access token's expiry


_STALE = or_(OAuthGrant.last_used_at.is_(None), OAuthGrant.last_used_at < func.now() - TOUCH_EVERY)


def resolve_access_token(session: Session, token: str, resource: str) -> Grant | None:
    """The grant a live access token for `resource` belongs to, or None. One SELECT. Does not commit.

    Live: an access token (not a refresh token, never a device token: those are in user_tokens),
    not expired, whose grant is not revoked and is bound to `resource`. Records the use in the
    grant's last_used_at at most once a minute, leaving the UPDATE pending for the caller to commit.
    """
    if not token.startswith(ACCESS_PREFIX):
        return None
    row = session.execute(
        select(OAuthGrant, OAuthToken.expires_at, _STALE)
        .join(OAuthToken, OAuthToken.grant_id == OAuthGrant.id)
        .where(
            OAuthToken.token_hash == hash_secret(token),
            OAuthToken.kind == "access",
            OAuthToken.expires_at > func.now(),
            OAuthGrant.revoked_at.is_(None),
            OAuthGrant.resource == resource,
        )
    ).one_or_none()
    if row is None:
        return None
    grant, expires_at, stale = row
    if stale:
        session.execute(update(OAuthGrant).where(OAuthGrant.id == grant.id, _STALE).values(last_used_at=func.now()))
    return Grant(
        grant_id=grant.id,
        user_id=grant.user_id,
        client_id=grant.client_id,
        client_name=grant.client_name,
        scopes=frozenset(grant.scopes),
        resource=grant.resource,
        expires_at=expires_at,
    )


def list_grants(session: Session, user_id: uuid.UUID) -> list[OAuthGrant]:
    """The user's live connections, newest first: not revoked, and with a refresh token that can still be
    used (one whose refresh tokens have all expired can never call again)."""
    live_refresh = (
        select(OAuthToken.token_hash)
        .where(
            OAuthToken.grant_id == OAuthGrant.id,
            OAuthToken.kind == "refresh",
            OAuthToken.rotated_at.is_(None),
            OAuthToken.expires_at > func.now(),
        )
        .exists()
    )
    return list(
        session.scalars(
            select(OAuthGrant)
            .where(OAuthGrant.user_id == user_id, OAuthGrant.revoked_at.is_(None), live_refresh)
            .order_by(OAuthGrant.created_at.desc(), OAuthGrant.id)
        )
    )


def revoke_grant(session: Session, user_id: uuid.UUID, grant_id: uuid.UUID) -> bool:
    """Revoke one of the user's connections and delete its tokens; False when the user has no such grant
    (another user's is the same as a missing one). Revoking a revoked one again is True. Does not commit."""
    owned = session.scalar(select(OAuthGrant.id).where(OAuthGrant.id == grant_id, OAuthGrant.user_id == user_id))
    if owned is None:
        return False
    _revoke(session, grant_id)
    return True
