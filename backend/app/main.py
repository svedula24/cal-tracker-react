"""The FastAPI app. `uv run uvicorn app.main:app --reload`

Importing does not connect: the engine is built when the app starts and disposed when it stops.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import TimeoutError as PoolTimeout
from sqlalchemy.orm import sessionmaker

from app.api.limits import SlidingWindow
from app.api.v1.devices import router as devices_router
from app.api.v1.food_logs import router as food_logs_router
from app.api.v1.foods import router as foods_router
from app.api.v1.nutrition import router as nutrition_router
from app.api.v1.sync import router as sync_router
from app.db.session import make_engine
from kalo.db import database_url, require_head

# A household or office shares one address; an app registers once per install.
REGISTRATIONS_PER_HOUR = 20


def create_app(url: str | None = None) -> FastAPI:
    """The app, with an engine (connection pool) to `url` (default: DATABASE_URL) for its lifetime."""
    url = url or database_url()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = make_engine(url)
        try:
            # Blocks startup until Postgres answers, so a bad URL fails fast; and refuses a database that
            # is not migrated (SchemaOutOfDate), which would otherwise answer every request with a 500.
            # require_head takes a psycopg cursor, so this reaches the driver connection under the engine.
            with engine.connect() as conn, conn.connection.cursor() as cur:
                require_head(cur)
            app.state.engine = engine
            app.state.sessionmaker = sessionmaker(engine, expire_on_commit=False)
            yield
        finally:
            engine.dispose()

    app = FastAPI(title="Kalo", lifespan=lifespan)
    app.include_router(foods_router)
    app.include_router(devices_router)
    app.include_router(sync_router)
    app.include_router(food_logs_router)
    app.include_router(nutrition_router)
    # Registration needs no token, so one address may only register this often (POST /api/v1/devices).
    app.state.registrations = SlidingWindow(REGISTRATIONS_PER_HOUR, per_seconds=3600)
    # Any origin may call the API (the web build and the Expo web dev server call it cross-origin).
    # What makes "*" safe is that credentials stay off: there are no cookies, and a user is known only
    # by the bearer token the app itself puts in the Authorization header, which another site's page
    # does not have. Authorization and a JSON Content-Type are not CORS-safelisted, so they are allowed
    # by name; any other method or header fails the preflight.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET", "POST", "PATCH", "DELETE"],  # a route that needs another method adds it here
        allow_headers=["Authorization", "Content-Type"],
    )
    # A page of 50 foods with their portions is 18 to 36 kB of JSON and gzips to about 3 kB (measured
    # on banana, rice, chicken breast): less for a phone to download. Small bodies are left alone.
    app.add_middleware(GZipMiddleware, minimum_size=1000)

    # A request waits pool_timeout seconds for a free connection, then gets a 503 rather than a 500.
    @app.exception_handler(PoolTimeout)
    def busy(request: Request, exc: PoolTimeout) -> JSONResponse:
        return JSONResponse({"detail": "database busy, try again"}, status_code=503, headers={"Retry-After": "1"})

    return app


app = create_app()
