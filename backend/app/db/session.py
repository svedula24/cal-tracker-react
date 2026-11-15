"""The SQLAlchemy engine and the per-request session."""

from __future__ import annotations

from collections.abc import Iterator
from typing import TYPE_CHECKING, Any

from fastapi import Request
from sqlalchemy import URL, Engine, create_engine, make_url
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

if TYPE_CHECKING:
    from app.settings import Settings


def sqlalchemy_url(url: str) -> URL:
    """A libpq-style URL (kalo.db.database_url) on the psycopg 3 driver; the query string is kept."""
    return make_url(url).set(drivername="postgresql+psycopg")


def make_engine(url: str, settings: Settings | None = None) -> Engine:
    """At most `db_pool_size` connections (default 10); a request that waits 5 s for one gets
    sqlalchemy.exc.TimeoutError. With db_pool_size 0 there is no pool: each session opens its own
    connection and closes it when it ends (a serverless function against a server-side pooler such as
    Neon's -pooler endpoint). The DB_* settings (app/settings.py) tune the rest; their defaults are the
    plain local pool.
    """
    connect_args: dict[str, Any] = {}
    options: dict[str, Any] = {}
    if settings is not None:
        if settings.db_connect_timeout is not None:
            connect_args["connect_timeout"] = settings.db_connect_timeout
        if settings.db_pool_size == 0:
            return create_engine(sqlalchemy_url(url), poolclass=NullPool, connect_args=connect_args)
        options = {"pool_pre_ping": settings.db_pool_pre_ping, "pool_recycle": settings.db_pool_recycle}
    pool_size = settings.db_pool_size if settings is not None else 10
    return create_engine(
        sqlalchemy_url(url), pool_size=pool_size, max_overflow=0, pool_timeout=5, connect_args=connect_args, **options
    )


def make_limits_engine(url: str, settings: Settings) -> Engine:
    """The rate limiters' own engine (RATE_LIMITS=db, app/services/limits.py), apart from the requests' pool:
    a request may hold a request connection while its limiter runs, and with one shared pool N such requests
    could wait on each other until the pool timeout. Two kept connections, more on demand (each limiter call
    holds one for two short statements), the same connect timeout and pre-ping as the main engine.
    """
    connect_args = {"connect_timeout": settings.db_connect_timeout} if settings.db_connect_timeout else {}
    return create_engine(
        sqlalchemy_url(url),
        pool_size=2,
        max_overflow=8,
        pool_timeout=5,
        pool_pre_ping=settings.db_pool_pre_ping,
        pool_recycle=settings.db_pool_recycle,
        connect_args=connect_args,
    )


def get_session(request: Request) -> Iterator[Session]:
    """FastAPI dependency: one session per request, from the app's sessionmaker."""
    with request.app.state.sessionmaker() as session:
        yield session
