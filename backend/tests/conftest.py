"""Shared fixtures. DB tests need Postgres: set DATABASE_URL (see README) and mark the module with
`pytestmark = pytest.mark.skipif(not URL, ...)` so they skip cleanly without it."""

import os
import uuid

import psycopg
import pytest
from alembic import command

from kalo.db import alembic_config

URL = os.environ.get("DATABASE_URL")


@pytest.fixture
def scratch_url():
    """A connection URL whose search_path is a fresh schema (then public, for pg_trgm), dropped afterwards."""
    if not URL:
        pytest.skip("DATABASE_URL not set")
    name = f"test_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(URL, autocommit=True) as conn:
        # In public, so the migration's CREATE EXTENSION IF NOT EXISTS is a no-op and gin_trgm_ops resolves.
        conn.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        conn.execute(f"CREATE SCHEMA {name}")
    sep = "&" if "?" in URL else "?"
    yield f"{URL}{sep}options=-c%20search_path%3D{name},public"
    with psycopg.connect(URL, autocommit=True) as conn:
        conn.execute(f"DROP SCHEMA {name} CASCADE")


@pytest.fixture
def migrated_url(scratch_url):
    """`scratch_url` with the schema migrated to head (the tables and alembic_version are in the scratch schema)."""
    command.upgrade(alembic_config(scratch_url), "head")
    return scratch_url
