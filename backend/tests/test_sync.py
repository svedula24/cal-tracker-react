"""POST /api/v1/sync (app/api/v1/sync.py, app/services/sync.py, app/services/logs.py).

Needs Postgres: set DATABASE_URL. Each test runs the app (`create_app`, which includes the sync
router) against a freshly migrated scratch schema with a few foods loaded.
"""

import json
import os
import uuid
from datetime import UTC, datetime, timedelta

import psycopg
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event

from app.main import create_app
from app.services import sync as sync_service
from kalo.usda.load import load
from kalo.usda.nutrients import FoodRow

pytestmark = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set")

URL = "/api/v1/sync"
BANANA = 1
OVERRIPE = 2  # reports no fiber, sugar or sodium
BROCCOLI = 4  # reports no sugar
UNKNOWN = 999

FOODS = [
    # fdc_id, description, calories, protein, carbs, fat, fiber, sugar, sodium (mg)
    (BANANA, "Bananas, raw", 89.0, 0.75, 23.0, 0.25, 1.5, 15.5, 1.0),
    (OVERRIPE, "Bananas, overripe, raw", 85.0, 0.75, 20.5, 0.25, None, None, None),
    (BROCCOLI, "Broccoli, raw", 39.0, 2.5, 6.25, 0.5, 2.5, None, 36.0),
]
BANANA_VALUES = {
    "calories": 89.0, "protein_g": 0.75, "carbs_g": 23.0, "fat_g": 0.25,
    "fiber_g": 1.5, "sugar_g": 15.5, "sodium_mg": 1.0,
}  # fmt: skip
EGGS = {"calories": 140, "protein_g": 12, "carbs_g": 1, "fat_g": 10, "fiber_g": 0, "sugar_g": 0.5, "sodium_mg": 140}
T0 = "2026-11-10T19:12:00.000Z"
EMPTY = {"food_logs": [], "saved_foods": [], "goals": [], "daily_activity": []}
TABLE_OF = {
    "food_logs": "food_logs", "saved_foods": "saved_foods", "goals": "user_goals", "daily_activity": "daily_activity",
}  # fmt: skip
KEY_OF = {"food_logs": "id", "saved_foods": "fdc_id", "goals": "effective_date", "daily_activity": "activity_date"}


@pytest.fixture
def client(migrated_url):
    rows = [
        FoodRow(fdc_id=i, description=d, data_type="SR Legacy", brand_name=None, calories_per_100g=kcal,
                protein_per_100g=p, carbs_per_100g=c, fat_per_100g=f,
                fiber_per_100g=fiber, sugar_per_100g=sugar, sodium_mg_per_100g=sodium)
        for i, d, kcal, p, c, f, fiber, sugar, sodium in FOODS
    ]  # fmt: skip
    load(rows, [], migrated_url)
    with TestClient(create_app(migrated_url)) as c:
        yield c


@pytest.fixture
def db(migrated_url):
    """A second connection to the same scratch schema: it sees only what the app committed."""
    with psycopg.connect(migrated_url, autocommit=True) as conn:
        yield conn


@pytest.fixture
def statements(client):
    seen = []

    def record(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    engine = client.app.state.engine
    event.listen(engine, "before_cursor_execute", record)
    yield seen
    event.remove(engine, "before_cursor_execute", record)


def register(client):
    r = client.post("/api/v1/devices", json={})
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture
def me(client):
    return register(client)


@pytest.fixture
def other(client):
    return register(client)


def sync(client, who, cursor=None, status=200, **changes):
    r = client.post(URL, json={"cursor": cursor, "changes": changes}, headers=who)
    assert r.status_code == status, r.text
    return r.json()


def pull_all(client, who, cursor=None):
    """Every page from `cursor` on: (the rows per table, the final cursor, the number of calls)."""
    got = {table: [] for table in EMPTY}
    for calls in range(1, 20):
        page = sync(client, who, cursor)
        for table, rows in page["changes"].items():
            got[table].extend(rows)
        assert page["cursor"] >= (cursor or 0)
        cursor = page["cursor"]
        if not page["has_more"]:
            return got, cursor, calls
    raise AssertionError("has_more never ended")


def when(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def at(minutes):
    """T0 plus that many minutes, as the app sends it."""
    return (when(T0) + timedelta(minutes=minutes)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def food_log(**over):
    """A log of 150 g of banana, as the app's mapping sends it."""
    row = {
        "id": str(uuid.uuid4()),
        "fdc_id": BANANA,
        "log_date": "2026-11-10",
        "logged_at": T0,
        "name": "Bananas, raw",
        "food_name": "Bananas, raw",
        "unit": "g",
        "quantity": 150,
        "values": dict(BANANA_VALUES),
        "food_values": dict(BANANA_VALUES),
        "updated_at": T0,
        "deleted_at": None,
    }
    return {**row, **over}


def custom_log(**over):
    """A hand-written entry: no food behind it, counted in servings."""
    row = {"fdc_id": None, "name": "Scrambled eggs", "food_name": None, "unit": "serving", "quantity": 2,
           "values": dict(EGGS), "food_values": None}  # fmt: skip
    return food_log(**{**row, **over})


def goal(**over):
    row = {"effective_date": "2026-11-01", "calories": 2000, "protein_g": 150, "carbs_g": 200, "fat_g": 70,
           "fiber_g": 30, "sugar_g": 50, "sodium_mg": 2300, "steps": 8000, "goal": "maintain",
           "updated_at": T0, "deleted_at": None,
           "source": "manual", "workout_kcal": 0, "active_rest_kcal": 0}  # fmt: skip
    return {**row, **over}


def steps(day="2026-11-10", count=5000, **over):
    """A daily_activity row."""
    row = {"activity_date": day, "steps": count, "updated_at": T0, "deleted_at": None, "day_type": None,
           "workout_kcal": None}  # fmt: skip
    return {**row, **over}


def legacy_steps(day="2026-11-10", count=5000, **over):
    """A day as an app from before daily_activity pushes it: under daily_steps, keyed by log_date."""
    return {"log_date": day, "steps": count, "updated_at": T0, "deleted_at": None, **over}


def saved(fdc_id=BANANA, **over):
    return {"fdc_id": fdc_id, "saved_at": T0, "updated_at": T0, "deleted_at": None, **over}


def tombstone(key, value, minutes=1):
    return {key: value, "updated_at": at(minutes), "deleted_at": at(minutes)}


def stored(db, table="food_logs", columns="*"):
    cur = db.execute(f"SELECT {columns} FROM {TABLE_OF[table]} ORDER BY rev")
    names = [c.name for c in cur.description]
    return [dict(zip(names, row, strict=True)) for row in cur.fetchall()]


def max_rev(db):
    union = " UNION ALL ".join(f"SELECT rev FROM {table}" for table in TABLE_OF.values())
    return db.execute(f"SELECT coalesce(max(rev), 0) FROM ({union}) r").fetchone()[0]


def same_moment(wire, expected):
    return when(wire) == when(expected)


# ---- auth and the envelope ----


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer kalo_" + "A" * 43}, {"Authorization": "nope"}])
def test_sync_needs_a_valid_token_and_writes_nothing_without_one(client, db, headers):
    r = client.post(URL, json={"cursor": None, "changes": {"food_logs": [food_log()]}}, headers=headers)
    assert r.status_code == 401
    assert r.headers["www-authenticate"] == "Bearer"
    assert stored(db) == []


def test_an_empty_sync_of_a_new_user(client, me):
    assert sync(client, me) == {"cursor": 0, "has_more": False, "changes": EMPTY, "rejected": []}
    # `changes` and `cursor` may be left out altogether.
    r = client.post(URL, json={}, headers=me)
    assert r.status_code == 200 and r.json()["cursor"] == 0


@pytest.mark.parametrize(
    "body",
    [
        [],
        {"cursor": "12", "changes": {}},
        {"cursor": -1, "changes": {}},
        {"cursor": 1.5, "changes": {}},
        {"cursor": 2**63, "changes": {}},
        {"cursor": None, "changes": []},
        {"cursor": None, "changes": {"food_logs": {}}},
        {"cursor": None, "changes": {"food_logs": ["not a row"]}},
        {"cursor": None, "changes": {"food_logs": [None]}},
        {"cursor": None, "changes": {"meals": []}},  # a table the server does not know
        {"cursor": None, "changes": {}, "user_id": str(uuid.uuid4())},
    ],
)
def test_a_malformed_envelope_is_422(client, me, db, body):
    assert client.post(URL, json=body, headers=me).status_code == 422
    assert stored(db) == []


def test_more_than_500_rows_is_413_and_nothing_is_stored(client, me, db):
    logs = [food_log() for _ in range(300)]
    days = [steps(day=f"2026-{m:02d}-{d:02d}") for m in range(1, 9) for d in range(1, 26)]  # 200
    body = sync(client, me, status=413, food_logs=logs, daily_activity=days, goals=[goal()])
    assert "500" in body["detail"]
    assert stored(db) == [] and stored(db, "daily_activity") == [] and stored(db, "goals") == []
    # Exactly 500 is fine.
    ok = sync(client, me, food_logs=logs, daily_activity=days)
    assert ok["rejected"] == [] and len(stored(db)) == 300 and len(stored(db, "daily_activity")) == 200


# ---- push ----


def test_a_pushed_log_is_stored_as_sent_and_is_not_sent_back(client, me, db):
    log = food_log(name="Banana (ripe)", quantity=118.5, logged_at="2026-11-10T23:30:00.000-08:00")
    out = sync(client, me, food_logs=[log])
    assert out["changes"] == EMPTY and out["rejected"] == [] and out["has_more"] is False
    (row,) = stored(db)
    assert out["cursor"] == row["rev"] == max_rev(db)
    assert str(row["id"]) == log["id"]
    assert (row["fdc_id"], row["name"], row["food_name"]) == (BANANA, "Banana (ripe)", "Bananas, raw")
    assert (row["unit"], row["quantity"]) == ("g", 118.5)
    assert str(row["log_date"]) == "2026-11-10"  # the client's local day, whatever the UTC instant is
    assert row["logged_at"] == when("2026-11-11T07:30:00Z")
    assert row["updated_at"] == when(T0) and row["deleted_at"] is None
    assert [row[f"unit_{n}"] for n in BANANA_VALUES] == list(BANANA_VALUES.values())
    assert row["food_calories_per_100g"] == 89.0 and row["food_sodium_mg_per_100g"] == 1.0
    assert row["calories"] == pytest.approx(89.0 * 118.5 / 100)  # the generated total
    # Pulling from that cursor finds nothing and leaves the cursor where it is.
    assert sync(client, me, cursor=out["cursor"]) == {**out, "cursor": out["cursor"]}


def test_a_pull_returns_rows_in_the_wire_format(client, me):
    log, entry = food_log(), custom_log(logged_at="2026-11-10T08:00:00.000+05:30")
    sync(client, me, food_logs=[log, entry], goals=[goal()], daily_activity=[steps()], saved_foods=[saved()])
    got, _, _ = pull_all(client, me)
    by_id = {row["id"]: row for row in got["food_logs"]}
    assert set(by_id) == {log["id"], entry["id"]}
    pulled = by_id[log["id"]]
    assert set(pulled) == set(log)  # no totals, no rev, no user id
    for key in ("logged_at", "updated_at"):
        assert same_moment(pulled.pop(key), log[key])
    assert pulled == {k: v for k, v in log.items() if k not in ("logged_at", "updated_at")}
    custom = by_id[entry["id"]]
    assert (custom["fdc_id"], custom["food_name"], custom["food_values"]) == (None, None, None)
    assert (custom["unit"], custom["quantity"], custom["values"]) == ("serving", 2, EGGS)
    # Timestamps come back in UTC with a zone.
    assert custom["logged_at"].endswith("Z") and same_moment(custom["logged_at"], "2026-11-10T02:30:00Z")
    (g,), (s,), (f,) = got["goals"], got["daily_activity"], got["saved_foods"]
    assert {**g, "updated_at": T0} == goal()
    assert {**s, "updated_at": T0} == steps()
    assert {**f, "updated_at": T0, "saved_at": T0} == saved()


def test_rev_order_is_write_order_and_the_cursor_is_the_highest_rev(client, me, db):
    cursors = [
        sync(client, me, food_logs=[food_log()])["cursor"],
        sync(client, me, daily_activity=[steps()])["cursor"],
        sync(client, me, goals=[goal()])["cursor"],
        sync(client, me, saved_foods=[saved()])["cursor"],
        sync(client, me, daily_activity=[steps(count=6000, updated_at=at(1))])["cursor"],  # an update gets a new rev
        sync(client, me, food_logs=[custom_log()])["cursor"],
    ]
    assert cursors == sorted(set(cursors))
    assert cursors[-1] == max_rev(db)
    by_table = {t: [r["rev"] for r in stored(db, t)] for t in TABLE_OF}
    assert by_table == {
        "food_logs": [cursors[0], cursors[5]],
        "daily_activity": [cursors[4]],  # the update's rev, not the insert's
        "goals": [cursors[2]],
        "saved_foods": [cursors[3]],
    }
    # A pull from any earlier cursor returns exactly what was written after it, oldest first.
    later = sync(client, me, cursor=cursors[2])["changes"]
    assert [len(later[t]) for t in ("food_logs", "saved_foods", "goals", "daily_activity")] == [1, 1, 0, 1]
    assert later["daily_activity"][0]["steps"] == 6000


def test_the_user_row_is_locked_first_and_the_request_is_one_transaction(client, me, db, statements, monkeypatch):
    sync(client, me, food_logs=[food_log()])
    after_auth = [s for s in statements if "user_tokens" not in s]
    assert after_auth[0].startswith("SELECT users.id") and after_auth[0].rstrip().endswith("FOR UPDATE")

    # If anything fails after the push, nothing of the request is kept.
    def broken(*args, **kwargs):
        raise RuntimeError("pull failed")

    monkeypatch.setattr(sync_service, "pull", broken)
    with pytest.raises(RuntimeError, match="pull failed"):
        sync(client, me, food_logs=[food_log()], daily_activity=[steps()])
    assert len(stored(db)) == 1 and stored(db, "daily_activity") == []


def test_a_batch_of_400_logs_is_a_handful_of_statements(client, me, db, statements):
    first = [food_log(fdc_id=[BANANA, OVERRIPE, BROCCOLI, UNKNOWN][i % 4]) for i in range(400)]
    statements.clear()
    assert sync(client, me, food_logs=first)["rejected"] == []
    assert len(stored(db)) == 400
    assert len(statements) <= 12, statements
    # And the same for 400 updates.
    statements.clear()
    edits = [{**log, "quantity": 75, "updated_at": at(1)} for log in first]
    assert sync(client, me, food_logs=edits)["rejected"] == []
    assert {row["quantity"] for row in stored(db)} == {75}
    assert len(statements) <= 15, statements


# ---- last write wins ----


def test_a_stale_push_loses_and_the_winner_comes_back(client, me, db):
    log = food_log()
    sync(client, me, food_logs=[log])
    newer = {**log, "quantity": 200, "name": "Two bananas", "updated_at": at(10)}
    cursor = sync(client, me, food_logs=[newer])["cursor"]
    before = stored(db)

    stale = {**log, "quantity": 50, "updated_at": at(5)}
    out = sync(client, me, cursor=cursor, food_logs=[stale])  # the client had already pulled everything
    assert out["rejected"] == []
    (winner,) = out["changes"]["food_logs"]
    assert (winner["id"], winner["quantity"], winner["name"]) == (log["id"], 200, "Two bananas")
    assert same_moment(winner["updated_at"], at(10))
    assert out["cursor"] == cursor
    assert stored(db) == before  # not touched: same data, same rev


def test_the_winner_is_sent_once_when_it_is_also_on_the_pulled_page(client, me):
    log = food_log()
    sync(client, me, food_logs=[{**log, "quantity": 200, "updated_at": at(10)}])
    out = sync(client, me, cursor=None, food_logs=[{**log, "quantity": 50, "updated_at": at(5)}])
    assert [row["quantity"] for row in out["changes"]["food_logs"]] == [200]


def test_an_equal_updated_at_is_applied(client, me, db):
    log = food_log()
    sync(client, me, food_logs=[log])
    out = sync(client, me, food_logs=[{**log, "quantity": 99}])
    assert out["changes"] == EMPTY
    assert stored(db)[0]["quantity"] == 99


def test_last_write_wins_on_every_table(client, me, db):
    sync(client, me, goals=[goal(updated_at=at(10))], daily_activity=[steps(updated_at=at(10))],
         saved_foods=[saved(updated_at=at(10))])  # fmt: skip
    cursor = max_rev(db)
    out = sync(client, me, cursor=cursor,
               goals=[goal(calories=1500, updated_at=at(5))],
               daily_activity=[steps(count=1, updated_at=at(5))],
               saved_foods=[saved(saved_at=at(3), updated_at=at(5))])  # fmt: skip
    assert out["rejected"] == [] and out["cursor"] == cursor == max_rev(db)
    assert out["changes"]["goals"][0]["calories"] == 2000
    assert out["changes"]["daily_activity"][0]["steps"] == 5000
    assert same_moment(out["changes"]["saved_foods"][0]["saved_at"], T0)
    # A newer one is applied and not sent back.
    out = sync(client, me, cursor=cursor,
               goals=[goal(calories=1500, goal="lose", updated_at=at(11))],
               daily_activity=[steps(count=7000, updated_at=at(11))],
               saved_foods=[saved(saved_at=at(3), updated_at=at(11))])  # fmt: skip
    assert out["changes"] == EMPTY and out["cursor"] == max_rev(db) > cursor
    assert [(g["calories"], g["goal"]) for g in stored(db, "goals")] == [(1500, "lose")]
    assert stored(db, "daily_activity")[0]["steps"] == 7000
    assert stored(db, "saved_foods")[0]["saved_at"] == when(at(3))


def test_the_same_key_twice_in_one_request_ends_with_the_newer(client, me, db):
    log = food_log()
    out = sync(client, me,
               food_logs=[{**log, "quantity": 1, "updated_at": at(2)}, {**log, "quantity": 2, "updated_at": at(1)}],
               daily_activity=[steps(count=1, updated_at=at(1)), steps(count=2, updated_at=at(2))])  # fmt: skip
    assert out["rejected"] == []
    assert [row["quantity"] for row in stored(db)] == [1]
    assert [row["steps"] for row in stored(db, "daily_activity")] == [2]
    # The row that lost to the other one in the same request is not reported as a server change.
    assert out["changes"] == EMPTY


def test_replaying_a_request_changes_nothing(client, me, db):
    request = {
        "food_logs": [food_log(), custom_log(), food_log(fdc_id=OVERRIPE), food_log(fdc_id=UNKNOWN)],
        "goals": [goal()],
        "daily_activity": [steps()],
        "saved_foods": [saved()],
    }
    first = sync(client, me, **request)
    tables = ("food_logs", "goals", "daily_activity", "saved_foods")
    before = {t: stored(db, t) for t in tables}
    again = sync(client, me, **request)
    assert again["rejected"] == first["rejected"] == []
    assert {t: stored(db, t) for t in tables} == before  # the same data and, as nothing changed, the same revs
    assert again["cursor"] == first["cursor"]
    # The replay did not know the first answer: it is sent its rows back (from its old cursor), once each.
    assert sorted(r["id"] for r in again["changes"]["food_logs"]) == sorted(r["id"] for r in request["food_logs"])
    # With the first answer's cursor it gets nothing.
    assert sync(client, me, cursor=first["cursor"], **request)["changes"] == EMPTY


def test_an_updated_at_in_the_future_is_clamped_to_five_minutes_ahead(client, me, db):
    ahead = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    soon = (datetime.now(UTC) + timedelta(minutes=2)).isoformat()
    log, near = food_log(updated_at=ahead), food_log(updated_at=soon)
    sync(client, me, food_logs=[log, near], daily_activity=[steps(updated_at=ahead)],
         goals=[goal(updated_at=ahead)], saved_foods=[saved(updated_at=ahead)])  # fmt: skip
    now = datetime.now(UTC)
    by_id = {str(row["id"]): row["updated_at"] for row in stored(db)}
    clamped = [by_id[log["id"]]] + [stored(db, t)[0]["updated_at"] for t in ("daily_activity", "goals", "saved_foods")]
    for value in clamped:
        assert timedelta(minutes=4) < value - now <= timedelta(minutes=5)
    assert by_id[near["id"]] == when(soon)  # within the allowance: kept as sent
    # So an edit made six minutes later, by an honest clock, wins.
    db.execute("UPDATE food_logs SET updated_at = updated_at - interval '6 minutes'")
    sync(client, me, food_logs=[{**log, "quantity": 42, "updated_at": datetime.now(UTC).isoformat()}])
    assert {str(r["id"]): r["quantity"] for r in stored(db)}[log["id"]] == 42
    # A deletion from the future is clamped too.
    sync(client, me, food_logs=[{"id": near["id"], "updated_at": ahead, "deleted_at": ahead}])
    row = next(r for r in stored(db) if str(r["id"]) == near["id"])
    assert row["deleted_at"] - datetime.now(UTC) <= timedelta(minutes=5)
    assert row["updated_at"] - datetime.now(UTC) <= timedelta(minutes=5)


# ---- tombstones ----


def test_a_tombstone_deletes_and_is_pulled_with_its_data(client, me, db):
    log = food_log()
    sync(client, me, food_logs=[log], goals=[goal()], daily_activity=[steps()], saved_foods=[saved()])
    out = sync(
        client,
        me,
        cursor=max_rev(db),
        food_logs=[tombstone("id", log["id"])],
        goals=[tombstone("effective_date", "2026-11-01")],
        daily_activity=[tombstone("activity_date", "2026-11-10")],
        saved_foods=[tombstone("fdc_id", BANANA)],
    )
    assert out["rejected"] == [] and out["changes"] == EMPTY
    (row,) = stored(db)
    assert row["deleted_at"] == row["updated_at"] == when(at(1))
    assert (row["name"], row["quantity"]) == ("Bananas, raw", 150)  # the data is kept
    for table in ("goals", "daily_activity", "saved_foods"):
        assert stored(db, table)[0]["deleted_at"] == when(at(1))
    # Another device (a pull from the start) gets the deletions, with the rows' data.
    got, _, _ = pull_all(client, me)
    (pulled,) = got["food_logs"]
    assert same_moment(pulled["deleted_at"], at(1)) and pulled["values"] == BANANA_VALUES
    assert got["goals"][0]["calories"] == 2000 and same_moment(got["goals"][0]["deleted_at"], at(1))
    assert got["daily_activity"][0]["steps"] == 5000 and got["daily_activity"][0]["deleted_at"]
    assert got["saved_foods"][0]["fdc_id"] == BANANA and got["saved_foods"][0]["deleted_at"]


def test_a_tombstone_for_a_row_the_server_never_had_is_ignored(client, me, db):
    out = sync(
        client,
        me,
        food_logs=[tombstone("id", str(uuid.uuid4()))],
        goals=[tombstone("effective_date", "2026-11-01")],
        daily_activity=[tombstone("activity_date", "2026-11-10")],
        saved_foods=[tombstone("fdc_id", BANANA), tombstone("fdc_id", UNKNOWN)],  # also for a food it does not have
    )
    assert out == {"cursor": 0, "has_more": False, "changes": EMPTY, "rejected": []}
    assert all(stored(db, table) == [] for table in TABLE_OF)


def test_a_tombstone_carrying_the_whole_row_is_still_only_a_deletion(client, me, db):
    log = food_log()
    sync(client, me, food_logs=[log])
    # The data it carries is ignored, even when it would not validate.
    sync(client, me, food_logs=[{**log, "quantity": -5, "name": "", "updated_at": at(1), "deleted_at": at(1)}])
    (row,) = stored(db)
    assert row["deleted_at"] == when(at(1)) and (row["name"], row["quantity"]) == ("Bananas, raw", 150)
    # And one for a row the server never had inserts nothing.
    sync(client, me, food_logs=[food_log(updated_at=at(1), deleted_at=at(1))])
    assert len(stored(db)) == 1


def test_an_older_live_row_loses_to_a_newer_tombstone(client, me, db):
    log = food_log()
    sync(client, me, food_logs=[log])
    cursor = sync(client, me, food_logs=[tombstone("id", log["id"], minutes=10)])["cursor"]
    out = sync(client, me, cursor=cursor, food_logs=[{**log, "quantity": 77, "updated_at": at(5)}])
    (winner,) = out["changes"]["food_logs"]  # the deletion, so the device deletes its copy
    assert winner["id"] == log["id"] and same_moment(winner["deleted_at"], at(10)) and winner["quantity"] == 150
    assert stored(db)[0]["deleted_at"] == when(at(10)) and stored(db)[0]["quantity"] == 150


def test_an_older_tombstone_loses_to_a_newer_live_row(client, me, db):
    log = food_log(updated_at=at(10))
    cursor = sync(client, me, food_logs=[log])["cursor"]
    out = sync(client, me, cursor=cursor, food_logs=[tombstone("id", log["id"], minutes=5)])
    (winner,) = out["changes"]["food_logs"]
    assert winner["id"] == log["id"] and winner["deleted_at"] is None
    assert stored(db)[0]["deleted_at"] is None


def test_a_newer_live_row_brings_a_deleted_row_back(client, me, db):
    log = food_log()
    sync(client, me, food_logs=[log], daily_activity=[steps()])
    sync(client, me, food_logs=[tombstone("id", log["id"], 1)],
         daily_activity=[tombstone("activity_date", "2026-11-10", 1)])  # fmt: skip
    out = sync(client, me, food_logs=[{**log, "quantity": 60, "updated_at": at(2)}],
               daily_activity=[steps(count=9000, updated_at=at(2))])  # fmt: skip
    assert out["rejected"] == []
    (row,) = stored(db)
    assert (row["deleted_at"], row["quantity"], row["updated_at"]) == (None, 60, when(at(2)))
    assert [(s["deleted_at"], s["steps"]) for s in stored(db, "daily_activity")] == [(None, 9000)]


def test_a_tombstone_for_a_deleted_row_keeps_it_deleted(client, me, db):
    log = food_log()
    sync(client, me, food_logs=[log])
    sync(client, me, food_logs=[tombstone("id", log["id"], minutes=5)])
    rev = stored(db)[0]["rev"]
    # An older one changes nothing; the same one again changes nothing; a newer one moves the times.
    sync(client, me, food_logs=[tombstone("id", log["id"], minutes=3)])
    sync(client, me, food_logs=[tombstone("id", log["id"], minutes=5)])
    assert stored(db)[0]["rev"] == rev and stored(db)[0]["deleted_at"] == when(at(5))
    sync(client, me, food_logs=[tombstone("id", log["id"], minutes=8)])
    (row,) = stored(db)
    assert row["deleted_at"] == row["updated_at"] == when(at(8)) and row["rev"] > rev


# ---- foods behind a log ----


def test_a_log_of_a_food_the_server_does_not_have_is_kept_as_a_custom_entry(client, me, db):
    log = food_log(fdc_id=UNKNOWN, name="Mystery fruit", food_name="Fruit, mystery", quantity=80)
    assert sync(client, me, food_logs=[log])["rejected"] == []
    (row,) = stored(db)
    assert (row["fdc_id"], row["food_name"]) == (None, None)
    assert all(row[c] is None for c in row if c.startswith("food_") and c.endswith("per_100g"))
    assert (row["name"], row["unit"], row["quantity"]) == ("Mystery fruit", "g", 80)
    assert [row[f"unit_{n}"] for n in BANANA_VALUES] == list(BANANA_VALUES.values())
    assert row["calories"] == pytest.approx(89.0 * 0.8)
    (pulled,) = pull_all(client, me)[0]["food_logs"]
    assert (pulled["fdc_id"], pulled["food_name"], pulled["food_values"]) == (None, None, None)
    assert pulled["values"] == BANANA_VALUES


def test_zero_is_stored_as_null_where_the_food_does_not_report_the_nutrient(client, me, db):
    zeros = {
        "calories": 85.0,
        "protein_g": 0.75,
        "carbs_g": 20.5,
        "fat_g": 0.25,
        "fiber_g": 0,
        "sugar_g": 0,
        "sodium_mg": 0,
    }
    overripe = food_log(fdc_id=OVERRIPE, name="Overripe", food_name="Bananas, overripe, raw",
                        values=dict(zeros), food_values=dict(zeros))  # fmt: skip
    # Broccoli reports fiber and sodium but not sugar; the user typed their own fiber, and a real 0 sodium.
    typed = {
        "calories": 39.0,
        "protein_g": 2.5,
        "carbs_g": 6.25,
        "fat_g": 0.5,
        "fiber_g": 0,
        "sugar_g": 3,
        "sodium_mg": 0,
    }
    food = {
        "calories": 39.0,
        "protein_g": 2.5,
        "carbs_g": 6.25,
        "fat_g": 0.5,
        "fiber_g": 2.5,
        "sugar_g": 0,
        "sodium_mg": 36,
    }
    broccoli = food_log(fdc_id=BROCCOLI, name="Broccoli", food_name="Broccoli, raw", values=typed, food_values=food)
    banana = food_log(values={**BANANA_VALUES, "fiber_g": 0})  # banana reports fiber: a typed 0 is a 0
    custom = custom_log(values={**EGGS, "fiber_g": 0, "sugar_g": None})
    assert sync(client, me, food_logs=[overripe, broccoli, banana, custom])["rejected"] == []
    rows = {str(r["id"]): r for r in stored(db)}

    def optional(log, prefix, suffixes=("fiber_g", "sugar_g", "sodium_mg")):
        return [rows[log["id"]][prefix + s] for s in suffixes]

    food_columns = ("fiber_per_100g", "sugar_per_100g", "sodium_mg_per_100g")
    assert optional(overripe, "unit_") == [None, None, None]
    assert optional(overripe, "food_", food_columns) == [None, None, None]
    assert optional(overripe, "") == [None, None, None]  # the totals
    assert rows[overripe["id"]]["unit_carbs_g"] == 20.5
    assert optional(broccoli, "unit_") == [0, 3, 0]  # a typed-over sugar is kept; 0 fiber and sodium are real
    assert optional(broccoli, "food_", food_columns) == [2.5, None, 36]
    assert optional(banana, "unit_") == [0, 15.5, 1.0]
    assert optional(custom, "unit_") == [0, None, 140]  # a custom entry is stored as sent
    # What a device pulls: null where it is not reported.
    pulled = {r["id"]: r for r in pull_all(client, me)[0]["food_logs"]}
    assert pulled[overripe["id"]]["values"] == {**zeros, "fiber_g": None, "sugar_g": None, "sodium_mg": None}
    assert pulled[overripe["id"]]["food_values"] == pulled[overripe["id"]]["values"]
    assert pulled[broccoli["id"]]["food_values"]["sugar_g"] is None


def test_a_database_log_without_its_snapshot_takes_it_from_the_food(client, me, db):
    log = food_log(fdc_id=BROCCOLI, name="Broccoli", food_name=None, food_values=None,
                   values={**BANANA_VALUES, "sugar_g": None})  # fmt: skip
    assert sync(client, me, food_logs=[log])["rejected"] == []
    (row,) = stored(db)
    assert (row["fdc_id"], row["food_name"]) == (BROCCOLI, "Broccoli, raw")
    assert (row["food_calories_per_100g"], row["food_sugar_per_100g"], row["food_sodium_mg_per_100g"]) == (39, None, 36)


def test_a_bookmark_of_an_unknown_food_is_rejected(client, me, db):
    out = sync(client, me, saved_foods=[saved(UNKNOWN), saved(BROCCOLI)])
    assert out["rejected"] == [{"table": "saved_foods", "key": str(UNKNOWN), "reason": "unknown_food"}]
    assert [row["fdc_id"] for row in stored(db, "saved_foods")] == [BROCCOLI]


# ---- rejected rows ----

BAD_LOGS = [
    ({"quantity": 0}, "invalid quantity"),
    ({"quantity": -1}, "invalid quantity"),
    ({"quantity": "150"}, "invalid quantity"),
    ({"quantity": True}, "invalid quantity"),
    ({"quantity": None}, "invalid quantity"),
    ({"quantity": 1e10}, "invalid quantity"),
    ({"values": {**BANANA_VALUES, "calories": -1}}, "invalid values.calories"),
    ({"values": {**BANANA_VALUES, "sodium_mg": -0.5}}, "invalid values.sodium_mg"),
    ({"values": {**BANANA_VALUES, "protein_g": None}}, "invalid values.protein_g"),
    ({"values": {"calories": 1}}, "invalid values.protein_g"),
    ({"values": None}, "invalid values"),
    ({"food_values": {**BANANA_VALUES, "fat_g": -1}}, "invalid food_values.fat_g"),
    ({"name": ""}, "invalid name"),
    ({"name": "   "}, "invalid name"),
    ({"name": "x" * 501}, "invalid name"),
    ({"name": "nul\x00byte"}, "invalid name"),
    ({"name": 5}, "invalid name"),
    ({"unit": "oz"}, "invalid unit"),
    ({"unit": "serving"}, "serving_with_fdc_id"),
    ({"fdc_id": "1"}, "invalid fdc_id"),
    ({"fdc_id": 1.5}, "invalid fdc_id"),
    ({"fdc_id": 2**63}, "invalid fdc_id"),
    ({"log_date": "2026-02-30"}, "invalid log_date"),
    ({"log_date": 20261110}, "invalid log_date"),
    ({"log_date": "0001-01-01"}, "invalid log_date"),
    ({"logged_at": "2026-11-10T19:12:00"}, "invalid logged_at"),  # no zone
    ({"logged_at": 1762801920}, "invalid logged_at"),
    ({"updated_at": "yesterday"}, "invalid updated_at"),
    ({"updated_at": None}, "invalid updated_at"),
    ({"updated_at": "0001-01-01T00:00:00+05:00"}, "invalid updated_at"),
    ({"id": "not-a-uuid"}, "invalid id"),
    ({"id": None}, "invalid id"),
]


@pytest.mark.parametrize(
    "change, reason", BAD_LOGS, ids=[reason + " " + str(i) for i, (_, reason) in enumerate(BAD_LOGS)]
)
def test_a_bad_log_is_rejected_and_the_rest_of_the_batch_is_applied(client, me, db, change, reason):
    good, bad, also_good = food_log(), food_log(**change), custom_log()
    out = sync(client, me, food_logs=[good, bad, also_good], daily_activity=[steps()])
    key = bad["id"] if isinstance(bad["id"], str) else ""
    assert out["rejected"] == [{"table": "food_logs", "key": key, "reason": reason}]
    assert {str(row["id"]) for row in stored(db)} == {good["id"], also_good["id"]}
    assert len(stored(db, "daily_activity")) == 1
    assert out["cursor"] == max_rev(db)


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity", "1e999"])
def test_a_number_that_is_not_finite_is_rejected(client, me, db, literal):
    good, bad = food_log(), food_log()
    for field in ("quantity", "values"):
        row = json.dumps(
            {**bad, field: "@"} if field == "quantity" else {**bad, "values": {**BANANA_VALUES, "fat_g": "@"}}
        )
        goals = json.dumps(goal(calories="@")).replace('"@"', literal)
        logs = json.dumps(good) + ", " + row.replace('"@"', literal)
        body = '{"cursor": null, "changes": {"food_logs": [' + logs + '], "goals": [' + goals + "]}}"
        r = client.post(URL, content=body, headers={**me, "Content-Type": "application/json"})
        assert r.status_code == 200, r.text
        where = "quantity" if field == "quantity" else "values.fat_g"
        assert r.json()["rejected"] == [
            {"table": "food_logs", "key": bad["id"], "reason": f"invalid {where}"},
            {"table": "goals", "key": "2026-11-01", "reason": "invalid calories"},
        ]
    assert [str(row["id"]) for row in stored(db)] == [good["id"]] and stored(db, "goals") == []


def test_bad_rows_of_the_other_tables_are_rejected_one_by_one(client, me, db):
    out = sync(
        client,
        me,
        goals=[
            goal(effective_date="2026-01-01", goal="bulk"),
            goal(effective_date="2026-01-02", protein_g=-1),
            goal(effective_date="2026-01-03", steps=-1),
            goal(effective_date="2026-01-04", steps=2**31),
            goal(effective_date="2026-01-05", steps=8000.5),
            goal(effective_date="2026-01-06", fiber_g=None),
            goal(effective_date="01/07/2026"),
            goal(effective_date="2026-01-08"),
        ],
        daily_activity=[
            steps("2026-01-01", -1),
            steps("2026-01-02", "many"),
            steps("2026-01-03", 2**31),
            steps("2026-01-04", updated_at="2026-01-04"),
            steps("2026-01-05", 0),
            {"steps": 5, "updated_at": T0},
        ],
        saved_foods=[saved("1"), saved(BANANA, saved_at=None), saved(-1), saved(OVERRIPE)],
    )
    assert out["rejected"] == [
        {"table": "saved_foods", "key": "1", "reason": "invalid fdc_id"},
        {"table": "saved_foods", "key": "1", "reason": "invalid saved_at"},
        {"table": "saved_foods", "key": "-1", "reason": "invalid fdc_id"},
        {"table": "goals", "key": "2026-01-01", "reason": "invalid goal"},
        {"table": "goals", "key": "2026-01-02", "reason": "invalid protein_g"},
        {"table": "goals", "key": "2026-01-03", "reason": "invalid steps"},
        {"table": "goals", "key": "2026-01-04", "reason": "invalid steps"},
        {"table": "goals", "key": "2026-01-05", "reason": "invalid steps"},
        {"table": "goals", "key": "2026-01-06", "reason": "invalid fiber_g"},
        {"table": "goals", "key": "01/07/2026", "reason": "invalid effective_date"},
        {"table": "daily_activity", "key": "2026-01-01", "reason": "invalid steps"},
        {"table": "daily_activity", "key": "2026-01-02", "reason": "invalid steps"},
        {"table": "daily_activity", "key": "2026-01-03", "reason": "invalid steps"},
        {"table": "daily_activity", "key": "2026-01-04", "reason": "invalid updated_at"},
        {"table": "daily_activity", "key": "", "reason": "invalid activity_date"},
    ]
    assert [str(g["effective_date"]) for g in stored(db, "goals")] == ["2026-01-08"]
    assert [(str(s["activity_date"]), s["steps"]) for s in stored(db, "daily_activity")] == [("2026-01-05", 0)]
    assert [f["fdc_id"] for f in stored(db, "saved_foods")] == [OVERRIPE]


def test_a_rejection_does_not_echo_the_bad_value(client, me):
    secret = "x" * 600
    out = sync(client, me, food_logs=[food_log(name=secret), food_log(id=secret)])
    assert secret not in json.dumps(out)
    assert [r["reason"] for r in out["rejected"]] == ["invalid name", "invalid id"]


def test_a_row_the_database_refuses_is_rejected_alone(client, me, db):
    # Something validation does not know about: the batch is applied again row by row, each in a savepoint.
    db.execute("ALTER TABLE daily_activity ADD CONSTRAINT no_thirteen CHECK (steps <> 13)")
    days = [
        steps("2026-11-01", 1),
        steps("2026-11-02", 13),
        steps("2026-11-03", 3),
        steps("2026-11-03", 4, updated_at=at(1)),  # the same day again, newer
        steps("2026-11-04", 5),
        steps("2026-11-04", 13, updated_at=at(1)),  # refused: the day keeps the 5
    ]
    log = food_log()
    out = sync(client, me, food_logs=[log], daily_activity=days, goals=[goal()])
    assert out["rejected"] == [
        {"table": "daily_activity", "key": "2026-11-02", "reason": "invalid row"},
        {"table": "daily_activity", "key": "2026-11-04", "reason": "invalid row"},
    ]
    assert {str(s["activity_date"]): s["steps"] for s in stored(db, "daily_activity")} == {
        "2026-11-01": 1, "2026-11-03": 4, "2026-11-04": 5,
    }  # fmt: skip
    assert len(stored(db)) == 1 and len(stored(db, "goals")) == 1
    assert out["cursor"] == max_rev(db) and out["changes"] == EMPTY
    # The same for an update of a stored row: it keeps what it had.
    out = sync(
        client,
        me,
        daily_activity=[steps("2026-11-01", 13, updated_at=at(5)), steps("2026-11-03", 30, updated_at=at(5))],
    )
    assert out["rejected"] == [{"table": "daily_activity", "key": "2026-11-01", "reason": "invalid row"}]
    assert {str(s["activity_date"]): s["steps"] for s in stored(db, "daily_activity")} == {
        "2026-11-01": 1, "2026-11-03": 30, "2026-11-04": 5,
    }  # fmt: skip


# ---- two users ----


def test_users_never_see_each_others_rows(client, me, other, db):
    mine, theirs = food_log(name="mine"), food_log(name="theirs")
    # The same keys under both users are different rows.
    sync(client, me, food_logs=[mine], goals=[goal(calories=1800)], daily_activity=[steps(count=1)],
         saved_foods=[saved()])  # fmt: skip
    sync(client, other, food_logs=[theirs], goals=[goal(calories=2600)], daily_activity=[steps(count=2)],
         saved_foods=[saved(updated_at=at(3))])  # fmt: skip
    for who, name, calories, count in ((me, "mine", 1800, 1), (other, "theirs", 2600, 2)):
        got, cursor, _ = pull_all(client, who)
        assert [row["name"] for row in got["food_logs"]] == [name]
        assert [row["calories"] for row in got["goals"]] == [calories]
        assert [row["steps"] for row in got["daily_activity"]] == [count]
        assert len(got["saved_foods"]) == 1
        assert sync(client, who, cursor=cursor)["changes"] == EMPTY
    assert len(stored(db)) == len(stored(db, "goals")) == len(stored(db, "daily_activity")) == 2
    # One user's cursor ends above the other's rows without ever returning them.
    assert sync(client, me, cursor=0)["cursor"] < sync(client, other, cursor=0)["cursor"]
    # Deleting "the same" keys as the other user deletes only one's own.
    sync(client, me, daily_activity=[tombstone("activity_date", "2026-11-10")],
         saved_foods=[tombstone("fdc_id", BANANA)])  # fmt: skip
    assert [(s["steps"], s["deleted_at"] is None) for s in stored(db, "daily_activity")] == [(2, True), (1, False)]
    assert pull_all(client, other)[0]["saved_foods"][0]["deleted_at"] is None


@pytest.mark.parametrize("attacker, victim", [("me", "other"), ("other", "me")])
def test_another_users_log_id_is_rejected_and_never_overwritten(client, db, request, attacker, victim):
    attacker, victim = request.getfixturevalue(attacker), request.getfixturevalue(victim)
    log, own = food_log(name="private dinner"), food_log()
    sync(client, victim, food_logs=[log])
    before = stored(db)
    cursor = None
    for attempt in (
        {**log, "name": "hijacked", "quantity": 1, "updated_at": at(60)},  # a newer write
        {**log, "name": "hijacked", "updated_at": at(-60)},  # an older one: must not return "the winner"
        tombstone("id", log["id"], minutes=60),  # a deletion
    ):
        out = sync(client, attacker, cursor, food_logs=[attempt, own])
        cursor = out["cursor"]
        assert out["rejected"] == [{"table": "food_logs", "key": log["id"], "reason": "not_found"}]
        assert out["changes"] == EMPTY
        assert "private dinner" not in json.dumps(out)
    assert [row for row in stored(db) if str(row["id"]) == log["id"]] == before
    assert [str(r["id"]) for r in stored(db) if r["user_id"] != before[0]["user_id"]] == [own["id"]]
    # The owner still has it, unchanged, and never sees the attacker's rows.
    (still,) = pull_all(client, victim)[0]["food_logs"]
    assert (still["name"], still["quantity"], still["deleted_at"]) == ("private dinner", 150, None)


# ---- paging ----


def keys_of(got):
    return [(table, str(row[KEY_OF[table]])) for table, rows in got.items() for row in rows]


def test_paging_returns_every_row_exactly_once_in_rev_order(client, me, other, db):
    sync(client, other, food_logs=[food_log() for _ in range(30)])  # someone else's rows in between
    logs = [food_log(name=f"log {i}") for i in range(1150)]
    days = [steps(day=f"2026-{m:02d}-{d:02d}") for m in range(1, 5) for d in range(1, 26)]  # 100
    for start in range(0, 1150, 250):
        sync(client, me, food_logs=logs[start : start + 250], daily_activity=days[start // 250 * 20 :][:20])
    sync(client, other, food_logs=[food_log() for _ in range(30)])
    sync(client, me, goals=[goal()], saved_foods=[saved()])
    total = 1150 + 100 + 2

    cursor, pages = None, []
    while True:
        page = sync(client, me, cursor)
        pages.append(page)
        cursor = page["cursor"]
        if not page["has_more"]:
            break
    assert [sum(len(rows) for rows in p["changes"].values()) for p in pages] == [500, 500, total - 1000]
    assert [p["has_more"] for p in pages] == [True, True, False]
    seen = [key for p in pages for key in keys_of(p["changes"])]
    assert len(seen) == len(set(seen)) == total
    my_id = db.execute("SELECT user_id FROM user_goals").fetchone()[0]
    assert cursor == db.execute("SELECT max(rev) FROM user_goals WHERE user_id = %s", (my_id,)).fetchone()[0]
    assert cursor > db.execute("SELECT max(rev) FROM saved_foods WHERE user_id = %s", (my_id,)).fetchone()[0]
    # Each page continues exactly where the one before stopped: page n holds revs (cursor n-1, cursor n].
    low = 0
    for p in pages:
        union = " UNION ALL ".join(
            f"SELECT '{wire}' AS t, {KEY_OF[wire]}::text AS k, rev FROM {table} WHERE user_id = %(u)s"
            for wire, table in TABLE_OF.items()
        )
        expected = db.execute(
            f"SELECT t, k FROM ({union}) r WHERE rev > %(low)s AND rev <= %(high)s ORDER BY rev",
            {"u": my_id, "low": low, "high": p["cursor"]},
        ).fetchall()
        assert sorted(keys_of(p["changes"])) == sorted(expected)
        # Within a table the rows are in rev order.
        ids = [k for t, k in expected if t == "food_logs"]
        assert [row["id"] for row in p["changes"]["food_logs"]] == ids
        low = p["cursor"]
    assert sync(client, me, cursor)["changes"] == EMPTY


def test_a_push_while_behind_does_not_skip_anything(client, me, db):
    """A device far behind pushes a row: it is paged through the older rows first and misses none."""
    older = [food_log(name=f"old {i}") for i in range(400)]
    sync(client, me, food_logs=older)
    days = [steps(day=f"2026-{m:02d}-{d:02d}") for m in range(1, 9) for d in range(1, 26)]  # 200
    sync(client, me, daily_activity=days)
    new = food_log(name="new")
    first = sync(client, me, cursor=None, food_logs=[new])
    assert first["has_more"] is True
    assert len(first["changes"]["food_logs"]) == 400 and len(first["changes"]["daily_activity"]) == 100
    assert new["id"] not in [row["id"] for row in first["changes"]["food_logs"]]
    assert first["cursor"] < stored(db)[-1]["rev"]  # not past the rows it has not been sent yet
    got, cursor, calls = pull_all(client, me, first["cursor"])
    assert calls == 1 and cursor == max_rev(db)
    assert len(got["daily_activity"]) == 100
    # Its own row comes back on the later page (the cursor could not pass over it): the same data.
    assert [row["id"] for row in got["food_logs"]] == [new["id"]]
    seen = keys_of(first["changes"]) + keys_of(got)
    assert len(seen) == len(set(seen)) == 601


def test_a_push_on_the_last_page_moves_the_cursor_past_its_own_rows(client, me, other, db):
    old = food_log(name="old")
    sync(client, me, food_logs=[old])
    sync(client, other, food_logs=[food_log()])
    new = food_log(name="new")
    out = sync(client, me, cursor=None, food_logs=[new], daily_activity=[steps()])
    assert [row["id"] for row in out["changes"]["food_logs"]] == [old["id"]]
    assert out["changes"]["daily_activity"] == [] and out["has_more"] is False
    assert out["cursor"] == stored(db, "daily_activity")[0]["rev"]
    assert sync(client, me, cursor=out["cursor"])["changes"] == EMPTY


def test_a_cursor_ahead_of_everything_is_kept(client, me):
    cursor = sync(client, me, food_logs=[food_log()])["cursor"]
    out = sync(client, me, cursor=cursor + 1000)
    assert out == {"cursor": cursor + 1000, "has_more": False, "changes": EMPTY, "rejected": []}


# ---- with the REST routes (app/api/v1/food_logs.py), which write through the same core ----


def test_a_log_made_over_rest_reaches_the_next_pull_and_a_synced_log_is_listed(client, me):
    cursor = sync(client, me, food_logs=[food_log(name="from the phone")])["cursor"]
    r = client.post("/api/v1/food-logs", json={"fdc_id": BROCCOLI, "quantity": 90}, headers=me)
    assert r.status_code == 201, r.text
    made = r.json()
    out = sync(client, me, cursor=cursor)
    (pulled,) = out["changes"]["food_logs"]
    assert (pulled["id"], pulled["fdc_id"], pulled["quantity"]) == (made["id"], BROCCOLI, 90)
    assert pulled["values"]["sugar_g"] is None and out["cursor"] == made["rev"]
    # Deleted over REST: the phone gets the tombstone.
    assert client.delete(f"/api/v1/food-logs/{made['id']}", headers=me).status_code == 204
    (gone,) = sync(client, me, cursor=out["cursor"])["changes"]["food_logs"]
    assert gone["id"] == made["id"] and gone["deleted_at"] is not None
    listed = client.get("/api/v1/food-logs?date=2026-11-10", headers=me).json()["logs"]
    assert [log["name"] for log in listed] == ["from the phone"]
    assert listed[0]["totals"]["calories"] == pytest.approx(133.5)


def test_zero_means_unknown_only_through_sync(client, me, db):
    """The phone sends 0 for "not reported", so /sync stores NULL; a REST client's 0 is a 0."""
    zeros = {
        "calories": 85.0,
        "protein_g": 0.75,
        "carbs_g": 20.5,
        "fat_g": 0.25,
        "fiber_g": 0,
        "sugar_g": 0,
        "sodium_mg": 0,
    }
    pushed = food_log(fdc_id=OVERRIPE, values=dict(zeros), food_values=dict(zeros))
    sync(client, me, food_logs=[pushed])
    r = client.post("/api/v1/food-logs", json={"fdc_id": OVERRIPE, "quantity": 100, "values": zeros}, headers=me)
    assert r.status_code == 201, r.text
    rows = {str(row["id"]): row for row in stored(db)}
    assert [rows[pushed["id"]][c] for c in ("unit_fiber_g", "unit_sugar_g", "unit_sodium_mg")] == [None, None, None]
    assert [rows[r.json()["id"]][c] for c in ("unit_fiber_g", "unit_sugar_g", "unit_sodium_mg")] == [0, 0, 0]
    # Pushed again through /sync (an edit on the phone), the REST log's zeros become "not reported" too.
    edit = {**pushed, "id": r.json()["id"], "updated_at": (datetime.now(UTC) + timedelta(minutes=1)).isoformat()}
    assert sync(client, me, food_logs=[edit])["rejected"] == []
    assert stored(db)[-1]["unit_fiber_g"] is None and str(stored(db)[-1]["id"]) == r.json()["id"]


def test_a_body_over_the_size_limit_is_413_before_it_is_parsed(client, me, db):
    from app.main import MAX_BODY_BYTES

    # Not valid for /sync (an unknown key would be a 422): the 413 shows it was never parsed.
    padding = "x" * MAX_BODY_BYTES
    r = client.post(URL, json={"cursor": None, "changes": {}, "padding": padding}, headers={**me, "Origin": "http://localhost:8081"})
    assert r.status_code == 413, r.text[:200]
    assert r.headers["access-control-allow-origin"] == "*"  # readable by the web build
    assert db.execute("SELECT count(*) FROM food_logs").fetchone() == (0,)
    # A body under the limit is handled as usual.
    assert sync(client, me)["rejected"] == []


# ---- activity targets: goal source and day amounts, daily_activity and its legacy name ----


def test_the_goal_and_day_fields_round_trip(client, me, other, db):
    computed = goal(source="computed", workout_kcal=320.5, active_rest_kcal=150)
    days = [
        steps("2026-11-10", 9000, day_type="workout", workout_kcal=410),
        steps("2026-11-11", 3000, day_type="active_rest", workout_kcal=0),  # 0 is a value, not "the goal's"
        steps("2026-11-12", 0, day_type="rest"),
    ]
    assert sync(client, me, goals=[computed], daily_activity=days)["rejected"] == []
    got, _, _ = pull_all(client, me)
    assert [{**g, "updated_at": T0} for g in got["goals"]] == [computed]
    assert [{**d, "updated_at": T0} for d in got["daily_activity"]] == days
    assert [(s["day_type"], s["workout_kcal"]) for s in stored(db, "daily_activity")] == [
        ("workout", 410), ("active_rest", 0), ("rest", None),
    ]  # fmt: skip
    assert pull_all(client, other)[0] == EMPTY


def test_a_row_without_the_new_fields_gets_the_defaults(client, me, db):
    old_goal = {k: v for k, v in goal().items() if k not in ("source", "workout_kcal", "active_rest_kcal")}
    old_day = {k: v for k, v in steps().items() if k not in ("day_type", "workout_kcal")}
    assert sync(client, me, goals=[old_goal], daily_activity=[old_day])["rejected"] == []
    (g,) = stored(db, "goals")
    assert (g["source"], g["workout_kcal"], g["active_rest_kcal"]) == ("manual", 0, 0)
    (d,) = stored(db, "daily_activity")
    assert (d["day_type"], d["workout_kcal"]) == (None, None)
    # An edit from such an app replaces the whole row, so it resets what a newer app had set.
    sync(client, me, goals=[goal(workout_kcal=300, updated_at=at(1))])
    sync(client, me, goals=[{**old_goal, "updated_at": at(2)}])
    assert stored(db, "goals")[0]["workout_kcal"] == 0


def test_bad_values_of_the_new_fields_are_rejected(client, me, db):
    out = sync(
        client,
        me,
        goals=[goal(source="guess"), goal(effective_date="2026-11-02", workout_kcal=-1),
               goal(effective_date="2026-11-03", active_rest_kcal="300")],
        daily_activity=[steps("2026-11-10", day_type="active_recovery"), steps("2026-11-11", workout_kcal=-5)],
    )  # fmt: skip
    assert out["rejected"] == [
        {"table": "goals", "key": "2026-11-01", "reason": "invalid source"},
        {"table": "goals", "key": "2026-11-02", "reason": "invalid workout_kcal"},
        {"table": "goals", "key": "2026-11-03", "reason": "invalid active_rest_kcal"},
        {"table": "daily_activity", "key": "2026-11-10", "reason": "invalid day_type"},
        {"table": "daily_activity", "key": "2026-11-11", "reason": "invalid workout_kcal"},
    ]
    assert stored(db, "goals") == [] and stored(db, "daily_activity") == []


def test_a_day_pushed_under_the_legacy_name_is_stored_as_daily_activity(client, me, other, db):
    out = sync(
        client,
        me,
        daily_steps=[legacy_steps("2026-11-10", 4000), legacy_steps("2026-11-11", -1), {"steps": 1, "updated_at": T0}],
    )
    assert out["rejected"] == [
        {"table": "daily_steps", "key": "2026-11-11", "reason": "invalid steps"},
        {"table": "daily_steps", "key": "", "reason": "invalid log_date"},
    ]
    assert [(str(s["activity_date"]), s["steps"], s["day_type"]) for s in stored(db, "daily_activity")] == [
        ("2026-11-10", 4000, None)
    ]
    # A pull only ever answers with daily_activity.
    page = sync(client, other)
    assert set(page["changes"]) == set(EMPTY)
    got, _, _ = pull_all(client, me)
    assert [{**d, "updated_at": T0} for d in got["daily_activity"]] == [steps("2026-11-10", 4000)]
    # A legacy tombstone deletes it; a legacy row that loses comes back as the daily_activity winner.
    sync(client, me, daily_activity=[steps("2026-11-12", 7000, updated_at=at(10))])
    out = sync(client, me, daily_steps=[tombstone("log_date", "2026-11-10"), legacy_steps("2026-11-12", 1)])
    assert out["rejected"] == []
    by_day = {str(s["activity_date"]): s for s in stored(db, "daily_activity")}
    assert by_day["2026-11-10"]["deleted_at"] is not None and by_day["2026-11-12"]["steps"] == 7000
    assert [(w["activity_date"], w["steps"]) for w in out["changes"]["daily_activity"]] == [("2026-11-12", 7000)]


def test_a_day_pushed_under_both_names_ends_with_the_newer_and_its_winner_is_sent_once(client, me, db):
    sync(client, me, daily_activity=[steps(count=9000, updated_at=at(10))])
    out = sync(client, me, daily_steps=[legacy_steps(count=1)], daily_activity=[steps(count=2)])
    assert [(w["activity_date"], w["steps"]) for w in out["changes"]["daily_activity"]] == [("2026-11-10", 9000)]
    out = sync(client, me, daily_steps=[legacy_steps(count=1, updated_at=at(11))],
               daily_activity=[steps(count=2, updated_at=at(12))])  # fmt: skip
    assert out["rejected"] == [] and [s["steps"] for s in stored(db, "daily_activity")] == [2]


def test_a_legacy_row_changes_only_the_steps(client, me, db):
    # An app from before daily_activity knows only steps: its edit keeps the day's type and kcal.
    sync(client, me, daily_activity=[steps(count=9000, day_type="workout", workout_kcal=400)])
    out = sync(client, me, daily_steps=[legacy_steps(count=1234, updated_at=at(5))])
    assert out["rejected"] == []
    (d,) = stored(db, "daily_activity")
    assert (d["steps"], d["day_type"], d["workout_kcal"], d["updated_at"]) == (1234, "workout", 400, when(at(5)))
    got, _, _ = pull_all(client, me)
    assert [(d["steps"], d["day_type"], d["workout_kcal"]) for d in got["daily_activity"]] == [(1234, "workout", 400)]


def test_legacy_rows_count_toward_the_500_row_limit(client, me, db):
    days = [legacy_steps(f"2026-{1 + i // 28:02d}-{1 + i % 28:02d}") for i in range(300)]
    sync(client, me, status=413, daily_steps=days, daily_activity=[steps()] * 201)
    assert stored(db, "daily_activity") == []

