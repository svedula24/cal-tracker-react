"""Device registration and bearer-token auth (app/api/deps.py, app/api/v1/devices.py).

Needs Postgres: set DATABASE_URL. Each test runs the app against a freshly migrated scratch schema.
"""

import hashlib
import logging
import os
import re
import uuid
from datetime import UTC, datetime

import psycopg
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event

from app.main import create_app

pytestmark = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set")

ORIGIN = {"Origin": "http://localhost:8081"}
TOKEN_RE = re.compile(r"kalo_[A-Za-z0-9_-]{43}")


@pytest.fixture
def client(migrated_url):
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


def register(client, **body):
    r = client.post("/api/v1/devices", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def test_registering_returns_a_user_id_and_a_token(client):
    r = client.post("/api/v1/devices", json={"platform": "ios", "app_version": "1.4.0"})
    assert r.status_code == 201
    body = r.json()
    assert set(body) == {"user_id", "token"}
    assert uuid.UUID(body["user_id"]).version == 4
    assert TOKEN_RE.fullmatch(body["token"])
    assert r.headers["cache-control"] == "no-store"


def test_registration_is_committed_as_a_user_and_a_hashed_token(client, db):
    body = register(client, platform="ios", app_version="1.4.0")
    users = db.execute("SELECT id, email, auth_provider, auth_subject, timezone FROM users").fetchall()
    assert users == [(uuid.UUID(body["user_id"]), None, None, None, "UTC")]
    tokens = db.execute("SELECT user_id, token_hash, label, last_used_at, revoked_at FROM user_tokens").fetchall()
    assert len(tokens) == 1
    user_id, token_hash, label, last_used_at, revoked_at = tokens[0]
    assert user_id == uuid.UUID(body["user_id"])
    assert token_hash == hashlib.sha256(body["token"].encode()).digest()
    assert len(token_hash) == 32
    assert (label, last_used_at, revoked_at) == ("ios 1.4.0", None, None)


def test_the_token_itself_is_stored_nowhere(client, db):
    token = register(client, platform="web", app_version="2.0")["token"]
    stored = db.execute("SELECT (u.*)::text || (t.*)::text FROM users u JOIN user_tokens t ON t.user_id = u.id")
    row = stored.fetchone()[0]
    assert token not in row
    assert token.removeprefix("kalo_") not in row


def test_registering_twice_gives_two_users(client, db):
    first, second = register(client, platform="ios"), register(client, platform="ios")
    assert first["user_id"] != second["user_id"]
    assert first["token"] != second["token"]
    assert db.execute("SELECT count(*) FROM users").fetchone()[0] == 2
    assert client.get("/api/v1/me", headers=auth(first["token"])).json()["user_id"] == first["user_id"]
    assert client.get("/api/v1/me", headers=auth(second["token"])).json()["user_id"] == second["user_id"]


@pytest.mark.parametrize(
    "send, label",
    [
        ({"json": {"platform": "android", "app_version": "3.1.0"}}, "android 3.1.0"),
        ({"json": {"platform": "web"}}, "web"),
        ({"json": {"app_version": "3.1.0"}}, "3.1.0"),
        ({"json": {"platform": None, "app_version": None}}, None),
        ({"json": {}}, None),
        ({}, None),  # no body at all
    ],
)
def test_platform_and_app_version_are_optional_and_label_the_token(client, db, send, label):
    r = client.post("/api/v1/devices", **send)
    assert r.status_code == 201, r.text
    assert db.execute("SELECT label FROM user_tokens").fetchall() == [(label,)]


@pytest.mark.parametrize(
    "body",
    [
        {"platform": "windows"},
        {"platform": "iOS"},
        {"platform": ""},
        {"platform": 1},
        {"app_version": "1" * 33},
        {"app_version": 14},
        ["ios"],
    ],
)
def test_a_bad_registration_is_422_and_creates_nothing(client, db, body):
    assert client.post("/api/v1/devices", json=body).status_code == 422
    assert db.execute("SELECT count(*) FROM users").fetchone()[0] == 0


def test_a_valid_token_resolves_to_its_user(client):
    before = datetime.now(UTC)
    device = register(client)
    r = client.get("/api/v1/me", headers=auth(device["token"]))
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"user_id", "timezone", "created_at"}
    assert body["user_id"] == device["user_id"]
    assert body["timezone"] == "UTC"
    created = datetime.fromisoformat(body["created_at"])
    assert created.tzinfo is not None
    assert abs((created - before).total_seconds()) < 60


@pytest.mark.parametrize("scheme", ["Bearer", "bearer", "BEARER"])
def test_the_scheme_is_case_insensitive(client, scheme):
    device = register(client)
    r = client.get("/api/v1/me", headers={"Authorization": f"{scheme} {device['token']}"})
    assert r.status_code == 200


def unauthorized(r, detail):
    assert r.status_code == 401, r.text
    assert r.headers["www-authenticate"] == "Bearer"
    assert r.json() == {"detail": detail}
    return r


@pytest.mark.parametrize(
    "header",
    [
        None,  # no Authorization header
        "",
        "Bearer",
        "Bearer ",
        "Bearer    ",
        "{token}",  # the bare token, no scheme
        "Token {token}",
        "Basic {token}",
        "Bearer{token}",
    ],
)
def test_a_missing_or_malformed_header_is_401_not_422(client, header):
    token = register(client)["token"]
    headers = {} if header is None else {"Authorization": header.format(token=token)}
    r = unauthorized(client.get("/api/v1/me", headers=headers), "missing bearer token")
    assert token not in r.text


@pytest.mark.parametrize(
    "token",
    [
        "kalo_" + "A" * 43,
        "not-a-token",
        "x" * 5000,
        "kalo_café",  # sent as latin-1; must not be a 500
    ],
)
def test_an_unknown_token_is_401_and_is_not_echoed(client, token):
    register(client)
    r = client.get("/api/v1/me", headers={"Authorization": f"Bearer {token}".encode("latin-1")})
    unauthorized(r, "invalid token")
    assert token[:20] not in r.text


def test_a_token_is_matched_whole_and_case_sensitively(client):
    token = register(client)["token"]
    for wrong in (token[:-1], token + "A", token.swapcase(), token.removeprefix("kalo_")):
        unauthorized(client.get("/api/v1/me", headers=auth(wrong)), "invalid token")


def test_a_revoked_token_is_401_and_other_tokens_keep_working(client, db):
    revoked, live = register(client), register(client)
    db.execute(
        "UPDATE user_tokens SET revoked_at = now() WHERE token_hash = %s",
        (hashlib.sha256(revoked["token"].encode()).digest(),),
    )
    unauthorized(client.get("/api/v1/me", headers=auth(revoked["token"])), "invalid token")
    assert client.get("/api/v1/me", headers=auth(live["token"])).status_code == 200
    # A refused request does not count as a use.
    assert db.execute("SELECT count(*) FROM user_tokens WHERE last_used_at IS NOT NULL").fetchone()[0] == 1


def test_a_deleted_users_token_is_401(client, db):
    device = register(client)
    db.execute("DELETE FROM users WHERE id = %s", (device["user_id"],))
    unauthorized(client.get("/api/v1/me", headers=auth(device["token"])), "invalid token")


def test_last_used_at_is_set_by_the_first_authenticated_request(client, db):
    device = register(client)
    assert db.execute("SELECT last_used_at FROM user_tokens").fetchone()[0] is None
    assert client.get("/api/v1/me", headers=auth(device["token"])).status_code == 200
    used, now = db.execute("SELECT last_used_at, now() FROM user_tokens").fetchone()  # committed: seen from outside
    assert used is not None
    assert abs((now - used).total_seconds()) < 60


def test_last_used_at_is_written_at_most_once_a_minute(client, db, statements):
    device = register(client)
    assert client.get("/api/v1/me", headers=auth(device["token"])).status_code == 200
    first = db.execute("SELECT last_used_at FROM user_tokens").fetchone()[0]
    assert len([s for s in statements if s.startswith("UPDATE")]) == 1

    statements.clear()
    for _ in range(3):
        assert client.get("/api/v1/me", headers=auth(device["token"])).status_code == 200
    assert db.execute("SELECT last_used_at FROM user_tokens").fetchone()[0] == first
    # A recently used token costs one SELECT per request and no write.
    assert len(statements) == 3 and all(s.startswith("SELECT") for s in statements)

    # Over a minute later, the next request records the use again.
    db.execute("UPDATE user_tokens SET last_used_at = now() - interval '61 seconds'")
    stale = db.execute("SELECT last_used_at FROM user_tokens").fetchone()[0]
    assert client.get("/api/v1/me", headers=auth(device["token"])).status_code == 200
    assert db.execute("SELECT last_used_at FROM user_tokens").fetchone()[0] > stale

    # Just under a minute: left alone.
    db.execute("UPDATE user_tokens SET last_used_at = now() - interval '50 seconds'")
    recent = db.execute("SELECT last_used_at FROM user_tokens").fetchone()[0]
    assert client.get("/api/v1/me", headers=auth(device["token"])).status_code == 200
    assert db.execute("SELECT last_used_at FROM user_tokens").fetchone()[0] == recent


def test_using_one_token_does_not_touch_another(client, db):
    used, unused = register(client), register(client)
    assert client.get("/api/v1/me", headers=auth(used["token"])).status_code == 200
    rows = dict(db.execute("SELECT user_id::text, last_used_at FROM user_tokens").fetchall())
    assert rows[used["user_id"]] is not None
    assert rows[unused["user_id"]] is None


def test_no_endpoint_takes_a_user_id_from_the_client(client, db):
    mine, theirs = register(client), register(client)
    # Registration does not adopt an id the client sends.
    made = register(client, user_id=theirs["user_id"])
    assert made["user_id"] not in (mine["user_id"], theirs["user_id"])
    # The user is the token's, whatever else the request says.
    r = client.request(
        "GET",
        "/api/v1/me",
        params={"user_id": theirs["user_id"]},
        headers={**auth(mine["token"]), "X-User-Id": theirs["user_id"]},
    )
    assert r.json()["user_id"] == mine["user_id"]
    # And nothing in the API declares a user id as input.
    for path, operations in client.get("/openapi.json").json()["paths"].items():
        assert "user_id" not in path
        for operation in operations.values():
            assert all("user" not in p["name"].lower() for p in operation.get("parameters", [])), path
    request_schema = client.get("/openapi.json").json()["components"]["schemas"]["DeviceRegistration"]
    assert set(request_schema["properties"]) == {"platform", "app_version"}


def test_the_token_is_not_logged(client, caplog):
    with caplog.at_level(logging.DEBUG):
        token = register(client, platform="ios")["token"]
        assert client.get("/api/v1/me", headers=auth(token)).status_code == 200
        assert client.get("/api/v1/me", headers=auth(token + "x")).status_code == 401
    assert token not in caplog.text
    assert token.removeprefix("kalo_") not in caplog.text


@pytest.mark.parametrize(
    "path, method, asks",
    [
        ("/api/v1/devices", "POST", "content-type"),
        ("/api/v1/devices", "POST", "authorization, content-type"),
        ("/api/v1/me", "GET", "authorization"),
        ("/api/v1/me", "PATCH", "Authorization, Content-Type"),
        ("/api/v1/me", "DELETE", "authorization"),
    ],
)
def test_preflight_allows_a_write_with_authorization(client, path, method, asks):
    headers = {**ORIGIN, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": asks}
    r = client.options(path, headers=headers)
    assert r.status_code == 200, r.text
    assert r.headers["access-control-allow-origin"] == "*"
    assert method in r.headers["access-control-allow-methods"]
    allowed = r.headers["access-control-allow-headers"].lower()
    assert "authorization" in allowed and "content-type" in allowed
    assert "access-control-allow-credentials" not in r.headers


def test_registration_and_auth_errors_are_readable_cross_origin(client):
    r = client.post("/api/v1/devices", json={"platform": "web"}, headers=ORIGIN)
    assert r.status_code == 201
    assert r.headers["access-control-allow-origin"] == "*"
    assert "access-control-allow-credentials" not in r.headers
    ok = client.get("/api/v1/me", headers={**ORIGIN, **auth(r.json()["token"])})
    assert ok.status_code == 200 and ok.headers["access-control-allow-origin"] == "*"
    refused = client.get("/api/v1/me", headers=ORIGIN)
    assert refused.status_code == 401 and refused.headers["access-control-allow-origin"] == "*"


def test_a_failed_registration_leaves_no_user_behind(client, db, monkeypatch):
    # The user row is flushed before the token row; if the second insert fails, neither is kept.
    from app.services import users as user_service

    monkeypatch.setattr(user_service, "hash_token", lambda token: b"too short")
    with pytest.raises(Exception, match="octet_length|check constraint"):
        client.post("/api/v1/devices", json={})
    assert db.execute("SELECT count(*) FROM users").fetchone()[0] == 0
