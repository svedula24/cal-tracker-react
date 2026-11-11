"""The loader's database path: first load, reloads (update in place, retire, un-retire), CHECK / NOT NULL,
unmigrated schema.

Needs Postgres: set DATABASE_URL (see README).
Run locally against docker-compose:  DATABASE_URL=postgresql://kalo:kalo@localhost:5432/kalo uv run pytest
Each test runs in its own schema so it never touches the real tables.
"""

import os

import psycopg
import pytest

from kalo.db import SchemaOutOfDate, require_head
from kalo.usda.load import MAX_RETIRED_SHARE, TooManyRetired, load
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


def log_and_save(url, fdc_id):
    """A user with one food log and one bookmark that reference the food."""
    with psycopg.connect(url) as conn:
        (user_id,) = conn.execute("INSERT INTO users DEFAULT VALUES RETURNING id").fetchone()
        conn.execute(
            """
            INSERT INTO food_logs (user_id, fdc_id, log_date, logged_at, name, food_name, unit, quantity,
                                   unit_calories, unit_protein_g, unit_carbs_g, unit_fat_g,
                                   food_calories_per_100g, food_protein_per_100g, food_carbs_per_100g,
                                   food_fat_per_100g, updated_at)
            VALUES (%s, %s, current_date, now(), 'Banana', 'Banana, raw', 'g', 120,
                    89, 1.09, 22.84, 0.33, 89, 1.09, 22.84, 0.33, now())
            """,
            (user_id, fdc_id),
        )
        conn.execute(
            "INSERT INTO saved_foods (user_id, fdc_id, saved_at, updated_at) VALUES (%s, %s, now(), now())",
            (user_id, fdc_id),
        )


FOOD_VERSIONS = "SELECT fdc_id, ctid, xmin FROM foods ORDER BY fdc_id"  # a rewritten row changes both
RETIRED = "SELECT fdc_id FROM foods WHERE retired_at IS NOT NULL ORDER BY fdc_id"


def test_the_first_load_copies_both_tables(migrated_url):
    rows = [row(1), row(2, data_type="Foundation", fat_per_100g=0.0)]
    portions = [
        Portion(1, "1 cup, sliced", 150.0),
        Portion(1, "1 small", 101.0),
        Portion(2, "1 banana (Peeled)", 110.5),
    ]
    counts, portion_count, retired = load(rows, portions, migrated_url)
    assert (dict(counts), portion_count, retired) == ({"Foundation": 1, "SR Legacy": 1}, 3, 0)
    foods = fetch(
        migrated_url,
        "SELECT fdc_id, fat_per_100g, fiber_per_100g, sodium_mg_per_100g, retired_at FROM foods ORDER BY 1",
    )
    assert foods == [(1, pytest.approx(0.33), pytest.approx(2.6), 1.0, None), (2, 0.0, pytest.approx(2.6), 1.0, None)]
    assert fetch(migrated_url, "SELECT id, fdc_id, description, gram_weight FROM food_portions ORDER BY id") == [
        (1, 1, "1 cup, sliced", 150.0),
        (2, 1, "1 small", 101.0),
        (3, 2, "1 banana (Peeled)", 110.5),
    ]
    # Foods without portions are fine: the reload removes those of food 1.
    assert load([row(1), row(2)], [Portion(2, "1 large", 136.0)], migrated_url) == ({"SR Legacy": 2}, 1, 0)
    assert fetch(migrated_url, "SELECT fdc_id, description FROM food_portions") == [(2, "1 large")]


def test_a_food_missing_from_a_reload_is_retired_and_keeps_its_portions_logs_and_bookmarks(migrated_url):
    load([row(1), row(2)], [Portion(1, "1 small", 101.0), Portion(2, "1 cup", 240.0)], migrated_url)
    log_and_save(migrated_url, 1)

    counts, portion_count, retired = load([row(2), row(3)], [Portion(2, "1 cup", 240.0)], migrated_url)

    assert (dict(counts), portion_count, retired) == ({"SR Legacy": 2}, 1, 1)  # current foods only
    assert fetch(migrated_url, "SELECT fdc_id, retired_at IS NULL FROM foods ORDER BY 1") == [
        (1, False),
        (2, True),
        (3, True),
    ]
    assert fetch(migrated_url, "SELECT fdc_id, description FROM food_portions ORDER BY fdc_id") == [
        (1, "1 small"),
        (2, "1 cup"),
    ]
    assert fetch(migrated_url, "SELECT fdc_id, calories FROM food_logs") == [(1, pytest.approx(106.8))]
    assert fetch(migrated_url, "SELECT fdc_id FROM saved_foods") == [(1,)]


def test_a_retired_food_keeps_its_date_until_it_returns(migrated_url):
    load([row(1), row(2)], [Portion(1, "1 small", 101.0)], migrated_url)
    assert load([row(2)], [], migrated_url)[2] == 1
    with psycopg.connect(migrated_url) as conn:  # as if retired by a load last year
        conn.execute("UPDATE foods SET retired_at = '2025-01-01T00:00:00Z' WHERE fdc_id = 1")
    (before,) = fetch(migrated_url, "SELECT retired_at, ctid, xmin FROM foods WHERE fdc_id = 1")

    assert load([row(2)], [], migrated_url)[2] == 0  # still missing: not retired again
    assert fetch(migrated_url, "SELECT retired_at, ctid, xmin FROM foods WHERE fdc_id = 1") == [before]

    counts, portion_count, retired = load([row(1), row(2)], [Portion(1, "1 large", 136.0)], migrated_url)
    assert (dict(counts), portion_count, retired) == ({"SR Legacy": 2}, 1, 0)
    assert fetch(migrated_url, RETIRED) == []
    assert fetch(migrated_url, "SELECT fdc_id, description FROM food_portions") == [(1, "1 large")]


def test_an_unchanged_reload_rewrites_no_food_row_and_a_changed_food_is_updated(migrated_url):
    # NULLs and values a REAL cannot hold exactly (0.33, 1.09) must still compare as unchanged.
    rows = [row(1), row(2, fiber_per_100g=None, sugar_per_100g=None, sodium_mg_per_100g=None), row(3)]
    portions = [Portion(1, "1 small", 101.0)]
    load(rows, portions, migrated_url)
    before = fetch(migrated_url, FOOD_VERSIONS)

    assert load(rows, portions, migrated_url) == ({"SR Legacy": 3}, 1, 0)
    assert fetch(migrated_url, FOOD_VERSIONS) == before

    changed = [
        rows[0],
        row(2, fiber_per_100g=None, sugar_per_100g=None, sodium_mg_per_100g=5.0),  # NULL → a value
        row(3, description="Banana, ripe", data_type="Foundation", calories_per_100g=97.0, fiber_per_100g=None),
    ]
    load(changed, portions, migrated_url)
    after = fetch(migrated_url, FOOD_VERSIONS)
    assert after[0] == before[0]  # the unchanged food is still not rewritten
    assert after[1] != before[1] and after[2] != before[2]
    columns = "description, data_type, calories_per_100g, fiber_per_100g, sodium_mg_per_100g"
    got = fetch(migrated_url, f"SELECT {columns} FROM foods ORDER BY fdc_id")
    assert got == [
        ("Banana, raw", "SR Legacy", 89.0, pytest.approx(2.6), 1.0),
        ("Banana, raw", "SR Legacy", 89.0, None, 5.0),
        ("Banana, ripe", "Foundation", 97.0, None, 1.0),
    ]


def test_portion_ids_are_not_reset_and_a_retired_foods_portions_are_not_replaced(migrated_url):
    load([row(1), row(2)], [Portion(1, "1 small", 101.0), Portion(2, "1 cup", 240.0)], migrated_url)
    load([row(2)], [Portion(2, "1 cup", 240.0), Portion(2, "1 large", 136.0)], migrated_url)
    assert fetch(migrated_url, "SELECT id, fdc_id, description FROM food_portions ORDER BY id") == [
        (1, 1, "1 small"),  # food 1 is retired: its portion row is untouched
        (3, 2, "1 cup"),  # food 2's were replaced, with new ids
        (4, 2, "1 large"),
    ]


def test_loading_nothing_retires_every_food_and_deletes_nothing(migrated_url):
    load([row(1), row(2)], [Portion(1, "1 small", 101.0)], migrated_url)
    log_and_save(migrated_url, 1)
    assert load([], [], migrated_url) == ({}, 0, 2)
    assert fetch(migrated_url, RETIRED) == [(1,), (2,)]
    assert fetch(migrated_url, "SELECT id, fdc_id FROM food_portions") == [(1, 1)]
    assert fetch(migrated_url, "SELECT count(*) FROM food_logs") == [(1,)]
    assert load([], [], migrated_url) == ({}, 0, 0)  # nothing current is left to retire


def test_a_load_that_would_retire_too_many_foods_is_refused_and_changes_nothing(migrated_url):
    foods = [row(i) for i in range(1, 21)]
    load(foods, [Portion(1, "1 small", 101.0)], migrated_url)
    state = "SELECT fdc_id, calories_per_100g, retired_at, xmin::text FROM foods ORDER BY fdc_id"
    before = fetch(migrated_url, state)
    # A truncated download: 3 of the 20 foods are missing (15%), and one that is present has changed.
    partial = [row(i, calories_per_100g=999.0 if i == 1 else 89.0) for i in range(1, 18)]
    with pytest.raises(TooManyRetired, match="would retire 3 of the 20 current ones"):
        load(partial, [], migrated_url, max_retired_share=MAX_RETIRED_SHARE)
    # Rolled back as a whole: nothing retired, the changed value not applied, the portion still there.
    assert fetch(migrated_url, state) == before
    assert fetch(migrated_url, "SELECT fdc_id FROM food_portions") == [(1,)]
    # An empty load is the extreme case.
    with pytest.raises(TooManyRetired):
        load([], [], migrated_url, max_retired_share=MAX_RETIRED_SHARE)
    # Within the share (2 of 20), and whenever the caller allows it (no share), the load goes through.
    assert load(foods[:18], [], migrated_url, max_retired_share=MAX_RETIRED_SHARE)[2] == 2
    assert load(foods[:5], [], migrated_url)[2] == 13


def test_the_first_load_is_never_refused_for_its_size(migrated_url):
    # An empty table has nothing to retire.
    assert load([row(1)], [], migrated_url, max_retired_share=MAX_RETIRED_SHARE)[2] == 0


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
    assert fetch(migrated_url, "SELECT fdc_id FROM foods") == [(1,)]  # refused before anything was written
    assert fetch(migrated_url, "SELECT count(*) FROM food_portions") == [(1,)]


def test_checks_and_not_nulls_reject_bad_rows_and_keep_the_previous_load(migrated_url):
    good = ([row(1)], [Portion(1, "1 small", 101.0)])
    load(*good, migrated_url)
    before = fetch(migrated_url, FOOD_VERSIONS)
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
    # One transaction: a failed load changed nothing, not even the row of the food it had in common.
    with pytest.raises(psycopg.errors.CheckViolation):
        load([row(1, description="Changed"), row(2, fat_per_100g=-1.0)], [], migrated_url)
    with pytest.raises(psycopg.errors.UniqueViolation):
        load([row(1, description="Changed"), row(2), row(2)], [], migrated_url)
    assert fetch(migrated_url, FOOD_VERSIONS) == before
    assert fetch(migrated_url, "SELECT fdc_id, description, retired_at FROM foods") == [(1, "Banana, raw", None)]
    assert fetch(migrated_url, "SELECT id, fdc_id FROM food_portions") == [(1, 1)]


def test_a_portion_for_a_food_that_is_not_in_the_load_is_rejected(migrated_url):
    with pytest.raises(ValueError, match=r"not in the load: \[999\]"):
        load([row(1)], [Portion(1, "1 small", 101.0), Portion(999, "1 cup", 240.0)], migrated_url)
    assert fetch(migrated_url, "SELECT count(*) FROM foods") == [(0,)]
    # A retired food exists, so the foreign key alone would accept (and pile up) a portion for it.
    load([row(1), row(2)], [Portion(1, "1 small", 101.0)], migrated_url)
    load([row(2)], [], migrated_url)
    with pytest.raises(ValueError, match=r"not in the load: \[1\]"):
        load([row(2)], [Portion(1, "1 cup", 240.0)], migrated_url)
    assert fetch(migrated_url, "SELECT fdc_id, description FROM food_portions") == [(1, "1 small")]


def test_an_unmigrated_schema_is_refused_even_when_a_later_schema_on_the_path_is_at_head(migrated_url):
    # search_path = empty schema, then a migrated one: an unqualified `alembic_version` (and `foods`) would
    # resolve to the migrated schema, and the load would write to tables that are not this schema's.
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
