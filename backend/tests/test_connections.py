"""/api/v1/pairing-codes and /api/v1/connections (app/api/v1/connections.py): the app's Connect ChatGPT screen.

Needs Postgres: set DATABASE_URL.
"""

import os
import re
import uuid
from datetime import UTC, datetime, timedelta

import psycopg
import pytest
from fastapi.testclient import TestClient
from test_oauth import CHATGPT, READ, REDIRECT, WRITE, auth, connect, device, make_app, resolve

pytestmark = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set")

CODE_RE = re.compile(r"[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}")


@pytest.fixture
def client(migrated_url):
    with TestClient(make_app(migrated_url), follow_redirects=False) as c:
        yield c


def test_a_pairing_code(client):
    token = device(client)
    before = datetime.now(UTC)
    r = client.post("/api/v1/pairing-codes", headers=auth(token))
    assert r.status_code == 201
    assert r.headers["cache-control"] == "no-store"
    body = r.json()
    assert set(body) == {"code", "expires_at"}
    assert CODE_RE.fullmatch(body["code"])
    expires_at = datetime.fromisoformat(body["expires_at"])
    assert timedelta(minutes=9) < expires_at - before < timedelta(minutes=10, seconds=5)


def test_pairing_codes_are_limited_to_10_an_hour_per_user(client):
    token = device(client)
    for _ in range(10):
        assert client.post("/api/v1/pairing-codes", headers=auth(token)).status_code == 201
    r = client.post("/api/v1/pairing-codes", headers=auth(token))
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0
    assert client.post("/api/v1/pairing-codes", headers=auth(device(client))).status_code == 201  # another user


def test_the_endpoints_need_a_device_token(client):
    tokens, _ = connect(client)
    for method, path in (
        ("POST", "/api/v1/pairing-codes"),
        ("GET", "/api/v1/connections"),
        ("DELETE", f"/api/v1/connections/{uuid.uuid4()}"),
    ):
        assert client.request(method, path).status_code == 401
        assert client.request(method, path, headers=auth(tokens["access_token"])).status_code == 401


def test_connections_are_listed_and_disconnect_stops_the_token(client, migrated_url):
    assert client.get("/api/v1/connections", headers=auth(device(client))).json() == {"connections": []}
    tokens, device_token = connect(client)
    read_only, _ = connect(client, device_token, allow_write=False, client_id=registered(client, "Dev"))
    r = client.get("/api/v1/connections", headers=auth(device_token))
    assert r.status_code == 200
    connections = r.json()["connections"]
    assert [(c["client_name"], c["scopes"]) for c in connections] == [("Dev", [READ]), ("ChatGPT", [READ, WRITE])]
    assert set(connections[0]) == {"id", "client_name", "scopes", "created_at", "last_used_at"}
    assert connections[1]["last_used_at"] is None
    first = resolve(migrated_url, tokens["access_token"])
    assert str(first.grant_id) == connections[1]["id"]
    listed = client.get("/api/v1/connections", headers=auth(device_token)).json()["connections"]
    assert listed[1]["last_used_at"] is not None

    r = client.delete(f"/api/v1/connections/{first.grant_id}", headers=auth(device_token))
    assert r.status_code == 204
    assert resolve(migrated_url, tokens["access_token"]) is None
    assert resolve(migrated_url, read_only["access_token"]) is not None  # the other connection is untouched
    r = client.post(
        "/oauth/token", data={"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"], "client_id":
        CHATGPT})  # fmt: skip
    assert r.json()["error"] == "invalid_grant"
    remaining = client.get("/api/v1/connections", headers=auth(device_token)).json()["connections"]
    assert [c["id"] for c in remaining] == [connections[0]["id"]]
    # Again: still gone, still 204.
    assert client.delete(f"/api/v1/connections/{first.grant_id}", headers=auth(device_token)).status_code == 204


def test_another_users_connection_is_404(client, migrated_url):
    tokens, _ = connect(client)
    grant_id = resolve(migrated_url, tokens["access_token"]).grant_id
    other = device(client)
    assert client.get("/api/v1/connections", headers=auth(other)).json() == {"connections": []}
    assert client.delete(f"/api/v1/connections/{grant_id}", headers=auth(other)).status_code == 404
    assert client.delete(f"/api/v1/connections/{uuid.uuid4()}", headers=auth(other)).status_code == 404
    assert client.delete("/api/v1/connections/not-a-uuid", headers=auth(other)).status_code == 422
    assert resolve(migrated_url, tokens["access_token"]) is not None


def registered(client, name):
    """A client id from dynamic registration: a second client besides ChatGPT."""
    r = client.post("/oauth/register", json={"redirect_uris": [REDIRECT], "client_name": name})
    assert r.status_code == 201, r.text
    return r.json()["client_id"]


def test_connecting_the_same_client_again_replaces_the_connection(client, migrated_url):
    first, device_token = connect(client)
    other_user, _ = connect(client)  # another user's connection to the same client is not touched
    second, _ = connect(client, device_token, allow_write=False)
    assert resolve(migrated_url, first["access_token"]) is None
    assert client.post("/oauth/token", data={
        "grant_type": "refresh_token", "refresh_token": first["refresh_token"], "client_id": CHATGPT,
    }).json()["error"] == "invalid_grant"  # fmt: skip
    assert resolve(migrated_url, second["access_token"]) is not None
    assert resolve(migrated_url, other_user["access_token"]) is not None
    listed = client.get("/api/v1/connections", headers=auth(device_token)).json()["connections"]
    assert [(c["client_name"], c["scopes"]) for c in listed] == [("ChatGPT", [READ])]
    assert listed[0]["id"] == str(resolve(migrated_url, second["access_token"]).grant_id)


def test_a_connection_whose_refresh_tokens_expired_is_not_listed(client, migrated_url):
    tokens, device_token = connect(client)
    assert len(client.get("/api/v1/connections", headers=auth(device_token)).json()["connections"]) == 1
    with psycopg.connect(migrated_url, autocommit=True) as db:
        db.execute("UPDATE oauth_tokens SET expires_at = now() - interval '1 second' WHERE kind = 'refresh'")
    assert client.get("/api/v1/connections", headers=auth(device_token)).json() == {"connections": []}
    # Its access token still works until its own expiry (an hour at most), and Disconnect still ends it.
    grant = resolve(migrated_url, tokens["access_token"])
    assert grant is not None
    assert client.delete(f"/api/v1/connections/{grant.grant_id}", headers=auth(device_token)).status_code == 204
    assert resolve(migrated_url, tokens["access_token"]) is None
