"""The loader's database path: COPY into both tables, reload, CHECK / NOT NULL / FK, unmigrated schema.

Needs Postgres: set DATABASE_URL (see README).
Run locally against docker-compose:  DATABASE_URL=postgresql://kalo:kalo@localhost:5432/kalo uv run pytest
Each test runs in its own schema so it never touches the real tables.
"""

import os

import psycopg
import pytest

from kalo.db import SchemaOutOfDate, require_head
from kalo.usda.load import load
from kalo.usda.nutrients import FoodRow
from kalo.usda.portions import Portion

URL = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="DATABASE_URL not set")


def row(fdc_id, **over):
    base = dict(
        fdc_id=fdc_id,
        description="Banana, raw",
        data_type="SR Legacy",
        brand_name=None,
        calories_per_100g=89.0,
        protein_per_100g=1.09,
        carbs_per_100g=22.84,
        fat_per_100g=0.33,
        fiber_per_100g=2.6,
        sugar_per_100g=12.23,
        sodium_mg_per_100g=1.0,
    )
    return FoodRow(**{**base, **over})


def fetch(url, query):
    with psycopg.connect(url) as conn:
        return conn.execute(query).fetchall()


def test_load_copies_both_tables_and_a_reload_replaces_them(migrated_url):
    rows = [row(1), row(2, data_type="Foundation", fat_per_100g=0.0)]
    portions = [
        Portion(1, "1 cup, sliced", 150.0),
        Portion(1, "1 small", 101.0),
        Portion(2, "1 banana (Peeled)", 110.5),
    ]
    counts, portion_count = load(rows, portions, migrated_url)
    assert (dict(counts), portion_count) == ({"Foundation": 1, "SR Legacy": 1}, 3)
    foods = fetch(migrated_url, "SELECT fdc_id, fat_per_100g, fiber_per_100g, sodium_mg_per_100g FROM foods ORDER BY 1")
    assert foods == [(1, pytest.approx(0.33), pytest.approx(2.6), 1.0), (2, 0.0, pytest.approx(2.6), 1.0)]
    assert fetch(migrated_url, "SELECT id, fdc_id, description, gram_weight FROM food_portions ORDER BY id") == [
        (1, 1, "1 cup, sliced", 150.0),
        (2, 1, "1 small", 101.0),
        (3, 2, "1 banana (Peeled)", 110.5),
    ]

    # A rerun replaces both tables, and the portion ids start again at 1.
    counts, portion_count = load([row(3)], [Portion(3, "1 large", 136.0)], migrated_url)
    assert (dict(counts), portion_count) == ({"SR Legacy": 1}, 1)
    assert fetch(migrated_url, "SELECT fdc_id FROM foods") == [(3,)]
    assert fetch(migrated_url, "SELECT id, fdc_id, description FROM food_portions") == [(1, 3, "1 large")]

    # Foods without portions, and no foods at all, are fine.
    assert load([row(4)], [], migrated_url) == ({"SR Legacy": 1}, 0)
    assert load([], [], migrated_url) == ({}, 0)


def test_null_fiber_sugar_and_sodium_load_as_null(migrated_url):
    load([row(1, fiber_per_100g=None, sugar_per_100g=None, sodium_mg_per_100g=None), row(2, sugar_per_100g=0.0)], [],
         migrated_url)  # fmt: skip
    got = fetch(migrated_url, "SELECT fiber_per_100g, sugar_per_100g, sodium_mg_per_100g FROM foods ORDER BY fdc_id")
    assert got == [(None, None, None), (pytest.approx(2.6), 0.0, 1.0)]


def test_an_unmigrated_schema_is_refused(scratch_url):
    with pytest.raises(SchemaOutOfDate, match="not migrated.*run `uv run alembic upgrade head`"):
        load([row(1)], [], scratch_url)
    with psycopg.connect(scratch_url) as conn, conn.cursor() as cur:
        with pytest.raises(SchemaOutOfDate):
            require_head(cur)
        # The loader created nothing of its own in the scratch schema.
        cur.execute("SELECT count(*) FROM pg_tables WHERE schemaname = current_schema()")
        assert cur.fetchone() == (0,)


def test_a_schema_at_another_revision_is_refused_and_left_alone(migrated_url):
    load([row(1)], [Portion(1, "1 small", 101.0)], migrated_url)
    with psycopg.connect(migrated_url) as conn:
        conn.execute("UPDATE alembic_version SET version_num = 'an_older_revision'")
    with pytest.raises(SchemaOutOfDate, match="is at an_older_revision.*run `uv run alembic upgrade head`"):
        load([row(2)], [], migrated_url)
    assert fetch(migrated_url, "SELECT fdc_id FROM foods") == [(1,)]  # refused before the TRUNCATE
    assert fetch(migrated_url, "SELECT count(*) FROM food_portions") == [(1,)]


def test_checks_and_not_nulls_reject_bad_rows_and_keep_the_previous_load(migrated_url):
    good = ([row(1)], [Portion(1, "1 small", 101.0)])
    load(*good, migrated_url)
    bad_foods = [
        row(2, carbs_per_100g=-0.1),
        row(2, calories_per_100g=-1.0),
        row(2, fiber_per_100g=-0.1),
        row(2, sugar_per_100g=-1.0),
        row(2, sodium_mg_per_100g=-1.0),
        row(2, data_type="Branded"),
    ]
    for bad in bad_foods:
        with pytest.raises(psycopg.errors.CheckViolation):
            load([bad], [], migrated_url)
    for column in ("description", "data_type", "calories_per_100g", "protein_per_100g", "carbs_per_100g",
                   "fat_per_100g"):  # fmt: skip
        with pytest.raises(psycopg.errors.NotNullViolation):
            load([row(2, **{column: None})], [], migrated_url)
    for grams in (0.0, -1.0):
        with pytest.raises(psycopg.errors.CheckViolation):
            load([row(2)], [Portion(2, "1 cup", grams)], migrated_url)
    with pytest.raises(psycopg.errors.NotNullViolation):
        load([row(2)], [Portion(2, None, 240.0)], migrated_url)
    with pytest.raises(psycopg.errors.UniqueViolation):
        load([row(2), row(2)], [], migrated_url)
    # One transaction: every failed load rolled back its TRUNCATE too.
    assert fetch(migrated_url, "SELECT fdc_id FROM foods") == [(1,)]
    assert fetch(migrated_url, "SELECT id, fdc_id FROM food_portions") == [(1, 1)]


def test_a_portion_for_a_missing_food_is_rejected(migrated_url):
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        load([row(1)], [Portion(1, "1 small", 101.0), Portion(999, "1 cup", 240.0)], migrated_url)
    assert fetch(migrated_url, "SELECT count(*) FROM foods") == [(0,)]


def test_an_unmigrated_schema_is_refused_even_when_a_later_schema_on_the_path_is_at_head(migrated_url):
    # search_path = empty schema, then a migrated one: an unqualified `alembic_version` (and `foods`) would
    # resolve to the migrated schema, and the load would truncate tables that are not this schema's.
    load([row(1)], [Portion(1, "1 small", 101.0)], migrated_url)
    (migrated,) = fetch(migrated_url, "SELECT current_schema()")[0]
    empty = f"{migrated}_empty"
    sep = "&" if "?" in URL else "?"
    url = f"{URL}{sep}options=-c%20search_path%3D{empty},{migrated},public"
    with psycopg.connect(URL, autocommit=True) as conn:
        conn.execute(f"CREATE SCHEMA {empty}")
    try:
        assert fetch(url, "SELECT to_regclass('alembic_version') IS NOT NULL, current_schema()") == [(True, empty)]
        with pytest.raises(SchemaOutOfDate, match=f"schema '{empty}' is at not migrated"):
            load([row(2)], [], url)
    finally:
        with psycopg.connect(URL, autocommit=True) as conn:
            conn.execute(f"DROP SCHEMA {empty} CASCADE")
    assert fetch(migrated_url, "SELECT fdc_id FROM foods") == [(1,)]  # the migrated schema's data is untouched
    assert fetch(migrated_url, "SELECT count(*) FROM food_portions") == [(1,)]
