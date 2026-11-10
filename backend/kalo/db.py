"""Where the database is: DATABASE_URL, else the docker-compose database."""

import os

DEFAULT_URL = "postgresql://kalo:kalo@localhost:5432/kalo"


def database_url() -> str:
    return os.environ.get("DATABASE_URL", DEFAULT_URL)
