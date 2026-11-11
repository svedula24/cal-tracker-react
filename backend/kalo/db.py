"""Where the database is (DATABASE_URL, else the docker-compose database), how to migrate it,
and the check that it has been migrated, shared by the loader and the API."""

import os
from pathlib import Path

import psycopg
from alembic.config import Config
from alembic.script import ScriptDirectory
from psycopg import sql

DEFAULT_URL = "postgresql://kalo:kalo@localhost:5432/kalo"
ALEMBIC_INI = Path(__file__).resolve().parent.parent / "alembic.ini"


def database_url() -> str:
    return os.environ.get("DATABASE_URL", DEFAULT_URL)


def alembic_config(url: str | None = None) -> Config:
    """The Alembic config for backend/alembic.ini. With `url`, migrations/env.py uses it instead of database_url()."""
    cfg = Config(str(ALEMBIC_INI))
    if url is not None:
        cfg.attributes["url"] = url
    return cfg


class SchemaOutOfDate(RuntimeError):
    """The database is not at the head of the Alembic migrations."""


def require_head(cur: psycopg.Cursor) -> None:
    """Raise SchemaOutOfDate unless the connection's schema is migrated to the current head.

    The version table is looked up in current_schema() (the first schema of the search_path), where
    migrations/env.py keeps it; a version table further down the path belongs to another schema's tables.
    """
    head = ScriptDirectory.from_config(alembic_config()).get_current_head()
    cur.execute("SELECT current_schema(), to_regclass(format('%I.alembic_version', current_schema())) IS NOT NULL")
    schema, migrated = cur.fetchone()
    versions: set[str] = set()
    if migrated:
        cur.execute(sql.SQL("SELECT version_num FROM {}").format(sql.Identifier(schema, "alembic_version")))
        versions = {version for (version,) in cur.fetchall()}
    if versions != {head}:
        found = ", ".join(sorted(versions)) or "not migrated"
        raise SchemaOutOfDate(
            f"schema {schema!r} is at {found}, the migrations are at {head}; run `uv run alembic upgrade head`"
        )
