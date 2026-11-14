"""The Alembic migration against a scratch schema: what it creates, where, and that the models match it."""

import uuid
from datetime import UTC, date, datetime

import psycopg
import pytest
from alembic import command
from alembic.script import ScriptDirectory
from conftest import URL
from psycopg import errors
from sqlalchemy import DefaultClause, inspect, text
from sqlalchemy.orm import Session

from app.db.session import make_engine, sqlalchemy_url
from app.models.foods import Base, Food, FoodPortion
from app.models.user_data import DailyActivity, FoodLog, SavedFood, User, UserGoal, UserToken
from kalo.db import alembic_config

pytestmark = pytest.mark.skipif(not URL, reason="DATABASE_URL not set")

HEAD = ScriptDirectory.from_config(alembic_config()).get_current_head()

FOODS_TABLES = {"foods", "food_portions", "alembic_version"}  # what revision 0001 creates
SYNCED_TABLES = ("food_logs", "user_goals", "daily_activity", "saved_foods")
TABLES = FOODS_TABLES | {"users", "user_tokens", *SYNCED_TABLES}
NOW = datetime(2026, 11, 10, 12, 0, tzinfo=UTC)
FOOD_LOGS_INDEXES = {
    "food_logs_pkey": "UNIQUE btree (id)",
    "food_logs_user_date_idx": "btree (user_id, log_date) WHERE (deleted_at IS NULL)",
    "food_logs_user_recent_idx": (
        "btree (user_id, fdc_id, logged_at DESC) WHERE ((deleted_at IS NULL) AND (fdc_id IS NOT NULL))"
    ),
    "food_logs_user_rev_idx": "btree (user_id, rev)",
}
NUTRIENTS = ("calories", "protein_g", "carbs_g", "fat_g", "fiber_g", "sugar_g", "sodium_mg")
FOOD_VALUES = (
    "food_calories_per_100g",
    "food_protein_per_100g",
    "food_carbs_per_100g",
    "food_fat_per_100g",
    "food_fiber_per_100g",
    "food_sugar_per_100g",
    "food_sodium_mg_per_100g",
)


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
    assert tables_in(migrated_url, schema) == TABLES
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
        ("foods", "retired_at", "timestamp with time zone", "YES", "NO", None),
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
    assert {name for name in indexes if name.startswith("food")} - set(FOOD_LOGS_INDEXES) == {
        "foods_pkey",
        "food_portions_pkey",
        "food_portions_fdc_id_idx",
        "foods_description_fts",
        "foods_description_trgm",
    }  # so foods.retired_at is not indexed; the other tables' indexes are in test_user_data_indexes
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


def test_downgrade_drops_every_table(migrated_url):
    schema = schema_of(migrated_url)
    command.downgrade(alembic_config(migrated_url), "base")
    assert tables_in(migrated_url, schema) == {"alembic_version"}
    with psycopg.connect(migrated_url) as conn:
        assert conn.execute(f"SELECT count(*) FROM {schema}.alembic_version").fetchone()[0] == 0
        assert conn.execute("SELECT count(*) FROM pg_extension WHERE extname = 'pg_trgm'").fetchone()[0] == 1
    command.upgrade(alembic_config(migrated_url), "head")  # and it can be applied again
    assert tables_in(migrated_url, schema) == TABLES


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
        assert tables_in(url, second) == TABLES
        with psycopg.connect(url) as conn:
            assert conn.execute(f"SELECT version_num FROM {second}.alembic_version").fetchall() == [(HEAD,)]
        # Downgrading the second leaves the first alone.
        command.downgrade(alembic_config(url), "base")
        assert tables_in(url, second) == {"alembic_version"}
        assert tables_in(url, first) == TABLES
        with psycopg.connect(url) as conn:
            assert conn.execute(f"SELECT version_num FROM {first}.alembic_version").fetchall() == [(HEAD,)]
    finally:
        with psycopg.connect(URL, autocommit=True) as conn:
            conn.execute(f"DROP SCHEMA {second} CASCADE")


@pytest.mark.parametrize("model", [Food, FoodPortion, User, UserToken, FoodLog, UserGoal, DailyActivity, SavedFood])
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
    assert {(c.name, fk.ondelete) for c in table.columns for fk in c.foreign_keys} == {
        (fk["constrained_columns"][0], fk["options"].get("ondelete")) for fk in foreign_keys
    }
    # The same columns are generated, and the same columns have a default. (`rev` has neither: a
    # trigger sets it, which the model says with a bare FetchedValue.)
    assert {c.name for c in table.columns if c.computed} == {c["name"] for c in reflected if c.get("computed")}
    assert {c.name for c in table.columns if isinstance(c.server_default, DefaultClause)} == {
        c["name"] for c in reflected if c["default"] is not None
    }


def test_models_cover_every_migrated_table(migrated_url):
    assert set(Base.metadata.tables) | {"alembic_version"} == tables_in(migrated_url, schema_of(migrated_url))


# ---- Revision 0002: users, tokens and the synced tables ----


@pytest.fixture
def conn(migrated_url):
    """Autocommit, so a statement a constraint rejects does not poison the ones after it."""
    with psycopg.connect(migrated_url, autocommit=True) as connection:
        yield connection


def insert(conn, table: str, returning: str = "*", **values):
    """Insert one row and return the `returning` columns as a tuple."""
    columns = ", ".join(values)
    marks = ", ".join(["%s"] * len(values))
    sql = f"INSERT INTO {table} ({columns}) VALUES ({marks}) RETURNING {returning}"
    return conn.execute(sql, list(values.values())).fetchone()


def add_user(conn, **values) -> uuid.UUID:
    return conn.execute(
        f"INSERT INTO users ({', '.join(values)}) VALUES ({', '.join(['%s'] * len(values))}) RETURNING id"
        if values
        else "INSERT INTO users DEFAULT VALUES RETURNING id",
        list(values.values()),
    ).fetchone()[0]


def add_food(conn, fdc_id: int = 1) -> int:
    conn.execute(
        "INSERT INTO foods (fdc_id, description, data_type, calories_per_100g, protein_per_100g,"
        " carbs_per_100g, fat_per_100g) VALUES (%s, 'Bananas, raw', 'Foundation', 89, 1.1, 22.8, 0.3)",
        (fdc_id,),
    )
    return fdc_id


def custom_log(user_id, **overrides) -> dict:
    """A hand-entered food_logs row: two servings, no USDA food."""
    return {
        "user_id": user_id,
        "log_date": date(2026, 11, 10),
        "logged_at": NOW,
        "name": "Dal",
        "unit": "serving",
        "quantity": 2,
        "unit_calories": 250,
        "unit_protein_g": 12,
        "unit_carbs_g": 30,
        "unit_fat_g": 8,
        "updated_at": NOW,
    } | overrides


def usda_log(user_id, fdc_id, **overrides) -> dict:
    """A food_logs row of a USDA food: 150 g, the user's values beside the food's own."""
    values = {
        "fdc_id": fdc_id,
        "name": "Banana",
        "food_name": "Bananas, raw",
        "unit": "g",
        "quantity": 150,
        "unit_calories": 90,
        "unit_protein_g": 1,
        "unit_carbs_g": 23,
        "unit_fat_g": 0.5,
        "food_calories_per_100g": 89,
        "food_protein_per_100g": 1.1,
        "food_carbs_per_100g": 22.8,
        "food_fat_per_100g": 0.3,
    }
    return custom_log(user_id, **values) | overrides


def goals(user_id, **overrides) -> dict:
    return {
        "user_id": user_id,
        "effective_date": date(2026, 11, 1),
        "calories": 2000,
        "protein_g": 120,
        "carbs_g": 220,
        "fat_g": 70,
        "fiber_g": 30,
        "sugar_g": 50,
        "sodium_mg": 2300,
        "steps": 8000,
        "goal": "maintain",
        "updated_at": NOW,
    } | overrides


def rejected_by(conn, table: str, values: dict) -> str:
    """The name of the CHECK constraint that rejects the row."""
    with pytest.raises(errors.CheckViolation) as raised:
        insert(conn, table, **values)
    return raised.value.diag.constraint_name


def test_user_data_columns(migrated_url):
    with psycopg.connect(migrated_url) as conn:
        rows = conn.execute(
            "SELECT table_name, column_name, data_type, is_nullable, column_default, is_generated"
            " FROM information_schema.columns WHERE table_schema = current_schema()"
            " AND table_name NOT IN ('foods', 'food_portions', 'alembic_version')"
            " ORDER BY table_name, ordinal_position"
        ).fetchall()
    by_table = {}
    for table, column, data_type, nullable, default, generated in rows:
        spec = data_type if nullable == "NO" else f"{data_type} NULL"
        spec += f" DEFAULT {default}" if default else ""
        spec += " GENERATED" if generated == "ALWAYS" else ""
        by_table.setdefault(table, {})[column] = spec
    synced = {
        "updated_at": "timestamp with time zone",
        "deleted_at": "timestamp with time zone NULL",
        "rev": "bigint",
    }
    assert set(by_table) == TABLES - FOODS_TABLES
    assert by_table["users"] == {
        "id": "uuid DEFAULT gen_random_uuid()",
        "email": "text NULL",
        "auth_provider": "text NULL",
        "auth_subject": "text NULL",
        "timezone": "text DEFAULT 'UTC'::text",
        "created_at": "timestamp with time zone DEFAULT now()",
    }
    assert by_table["user_tokens"] == {
        "id": "uuid DEFAULT gen_random_uuid()",
        "user_id": "uuid",
        "token_hash": "bytea",
        "label": "text NULL",
        "created_at": "timestamp with time zone DEFAULT now()",
        "last_used_at": "timestamp with time zone NULL",
        "revoked_at": "timestamp with time zone NULL",
    }
    required = ("calories", "protein_g", "carbs_g", "fat_g")
    assert by_table["food_logs"] == {
        "id": "uuid DEFAULT gen_random_uuid()",
        "user_id": "uuid",
        "fdc_id": "bigint NULL",
        "log_date": "date",
        "logged_at": "timestamp with time zone",
        "name": "text",
        "food_name": "text NULL",
        "unit": "text",
        "quantity": "double precision",
        **{f"unit_{n}": "double precision" if n in required else "double precision NULL" for n in NUTRIENTS},
        **{column: "double precision NULL" for column in FOOD_VALUES},
        **{n: "double precision NULL GENERATED" for n in NUTRIENTS},
        "created_at": "timestamp with time zone DEFAULT now()",
        **synced,
    }
    assert by_table["user_goals"] == {
        "user_id": "uuid",
        "effective_date": "date",
        **{n: "double precision" for n in NUTRIENTS},
        "steps": "integer",
        "goal": "text",
        **synced,
        "source": "text DEFAULT 'manual'::text",
        "workout_kcal": "double precision DEFAULT 0",
        "active_rest_kcal": "double precision DEFAULT 0",
    }
    assert by_table["daily_activity"] == {
        "user_id": "uuid",
        "activity_date": "date",
        "steps": "integer",
        **synced,
        "day_type": "text NULL",
        "workout_kcal": "double precision NULL",
    }
    assert by_table["saved_foods"] == {
        "user_id": "uuid",
        "fdc_id": "bigint",
        "saved_at": "timestamp with time zone",
        **synced,
    }
    # Column order is part of the contract too (the model test compares it table by table).
    assert list(by_table["food_logs"])[-11:-4] == list(NUTRIENTS)


def test_user_data_constraints(migrated_url):
    with psycopg.connect(migrated_url) as conn:
        rows = conn.execute(
            "SELECT c.conrelid::regclass::text, c.contype::text, c.conname, pg_get_constraintdef(c.oid)"
            " FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace"
            " WHERE n.nspname = current_schema() AND c.contype IN ('p', 'f', 'c', 'u') ORDER BY 1, 2, 3"
        ).fetchall()
    by_table = {}
    for table, kind, name, definition in rows:
        if kind != "c" or not definition.endswith(" >= (0)::double precision))"):
            by_table.setdefault(table, {})[name] = " ".join(definition.split())
    user_fk = "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE"
    # Not ON DELETE CASCADE: a food that is logged or saved cannot be deleted, only retired.
    food_fk = "FOREIGN KEY (fdc_id) REFERENCES foods(fdc_id)"
    assert by_table["users"] == {
        "users_pkey": "PRIMARY KEY (id)",
        "users_auth_provider_auth_subject_key": "UNIQUE (auth_provider, auth_subject)",
        "users_check": "CHECK (((auth_provider IS NULL) = (auth_subject IS NULL)))",
    }
    assert by_table["user_tokens"] == {
        "user_tokens_pkey": "PRIMARY KEY (id)",
        "user_tokens_user_id_fkey": user_fk,
        "user_tokens_token_hash_key": "UNIQUE (token_hash)",
        "user_tokens_token_hash_check": "CHECK ((octet_length(token_hash) = 32))",
    }
    assert by_table["food_logs"] == {
        "food_logs_pkey": "PRIMARY KEY (id)",
        "food_logs_user_id_fkey": user_fk,
        "food_logs_fdc_id_fkey": food_fk,
        "food_logs_name_check": "CHECK ((name <> ''::text))",
        "food_logs_unit_check": "CHECK ((unit = ANY (ARRAY['g'::text, 'serving'::text])))",
        "food_logs_quantity_check": "CHECK ((quantity > (0)::double precision))",
        "food_logs_check": "CHECK (((fdc_id IS NULL) OR (unit = 'g'::text)))",
        "food_logs_check1": (
            "CHECK ((num_nulls(food_name, food_calories_per_100g, food_protein_per_100g, food_carbs_per_100g,"
            " food_fat_per_100g) = CASE WHEN (fdc_id IS NULL) THEN 5 ELSE 0 END))"
        ),
        "food_logs_check2": (
            "CHECK (((fdc_id IS NOT NULL)"
            " OR (num_nulls(food_fiber_per_100g, food_sugar_per_100g, food_sodium_mg_per_100g) = 3)))"
        ),
    }
    assert by_table["user_goals"] == {
        "user_goals_pkey": "PRIMARY KEY (user_id, effective_date)",
        "user_goals_user_id_fkey": user_fk,
        "user_goals_steps_check": "CHECK ((steps >= 0))",
        "user_goals_goal_check": "CHECK ((goal = ANY (ARRAY['lose'::text, 'maintain'::text, 'gain'::text])))",
        "user_goals_source_check": "CHECK ((source = ANY (ARRAY['computed'::text, 'manual'::text])))",
    }
    assert by_table["daily_activity"] == {
        "daily_activity_pkey": "PRIMARY KEY (user_id, activity_date)",
        "daily_activity_user_id_fkey": user_fk,
        "daily_activity_steps_check": "CHECK ((steps >= 0))",
        "daily_activity_day_type_check": (
            "CHECK ((day_type = ANY (ARRAY['workout'::text, 'active_rest'::text, 'rest'::text])))"
        ),
    }
    assert by_table["saved_foods"] == {
        "saved_foods_pkey": "PRIMARY KEY (user_id, fdc_id)",
        "saved_foods_user_id_fkey": user_fk,
        "saved_foods_fdc_id_fkey": food_fk,
    }
    # And one "never negative" CHECK per numeric column, named <table>_<column>_check.
    never_negative = {name for _, kind, name, d in rows if kind == "c" and d.endswith(" >= (0)::double precision))")}
    assert never_negative - {name for name in never_negative if name.startswith("foods_")} == (
        {f"food_logs_unit_{n}_check" for n in NUTRIENTS}
        | {f"food_logs_{column}_check" for column in FOOD_VALUES}
        | {f"user_goals_{n}_check" for n in (*NUTRIENTS, "workout_kcal", "active_rest_kcal")}
        | {"daily_activity_workout_kcal_check"}
    )


def test_user_data_indexes(migrated_url):
    schema = schema_of(migrated_url)
    with psycopg.connect(migrated_url) as conn:
        rows = conn.execute(
            "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()"
            " AND tablename NOT IN ('foods', 'food_portions', 'alembic_version')"
        ).fetchall()
    indexes = {}
    for name, definition in rows:
        head, _, rest = definition.partition(f" ON {schema}.")
        indexes[name] = ("UNIQUE " if head.startswith("CREATE UNIQUE") else "") + rest.partition(" USING ")[2]
    assert indexes == {
        "users_pkey": "UNIQUE btree (id)",
        "users_auth_provider_auth_subject_key": "UNIQUE btree (auth_provider, auth_subject)",
        "users_email_key": "UNIQUE btree (lower(email))",
        "user_tokens_pkey": "UNIQUE btree (id)",
        "user_tokens_token_hash_key": "UNIQUE btree (token_hash)",
        "user_tokens_user_id_idx": "btree (user_id)",
        **FOOD_LOGS_INDEXES,
        "user_goals_pkey": "UNIQUE btree (user_id, effective_date)",
        "user_goals_user_rev_idx": "btree (user_id, rev)",
        "daily_activity_pkey": "UNIQUE btree (user_id, activity_date)",
        "daily_activity_user_rev_idx": "btree (user_id, rev)",
        "saved_foods_pkey": "UNIQUE btree (user_id, fdc_id)",
        "saved_foods_user_rev_idx": "btree (user_id, rev)",
    }


def test_every_synced_table_has_the_rev_trigger(conn):
    rows = conn.execute(
        "SELECT t.tgrelid::regclass::text, t.tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t"
        " JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace"
        " WHERE n.nspname = current_schema() AND NOT t.tgisinternal"
    ).fetchall()
    assert {(table, name) for table, name, _ in rows} == {(table, f"{table}_rev") for table in SYNCED_TABLES}
    for _, _, definition in rows:
        assert "BEFORE INSERT OR UPDATE" in definition
        assert definition.endswith("FOR EACH ROW EXECUTE FUNCTION set_sync_rev()")
    assert conn.execute(
        "SELECT data_type FROM information_schema.sequences WHERE sequence_name = 'sync_rev_seq'"
        " AND sequence_schema = current_schema()"
    ).fetchall() == [("bigint",)]


def test_rev_comes_from_one_sequence_on_every_insert_and_update(conn):
    user_id = add_user(conn)
    fdc_id = add_food(conn)
    revs = [
        insert(conn, "food_logs", "rev", **custom_log(user_id))[0],
        insert(conn, "user_goals", "rev", **goals(user_id))[0],
        insert(
            conn, "daily_activity", "rev", user_id=user_id, activity_date=date(2026, 11, 10), steps=4000, updated_at=NOW
        )[0],
        insert(conn, "saved_foods", "rev", user_id=user_id, fdc_id=fdc_id, saved_at=NOW, updated_at=NOW)[0],
    ]
    # An update takes a new number, as does a soft delete; and a rev the client sends is ignored.
    revs.append(conn.execute("UPDATE food_logs SET quantity = 3 RETURNING rev").fetchone()[0])
    revs.append(conn.execute("UPDATE user_goals SET calories = 1800 RETURNING rev").fetchone()[0])
    revs.append(conn.execute("UPDATE daily_activity SET steps = 9000, rev = 1 RETURNING rev").fetchone()[0])
    revs.append(conn.execute("UPDATE saved_foods SET deleted_at = now() RETURNING rev").fetchone()[0])
    revs.append(insert(conn, "food_logs", "rev", **custom_log(user_id, rev=1))[0])
    assert revs == list(range(revs[0], revs[0] + 9))
    assert conn.execute("SELECT last_value FROM sync_rev_seq").fetchone()[0] == revs[-1]


def test_totals_are_generated(conn):
    user_id = add_user(conn)
    fdc_id = add_food(conn)
    totals = ", ".join(NUTRIENTS)
    # Per serving: 2 servings of 250 kcal. Fiber, sugar and sodium were not entered and stay NULL.
    assert insert(conn, "food_logs", totals, **custom_log(user_id)) == (500, 24, 60, 16, None, None, None)
    # Per 100 g: 150 g of a food with 90 kcal per 100 g.
    row = insert(conn, "food_logs", totals, **usda_log(user_id, fdc_id, unit_fiber_g=2, unit_sodium_mg=0))
    assert row == (135, 1.5, 34.5, 0.75, 3, None, 0)
    # A custom entry weighed in grams is per 100 g too.
    assert insert(conn, "food_logs", "calories", **custom_log(user_id, unit="g", quantity=50)) == (125,)
    # They follow an edit, and cannot be written.
    assert conn.execute(
        "UPDATE food_logs SET quantity = 200, unit_sugar_g = 12 WHERE fdc_id IS NOT NULL RETURNING calories, sugar_g"
    ).fetchone() == (180, 24)
    with pytest.raises(errors.GeneratedAlways):
        insert(conn, "food_logs", **custom_log(user_id, calories=1))


@pytest.mark.parametrize(
    ("overrides", "constraint"),
    [
        ({"quantity": 0}, "food_logs_quantity_check"),
        ({"quantity": -1}, "food_logs_quantity_check"),
        ({"name": ""}, "food_logs_name_check"),
        ({"unit": "cup"}, "food_logs_unit_check"),
        *[({f"unit_{n}": -0.1}, f"food_logs_unit_{n}_check") for n in NUTRIENTS],
        # A custom entry has no USDA food, so none of the food's name and values.
        ({"food_name": "Bananas, raw"}, "food_logs_check1"),
        ({"food_calories_per_100g": 89}, "food_logs_check1"),
        ({"food_fiber_per_100g": 2.6}, "food_logs_check2"),
        ({"food_sodium_mg_per_100g": 1}, "food_logs_check2"),
    ],
)
def test_food_logs_rejects_a_bad_custom_entry(conn, overrides, constraint):
    assert rejected_by(conn, "food_logs", custom_log(add_user(conn), **overrides)) == constraint


@pytest.mark.parametrize(
    ("overrides", "constraint"),
    [
        # A USDA log is in grams and keeps the food's name and its four required values.
        ({"unit": "serving"}, "food_logs_check"),
        ({"food_name": None}, "food_logs_check1"),
        ({"food_fat_per_100g": None}, "food_logs_check1"),
        (dict.fromkeys(("food_name", *FOOD_VALUES[:4])), "food_logs_check1"),
        *[({column: -0.1}, f"food_logs_{column}_check") for column in FOOD_VALUES],
    ],
)
def test_food_logs_rejects_a_bad_usda_log(conn, overrides, constraint):
    values = usda_log(add_user(conn), add_food(conn), **overrides)
    assert rejected_by(conn, "food_logs", values) == constraint


def test_food_logs_accepts_a_usda_log_with_and_without_the_optional_food_values(conn):
    user_id = add_user(conn)
    fdc_id = add_food(conn)
    insert(conn, "food_logs", **usda_log(user_id, fdc_id))
    optional = {"food_fiber_per_100g": 2.6, "food_sugar_per_100g": 12.2, "food_sodium_mg_per_100g": 0}
    insert(conn, "food_logs", **usda_log(user_id, fdc_id, **optional))
    assert conn.execute("SELECT count(*) FROM food_logs").fetchone()[0] == 2
    with pytest.raises(errors.ForeignKeyViolation):  # a food that is not in the table
        insert(conn, "food_logs", **usda_log(user_id, fdc_id + 1))


@pytest.mark.parametrize(
    ("overrides", "constraint"),
    [
        ({"goal": "bulk"}, "user_goals_goal_check"),
        ({"steps": -1}, "user_goals_steps_check"),
        *[({n: -1}, f"user_goals_{n}_check") for n in NUTRIENTS],
    ],
)
def test_user_goals_rejects_bad_values(conn, overrides, constraint):
    assert rejected_by(conn, "user_goals", goals(add_user(conn), **overrides)) == constraint


def test_one_row_per_user_and_day_or_food(conn):
    user_id = add_user(conn)
    fdc_id = add_food(conn)
    steps = {"user_id": user_id, "activity_date": date(2026, 11, 10), "steps": 0, "updated_at": NOW}
    saved = {"user_id": user_id, "fdc_id": fdc_id, "saved_at": NOW, "updated_at": NOW}
    for table, values in (("user_goals", goals(user_id)), ("daily_activity", steps), ("saved_foods", saved)):
        insert(conn, table, **values)
        with pytest.raises(errors.UniqueViolation):
            insert(conn, table, **values)
        insert(conn, table, **values | {"user_id": add_user(conn)})  # another user's row is separate
    assert rejected_by(conn, "daily_activity", steps | {"steps": -1}) == "daily_activity_steps_check"


def test_user_tokens_stores_one_sha256_hash_per_token(conn):
    user_id = add_user(conn)
    assert rejected_by(conn, "user_tokens", {"user_id": user_id, "token_hash": b"x" * 31}) == (
        "user_tokens_token_hash_check"
    )
    assert rejected_by(conn, "user_tokens", {"user_id": user_id, "token_hash": b"x" * 33}) == (
        "user_tokens_token_hash_check"
    )
    insert(conn, "user_tokens", user_id=user_id, token_hash=b"x" * 32)
    with pytest.raises(errors.UniqueViolation):
        insert(conn, "user_tokens", user_id=add_user(conn), token_hash=b"x" * 32)
    with pytest.raises(errors.ForeignKeyViolation):
        insert(conn, "user_tokens", user_id=uuid.uuid4(), token_hash=b"y" * 32)


def test_users_identity_rules(conn):
    # Anonymous devices: any number of users with no email and no provider.
    first, second = add_user(conn), add_user(conn)
    assert first != second
    assert conn.execute("SELECT DISTINCT timezone, email, auth_provider FROM users").fetchall() == [("UTC", None, None)]
    # A provider and its subject come together, and identify one user.
    assert rejected_by(conn, "users", {"auth_provider": "apple"}) == "users_check"
    assert rejected_by(conn, "users", {"auth_subject": "abc"}) == "users_check"
    add_user(conn, auth_provider="apple", auth_subject="abc")
    add_user(conn, auth_provider="google", auth_subject="abc")
    with pytest.raises(errors.UniqueViolation) as raised:
        add_user(conn, auth_provider="apple", auth_subject="abc")
    assert raised.value.diag.constraint_name == "users_auth_provider_auth_subject_key"
    # One user per email, whatever its case.
    add_user(conn, email="Kiran@example.com")
    with pytest.raises(errors.UniqueViolation) as raised:
        add_user(conn, email="kiran@EXAMPLE.com")
    assert raised.value.diag.constraint_name == "users_email_key"


def test_deleting_a_user_deletes_their_data_and_nothing_else(conn):
    fdc_id = add_food(conn)
    for token_hash in (b"a" * 32, b"b" * 32):
        user_id = add_user(conn)
        insert(conn, "user_tokens", user_id=user_id, token_hash=token_hash)
        insert(conn, "food_logs", **custom_log(user_id))
        insert(conn, "food_logs", **usda_log(user_id, fdc_id))
        insert(conn, "user_goals", **goals(user_id))
        insert(conn, "daily_activity", user_id=user_id, activity_date=date(2026, 11, 10), steps=1, updated_at=NOW)
        insert(conn, "saved_foods", user_id=user_id, fdc_id=fdc_id, saved_at=NOW, updated_at=NOW)
    conn.execute("DELETE FROM users WHERE id = %s", (user_id,))
    counts = {
        table: conn.execute(f"SELECT count(*), count(user_id = %s OR NULL) FROM {table}", (user_id,)).fetchone()
        for table in ("user_tokens", *SYNCED_TABLES)
    }
    assert counts == {
        "user_tokens": (1, 0),
        "food_logs": (2, 0),
        "user_goals": (1, 0),
        "daily_activity": (1, 0),
        "saved_foods": (1, 0),
    }
    assert conn.execute("SELECT count(*) FROM foods").fetchone()[0] == 1


@pytest.mark.parametrize("table", ["food_logs", "saved_foods"])
def test_a_food_that_is_logged_or_saved_cannot_be_deleted(conn, table):
    user_id = add_user(conn)
    fdc_id = add_food(conn)
    if table == "food_logs":
        insert(conn, "food_logs", **usda_log(user_id, fdc_id, deleted_at=NOW))  # even a deleted log keeps its food
    else:
        insert(conn, "saved_foods", user_id=user_id, fdc_id=fdc_id, saved_at=NOW, updated_at=NOW, deleted_at=NOW)
    with pytest.raises(errors.ForeignKeyViolation) as raised:
        conn.execute("DELETE FROM foods WHERE fdc_id = %s", (fdc_id,))
    assert raised.value.diag.constraint_name == f"{table}_fdc_id_fkey"
    # What the loader did on every reload before foods could be retired. Postgres refuses it for
    # any table a foreign key references, even when no row does.
    with pytest.raises(errors.FeatureNotSupported):
        conn.execute("TRUNCATE foods, food_portions")
    # It is retired instead, and the row that references it stays.
    assert conn.execute("SELECT retired_at FROM foods").fetchall() == [(None,)]
    conn.execute("UPDATE foods SET retired_at = now()")
    assert conn.execute(f"SELECT count(*) FROM {table} WHERE fdc_id = %s", (fdc_id,)).fetchone()[0] == 1


def test_downgrade_to_0001_keeps_the_foods_and_drops_the_rest(conn, migrated_url):
    schema = schema_of(migrated_url)
    add_food(conn)
    insert(conn, "food_logs", **custom_log(add_user(conn)))

    def leftovers():
        return conn.execute(
            "SELECT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace"
            "        WHERE n.nspname = current_schema() AND p.proname = 'set_sync_rev'),"
            " (SELECT count(*) FROM pg_sequences"
            "        WHERE schemaname = current_schema() AND sequencename = 'sync_rev_seq'),"
            " (SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema()"
            "        AND table_name = 'foods' AND column_name = 'retired_at')"
        ).fetchone()

    assert leftovers() == (1, 1, 1)
    command.downgrade(alembic_config(migrated_url), "0001")
    assert tables_in(migrated_url, schema) == FOODS_TABLES
    assert leftovers() == (0, 0, 0)
    assert conn.execute("SELECT version_num FROM alembic_version").fetchall() == [("0001",)]
    assert conn.execute("SELECT fdc_id FROM foods").fetchall() == [(1,)]  # the foods survive
    command.upgrade(alembic_config(migrated_url), "head")
    assert tables_in(migrated_url, schema) == TABLES
    assert leftovers() == (1, 1, 1)
    assert conn.execute("SELECT fdc_id, retired_at FROM foods").fetchall() == [(1, None)]
    assert insert(conn, "food_logs", "rev", **custom_log(add_user(conn))) == (1,)  # a new sequence


def test_models_write_and_read_back_what_the_database_sets(migrated_url):
    """The API streams write through these models: ids, defaults, `rev` and the totals come back from Postgres."""
    engine = make_engine(migrated_url)
    try:
        with Session(engine) as session:
            user = User()
            session.add(user)
            session.flush()
            assert isinstance(user.id, uuid.UUID)
            assert user.timezone == "UTC"
            assert user.created_at.tzinfo is not None
            session.add(Food(fdc_id=1, description="Bananas, raw", data_type="Foundation", calories_per_100g=89,
                             protein_per_100g=1.1, carbs_per_100g=22.8, fat_per_100g=0.3))  # fmt: skip
            session.add(UserToken(user_id=user.id, token_hash=b"h" * 32, label="ios 1.0"))
            log = FoodLog(**usda_log(user.id, 1))
            steps = DailyActivity(user_id=user.id, activity_date=date(2026, 11, 10), steps=4000, updated_at=NOW)
            session.add_all([log, steps, UserGoal(**goals(user.id))])
            session.add(SavedFood(user_id=user.id, fdc_id=1, saved_at=NOW, updated_at=NOW))
            session.flush()
            assert isinstance(log.id, uuid.UUID)
            assert (log.calories, log.fiber_g) == (135, None)
            assert log.logged_at == NOW and log.logged_at.tzinfo is not None
            first_rev = log.rev
            assert first_rev > 0 and steps.rev > 0 and steps.rev != first_rev
            log.quantity = 200
            session.flush()
            assert log.rev > max(first_rev, steps.rev)  # the trigger's new value, not the stale one
            assert log.calories == 180
            session.commit()
            assert session.get(Food, 1).retired_at is None
            assert session.scalars(text("SELECT token_hash FROM user_tokens")).one() == b"h" * 32
    finally:
        engine.dispose()


# ---- Revision 0003: goal sources and day amounts; daily_steps becomes daily_activity ----


@pytest.mark.parametrize(
    ("table", "overrides", "constraint"),
    [
        ("user_goals", {"source": "guess"}, "user_goals_source_check"),
        ("user_goals", {"workout_kcal": -1}, "user_goals_workout_kcal_check"),
        ("user_goals", {"active_rest_kcal": -1}, "user_goals_active_rest_kcal_check"),
        ("daily_activity", {"day_type": "active_recovery"}, "daily_activity_day_type_check"),
        ("daily_activity", {"workout_kcal": -1}, "daily_activity_workout_kcal_check"),
    ],
)
def test_0003_columns_reject_bad_values(conn, table, overrides, constraint):
    user_id = add_user(conn)
    day = {"user_id": user_id, "activity_date": date(2026, 11, 10), "steps": 0, "updated_at": NOW}
    values = goals(user_id) if table == "user_goals" else day
    assert rejected_by(conn, table, values | overrides) == constraint


def test_0003_defaults(conn):
    user_id = add_user(conn)
    assert insert(conn, "user_goals", "source, workout_kcal, active_rest_kcal", **goals(user_id)) == ("manual", 0, 0)
    day = {"user_id": user_id, "steps": 0, "updated_at": NOW}
    assert insert(conn, "daily_activity", "day_type, workout_kcal", activity_date=date(2026, 11, 10), **day) == (
        None,
        None,
    )
    # 0 is a value.
    insert(conn, "daily_activity", activity_date=date(2026, 11, 11), day_type="workout", workout_kcal=0, **day)


def daily_objects(conn) -> set[str]:
    """The names of the constraints, indexes and triggers of the daily_steps / daily_activity table."""
    rows = conn.execute(
        "SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace"
        " WHERE n.nspname = current_schema() AND conname LIKE 'daily%'"
        " UNION ALL SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname LIKE 'daily%'"
        " UNION ALL SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid"
        " JOIN pg_namespace n ON n.oid = c.relnamespace"
        " WHERE n.nspname = current_schema() AND NOT t.tgisinternal AND t.tgname LIKE 'daily%'"
    ).fetchall()
    return {name for (name,) in rows}


def test_downgrade_to_0002_gives_daily_steps_back_with_its_rows(conn, migrated_url):
    user_id = add_user(conn)
    insert(conn, "user_goals", **goals(user_id, workout_kcal=300))
    day = {"user_id": user_id, "activity_date": date(2026, 11, 10), "steps": 4000, "updated_at": NOW}
    (rev,) = insert(conn, "daily_activity", "rev", day_type="workout", workout_kcal=250, **day)
    old_names = {"daily_steps_pkey", "daily_steps_user_id_fkey", "daily_steps_steps_check", "daily_steps_user_rev_idx"}
    old_names.add("daily_steps_rev")

    command.downgrade(alembic_config(migrated_url), "0002")
    assert daily_objects(conn) == old_names
    assert conn.execute("SELECT user_id, log_date, steps, rev FROM daily_steps").fetchall() == [
        (user_id, date(2026, 11, 10), 4000, rev)
    ]
    goal_columns = conn.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema()"
        " AND table_name = 'user_goals'"
    ).fetchall()
    assert {"source", "workout_kcal", "active_rest_kcal"}.isdisjoint(c for (c,) in goal_columns)

    command.upgrade(alembic_config(migrated_url), "head")
    new_names = {name.replace("daily_steps", "daily_activity") for name in old_names}
    assert daily_objects(conn) == new_names | {"daily_activity_day_type_check", "daily_activity_workout_kcal_check"}
    # The renames kept the row and its rev; the new columns start empty.
    assert conn.execute("SELECT steps, day_type, workout_kcal, rev FROM daily_activity").fetchall() == [
        (4000, None, None, rev)
    ]
