"""The SQLAlchemy engine and the per-request session."""

from collections.abc import Iterator

from fastapi import Request
from sqlalchemy import URL, Engine, create_engine, make_url
from sqlalchemy.orm import Session


def sqlalchemy_url(url: str) -> URL:
    """A libpq-style URL (kalo.db.database_url) on the psycopg 3 driver; the query string is kept."""
    return make_url(url).set(drivername="postgresql+psycopg")


def make_engine(url: str) -> Engine:
    """At most 10 connections; a request that waits 5 s for one gets sqlalchemy.exc.TimeoutError."""
    return create_engine(sqlalchemy_url(url), pool_size=10, max_overflow=0, pool_timeout=5)


def get_session(request: Request) -> Iterator[Session]:
    """FastAPI dependency: one session per request, from the app's sessionmaker."""
    with request.app.state.sessionmaker() as session:
        yield session
