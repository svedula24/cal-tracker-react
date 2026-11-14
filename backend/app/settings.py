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
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

DEFAULT_CLIENT_IDS = ("https://chatgpt.com/oauth/client.json",)
DEFAULT_REDIRECT_URIS = ("https://chatgpt.com/connector_platform_oauth_redirect",)
MIN_SECRET_LENGTH = 32
DEFAULT_OFF_BASE_URL = "https://world.openfoodfacts.org"
DEFAULT_OFF_USER_AGENT = "Kalo/0.1 (+https://github.com/svedula24/cal-tracker-react)"


@dataclass(frozen=True)
class Settings:
    public_url: str | None = None
    secret: bytes = b""
    oauth_client_ids: tuple[str, ...] = DEFAULT_CLIENT_IDS
    oauth_redirect_uris: tuple[str, ...] = DEFAULT_REDIRECT_URIS
    off_base_url: str = DEFAULT_OFF_BASE_URL
    off_user_agent: str = DEFAULT_OFF_USER_AGENT

    def __post_init__(self) -> None:
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


def _list(value: str | None, default: tuple[str, ...]) -> tuple[str, ...]:
    if value is None or not value.strip():
        return default
    return tuple(item.strip() for item in value.split(",") if item.strip())


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
    )
