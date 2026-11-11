"""GET /api/v1/nutrition/daily (app/api/v1/nutrition.py): a day's totals, goal and steps.

Needs Postgres: set DATABASE_URL. Fixtures and helpers come from tests/test_food_logs.py.
"""

import os

import pytest
import test_food_logs as logs
from sqlalchemy import event
from test_food_logs import BANANA, BROCCOLI, CHICKEN, EGGS, OVERRIPE, create, patch

client, db, me, other = logs.client, logs.db, logs.me, logs.other  # the fixtures, for this module too

pytestmark = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set")

URL = "/api/v1/nutrition/daily"
DAY = "2026-03-01"
ZEROS = {"calories": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0, "fiber_g": 0, "sugar_g": 0, "sodium_mg": 0}
NONE_UNKNOWN = {"fiber_g": 0, "sugar_g": 0, "sodium_mg": 0}
GOAL = {
    "calories": 2000.0, "protein_g": 150.0, "carbs_g": 200.0, "fat_g": 65.0,
    "fiber_g": 30.0, "sugar_g": 50.0, "sodium_mg": 2300.0, "steps": 10000, "goal": "lose",
}  # fmt: skip


def daily(client, who, date=DAY):
    r = client.get(URL, params={"date": date}, headers=who)
    assert r.status_code == 200, r.text
    assert set(r.json()) == {"date", "totals", "unknown", "goal", "steps", "log_count"}
    return r.json()


def user_id(client, who):
    return client.get("/api/v1/me", headers=who).json()["user_id"]


def add_goal(db, uid, effective_date, deleted=False, **changes):
    goal = {**GOAL, **changes}
    db.execute(
        "INSERT INTO user_goals (user_id, effective_date, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g,"
        " sodium_mg, steps, goal, updated_at, deleted_at)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), %s)",
        (uid, effective_date, *goal.values(), "2026-01-01T00:00:00Z" if deleted else None),
    )


def add_steps(db, uid, log_date, steps, deleted=False):
    db.execute(
        "INSERT INTO daily_steps (user_id, log_date, steps, updated_at, deleted_at) VALUES (%s, %s, %s, now(), %s)",
        (uid, log_date, steps, "2026-01-01T00:00:00Z" if deleted else None),
    )


def test_it_needs_a_token(client):
    for headers in ({}, {"Authorization": "Bearer kalo_" + "A" * 43}):
        r = client.get(URL, params={"date": DAY}, headers=headers)
        assert r.status_code == 401
        assert r.headers["www-authenticate"] == "Bearer"


def test_an_empty_day_is_zeros_not_404(client, me):
    assert daily(client, me) == {
        "date": DAY, "totals": ZEROS, "unknown": NONE_UNKNOWN, "goal": None, "steps": None, "log_count": 0,
    }  # fmt: skip


def test_totals_are_the_sum_of_the_days_logs(client, me):
    create(client, me, fdc_id=BANANA, quantity=150, log_date=DAY)  # 133.5 kcal
    create(client, me, fdc_id=CHICKEN, quantity=200, log_date=DAY)  # 330 kcal
    create(client, me, name="Two eggs", quantity=2, values=EGGS, log_date=DAY)  # 280 kcal, per serving
    create(client, me, fdc_id=BANANA, quantity=1000, log_date="2026-03-02")  # another day
    body = daily(client, me)
    assert body["log_count"] == 3
    assert body["unknown"] == NONE_UNKNOWN
    assert body["totals"] == {
        "calories": pytest.approx(133.5 + 330 + 280),
        "protein_g": pytest.approx(1.11 + 62.04 + 24),
        "carbs_g": pytest.approx(34.5 + 0 + 2),
        "fat_g": pytest.approx(0.435 + 7.14 + 20),
        "fiber_g": pytest.approx(2.55 + 0 + 0),
        "sugar_g": pytest.approx(23.7 + 0 + 1),
        "sodium_mg": pytest.approx(1.5 + 148 + 280),
    }
    assert daily(client, me, "2026-03-02")["totals"]["calories"] == pytest.approx(890)


def test_the_same_food_twice_in_a_day_counts_twice(client, me):
    create(client, me, fdc_id=BANANA, quantity=100, log_date=DAY)
    create(client, me, fdc_id=BANANA, quantity=100, log_date=DAY)
    body = daily(client, me)
    assert body["log_count"] == 2
    assert body["totals"]["calories"] == pytest.approx(178)
    assert body["totals"]["protein_g"] == pytest.approx(1.48)


def test_unreported_nutrients_add_zero_and_are_counted(client, me):
    create(client, me, fdc_id=OVERRIPE, quantity=100, log_date=DAY)  # no fiber, sugar or sodium
    create(client, me, fdc_id=BROCCOLI, quantity=100, log_date=DAY)  # no sugar; fiber 2.4, sodium 36
    create(client, me, fdc_id=BANANA, quantity=100, log_date=DAY)  # fiber 1.7, sugar 15.8, sodium 1
    body = daily(client, me)
    assert body["log_count"] == 3
    assert body["unknown"] == {"fiber_g": 1, "sugar_g": 2, "sodium_mg": 1}
    assert body["totals"]["calories"] == pytest.approx(85 + 39 + 89)
    assert body["totals"]["fiber_g"] == pytest.approx(2.4 + 1.7)
    assert body["totals"]["sugar_g"] == pytest.approx(15.8)
    assert body["totals"]["sodium_mg"] == pytest.approx(37)
    # A day where no log reports a nutrient totals 0 for it, never null.
    create(client, me, fdc_id=OVERRIPE, quantity=100, log_date="2026-03-03")
    alone = daily(client, me, "2026-03-03")
    assert (alone["totals"]["fiber_g"], alone["totals"]["sugar_g"], alone["totals"]["sodium_mg"]) == (0, 0, 0)
    assert alone["unknown"] == {"fiber_g": 1, "sugar_g": 1, "sodium_mg": 1}
    # A reported 0 is known.
    create(client, me, fdc_id=CHICKEN, quantity=100, log_date="2026-03-04")
    assert daily(client, me, "2026-03-04")["unknown"] == NONE_UNKNOWN


def test_edits_and_deletes_show_in_the_totals(client, me):
    banana = create(client, me, fdc_id=BANANA, quantity=100, log_date=DAY)
    chicken = create(client, me, fdc_id=CHICKEN, quantity=100, log_date=DAY)
    assert daily(client, me)["totals"]["calories"] == pytest.approx(254)
    patch(client, me, banana["id"], values={"calories": 100})  # typed over
    patch(client, me, banana["id"], quantity=200)  # and it scales
    assert daily(client, me)["totals"]["calories"] == pytest.approx(200 + 165)
    assert client.delete(f"/api/v1/food-logs/{chicken['id']}", headers=me).status_code == 204
    body = daily(client, me)
    assert (body["log_count"], body["totals"]["calories"]) == (1, pytest.approx(200))
    patch(client, me, banana["id"], log_date="2026-03-02")  # moved to the next day
    assert daily(client, me)["log_count"] == 0
    assert daily(client, me, "2026-03-02")["totals"]["calories"] == pytest.approx(200)


def test_another_users_logs_goal_and_steps_are_never_counted(client, me, other, db):
    create(client, other, fdc_id=CHICKEN, quantity=500, log_date=DAY)
    add_goal(db, user_id(client, other), "2026-01-01")
    add_steps(db, user_id(client, other), DAY, 9000)
    assert daily(client, me) == {
        "date": DAY, "totals": ZEROS, "unknown": NONE_UNKNOWN, "goal": None, "steps": None, "log_count": 0,
    }  # fmt: skip
    create(client, me, fdc_id=BANANA, quantity=100, log_date=DAY)
    assert daily(client, me)["totals"]["calories"] == pytest.approx(89)
    theirs = daily(client, other)
    assert (theirs["log_count"], theirs["steps"]) == (1, 9000)
    assert theirs["totals"]["calories"] == pytest.approx(825)


def test_the_goal_is_the_latest_one_in_force_on_that_day(client, me, db):
    uid = user_id(client, me)
    add_goal(db, uid, "2026-01-01", calories=2200.0)
    add_goal(db, uid, "2026-02-15", calories=2000.0, goal="maintain")
    add_goal(db, uid, "2026-02-20", calories=1.0, deleted=True)  # deleted: never in force
    add_goal(db, uid, "2026-03-10", calories=1800.0)  # starts later
    assert daily(client, me, "2025-12-31")["goal"] is None  # before the first
    assert daily(client, me, "2026-01-01")["goal"] == {**GOAL, "effective_date": "2026-01-01", "calories": 2200.0}
    assert daily(client, me, "2026-02-14")["goal"]["effective_date"] == "2026-01-01"
    assert daily(client, me)["goal"] == {
        **GOAL, "effective_date": "2026-02-15", "calories": 2000.0, "goal": "maintain",
    }  # fmt: skip
    assert daily(client, me, "2026-03-10")["goal"]["calories"] == 1800.0
    assert daily(client, me, "2030-01-01")["goal"]["calories"] == 1800.0


def test_steps_are_that_days(client, me, db):
    uid = user_id(client, me)
    add_steps(db, uid, DAY, 8421)
    add_steps(db, uid, "2026-03-02", 0)
    add_steps(db, uid, "2026-03-03", 5000, deleted=True)
    assert daily(client, me)["steps"] == 8421
    assert daily(client, me, "2026-03-02")["steps"] == 0  # a recorded 0 is not "none"
    assert daily(client, me, "2026-03-03")["steps"] is None
    assert daily(client, me, "2026-03-04")["steps"] is None


def test_the_totals_are_one_query_over_the_logs(client, me):
    for _ in range(3):
        create(client, me, fdc_id=BANANA, quantity=100, log_date=DAY)
    seen = []

    def record(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    engine = client.app.state.engine
    event.listen(engine, "before_cursor_execute", record)
    try:
        daily(client, me)
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert len([s for s in seen if "food_logs" in s]) == 1
    assert len(seen) == 4  # the token, the sums, the goal, the steps


@pytest.mark.parametrize("date", ["yesterday", "2026-02-30", "2026-3-1x", ""])
def test_a_bad_date_is_422(client, me, date):
    assert client.get(URL, params={"date": date}, headers=me).status_code == 422
