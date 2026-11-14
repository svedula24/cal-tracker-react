"""The user's timezone: set at registration and by PATCH /api/v1/me (app/api/v1/devices.py), and the
"today" that the endpoints default to (log_queries.local_date) follows it.

Needs Postgres: set DATABASE_URL. Each test runs the app against a freshly migrated scratch schema.
"""

import os
from datetime import UTC, datetime

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.api.v1.food_logs import utc_now
from app.main import create_app
from app.services import users as user_service

pytestmark = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set")

# Two instants at which UTC, Kiritimati (UTC+14) and Pago Pago (UTC-11) do not all share a calendar day.
INSTANT = datetime(2026, 3, 1, 23, 30, tzinfo=UTC)  # Kiritimati: 03-02 13:30; Pago Pago: 03-01 12:30
EARLY = datetime(2026, 3, 1, 5, 0, tzinfo=UTC)  # Pago Pago: 02-28 18:00; Kiritimati: 03-01 19:00


@pytest.fixture
def client(migrated_url):
    with TestClient(create_app(migrated_url)) as c:
        yield c


@pytest.fixture
def db(migrated_url):
    with psycopg.connect(migrated_url, autocommit=True) as conn:
        yield conn


def register(client, **body):
    r = client.post("/api/v1/devices", json=body)
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def stored_timezones(db):
    return [row[0] for row in db.execute("SELECT timezone FROM users ORDER BY created_at")]


def patch_me(client, who, body):
    return client.patch("/api/v1/me", json=body, headers=who)


def test_registration_stores_the_timezone(client, db):
    who = register(client, platform="ios", timezone="America/Los_Angeles")
    assert stored_timezones(db) == ["America/Los_Angeles"]
    assert client.get("/api/v1/me", headers=who).json()["timezone"] == "America/Los_Angeles"


@pytest.mark.parametrize("body", [{}, {"platform": "web"}, {"timezone": None}])
def test_registration_without_a_timezone_is_utc(client, db, body):
    register(client, **body)
    assert stored_timezones(db) == ["UTC"]


@pytest.mark.parametrize("zone", ["Mars/Olympus_Mons", "america/los_angeles", "", "PST"])
def test_registration_with_an_unknown_timezone_still_registers_as_utc(client, db, zone):
    # A phone whose tz data is newer than the server's must not be locked out of sync.
    register(client, timezone=zone)
    assert stored_timezones(db) == ["UTC"]


def test_registration_refuses_a_timezone_that_is_not_a_short_string(client, db):
    assert client.post("/api/v1/devices", json={"timezone": "x" * 65}).status_code == 422
    assert client.post("/api/v1/devices", json={"timezone": 5}).status_code == 422
    assert stored_timezones(db) == []


@pytest.mark.parametrize("zone", ["America/Los_Angeles", "Pacific/Kiritimati", "UTC", "Europe/London"])
def test_patch_me_sets_the_timezone(client, db, zone):
    who = register(client)
    r = patch_me(client, who, {"timezone": zone})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"user_id", "timezone", "created_at"}
    assert body["timezone"] == zone
    assert stored_timezones(db) == [zone]
    assert client.get("/api/v1/me", headers=who).json() == body


def test_patch_me_changes_only_the_callers_user(client, db):
    me, other = register(client, timezone="Asia/Tokyo"), register(client, timezone="Asia/Tokyo")
    assert patch_me(client, me, {"timezone": "Europe/Paris"}).status_code == 200
    assert client.get("/api/v1/me", headers=other).json()["timezone"] == "Asia/Tokyo"
    assert sorted(stored_timezones(db)) == ["Asia/Tokyo", "Europe/Paris"]


@pytest.mark.parametrize(
    "body",
    [
        {"timezone": "Mars/Olympus_Mons"},
        {"timezone": "america/los_angeles"},  # names are case-sensitive
        {"timezone": "PST"},
        {"timezone": ""},
        {"timezone": "x" * 65},
        {"timezone": None},
        {"timezone": 5},
        {},
        {"timezone": "UTC", "user_id": "someone else"},  # nothing else can be changed here
    ],
)
def test_patch_me_refuses_an_unknown_timezone(client, db, body):
    who = register(client, timezone="Asia/Tokyo")
    r = patch_me(client, who, body)
    assert r.status_code == 422, r.text
    assert stored_timezones(db) == ["Asia/Tokyo"]


def test_patch_me_needs_a_token(client, db):
    register(client)
    r = client.patch("/api/v1/me", json={"timezone": "Asia/Tokyo"})
    assert r.status_code == 401
    assert r.headers["www-authenticate"] == "Bearer"
    unknown = {"Authorization": "Bearer kalo_" + "A" * 43}
    r = client.patch("/api/v1/me", json={"timezone": "Asia/Tokyo"}, headers=unknown)
    assert r.status_code == 401
    assert stored_timezones(db) == ["UTC"]


def test_patch_me_is_allowed_cross_origin(client):
    r = client.options(
        "/api/v1/me",
        headers={
            "Origin": "http://localhost:8081",
            "Access-Control-Request-Method": "PATCH",
            "Access-Control-Request-Headers": "authorization, content-type",
        },
    )
    assert r.status_code == 200
    assert "PATCH" in r.headers["access-control-allow-methods"]


def test_the_known_timezones_are_read_once():
    user_service._timezones.cache_clear()
    assert user_service.known_timezone("Pacific/Pago_Pago")
    assert not user_service.known_timezone("Nowhere/Special")
    assert user_service._timezones.cache_info().misses == 1


def today_seen(client, who, now):
    """The day /nutrition/daily answers for when no date is given, at `now`."""
    client.app.dependency_overrides[utc_now] = lambda: now
    r = client.get("/api/v1/nutrition/daily", headers=who)
    assert r.status_code == 200, r.text
    return r.json()["date"]


def test_today_follows_the_users_timezone(client):
    utc = register(client)
    ahead = register(client, timezone="Pacific/Kiritimati")  # UTC+14
    behind = register(client, timezone="Pacific/Pago_Pago")  # UTC-11
    assert today_seen(client, utc, INSTANT) == "2026-03-01"
    assert today_seen(client, ahead, INSTANT) == "2026-03-02"
    assert today_seen(client, behind, INSTANT) == "2026-03-01"
    assert today_seen(client, utc, EARLY) == "2026-03-01"
    assert today_seen(client, ahead, EARLY) == "2026-03-01"
    assert today_seen(client, behind, EARLY) == "2026-02-28"


def test_today_follows_a_patched_timezone(client):
    who = register(client)
    assert today_seen(client, who, INSTANT) == "2026-03-01"
    assert patch_me(client, who, {"timezone": "Pacific/Kiritimati"}).status_code == 200
    assert today_seen(client, who, INSTANT) == "2026-03-02"
    # A food log made without a date lands on the user's day too.
    r = client.post(
        "/api/v1/food-logs",
        json={"name": "Toast", "unit": "serving", "quantity": 1,
              "values": {"calories": 80, "protein_g": 3, "carbs_g": 14, "fat_g": 1}},
        headers=who,
    )  # fmt: skip
    assert r.status_code == 201, r.text
    assert r.json()["log_date"] == "2026-03-02"
