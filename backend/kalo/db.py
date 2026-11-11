"""Where the database is: DATABASE_URL, else the docker-compose database. And how to migrate it."""

import os
from pathlib import Path

from alembic.config import Config

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
