"""The database path: schema, COPY, CHECKs, schema drift. Needs Postgres: set DATABASE_URL (see README).

Run locally against docker-compose:  DATABASE_URL=postgresql://kalo:kalo@localhost:5432/kalo uv run pytest
Each test runs in its own schema so it never touches the real foods table.
"""

import os

import psycopg
import pytest

from kalo.usda.load import SchemaOutOfDate, ensure_schema, load
from kalo.usda.nutrients import FoodRow

URL = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="DATABASE_URL not set")


def row(fdc_id, **over):
    base = dict(fdc_id=fdc_id, description="Banana, raw", data_type="SR Legacy", brand_name=None,
                calories_per_100g=89.0, protein_per_100g=1.09, carbs_per_100g=22.84, fat_per_100g=0.33)
    return FoodRow(**{**base, **over})


def test_load_creates_the_table_copies_rows_and_reloads(scratch_url):
    counts = load([row(1), row(2, data_type="Foundation", fat_per_100g=0.0)], scratch_url)
    assert dict(counts) == {"Foundation": 1, "SR Legacy": 1}
    with psycopg.connect(scratch_url) as conn:
        got = conn.execute("SELECT fdc_id, fat_per_100g FROM foods ORDER BY fdc_id").fetchall()
    assert got == [(1, pytest.approx(0.33)), (2, 0.0)]
    assert dict(load([row(3)], scratch_url)) == {"SR Legacy": 1}  # a rerun replaces, not appends


def test_checks_reject_bad_rows(scratch_url):
    for bad in [row(1, carbs_per_100g=-0.1), row(1, data_type="Branded"), row(1, calories_per_100g=-1.0)]:
        with pytest.raises(psycopg.errors.CheckViolation):
            load([bad], scratch_url)
    for column in ("calories_per_100g", "protein_per_100g", "carbs_per_100g", "fat_per_100g"):
        with pytest.raises(psycopg.errors.NotNullViolation):
            load([row(1, **{column: None})], scratch_url)


def test_existing_table_without_the_current_constraints_is_refused(scratch_url):
    with psycopg.connect(scratch_url) as conn:
        conn.execute("CREATE TABLE foods (fdc_id BIGINT PRIMARY KEY, description TEXT NOT NULL, data_type TEXT)")
    with pytest.raises(SchemaOutOfDate, match="foods_carbs_per_100g_check"):
        load([row(1)], scratch_url)
    with psycopg.connect(scratch_url) as conn, conn.cursor() as cur:
        with pytest.raises(SchemaOutOfDate):
            ensure_schema(cur)


def test_existing_table_with_nullable_nutrients_is_refused(scratch_url):
    with psycopg.connect(scratch_url) as conn:
        conn.execute("CREATE TABLE foods (fdc_id BIGINT PRIMARY KEY, description TEXT NOT NULL, "
                     "data_type TEXT NOT NULL CHECK (data_type IN ('SR Legacy')), brand_name TEXT, "
                     "calories_per_100g REAL NOT NULL CHECK (calories_per_100g >= 0), "
                     "protein_per_100g REAL NOT NULL CHECK (protein_per_100g >= 0), "
                     "carbs_per_100g REAL NOT NULL CHECK (carbs_per_100g >= 0), "
                     "fat_per_100g REAL CHECK (fat_per_100g >= 0))")
    with pytest.raises(SchemaOutOfDate, match=r"missing fat_per_100g NOT NULL\)"):
        load([row(1)], scratch_url)
