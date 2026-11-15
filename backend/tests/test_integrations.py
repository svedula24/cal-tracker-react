"""Integration tokens and PUT /api/v1/daily-activity/{date}/steps (app/api/v1/integrations.py): what the
Apple Health Shortcut uses (docs/health-shortcut.md).

Needs Postgres: set DATABASE_URL. Fixtures and helpers come from tests/test_food_logs.py.
"""

import os
import uuid
from datetime import UTC, datetime

import pytest
import test_food_logs as logs
from test_food_logs import set_clock, set_timezone

client, db, me, other = logs.client, logs.db, logs.me, logs.other  # the fixtures, for this module too

pytestmark = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set")

TOKENS = "/api/v1/integration-tokens"
ACTIVITY = "/api/v1/daily-activity"


def create_token(client, who, status=201, **body):
    r = client.post(TOKENS, json=body or None, headers=who)
    assert r.status_code == status, r.text
    return r.json()


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def put_steps(client, who, day, steps, status=200):
    r = client.put(f"{ACTIVITY}/{day}/steps", json={"steps": steps}, headers=who)
    assert r.status_code == status, r.text
    return r.json()


def pull(client, who, cursor=None):
    """(the days pulled since `cursor`, the new cursor)"""
    r = client.post("/api/v1/sync", json={"cursor": cursor, "changes": {}}, headers=who)
    return r.json()["changes"]["daily_activity"], r.json()["cursor"]


def test_create_list_and_revoke(client, me, other, db):
    made = create_token(client, me, label="  Apple Health  ")
    assert set(made) == {"id", "token", "label", "created_at"}
    assert made["label"] == "Apple Health" and made["token"].startswith("kalo_")
    default = create_token(client, me)
    assert default["label"] == "Apple Health"

    listed = client.get(TOKENS, headers=me).json()["tokens"]
    assert [t["id"] for t in listed] == [default["id"], made["id"]]  # newest first
    assert all("token" not in t for t in listed)
    assert client.get(TOKENS, headers=other).json() == {"tokens": []}
    # Only the hash is stored.
    stored = db.execute("SELECT token_hash, label FROM user_tokens WHERE id = %s", (made["id"],)).fetchone()
    assert made["token"].encode() not in stored[0] and stored[1] == "integration:Apple Health"

    # Another user cannot revoke it.
    assert client.delete(f"{TOKENS}/{made['id']}", headers=other).status_code == 404
    assert client.delete(f"{TOKENS}/{made['id']}", headers=me).status_code == 204
    assert client.delete(f"{TOKENS}/{made['id']}", headers=me).status_code == 204  # again: still 204
    assert client.delete(f"{TOKENS}/{uuid.uuid4()}", headers=me).status_code == 404
    assert [t["id"] for t in client.get(TOKENS, headers=me).json()["tokens"]] == [default["id"]]
    # The revoked token stops working at once.
    put_steps(client, bearer(made["token"]), "2026-03-01", 10, status=401)
    put_steps(client, bearer(default["token"]), "2026-03-01", 10)


def test_a_device_token_cannot_be_revoked_here(client, me, db):
    (device_id,) = db.execute("SELECT id FROM user_tokens").fetchone()
    assert client.delete(f"{TOKENS}/{device_id}", headers=me).status_code == 404
    assert client.get("/api/v1/me", headers=me).status_code == 200


def test_label_is_checked_and_live_tokens_are_capped(client, me):
    create_token(client, me, status=422, label="")
    create_token(client, me, status=422, label="x" * 61)
    create_token(client, me, status=422, label="ok", extra=1)
    made = [create_token(client, me) for _ in range(10)]
    create_token(client, me, status=409)
    assert client.delete(f"{TOKENS}/{made[0]['id']}", headers=me).status_code == 204
    create_token(client, me)


def test_an_integration_token_only_sets_steps(client, me):
    health = bearer(create_token(client, me)["token"])
    # The scope rule: every other route refuses it as if it were unknown.
    for method, path, body in [
        ("GET", "/api/v1/me", None),
        ("GET", TOKENS, None),
        ("POST", TOKENS, {"label": "more"}),
        ("POST", "/api/v1/sync", {"cursor": None, "changes": {}}),
        ("GET", "/api/v1/food-logs", None),
        ("PUT", f"{ACTIVITY}/2026-03-01", {"steps": 1}),
        ("POST", "/api/v1/pairing-codes", None),
    ]:
        assert client.request(method, path, json=body, headers=health).status_code == 401, path
    # The device token works on the steps route too.
    assert put_steps(client, me, "2026-03-01", 5)["steps"] == 5
    assert put_steps(client, health, "2026-03-01", 6)["steps"] == 6


def test_steps_needs_a_token(client, db):
    for headers in ({}, bearer("kalo_" + "A" * 43)):
        put_steps(client, headers, "2026-03-01", 1, status=401)
    assert db.execute("SELECT count(*) FROM daily_activity").fetchone() == (0,)


def test_steps_set_replace_and_keep_the_day(client, me, db):
    health = bearer(create_token(client, me)["token"])
    first = put_steps(client, health, "2026-03-01", 4000)
    assert first == {"activity_date": "2026-03-01", "steps": 4000, "day_type": None, "workout_kcal": None}

    # The phone says what kind of day it was; steps from the Shortcut keep that.
    r = client.put(
        f"{ACTIVITY}/2026-03-01", json={"steps": 4000, "day_type": "workout", "workout_kcal": 350}, headers=me
    )
    assert r.status_code == 200, r.text
    (rev_before,) = db.execute("SELECT rev FROM daily_activity").fetchone()
    _, cursor = pull(client, me)  # the phone is up to date
    assert put_steps(client, health, "2026-03-01", 9000) == {
        "activity_date": "2026-03-01", "steps": 9000, "day_type": "workout", "workout_kcal": 350.0,
    }  # fmt: skip
    (rev_after,) = db.execute("SELECT rev FROM daily_activity").fetchone()
    assert rev_after > rev_before

    # A lower count replaces it (the Shortcut sends the total so far, and Health may revise it).
    assert put_steps(client, health, "2026-03-01", 8500)["steps"] == 8500
    # The same count again writes nothing.
    (rev_now,) = db.execute("SELECT rev FROM daily_activity").fetchone()
    assert put_steps(client, health, "2026-03-01", 8500)["steps"] == 8500
    assert db.execute("SELECT rev FROM daily_activity").fetchone() == (rev_now,)

    # And it reaches the phone on its next pull.
    (day,), _ = pull(client, me, cursor)
    assert (day["activity_date"], day["steps"], day["day_type"]) == ("2026-03-01", 8500, "workout")


def test_zero_never_wipes_a_count(client, me, db):
    """A run while the iPhone is locked reads no Health data and sends 0: the day keeps its count."""
    put_steps(client, me, "2026-03-01", 9000)
    (rev,) = db.execute("SELECT rev FROM daily_activity").fetchone()
    assert put_steps(client, me, "2026-03-01", 0)["steps"] == 9000
    assert put_steps(client, me, "2026-03-01", "0")["steps"] == 9000
    assert db.execute("SELECT steps, rev FROM daily_activity").fetchone() == (9000, rev)
    # 0 is stored when there is nothing yet (or the stored count is 0).
    assert put_steps(client, me, "2026-03-02", 0)["steps"] == 0
    assert put_steps(client, me, "2026-03-02", 0)["steps"] == 0
    assert put_steps(client, me, "2026-03-02", 10)["steps"] == 10


def test_a_device_cannot_register_with_the_integration_prefix(client, db):
    r = client.post("/api/v1/devices", json={"app_version": "integration:Apple Health"})
    assert r.status_code == 422
    assert db.execute("SELECT count(*) FROM user_tokens").fetchone() == (0,)
    assert client.post("/api/v1/devices", json={"app_version": "1.4.0"}).status_code == 201


def test_steps_come_back_after_a_deleted_day(client, me, db):
    client.post(
        "/api/v1/sync",
        json={"changes": {"daily_activity": [{
            "activity_date": "2026-03-01", "steps": 100, "day_type": "rest",
            "updated_at": "2026-03-01T10:00:00Z", "deleted_at": "2026-03-01T11:00:00Z",
        }]}},
        headers=me,
    )  # fmt: skip
    assert put_steps(client, me, "2026-03-01", 200) == {
        "activity_date": "2026-03-01", "steps": 200, "day_type": None, "workout_kcal": None,
    }  # fmt: skip
    assert db.execute("SELECT deleted_at FROM daily_activity").fetchone() == (None,)


@pytest.mark.parametrize(
    ("sent", "stored"),
    [
        (8123, 8123), (8123.4, 8123), (8123.5, 8124), ("8123", 8123), ("  77.0 ", 77),
        ("8,123", 8123), ("8 123", 8123), ("8\u00a0123", 8123), ("8\u202f123", 8123), ("8'123", 8123),
        ("12,345.6", 12346),
    ],
)  # fmt: skip
def test_steps_from_a_shortcut_are_rounded(client, me, sent, stored):
    assert put_steps(client, me, "2026-03-01", sent)["steps"] == stored


@pytest.mark.parametrize("sent", [-1, True, None, "many", "", "8-123", 2**31, [1]])
def test_bad_steps_are_422(client, me, db, sent):
    put_steps(client, me, "2026-03-01", sent, status=422)
    r = client.put(f"{ACTIVITY}/2026-03-01/steps", json={"steps": 1, "day_type": "rest"}, headers=me)
    assert r.status_code == 422
    assert db.execute("SELECT count(*) FROM daily_activity").fetchone() == (0,)


def test_the_day_is_in_the_users_calendar(client, me, db):
    # 03:00 UTC on 2 March is still 1 March in Los Angeles.
    set_clock(client, datetime(2026, 3, 2, 3, 0, tzinfo=UTC))
    set_timezone(db, "America/Los_Angeles")
    put_steps(client, me, "2026-03-02", 10, status=422)
    put_steps(client, me, "2026-03-01", 10)
    set_timezone(db, "Asia/Tokyo")  # already 2 March there
    put_steps(client, me, "2026-03-02", 10)
    put_steps(client, me, "2026-03-03", 10, status=422)
    put_steps(client, me, "not-a-date", 10, status=422)
