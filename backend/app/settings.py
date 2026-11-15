"""Settings read from the environment: the public URL that turns on OAuth and MCP, their secrets, and
where barcode lookups go.

PUBLIC_URL          the server's public origin (the ngrok domain), no trailing slash. Unset = the OAuth
                    authorization server and the MCP endpoint are off (the rest of the API is unchanged).
KALO_SECRET         the HMAC key for the authorize page's signed fields and the DCR client ids. At least
                    32 characters; required when PUBLIC_URL is set. Changing it invalidates open sign-in
                    pages and DCR client ids, nothing else.
OAUTH_CLIENT_IDS    comma-separated client ids (client ID metadata document URLs) that may sign in.
                    Only these URLs are ever fetched. Default: ChatGPT's.
OAUTH_REDIRECT_URIS comma-separated redirect URIs a client may use (each must also start with
                    https://chatgpt.com/). Default: ChatGPT's connector redirect.
OFF_BASE_URL        the Open Food Facts origin barcode lookups read from, no trailing slash.
                    Default: https://world.openfoodfacts.org
OFF_USER_AGENT      the User-Agent sent to Open Food Facts, which asks for "AppName/Version (contact)".
                    Default: Kalo/0.1 (+https://github.com/svedula24/cal-tracker-react)
ALLOW_REGISTRATION  whether POST /api/v1/devices creates new users: true (default) or false. A deployment
                    registers its phone, then sets it to false so nobody else can. Anything other than
                    true/false/1/0/yes/no/on/off is refused, so a typo cannot leave registration open.
SERVE_API_PUBLICLY  true serves the whole API on PUBLIC_URL's host (the Vercel deployment: the web app and
                    the API share one origin), without /docs, /redoc or /openapi.json. Default false: only
                    /mcp, /oauth/* and /.well-known/* are served there (the ngrok tunnel).
RATE_LIMITS         where the rate limits count: memory (default: this process, fine for one uvicorn) or db
                    (the rate_limits table, shared by every serverless instance; app/services/limits.py).
CLIENT_IP_HEADER    the request header with the client's address, set by a proxy that overwrites whatever
                    the client sent; its first entry is used. Default: none (the connection's peer; uvicorn
                    --proxy-headers handles a local proxy), or x-forwarded-for when VERCEL=1 (Vercel sets
                    VERCEL=1 and overwrites that header). Rate limits key on it.
DB_POOL_SIZE        connections the engine keeps per process. Default 10. 0 = no pool (NullPool).
DB_POOL_PRE_PING    true tests a pooled connection before use, so one the server closed (Neon suspends an
                    idle compute) is replaced instead of failing the request.
DB_POOL_RECYCLE     seconds after which a pooled connection is replaced. Default: never.
DB_CONNECT_TIMEOUT  seconds to wait for a new connection (libpq connect_timeout). Default: libpq's (none).
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import urlsplit

DEFAULT_CLIENT_IDS = ("https://chatgpt.com/oauth/client.json",)
DEFAULT_REDIRECT_URIS = ("https://chatgpt.com/connector_platform_oauth_redirect",)
MIN_SECRET_LENGTH = 32
DEFAULT_OFF_BASE_URL = "https://world.openfoodfacts.org"
DEFAULT_OFF_USER_AGENT = "Kalo/0.1 (+https://github.com/svedula24/cal-tracker-react)"
RATE_LIMIT_STORES = ("memory", "db")
# Vercel overwrites X-Forwarded-For with the client's public address and does not forward one a client sent,
# "to prevent IP spoofing" (https://vercel.com/docs/headers/request-headers).
VERCEL_CLIENT_IP_HEADER = "x-forwarded-for"


@dataclass(frozen=True)
class Settings:
    public_url: str | None = None
    secret: bytes = b""
    oauth_client_ids: tuple[str, ...] = DEFAULT_CLIENT_IDS
    oauth_redirect_uris: tuple[str, ...] = DEFAULT_REDIRECT_URIS
    off_base_url: str = DEFAULT_OFF_BASE_URL
    off_user_agent: str = DEFAULT_OFF_USER_AGENT
    allow_registration: bool = True
    serve_api_publicly: bool = False
    rate_limits: str = "memory"
    client_ip_header: str | None = None
    db_pool_size: int = 10
    db_pool_pre_ping: bool = False
    db_pool_recycle: int = -1
    db_connect_timeout: int | None = None

    def __post_init__(self) -> None:
        if self.rate_limits not in RATE_LIMIT_STORES:
            raise ValueError(f"RATE_LIMITS must be one of {', '.join(RATE_LIMIT_STORES)}, not {self.rate_limits!r}")
        if self.public_url is None:
            return
        if not self.public_url.startswith(("https://", "http://localhost", "http://127.0.0.1")):
            raise ValueError("PUBLIC_URL must be https:// (or http://localhost for local testing)")
        if self.public_url.endswith("/"):
            raise ValueError("PUBLIC_URL must not end with a slash")
        if len(self.secret) < MIN_SECRET_LENGTH:
            raise ValueError(f"KALO_SECRET must be set (at least {MIN_SECRET_LENGTH} characters) with PUBLIC_URL")

    @property
    def resource(self) -> str:
        """The MCP endpoint's URL: the resource (RFC 8707) every OAuth token is bound to."""
        if self.public_url is None:
            raise ValueError("PUBLIC_URL is not set")
        return self.public_url + "/mcp"

    @property
    def public_host(self) -> str | None:
        """PUBLIC_URL's host name, lowercase and without a port, when it is a real (https) public origin.

        None without PUBLIC_URL, and for an http://localhost one (local testing): that host is not public,
        and the web build and simulator call the API on it.
        """
        if self.public_url is None or not self.public_url.startswith("https://"):
            return None
        return urlsplit(self.public_url).hostname


def host_name(host: str) -> str:
    """A Host header's name: lowercase, without its port or a trailing dot ("Kalo.Example.:443" -> "kalo.example")."""
    host = host.strip().lower()
    if host.startswith("["):  # an IPv6 literal, "[::1]:8000" -> "::1" (as urlsplit's hostname has it)
        return host[1:].partition("]")[0]
    return host.rpartition(":")[0].rstrip(".") if ":" in host else host.rstrip(".")


def _list(value: str | None, default: tuple[str, ...]) -> tuple[str, ...]:
    if value is None or not value.strip():
        return default
    return tuple(item.strip() for item in value.split(",") if item.strip())


_TRUE = ("true", "1", "yes", "on")
_FALSE = ("false", "0", "no", "off")


def _bool(name: str, value: str | None, default: bool) -> bool:
    if value is None or not value.strip():
        return default
    if value.strip().lower() in _TRUE:
        return True
    if value.strip().lower() in _FALSE:
        return False
    raise ValueError(f"{name} must be true or false, not {value!r}")


def _int(name: str, value: str | None, default: int | None, minimum: int) -> int | None:
    if value is None or not value.strip():
        return default
    try:
        number = int(value.strip())
    except ValueError:
        raise ValueError(f"{name} must be a whole number, not {value!r}") from None
    if number < minimum:
        raise ValueError(f"{name} must be at least {minimum}, not {number}")
    return number


def get_settings(environ: Mapping[str, str] | None = None) -> Settings:
    """Settings from the environment (or `environ`). Raises ValueError for an unusable combination."""
    env = os.environ if environ is None else environ
    public_url = (env.get("PUBLIC_URL") or "").strip().rstrip("/") or None
    return Settings(
        public_url=public_url,
        secret=(env.get("KALO_SECRET") or "").encode(),
        oauth_client_ids=_list(env.get("OAUTH_CLIENT_IDS"), DEFAULT_CLIENT_IDS),
        oauth_redirect_uris=_list(env.get("OAUTH_REDIRECT_URIS"), DEFAULT_REDIRECT_URIS),
        off_base_url=(env.get("OFF_BASE_URL") or "").strip().rstrip("/") or DEFAULT_OFF_BASE_URL,
        off_user_agent=(env.get("OFF_USER_AGENT") or "").strip() or DEFAULT_OFF_USER_AGENT,
        allow_registration=_bool("ALLOW_REGISTRATION", env.get("ALLOW_REGISTRATION"), default=True),
        serve_api_publicly=_bool("SERVE_API_PUBLICLY", env.get("SERVE_API_PUBLICLY"), default=False),
        rate_limits=(env.get("RATE_LIMITS") or "").strip().lower() or "memory",
        client_ip_header=(env.get("CLIENT_IP_HEADER") or "").strip().lower()
        or (VERCEL_CLIENT_IP_HEADER if env.get("VERCEL") == "1" else None),
        db_pool_size=_int("DB_POOL_SIZE", env.get("DB_POOL_SIZE"), 10, minimum=0),
        db_pool_pre_ping=_bool("DB_POOL_PRE_PING", env.get("DB_POOL_PRE_PING"), default=False),
        db_pool_recycle=_int("DB_POOL_RECYCLE", env.get("DB_POOL_RECYCLE"), -1, minimum=1),
        db_connect_timeout=_int("DB_CONNECT_TIMEOUT", env.get("DB_CONNECT_TIMEOUT"), None, minimum=1),
    )
