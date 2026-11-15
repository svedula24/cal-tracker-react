"""The FastAPI app. `uv run uvicorn app.main:app --reload`

Importing does not connect: the engine is built when the app starts and disposed when it stops.
With PUBLIC_URL set (app/settings.py) it also serves the OAuth authorization server (app/api/oauth.py)
and the MCP endpoint /mcp (app/mcp/); without it, neither exists.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from sqlalchemy.exc import TimeoutError as PoolTimeout
from sqlalchemy.orm import Session, sessionmaker
from starlette.types import ASGIApp, Receive, Scope, Send

from app.api import oauth as oauth_api
from app.api.limits import BodyLimit
from app.api.v1.connections import CODES_PER_HOUR
from app.api.v1.connections import router as connections_router
from app.api.v1.devices import router as devices_router
from app.api.v1.food_logs import router as food_logs_router
from app.api.v1.foods import BARCODE_LOOKUPS_PER_HOUR, FOOD_SEARCHES_PER_HOUR, OFF_READS_PER_MINUTE
from app.api.v1.foods import router as foods_router
from app.api.v1.goals import daily_activity_router, goals_router
from app.api.v1.nutrition import router as nutrition_router
from app.api.v1.sync import router as sync_router
from app.db.session import make_engine, make_limits_engine
from app.services.limits import make_limiter
from app.settings import Settings, get_settings, host_name
from kalo.db import database_url, require_head

# A household or office shares one address; an app registers once per install.
REGISTRATIONS_PER_HOUR = 20

# The largest request body accepted. The biggest legitimate one is a sync push of 500 rows, about
# 300 kB; without a limit the whole body is read and parsed before the 500-row check can refuse it.
MAX_BODY_BYTES = 2 * 1024 * 1024


def public_path(path: str) -> bool:
    """Whether `path` may be served on the public host: /mcp, or anything under /mcp/, /oauth/ or /.well-known/.

    The same paths as ops/ngrok-policy.yml (plus /mcp/...). Matched on the path as it is routed: Starlette
    neither collapses "..", nor "." nor "//", so a path with such a segment is refused rather than trusted
    to route where its prefix says.
    """
    if path != "/mcp" and not path.startswith(("/mcp/", "/oauth/", "/.well-known/")):
        return False
    return not any(segment in (".", "..") for segment in path.split("/")[1:]) and "//" not in path


class PublicHostGuard:
    """404 for every request on PUBLIC_URL's host whose path is not public (`public_path`).

    The tunnel's traffic policy does the same at ngrok; this keeps the REST API, /docs and /openapi.json
    off the public host even if the tunnel is started without that policy. Requests on any other host
    (localhost, the Mac's LAN address the phone uses) pass untouched. The Host header is compared without
    its port and case; a request with several Host headers is guarded if any of them is the public host.
    Plain ASGI, like BodyLimit.
    """

    def __init__(self, app: ASGIApp, host: str) -> None:
        self.app = app
        self.host = host

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket") and not public_path(scope["path"]):
            hosts = (host_name(value.decode("latin-1")) for key, value in scope["headers"] if key == b"host")
            if self.host in hosts:
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                else:
                    await PlainTextResponse("Not found", status_code=404)(scope, receive, send)
                return
        await self.app(scope, receive, send)


class ClientAddressHeader:
    """Takes the client's address from `header` (CLIENT_IP_HEADER), set by a proxy that overwrites what the
    client sent: on Vercel the connection's peer is Vercel's, not the phone's, and per-address rate limits
    would otherwise count everyone together. Without the header the peer stays. Plain ASGI."""

    def __init__(self, app: ASGIApp, header: str) -> None:
        self.app = app
        self.header = header.lower().encode("latin-1")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket"):
            value = next((v for k, v in scope["headers"] if k == self.header), None)
            address = value.decode("latin-1").split(",")[0].strip() if value else ""
            if address:
                scope = {**scope, "client": (address, 0)}
        await self.app(scope, receive, send)


def create_app(url: str | None = None, settings: Settings | None = None, token_verifier: Any = None) -> FastAPI:
    """The app, with an engine (connection pool) to `url` (default: DATABASE_URL) for its lifetime.

    `settings` default to the environment's (get_settings). `token_verifier` replaces the one /mcp checks
    access tokens with (app/mcp/auth.py `KaloVerifier`): tests pass a stub.
    """
    url = url or database_url()
    settings = settings or get_settings()
    session_manager = None

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = make_engine(url, settings)
        limits_engine = make_limits_engine(url, settings) if settings.rate_limits == "db" else None
        try:
            # Blocks startup until Postgres answers, so a bad URL fails fast; and refuses a database that
            # is not migrated (SchemaOutOfDate), which would otherwise answer every request with a 500.
            # require_head takes a psycopg cursor, so this reaches the driver connection under the engine.
            # One connection and two small queries per process start (on Vercel, per cold start).
            with engine.connect() as conn, conn.connection.cursor() as cur:
                require_head(cur)
            app.state.engine = engine
            app.state.limits_engine = limits_engine
            app.state.sessionmaker = sessionmaker(engine, expire_on_commit=False)
            async with AsyncExitStack() as stack:
                if session_manager is not None:  # the MCP SDK's task group, for the request handlers
                    await stack.enter_async_context(session_manager.run())
                yield
        finally:
            engine.dispose()
            if limits_engine is not None:
                limits_engine.dispose()

    # On a deployment that serves the API publicly (Vercel) there is no /docs, /redoc or /openapi.json.
    hidden = {"docs_url": None, "redoc_url": None, "openapi_url": None} if settings.serve_api_publicly else {}
    app = FastAPI(title="Kalo", lifespan=lifespan, **hidden)
    app.state.settings = settings
    app.include_router(foods_router)
    app.include_router(devices_router)
    app.include_router(sync_router)
    app.include_router(food_logs_router)
    app.include_router(nutrition_router)
    app.include_router(goals_router)
    app.include_router(daily_activity_router)
    # The app asks for pairing codes before a tunnel is up, so these exist with or without PUBLIC_URL.
    app.include_router(connections_router)
    if settings.public_url is not None:
        from app.mcp import server as mcp_server  # the SDK is only imported when it is used
        from app.mcp.auth import KaloVerifier

        app.include_router(oauth_api.router)

        def sessions() -> Session:
            return app.state.sessionmaker()

        verifier = token_verifier or KaloVerifier(sessions, settings.resource)
        routes, session_manager = mcp_server.build(settings, sessions, verifier)
        app.router.routes.extend(routes)
    # The rate limits, in this process's memory or (RATE_LIMITS=db) in Postgres, shared by every instance
    # (app/services/limits.py). Each is named after its app.state attribute.
    def limit(name: str, count: int, per_seconds: float) -> None:
        setattr(app.state, name, make_limiter(app, name, count, per_seconds))

    # Registration needs no token, so one address may only register this often (POST /api/v1/devices).
    limit("registrations", REGISTRATIONS_PER_HOUR, per_seconds=3600)
    # Pairing codes the app asks for, per user; and pairing-code attempts on the sign-in page, per address
    # and from everyone. In memory, each app (each test's app) counts on its own; tests may replace them.
    limit("pairing_codes", CODES_PER_HOUR, per_seconds=3600)
    limit("pairing_attempts", *oauth_api.ATTEMPTS_PER_ADDRESS)
    limit("pairing_attempts_overall", *oauth_api.ATTEMPTS_OVERALL)
    # Barcode lookups per user: they share the server's one Open Food Facts allowance.
    limit("barcode_lookups", BARCODE_LOOKUPS_PER_HOUR, per_seconds=3600)
    limit("off_reads", OFF_READS_PER_MINUTE, per_seconds=60)
    # Food search and lookup need no token, so they are limited per address (generous: the app searches
    # as the user types, debounced).
    limit("food_searches", FOOD_SEARCHES_PER_HOUR, per_seconds=3600)
    # Refused by its declared size, before any of it is read. Added before the CORS middleware, which
    # therefore wraps it: the 413 is readable cross-origin.
    app.add_middleware(BodyLimit, max_bytes=MAX_BODY_BYTES)
    # Any origin may call the API (the web build and the Expo web dev server call it cross-origin).
    # What makes "*" safe is that credentials stay off: there are no cookies, and a user is known only
    # by the bearer token the app itself puts in the Authorization header, which another site's page
    # does not have. Authorization and a JSON Content-Type are not CORS-safelisted, so they are allowed
    # by name; any other method or header fails the preflight.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],  # a route that needs another method adds it here
        allow_headers=["Authorization", "Content-Type"],
    )
    # A page of 50 foods with their portions is 18 to 36 kB of JSON and gzips to about 3 kB (measured
    # on banana, rice, chicken breast): less for a phone to download. Small bodies are left alone.
    app.add_middleware(GZipMiddleware, minimum_size=1000)
    # Added after the others, so it wraps them: on the public host a hidden path is refused before CORS, the
    # body limit, gzip or routing do any work. Its 404 carries no CORS headers (unlike the 413 above), as
    # at ngrok: those paths are not served there to any origin, and a preflight to them fails too.
    # With SERVE_API_PUBLICLY (the Vercel deployment: the web app calls the API on its own origin) the
    # public host serves everything, like any other host.
    if settings.public_host is not None and not settings.serve_api_publicly:
        app.add_middleware(PublicHostGuard, host=settings.public_host)
    # Outermost of all, so the rate limits (and anything else reading request.client) see the real client.
    if settings.client_ip_header is not None:
        app.add_middleware(ClientAddressHeader, header=settings.client_ip_header)

    # A request waits pool_timeout seconds for a free connection, then gets a 503 rather than a 500.
    @app.exception_handler(PoolTimeout)
    def busy(request: Request, exc: PoolTimeout) -> JSONResponse:
        return JSONResponse({"detail": "database busy, try again"}, status_code=503, headers={"Retry-After": "1"})

    return app


app = create_app()
