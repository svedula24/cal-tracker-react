"""Retired foods (dropped by a later USDA load, kept for the logs that reference them): search skips
them, lookup by id still returns them, and the filter leaves the search on its GIN indexes.

Needs Postgres: set DATABASE_URL (see README). Each test runs in its own schema.
"""

import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db.session import make_engine
from app.main import create_app
from app.services.foods import SET_THRESHOLD, params, sql_for
from kalo.usda.load import load
from kalo.usda.nutrients import FoodRow
from kalo.usda.portions import Portion

pytestmark = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set")

RAW, POWDER, BREAD = 1, 2, 3


def food(fdc_id, description):
    return FoodRow(fdc_id, description, "SR Legacy", None, 89.0, 1.09, 22.84, 0.33)


FOODS = [food(RAW, "Bananas, raw"), food(POWDER, "Banana powder"), food(BREAD, "Bread, banana")]
PORTIONS = [Portion(RAW, "1 small", 101.0), Portion(RAW, "1 cup, sliced", 150.0), Portion(POWDER, "1 tbsp", 6.2)]


@pytest.fixture
def client(migrated_url):
    """All three foods loaded, then a reload without "Bananas, raw", which retires it."""
    load(FOODS, PORTIONS, migrated_url)
    load(FOODS[1:], PORTIONS[2:], migrated_url)
    with TestClient(create_app(migrated_url)) as c:
        yield c


def found(client, q):
    response = client.get("/api/v1/foods/search", params={"q": q})
    assert response.status_code == 200
    return {item["fdc_id"] for item in response.json()["foods"]}


@pytest.mark.parametrize(
    "q, tier",
    [
        ("bananas, raw", "exact"),
        ("banana", "prefix and full text"),
        ("raw", "full text"),
        ("bananna", "fuzzy"),
        ("ba", "short query (prefix only)"),
    ],
)
def test_search_skips_a_retired_food_in_every_tier(client, q, tier):
    assert RAW not in found(client, q)


def test_search_still_finds_the_current_foods(client):
    assert found(client, "banana") == {POWDER, BREAD}
    assert found(client, "ba") == {POWDER}


def test_a_retired_food_is_still_returned_by_id_with_its_portions(client):
    response = client.get(f"/api/v1/foods/{RAW}")
    assert response.status_code == 200
    body = response.json()
    assert body["description"] == "Bananas, raw"
    assert [(p["description"], p["gram_weight"]) for p in body["portions"]] == [
        ("1 small", 101.0),
        ("1 cup, sliced", 150.0),
    ]


def test_a_food_that_returns_is_searchable_again(migrated_url, client):
    load(FOODS, PORTIONS, migrated_url)
    assert found(client, "banana") == {RAW, POWDER, BREAD}
    assert found(client, "ba") == {RAW, POWDER}


@pytest.mark.parametrize("q, indexes", [("banana", {"foods_description_fts", "foods_description_trgm"}),
                                        ("ba", {"foods_description_trgm"})])  # fmt: skip
def test_the_retired_filter_keeps_the_search_on_its_gin_indexes(migrated_url, q, indexes):
    rows = [food(i, f"Banana bread number {i}" if i % 3 else f"Chicken breast number {i}") for i in range(1, 401)]
    load(rows, [], migrated_url)
    load(rows[:300], [], migrated_url)  # a quarter of the table is retired
    engine = make_engine(migrated_url)
    try:
        with Session(engine) as session:
            session.execute(text("SET LOCAL enable_seqscan = off"))
            session.execute(SET_THRESHOLD)
            plan = "\n".join(line for (line,) in session.execute(text("EXPLAIN " + sql_for(q).text), params(q, 20, 0)))
    finally:
        engine.dispose()
    assert "Seq Scan" not in plan
    assert all(f"Bitmap Index Scan on {index}" in plan for index in indexes), plan
    assert "retired_at IS NULL" in plan  # a filter on the heap rows the indexes find
