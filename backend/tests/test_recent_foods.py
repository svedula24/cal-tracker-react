"""GET /api/v1/foods/recent (app/api/v1/foods.py): the foods a user logged last.

Needs Postgres: set DATABASE_URL. Fixtures and helpers come from tests/test_food_logs.py.
"""

import os

import pytest
import test_food_logs as logs
from sqlalchemy import event
from test_food_logs import BANANA, BROCCOLI, CHICKEN, EGGS, OVERRIPE, RETIRED, create, patch, when

client, db, me, other = logs.client, logs.db, logs.me, logs.other  # the fixtures, for this module too

pytestmark = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set")

URL = "/api/v1/foods/recent"
ITEM_KEYS = {
    "fdc_id", "description", "data_type", "brand_name",
    "calories_per_100g", "protein_per_100g", "carbs_per_100g", "fat_per_100g",
    "fiber_per_100g", "sugar_per_100g", "sodium_mg_per_100g",
    "portions", "grams", "logged_at",
}  # fmt: skip


def recent(client, who, **params):
    r = client.get(URL, params=params, headers=who)
    assert r.status_code == 200, r.text
    assert set(r.json()) == {"foods"}
    return r.json()["foods"]


def log(client, who, fdc_id, grams, at, **more):
    return create(client, who, fdc_id=fdc_id, quantity=grams, logged_at=f"2026-03-{at}:00Z", **more)


def summary(foods):
    return [(f["fdc_id"], f["grams"]) for f in foods]


def test_recent_is_not_parsed_as_a_food_id(client, me):
    # Declared after /{fdc_id} it would be a 422 ("recent" is not an integer), with or without a token.
    r = client.get(URL, headers=me)
    assert r.status_code == 200, r.text
    assert r.json() == {"foods": []}
    assert client.get(URL).status_code == 401
    # And the routes around it still work, without a token.
    assert client.get(f"/api/v1/foods/{BANANA}").status_code == 200
    assert client.get("/api/v1/foods/search", params={"q": "banana"}).status_code == 200
    assert client.get("/api/v1/foods/recently").status_code == 422


def test_it_needs_a_token(client):
    for headers in ({}, {"Authorization": "Bearer kalo_" + "A" * 43}):
        r = client.get(URL, headers=headers)
        assert r.status_code == 401
        assert r.headers["www-authenticate"] == "Bearer"


def test_each_food_once_most_recent_first_at_its_last_amount(client, me):
    log(client, me, BANANA, 118, "01T08:00")
    log(client, me, CHICKEN, 200, "01T12:30")
    log(client, me, BROCCOLI, 91, "01T12:31")
    log(client, me, BANANA, 80, "02T08:00")  # the banana again, a day later, at another amount
    log(client, me, CHICKEN, 150, "01T07:00")  # entered later, but eaten before the 200 g
    foods = recent(client, me)
    assert summary(foods) == [(BANANA, 80), (BROCCOLI, 91), (CHICKEN, 200)]
    assert [when(f["logged_at"]) for f in foods] == [
        when("2026-03-02T08:00:00+00:00"), when("2026-03-01T12:31:00+00:00"), when("2026-03-01T12:30:00+00:00"),
    ]  # fmt: skip


def test_an_item_is_a_search_item_with_the_last_amount(client, me):
    log(client, me, BANANA, 80, "01T08:00", name="Breakfast banana", values={**EGGS, "calories": 999})
    (food,) = recent(client, me)
    assert set(food) == ITEM_KEYS
    (found,) = [f for f in client.get("/api/v1/foods/search", params={"q": "bananas, raw"}).json()["foods"][:1]]
    # The DATABASE food: its name and values, not the entry's rename or typed-over values.
    assert {k: v for k, v in food.items() if k not in ("grams", "logged_at")} == found
    assert (food["description"], food["calories_per_100g"], food["protein_per_100g"]) == ("Bananas, raw", 89.0, 0.74)
    assert [(p["description"], p["gram_weight"]) for p in food["portions"]] == [
        ("1 extra small", 81.0),
        ("1 medium", 118.0),
    ]
    assert food["grams"] == 80


def test_portions_belong_to_their_food_and_cost_one_query(client, me):
    log(client, me, BANANA, 100, "01T08:00")
    log(client, me, BROCCOLI, 100, "01T09:00")
    log(client, me, CHICKEN, 100, "01T10:00")
    seen = []

    def record(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    engine = client.app.state.engine
    event.listen(engine, "before_cursor_execute", record)
    try:
        foods = recent(client, me)
    finally:
        event.remove(engine, "before_cursor_execute", record)
    by_id = {f["fdc_id"]: [p["description"] for p in f["portions"]] for f in foods}
    assert by_id == {CHICKEN: [], BROCCOLI: ["1 spear"], BANANA: ["1 extra small", "1 medium"]}
    assert len([s for s in seen if "food_portions" in s]) == 1
    assert len(seen) == 3  # the token, the recent foods, their portions
    assert "DISTINCT ON" in seen[1]


def test_no_recents_skips_the_portions_query(client, me):
    create(client, me, name="Two eggs", quantity=2, values=EGGS)
    seen = []
    engine = client.app.state.engine

    def record(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        assert recent(client, me) == []
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert not [s for s in seen if "food_portions" in s]


def test_custom_entries_and_deleted_logs_do_not_appear(client, me):
    create(client, me, name="Two eggs", quantity=2, values=EGGS, logged_at="2026-03-05T08:00:00Z")
    create(client, me, name="Granola", quantity=60, unit="g", values=EGGS, logged_at="2026-03-05T09:00:00Z")
    assert recent(client, me) == []

    log(client, me, BANANA, 118, "01T08:00")
    latest = log(client, me, BANANA, 80, "02T08:00")
    chicken = log(client, me, CHICKEN, 200, "03T12:00")
    assert summary(recent(client, me)) == [(CHICKEN, 200), (BANANA, 80)]
    # Deleting a food's only log removes the food; deleting its latest log falls back to the one before.
    assert client.delete(f"/api/v1/food-logs/{chicken['id']}", headers=me).status_code == 204
    assert client.delete(f"/api/v1/food-logs/{latest['id']}", headers=me).status_code == 204
    foods = recent(client, me)
    assert summary(foods) == [(BANANA, 118)]
    assert when(foods[0]["logged_at"]) == when("2026-03-01T08:00:00+00:00")


def test_an_edit_changes_the_last_amount(client, me):
    banana = log(client, me, BANANA, 118, "01T08:00")
    patch(client, me, banana["id"], quantity=95, name="Small banana")
    (food,) = recent(client, me)
    assert (food["fdc_id"], food["grams"], food["description"]) == (BANANA, 95, "Bananas, raw")


def test_another_users_logs_never_appear(client, me, other):
    log(client, other, CHICKEN, 200, "01T12:00")
    log(client, other, BANANA, 500, "02T12:00")
    assert recent(client, me) == []
    log(client, me, BANANA, 80, "01T08:00")
    assert summary(recent(client, me)) == [(BANANA, 80)]  # mine, though theirs is newer
    assert summary(recent(client, other)) == [(BANANA, 500), (CHICKEN, 200)]


def test_a_retired_food_and_unreported_nutrients(client, me):
    log(client, me, RETIRED, 50, "01T08:00")
    log(client, me, OVERRIPE, 120, "02T08:00")
    overripe, retired = recent(client, me)
    assert (retired["fdc_id"], retired["description"], retired["grams"]) == (RETIRED, "Kale, discontinued", 50)
    assert (overripe["fiber_per_100g"], overripe["sugar_per_100g"], overripe["sodium_mg_per_100g"]) == (None,) * 3


def test_limit(client, me):
    for hour, fdc_id in enumerate((BANANA, OVERRIPE, CHICKEN, BROCCOLI), start=10):
        log(client, me, fdc_id, 100, f"01T{hour}:00")
    assert [f["fdc_id"] for f in recent(client, me)] == [BROCCOLI, CHICKEN, OVERRIPE, BANANA]  # default 20
    assert [f["fdc_id"] for f in recent(client, me, limit=2)] == [BROCCOLI, CHICKEN]
    assert len(recent(client, me, limit=1)) == 1
    assert len(recent(client, me, limit=50)) == 4
    for bad in (0, 51, -1, "many"):
        assert client.get(URL, params={"limit": bad}, headers=me).status_code == 422


def test_it_is_readable_cross_origin(client, me):
    r = client.get(URL, headers={**me, "Origin": "http://localhost:8081"})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "*"
