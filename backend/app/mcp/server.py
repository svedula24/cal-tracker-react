"""The MCP server (official `mcp` SDK, Streamable HTTP) and how it is attached to the FastAPI app.

Only when PUBLIC_URL is set (app/main.py). One route, POST/GET/DELETE /mcp (no trailing-slash
redirect), stateless (no session ids: every request stands alone, so a restart loses nothing) with
plain JSON responses (no SSE stream for a tunnel to buffer). The SDK is the OAuth resource server: a
request without a valid token gets a 401 whose WWW-Authenticate names the protected-resource
document, served at /.well-known/oauth-protected-resource/mcp (and at the bare path), which points to
this server's own authorization server (app/api/oauth.py). Every token needs `nutrition:read`; the
write tools check for `nutrition:write` themselves (app/mcp/tools.py), so a read-only connection
still lists them and gets a clear error.

The Host header must be the public host (or localhost, for local tests): a DNS-rebinding guard.
"""

from __future__ import annotations

from collections.abc import Callable
from urllib.parse import urlsplit

from mcp.server.auth.provider import TokenVerifier
from mcp.server.auth.routes import create_protected_resource_routes
from mcp.server.auth.settings import AuthSettings
from mcp.server.mcpserver import MCPServer
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import AnyHttpUrl
from sqlalchemy.orm import Session
from starlette.routing import BaseRoute, Route

from app.mcp import tools
from app.services.oauth import SCOPE_READ, SCOPE_WRITE
from app.settings import Settings

INSTRUCTIONS = """Kalo is the user's calorie and macro tracker. Dates are days in the user's own calendar \
(every result gives `today` and `timezone`). To log a food: search_foods, then log_food with the fdc_id \
and grams or a portion name; use log_custom_food only for foods the database does not have. To edit or \
delete an entry, get its log_id from get_daily_macros. Calories are kcal, sodium mg, everything else grams."""


def build(
    settings: Settings, sessions: Callable[[], Session], token_verifier: TokenVerifier
) -> tuple[list[BaseRoute], StreamableHTTPSessionManager]:
    """The routes to add to the app (/mcp and the protected-resource documents) and the session manager
    whose `run()` the app's lifespan must hold open."""
    assert settings.public_url is not None
    server = MCPServer(
        "kalo",
        title="Kalo",
        instructions=INSTRUCTIONS,
        token_verifier=token_verifier,
        auth=AuthSettings(
            # Strings, not AnyHttpUrl(...): AuthSettings keeps an empty path empty, so the issuer has no
            # trailing slash and matches the authorization server's metadata exactly (RFC 8414).
            issuer_url=settings.public_url,  # type: ignore[arg-type]
            resource_server_url=settings.resource,  # type: ignore[arg-type]
            required_scopes=[SCOPE_READ],
            validate_token_resource=True,
        ),
    )
    tools.register(server, sessions)
    host = urlsplit(settings.public_url).netloc
    security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=[host, "localhost", "localhost:*", "127.0.0.1", "127.0.0.1:*", "testserver"],
        allowed_origins=[settings.public_url, "https://chatgpt.com", "http://localhost:*", "http://127.0.0.1:*"],
    )
    mcp_app = server.streamable_http_app(
        streamable_http_path="/mcp", json_response=True, stateless_http=True, transport_security=security
    )
    # The SDK's app holds the bearer middleware; a Route whose endpoint is an ASGI app hands it the
    # request as is (any method), so only /mcp reaches it and the rest of the API keeps its own 404/405s.
    # The protected-resource document is built here rather than taken from the SDK's app so that it
    # lists both scopes (the SDK lists only the required one): a client asks for what it lists.
    documents = create_protected_resource_routes(
        resource_url=AnyHttpUrl(settings.resource),
        authorization_servers=[settings.public_url],  # type: ignore[list-item]  (as above: no trailing slash)
        scopes_supported=[SCOPE_READ, SCOPE_WRITE],
        resource_name="Kalo",
    )
    bare = [Route("/.well-known/oauth-protected-resource", endpoint=route.endpoint, methods=["GET", "OPTIONS"])
            for route in documents if isinstance(route, Route)]  # fmt: skip
    return [Route("/mcp", endpoint=mcp_app), *documents, *bare], server.session_manager
