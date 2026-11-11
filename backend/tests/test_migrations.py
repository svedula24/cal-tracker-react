"""The Alembic migration against a scratch schema: what it creates, where, and that the models match it."""

import uuid

import psycopg
import pytest
from alembic import command
from alembic.script import ScriptDirectory
from conftest import URL
from sqlalchemy import inspect, text

from app.db.session import make_engine, sqlalchemy_url
from app.models.foods import Base, Food, FoodPortion
from kalo.db import alembic_config

pytestmark = pytest.mark.skipif(not URL, reason="DATABASE_URL not set")

HEAD = ScriptDirectory.from_config(alembic_config()).get_current_head()


def schema_of(url: str) -> str:
    """The scratch schema a `scratch_url` points at."""
    with psycopg.connect(url) as conn:
        return conn.execute("SELECT current_schema()").fetchone()[0]


def tables_in(url: str, schema: str) -> set[str]:
    with psycopg.connect(url) as conn:
        rows = conn.execute("SELECT tablename FROM pg_tables WHERE schemaname = %s", (schema,)).fetchall()
    return {r[0] for r in rows}


def test_scratch_url_search_path_survives_sqlalchemy_url(scratch_url):
    assert sqlalchemy_url(scratch_url).drivername == "postgresql+psycopg"
    engine = make_engine(scratch_url)
    try:
        with engine.connect() as conn:
            schema = conn.scalar(text("SELECT current_schema()"))
            search_path = conn.scalar(text("SHOW search_path"))
    finally:
        engine.dispose()
    assert schema.startswith("test_")
    assert search_path.replace(" ", "") == f"{schema},public"
    assert schema == schema_of(scratch_url)  # the same schema plain psycopg lands in


def test_upgrade_creates_tables_in_the_scratch_schema(migrated_url):
    schema = schema_of(migrated_url)
    assert tables_in(migrated_url, schema) == {"foods", "food_portions", "alembic_version"}
    with psycopg.connect(migrated_url) as conn:
        assert conn.execute(f"SELECT version_num FROM {schema}.alembic_version").fetchall() == [(HEAD,)]


def test_columns(migrated_url):
    with psycopg.connect(migrated_url) as conn:
        rows = conn.execute(
            "SELECT table_name, column_name, data_type, is_nullable, is_identity, identity_generation"
            " FROM information_schema.columns WHERE table_schema = current_schema()"
            " AND table_name IN ('foods', 'food_portions') ORDER BY table_name, ordinal_position"
        ).fetchall()
    assert rows == [
        ("food_portions", "id", "bigint", "NO", "YES", "ALWAYS"),
        ("food_portions", "fdc_id", "bigint", "NO", "NO", None),
        ("food_portions", "description", "text", "NO", "NO", None),
        ("food_portions", "gram_weight", "real", "NO", "NO", None),
        ("foods", "fdc_id", "bigint", "NO", "NO", None),
        ("foods", "description", "text", "NO", "NO", None),
        ("foods", "data_type", "text", "NO", "NO", None),
        ("foods", "brand_name", "text", "YES", "NO", None),
        ("foods", "calories_per_100g", "real", "NO", "NO", None),
        ("foods", "protein_per_100g", "real", "NO", "NO", None),
        ("foods", "carbs_per_100g", "real", "NO", "NO", None),
        ("foods", "fat_per_100g", "real", "NO", "NO", None),
        ("foods", "fiber_per_100g", "real", "YES", "NO", None),
        ("foods", "sugar_per_100g", "real", "YES", "NO", None),
        ("foods", "sodium_mg_per_100g", "real", "YES", "NO", None),
    ]


def test_constraints(migrated_url):
    with psycopg.connect(migrated_url) as conn:
        rows = conn.execute(
            "SELECT c.conrelid::regclass::text, c.contype::text, c.conname, pg_get_constraintdef(c.oid)"
            " FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace"
            " WHERE n.nspname = current_schema() AND c.contype IN ('p', 'f', 'c') ORDER BY 1, 2, 3"
        ).fetchall()
    by_kind = {}
    for table, kind, name, definition in rows:
        by_kind.setdefault((table, kind), {})[name] = definition
    assert by_kind["foods", "p"] == {"foods_pkey": "PRIMARY KEY (fdc_id)"}
    assert by_kind["food_portions", "p"] == {"food_portions_pkey": "PRIMARY KEY (id)"}
    assert by_kind["food_portions", "f"] == {
        "food_portions_fdc_id_fkey": "FOREIGN KEY (fdc_id) REFERENCES foods(fdc_id)"
    }
    assert by_kind["food_portions", "c"] == {
        "food_portions_gram_weight_check": "CHECK ((gram_weight > (0)::double precision))"
    }
    checks = by_kind["foods", "c"]
    assert set(checks) == {
        "foods_data_type_check",
        "foods_calories_per_100g_check",
        "foods_protein_per_100g_check",
        "foods_carbs_per_100g_check",
        "foods_fat_per_100g_check",
        "foods_fiber_per_100g_check",
        "foods_sugar_per_100g_check",
        "foods_sodium_mg_per_100g_check",
    }
    for value in ("Foundation", "SR Legacy", "Survey (FNDDS)"):
        assert f"'{value}'" in checks["foods_data_type_check"]
    for name, definition in checks.items():
        if name != "foods_data_type_check":
            column = name.removeprefix("foods_").removesuffix("_check")
            assert definition == f"CHECK (({column} >= (0)::double precision))"


def test_indexes(migrated_url):
    with psycopg.connect(migrated_url) as conn:
        rows = conn.execute(
            "SELECT c.relname, am.amname, c.reloptions, pg_get_indexdef(c.oid)"
            " FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_am am ON am.oid = c.relam"
            " WHERE n.nspname = current_schema() AND c.relkind = 'i' AND c.relname NOT LIKE 'alembic%'"
        ).fetchall()
    indexes = {name: (method, options, definition) for name, method, options, definition in rows}
    assert set(indexes) == {
        "foods_pkey",
        "food_portions_pkey",
        "food_portions_fdc_id_idx",
        "foods_description_fts",
        "foods_description_trgm",
    }
    for name in ("foods_description_fts", "foods_description_trgm"):
        method, options, _ = indexes[name]
        assert method == "gin"
        assert options == ["fastupdate=off"]
    # The expressions the search SQL must repeat for the planner to use the indexes.
    assert "to_tsvector('english'::regconfig, description)" in indexes["foods_description_fts"][2]
    assert "lower(description) gin_trgm_ops" in indexes["foods_description_trgm"][2]
    method, _, definition = indexes["food_portions_fdc_id_idx"]
    assert method == "btree"
    assert definition.endswith("(fdc_id)")


def test_downgrade_drops_both_tables(migrated_url):
    schema = schema_of(migrated_url)
    command.downgrade(alembic_config(migrated_url), "base")
    assert tables_in(migrated_url, schema) == {"alembic_version"}
    with psycopg.connect(migrated_url) as conn:
        assert conn.execute(f"SELECT count(*) FROM {schema}.alembic_version").fetchone()[0] == 0
        assert conn.execute("SELECT count(*) FROM pg_extension WHERE extname = 'pg_trgm'").fetchone()[0] == 1
    command.upgrade(alembic_config(migrated_url), "head")  # and it can be applied again
    assert tables_in(migrated_url, schema) == {"foods", "food_portions", "alembic_version"}


def test_each_scratch_schema_gets_its_own_version_table(migrated_url):
    """A second schema must be migrated even though an alembic_version at head is visible on its search_path."""
    first = schema_of(migrated_url)
    second = f"test_{uuid.uuid4().hex[:8]}"
    sep = "&" if "?" in URL else "?"
    # `first` plays the part of a migrated public: later on the path, with alembic_version at head.
    url = f"{URL}{sep}options=-c%20search_path%3D{second},{first},public"
    with psycopg.connect(URL, autocommit=True) as conn:
        conn.execute(f"CREATE SCHEMA {second}")
    try:
        with psycopg.connect(url) as conn:  # the trap is set: unqualified, the first schema's table is found
            assert conn.execute("SELECT to_regclass('alembic_version')::text").fetchone()[0] == "alembic_version"
            assert conn.execute("SELECT version_num FROM alembic_version").fetchall() == [(HEAD,)]
        command.upgrade(alembic_config(url), "head")
        assert tables_in(url, second) == {"foods", "food_portions", "alembic_version"}
        with psycopg.connect(url) as conn:
            assert conn.execute(f"SELECT version_num FROM {second}.alembic_version").fetchall() == [(HEAD,)]
        # Downgrading the second leaves the first alone.
        command.downgrade(alembic_config(url), "base")
        assert tables_in(url, second) == {"alembic_version"}
        assert tables_in(url, first) == {"foods", "food_portions", "alembic_version"}
        with psycopg.connect(url) as conn:
            assert conn.execute(f"SELECT version_num FROM {first}.alembic_version").fetchall() == [(HEAD,)]
    finally:
        with psycopg.connect(URL, autocommit=True) as conn:
            conn.execute(f"DROP SCHEMA {second} CASCADE")


@pytest.mark.parametrize("model", [Food, FoodPortion])
def test_models_match_the_migrated_tables(migrated_url, model):
    schema = schema_of(migrated_url)
    engine = make_engine(migrated_url)
    try:
        inspector = inspect(engine)
        reflected = inspector.get_columns(model.__tablename__, schema=schema)
        primary_key = inspector.get_pk_constraint(model.__tablename__, schema=schema)["constrained_columns"]
        foreign_keys = inspector.get_foreign_keys(model.__tablename__, schema=schema)
    finally:
        engine.dispose()
    table = model.__table__
    # Same names in the same order, same nullability, same types.
    assert [c.name for c in table.columns] == [c["name"] for c in reflected]
    assert {c.name: c.nullable for c in table.columns} == {c["name"]: c["nullable"] for c in reflected}
    dialect = engine.dialect
    assert {c.name: c.type.compile(dialect) for c in table.columns} == {
        c["name"]: c["type"].compile(dialect) for c in reflected
    }
    assert [c.name for c in table.primary_key.columns] == primary_key
    assert {(c.name, fk.target_fullname) for c in table.columns for fk in c.foreign_keys} == {
        (fk["constrained_columns"][0], f"{fk['referred_table']}.{fk['referred_columns'][0]}") for fk in foreign_keys
    }


def test_models_cover_every_migrated_table(migrated_url):
    assert set(Base.metadata.tables) | {"alembic_version"} == tables_in(migrated_url, schema_of(migrated_url))
