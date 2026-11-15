"""Linking another install to the same user (app/api/v1/link.py, app/services/linking.py).

Needs Postgres: set DATABASE_URL. Each test runs the app against a freshly migrated scratch schema.
"""

import logging
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.api.limits import SlidingWindow
from app.main import create_app
from app.services import pairing
from app.settings import Settings

pytestmark = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set")

CODE_RE = re.compile(r"[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}")
TOKEN_RE = re.compile(r"kalo_[A-Za-z0-9_-]{43}")
INVALID = {"detail": "invalid or expired code"}


@pytest.fixture
def client(migrated_url):
    with TestClient(create_app(migrated_url)) as c:
        yield c


@pytest.fixture
def db(migrated_url):
    """A second connection to the same scratch schema: it sees only what the app committed."""
    with psycopg.connect(migrated_url, autocommit=True) as conn:
        yield conn


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def device(client, timezone="America/New_York"):
    r = client.post("/api/v1/devices", json={"platform": "ios", "app_version": "1.4.0", "timezone": timezone})
    assert r.status_code == 201, r.text
    return r.json()


def link_code(client, token):
    r = client.post("/api/v1/link-codes", headers=auth(token))
    assert r.status_code == 201, r.text
    return r.json()["code"]


def link(client, code, **body):
    return client.post("/api/v1/devices/link", json={"code": code, "platform": "web", **body})


def test_a_link_code(client):
    r = client.post("/api/v1/link-codes", headers=auth(device(client)["token"]))
    assert r.status_code == 201
    assert r.headers["cache-control"] == "no-store"
    assert set(r.json()) == {"code", "expires_at"}
    assert CODE_RE.fullmatch(r.json()["code"])


def test_linking_gives_a_new_token_for_the_same_user(client, db):
    phone = device(client)
    code = link_code(client, phone["token"])
    r = link(client, code.lower().replace("-", " "), app_version="2.0", timezone="Europe/Paris")  # typed loosely
    assert r.status_code == 201, r.text
    assert r.headers["cache-control"] == "no-store"
    linked = r.json()
    assert set(linked) == {"user_id", "token", "timezone"}
    assert TOKEN_RE.fullmatch(linked["token"]) and linked["token"] != phone["token"]
    # The code's user, with their timezone (the one the new install sent is not applied).
    assert linked["user_id"] == phone["user_id"] and linked["timezone"] == "America/New_York"
    me = client.get("/api/v1/me", headers=auth(linked["token"]))
    assert me.status_code == 200 and me.json()["user_id"] == phone["user_id"]
    # Both installs keep working; no user was created.
    assert client.get("/api/v1/me", headers=auth(phone["token"])).json()["user_id"] == phone["user_id"]
    assert db.execute("SELECT count(*) FROM users").fetchone()[0] == 1
    labels = db.execute("SELECT label FROM user_tokens ORDER BY created_at").fetchall()
    assert labels == [("ios 1.4.0",), ("web 2.0 (linked)",)]


def test_the_linked_token_reads_and_writes_the_same_data(client):
    phone = device(client)
    entry = {
        "id": "7b0d3f9e-8a63-4d7e-9a0e-2f1f4f6c1a01", "fdc_id": None, "log_date": "2026-11-14",
        "logged_at": "2026-11-14T12:00:00Z", "name": "Soup", "food_name": None, "unit": "serving", "quantity": 1,
        "values": {"calories": 300, "protein_g": 10, "carbs_g": 40, "fat_g": 9, "fiber_g": 3, "sugar_g": 2,
                   "sodium_mg": 400},
        "food_values": None, "updated_at": "2026-11-14T12:00:00Z", "deleted_at": None,
    }  # fmt: skip
    push = {"cursor": None, "changes": {"food_logs": [entry]}}
    pushed = client.post("/api/v1/sync", headers=auth(phone["token"]), json=push)
    assert pushed.status_code == 200, pushed.text
    web = link(client, link_code(client, phone["token"])).json()["token"]
    pulled = client.post("/api/v1/sync", headers=auth(web), json={"cursor": None, "changes": {}}).json()
    assert [row["name"] for row in pulled["changes"]["food_logs"]] == ["Soup"]


def test_a_used_code_does_not_link_again(client):
    code = link_code(client, device(client)["token"])
    assert link(client, code).status_code == 201
    r = link(client, code)
    assert r.status_code == 400 and r.json() == INVALID


@pytest.mark.parametrize("code", ["ZZZZ-ZZZZ", "", "not a code", "K7QM-4XP"])
def test_a_wrong_code_is_400(client, db, code):
    r = link(client, code)
    assert r.status_code == 400 and r.json() == INVALID
    assert db.execute("SELECT count(*) FROM user_tokens").fetchone()[0] == 0


def test_an_expired_code_is_400(client, db):
    code = link_code(client, device(client)["token"])
    db.execute("UPDATE link_codes SET expires_at = now() - interval '1 second'")
    assert link(client, code).json() == INVALID


def test_two_links_racing_for_one_code_only_one_wins(client, db):
    code = link_code(client, device(client)["token"])
    start = threading.Barrier(8)

    def attempt(_):
        start.wait()
        return link(client, code).status_code

    with ThreadPoolExecutor(8) as pool:
        statuses = sorted(pool.map(attempt, range(8)))
    assert statuses == [201] + [400] * 7
    assert db.execute("SELECT count(*) FROM user_tokens WHERE label LIKE '%(linked)'").fetchone()[0] == 1


def test_a_new_code_replaces_the_users_earlier_one(client):
    token = device(client)["token"]
    first, second = link_code(client, token), link_code(client, token)
    assert link(client, first).status_code == 400
    assert link(client, second).status_code == 201


def test_link_codes_and_pairing_codes_are_not_interchangeable(client, migrated_url):
    token = device(client)["token"]
    pairing_code = client.post("/api/v1/pairing-codes", headers=auth(token)).json()["code"]
    code = link_code(client, token)
    # A pairing code does not link, and a link code does not replace the user's pairing code.
    assert link(client, pairing_code).status_code == 400
    from sqlalchemy.orm import Session

    from app.db.session import make_engine

    engine = make_engine(migrated_url)
    try:
        with Session(engine) as session:
            assert pairing.consume(session, code) is None  # a link code does not sign ChatGPT in
            assert pairing.consume(session, pairing_code) is not None
    finally:
        engine.dispose()
    assert link(client, code).status_code == 201


def test_a_linked_token_can_be_revoked_like_any_other(client, db):
    phone = device(client)
    web = link(client, link_code(client, phone["token"])).json()["token"]
    db.execute("UPDATE user_tokens SET revoked_at = now() WHERE label LIKE '%(linked)'")
    assert client.get("/api/v1/me", headers=auth(web)).status_code == 401
    assert client.get("/api/v1/me", headers=auth(phone["token"])).status_code == 200


def test_linking_works_when_registration_is_closed(migrated_url, client):
    phone = device(client)  # registered while the server was open
    code = link_code(client, phone["token"])
    with TestClient(create_app(migrated_url, settings=Settings(allow_registration=False))) as closed:
        assert closed.post("/api/v1/devices", json={"platform": "web"}).status_code == 403
        r = link(closed, code)
        assert r.status_code == 201 and r.json()["user_id"] == phone["user_id"]


def test_link_codes_need_a_device_token_and_are_limited_per_user(client):
    assert client.post("/api/v1/link-codes").status_code == 401
    token = device(client)["token"]
    for _ in range(10):
        link_code(client, token)
    r = client.post("/api/v1/link-codes", headers=auth(token))
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0
    assert client.post("/api/v1/link-codes", headers=auth(device(client)["token"])).status_code == 201  # another user


def test_link_attempts_are_limited_per_address(client):
    for _ in range(10):
        assert link(client, "ZZZZ-ZZZZ").status_code == 400
    code = link_code(client, device(client)["token"])
    r = link(client, code)
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0
    client.app.state.link_attempts = SlidingWindow(10, per_seconds=900)  # the window has passed
    assert link(client, code).status_code == 201  # the refused try did not spend the code


def test_link_attempts_are_limited_overall(client):
    client.app.state.link_attempts_overall = SlidingWindow(3, per_seconds=3600)
    # A right code does not count overall: only wrong ones do.
    for _ in range(3):
        assert link(client, link_code(client, device(client)["token"])).status_code == 201
    for _ in range(3):
        assert link(client, "ZZZZ-ZZZZ").status_code == 400
    code = link_code(client, device(client)["token"])
    assert link(client, code).status_code == 429
    client.app.state.link_attempts_overall = SlidingWindow(3, per_seconds=3600)
    assert link(client, code).status_code == 201


def test_register_limits_takes_another_limiter():
    made = []

    class Limiter:
        def __init__(self, limit, per_seconds):
            made.append((limit, per_seconds))

    from fastapi import FastAPI

    from app.api.v1.link import register_limits

    app = FastAPI()
    register_limits(app, Limiter)
    assert made == [(10, 3600), (10, 900), (1000, 3600)]
    names = ("link_codes", "link_attempts", "link_attempts_overall")
    assert all(isinstance(getattr(app.state, name), Limiter) for name in names)


def test_codes_and_tokens_are_not_logged_or_stored_in_the_clear(client, db, caplog):
    caplog.set_level(logging.DEBUG)
    phone = device(client)
    code = link_code(client, phone["token"])
    token = link(client, code).json()["token"]
    for secret in (code, code.replace("-", ""), token):
        assert secret not in caplog.text
    stored = db.execute("SELECT code_hash, used_at FROM link_codes").fetchall()
    assert len(stored) == 1 and stored[0][0] == pairing.hash_code(code.replace("-", "")) and stored[0][1] is not None
