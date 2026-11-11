"""The FastAPI app. `uv run uvicorn app.main:app --reload`

Importing does not connect: the engine is built when the app starts and disposed when it stops.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import TimeoutError as PoolTimeout
from sqlalchemy.orm import sessionmaker

from app.api.v1.foods import router as foods_router
from app.db.session import make_engine
from kalo.db import database_url, require_head


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

    # A request waits pool_timeout seconds for a free connection, then gets a 503 rather than a 500.
    @app.exception_handler(PoolTimeout)
    def busy(request: Request, exc: PoolTimeout) -> JSONResponse:
        return JSONResponse({"detail": "database busy, try again"}, status_code=503, headers={"Retry-After": "1"})

    return app


app = create_app()
