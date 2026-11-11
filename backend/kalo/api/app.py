"""The FastAPI app. `uv run uvicorn kalo.api.app:app --reload`

Importing does not connect: the connection pool opens when the app starts and closes when it stops.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from psycopg_pool import ConnectionPool, PoolTimeout

from ..db import database_url
from .foods import router

# A request waits this long for a free connection, then gets a 503 (rather than a 500 after psycopg's 30 s).
CONNECTION_WAIT_S = 5.0


def create_app(url: str | None = None) -> FastAPI:
    """The app, with a connection pool to `url` (default: DATABASE_URL) for its lifetime."""
    url = url or database_url()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        pool = ConnectionPool(url, min_size=1, max_size=10, timeout=CONNECTION_WAIT_S, open=False)
        pool.open(wait=True, timeout=10)  # blocks startup until Postgres answers, so a bad URL fails fast
        app.state.pool = pool
        try:
            yield
        finally:
            pool.close()

    app = FastAPI(title="Kalo", lifespan=lifespan)
    app.include_router(router)

    @app.exception_handler(PoolTimeout)
    def busy(request: Request, exc: PoolTimeout) -> JSONResponse:
        return JSONResponse({"detail": "database busy, try again"}, status_code=503, headers={"Retry-After": "1"})

    return app


app = create_app()
