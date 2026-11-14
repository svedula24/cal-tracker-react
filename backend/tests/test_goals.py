"""The REST goal and day routes (app/api/v1/goals.py): GET /goals, PUT /goals/{effective_date},
POST /goals/suggest and PUT /daily-activity/{activity_date}.

Needs Postgres: set DATABASE_URL. Fixtures and helpers come from tests/test_food_logs.py.
"""

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
import test_food_logs as logs
from sqlalchemy import event
from test_food_logs import set_clock, set_timezone

client, db, me, other = logs.client, logs.db, logs.me, logs.other  # the fixtures, for this module too

pytestmark = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set")

GOALS = "/api/v1/goals"
ACTIVITY = "/api/v1/daily-activity"
GOAL = {
    "calories": 2000.0, "protein_g": 150.0, "carbs_g": 200.0, "fat_g": 65.0, "fiber_g": 30.0,
    "sugar_g": 50.0, "sodium_mg": 2300.0, "steps": 10000, "goal": "lose",
}  # fmt: skip
DEFAULTS = {"source": "manual", "workout_kcal": 0.0, "active_rest_kcal": 0.0}
SUGGEST = json.loads((Path(__file__).resolve().parents[2] / "shared" / "targets-fixtures.json").read_text())["suggest"]


def put_goal(client, who, day, status=200, **body):
    r = client.put(f"{GOALS}/{day}", json={**GOAL, **body}, headers=who)
    assert r.status_code == status, r.text
    return r.json()


def put_day(client, who, day, status=200, **body):
    r = client.put(f"{ACTIVITY}/{day}", json=body, headers=who)
    assert r.status_code == status, r.text
    return r.json()


def get_goal(client, who, day=None, status=200):
    r = client.get(GOALS, params={"day": day} if day else {}, headers=who)
    assert r.status_code == status, r.text
    return r.json()


def pulled(client, who):
    return client.post("/api/v1/sync", json={"cursor": None, "changes": {}}, headers=who).json()["changes"]


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("GET", GOALS, None),
        ("PUT", f"{GOALS}/2026-03-01", GOAL),
        ("POST", f"{GOALS}/suggest", SUGGEST[0]["input"]),
        ("PUT", f"{ACTIVITY}/2026-03-01", {"steps": 1}),
    ],
)
def test_every_route_needs_a_token(client, db, method, path, body):
    for headers in ({}, {"Authorization": "Bearer kalo_" + "A" * 43}):
        r = client.request(method, path, json=body, headers=headers)
        assert r.status_code == 401
    written = "SELECT (SELECT count(*) FROM user_goals) + (SELECT count(*) FROM daily_activity)"
    assert db.execute(written).fetchone() == (0,)


def test_put_creates_then_replaces_a_goal(client, me, db):
    assert put_goal(client, me, "2026-03-01") == {**GOAL, **DEFAULTS, "effective_date": "2026-03-01"}
    changed = {"calories": 1800.0, "source": "computed", "workout_kcal": 300.0, "active_rest_kcal": 120.5}
    assert put_goal(client, me, "2026-03-01", **changed) == {**GOAL, **changed, "effective_date": "2026-03-01"}
    # PUT is the whole goal: what is left out goes back to its default.
    assert put_goal(client, me, "2026-03-01")["workout_kcal"] == 0
    assert db.execute("SELECT count(*), max(rev) > 0 FROM user_goals").fetchone() == (1, True)


@pytest.mark.parametrize(
    ("change", "status"),
    [
        ({"user_id": "00000000-0000-0000-0000-000000000000"}, 422),  # unknown keys are refused, a user id above all
        ({"rev": 1}, 422),
        ({"updated_at": "2030-01-01T00:00:00Z"}, 422),
        ({"source": "guess"}, 422),
        ({"workout_kcal": -1}, 422),
        ({"active_rest_kcal": "300"}, 422),
        ({"calories": None}, 422),
        ({"goal": "bulk"}, 422),
    ],
)
def test_a_bad_goal_is_422_and_stores_nothing(client, me, db, change, status):
    put_goal(client, me, "2026-03-01", status, **change)
    assert db.execute("SELECT count(*) FROM user_goals").fetchone() == (0,)


@pytest.mark.parametrize("day", ["2026-02-30", "yesterday", "0001-01-01"])
def test_a_bad_date_in_the_path_is_422(client, me, day):
    put_goal(client, me, day, 422)
    put_day(client, me, day, 422, steps=1)


def test_get_returns_the_goal_in_force(client, me, db):
    set_clock(client, datetime(2026, 3, 10, 12, tzinfo=UTC))
    assert get_goal(client, me, status=404) == {"detail": "no goal in force on that day"}
    put_goal(client, me, "2026-01-01", calories=2200.0)
    put_goal(client, me, "2026-03-05", calories=1900.0)
    put_goal(client, me, "2026-04-01", calories=1500.0)
    assert get_goal(client, me)["calories"] == 1900  # today, by the clock
    assert get_goal(client, me, "2026-03-04")["effective_date"] == "2026-01-01"
    assert get_goal(client, me, "2026-04-01")["calories"] == 1500
    get_goal(client, me, "2025-12-31", status=404)
    # "today" is the user's: already 11 March in Tokyo.
    set_clock(client, datetime(2026, 3, 4, 20, tzinfo=UTC))
    set_timezone(db, "Asia/Tokyo")
    assert get_goal(client, me)["effective_date"] == "2026-03-05"


def test_a_goal_set_over_rest_reaches_the_phone_and_wins(client, me, db):
    """Through the same core as sync: a new rev, and the edit replaces a copy stamped ahead of now."""
    ahead = (datetime.now(UTC) + timedelta(minutes=4)).isoformat()
    phone = {**GOAL, **DEFAULTS, "effective_date": "2026-03-01", "updated_at": ahead, "deleted_at": None}
    assert client.post("/api/v1/sync", json={"changes": {"goals": [phone]}}, headers=me).json()["rejected"] == []
    rev = db.execute("SELECT rev FROM user_goals").fetchone()[0]
    put_goal(client, me, "2026-03-01", calories=1750.0, source="computed")
    assert db.execute("SELECT calories, rev > %s FROM user_goals", (rev,)).fetchone() == (1750, True)
    (goal,) = pulled(client, me)["goals"]
    assert (goal["calories"], goal["source"]) == (1750, "computed")


def test_put_brings_a_deleted_goal_back(client, me, db):
    put_goal(client, me, "2026-03-01")
    db.execute("UPDATE user_goals SET deleted_at = updated_at")
    get_goal(client, me, "2026-03-01", 404)
    put_goal(client, me, "2026-03-01")
    assert get_goal(client, me, "2026-03-01")["effective_date"] == "2026-03-01"


def test_put_daily_activity(client, me, db):
    assert put_day(client, me, "2026-03-01", steps=8000, day_type="workout", workout_kcal=0) == {
        "activity_date": "2026-03-01", "steps": 8000, "day_type": "workout", "workout_kcal": 0,
    }  # fmt: skip
    # The whole day: what is left out is cleared.
    assert put_day(client, me, "2026-03-01", steps=9000) == {
        "activity_date": "2026-03-01", "steps": 9000, "day_type": None, "workout_kcal": None,
    }  # fmt: skip
    put_day(client, me, "2026-03-01", steps=9000, day_type="active_rest")
    (day,) = pulled(client, me)["daily_activity"]
    assert (day["activity_date"], day["steps"], day["day_type"]) == ("2026-03-01", 9000, "active_rest")
    nutrition = client.get("/api/v1/nutrition/daily", params={"date": "2026-03-01"}, headers=me).json()
    assert nutrition["activity"] == {"steps": 9000, "day_type": "active_rest", "workout_kcal": None}


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"steps": -1},
        {"steps": 1.5},
        {"steps": 1, "day_type": "active_recovery"},
        {"steps": 1, "workout_kcal": -1},
        {"steps": 1, "log_date": "2026-03-01"},
        {"steps": 1, "user_id": "00000000-0000-0000-0000-000000000000"},
    ],
)
def test_a_bad_day_is_422_and_stores_nothing(client, me, db, body):
    put_day(client, me, "2026-03-01", 422, **body)
    assert db.execute("SELECT count(*) FROM daily_activity").fetchone() == (0,)


def test_writes_lock_the_user_row_first(client, me):
    seen = []

    def record(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    engine = client.app.state.engine
    for request in (lambda: put_goal(client, me, "2026-03-01"), lambda: put_day(client, me, "2026-03-01", steps=1)):
        seen.clear()
        event.listen(engine, "before_cursor_execute", record)
        try:
            request()
        finally:
            event.remove(engine, "before_cursor_execute", record)
        after_auth = [s for s in seen if "user_tokens" not in s]
        assert after_auth[0].startswith("SELECT users.id") and after_auth[0].rstrip().endswith("FOR UPDATE")


def test_users_never_see_or_change_each_others_goals_and_days(client, me, other, db):
    put_goal(client, me, "2026-03-01", calories=1800.0)
    put_day(client, me, "2026-03-01", steps=5000, day_type="workout")
    # The other user sees none of it.
    get_goal(client, other, "2026-03-01", 404)
    assert pulled(client, other) == {"food_logs": [], "saved_foods": [], "goals": [], "daily_activity": []}
    theirs = client.get("/api/v1/nutrition/daily", params={"date": "2026-03-01"}, headers=other).json()
    assert (theirs["goal"], theirs["activity"], theirs["target"]) == (None, None, None)
    # Writing the same keys makes their own rows and leaves mine alone.
    put_goal(client, other, "2026-03-01", calories=3000.0)
    put_day(client, other, "2026-03-01", steps=1)
    assert get_goal(client, me, "2026-03-01")["calories"] == 1800
    assert get_goal(client, other, "2026-03-01")["calories"] == 3000
    mine = client.get("/api/v1/nutrition/daily", params={"date": "2026-03-01"}, headers=me).json()
    assert mine["activity"] == {"steps": 5000, "day_type": "workout", "workout_kcal": None}
    assert db.execute("SELECT count(DISTINCT user_id), count(*) FROM user_goals").fetchone() == (2, 2)
    assert db.execute("SELECT count(DISTINCT user_id), count(*) FROM daily_activity").fetchone() == (2, 2)


@pytest.mark.parametrize("case", SUGGEST, ids=lambda case: case["name"])
def test_suggest_answers_the_shared_cases(client, me, case):
    r = client.post(f"{GOALS}/suggest", json=case["input"], headers=me)
    assert r.status_code == 200, r.text
    assert r.json() == case["expected"]


def test_suggest_stores_nothing(client, me, db):
    tables = ("user_goals", "daily_activity", "food_logs", "saved_foods")

    def counts():
        return [db.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in tables]

    before = counts()
    client.post(f"{GOALS}/suggest", json=SUGGEST[0]["input"], headers=me)
    assert counts() == before
    profile_columns = (
        "SELECT count(*) FROM information_schema.columns"
        " WHERE column_name IN ('sex', 'age', 'height_cm', 'weight_kg') AND table_schema = current_schema()"
    )
    assert db.execute(profile_columns).fetchone() == (0,)  # there is nowhere to store them


@pytest.mark.parametrize(
    "change",
    [
        {"sex": "other"},
        {"age": 0},
        {"age": 9.9},  # the accepted ranges: age 10-120, height_cm 50-300, weight_kg 20-500
        {"age": 121},
        {"age": "30"},
        {"height_cm": -1},
        {"height_cm": 49},
        {"height_cm": 301},
        {"weight_kg": 0},
        {"weight_kg": 19.9},
        {"weight_kg": 501},
        {"weight_kg": 5000},
        {"height_cm": True},
        {"goal": "bulk"},
        {"activity": 1.5},
    ],
)
def test_a_bad_suggest_request_is_422(client, me, change):
    body = {**SUGGEST[0]["input"], **change}
    assert client.post(f"{GOALS}/suggest", json=body, headers=me).status_code == 422
