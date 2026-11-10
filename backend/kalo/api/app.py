"""The FastAPI app. `uv run uvicorn kalo.api.app:app --reload`

Importing does not connect: the connection pool opens when the app starts and closes when it stops.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from psycopg_pool import ConnectionPool

from ..db import database_url
from .foods import router


def create_app(url: str | None = None) -> FastAPI:
    """The app, with a connection pool to `url` (default: DATABASE_URL) for its lifetime."""
    url = url or database_url()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        pool = ConnectionPool(url, min_size=1, max_size=10, open=False)
        pool.open(wait=True, timeout=10)
        app.state.pool = pool
        try:
            yield
        finally:
            pool.close()

    app = FastAPI(title="Kalo", lifespan=lifespan)
    app.include_router(router)
    return app


app = create_app()
