"""Alembic environment: where the database is and which schema the version table lives in."""

from alembic import context
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.db.session import sqlalchemy_url
from kalo.db import database_url

config = context.config


def run_migrations() -> None:
    url = config.attributes.get("url") or database_url()
    engine = create_engine(sqlalchemy_url(url), poolclass=NullPool)
    with engine.connect() as connection:
        # The first schema on the search_path, where unqualified CREATE TABLE lands. Pinning the
        # version table to it stops Alembic from finding an alembic_version further along the path
        # (a test's scratch schema would otherwise read public's and skip its own migrations).
        schema = connection.scalar(text("SELECT current_schema()"))
        connection.commit()  # so Alembic opens (and commits) its own transaction
        context.configure(connection=connection, version_table_schema=schema)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    raise SystemExit("offline mode (--sql) is not supported: the migrations need a connection")
run_migrations()
