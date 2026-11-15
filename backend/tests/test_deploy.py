"""The serverless (Vercel + Neon) switches: SERVE_API_PUBLICLY, CLIENT_IP_HEADER, the DB_* engine settings and
the Postgres-backed rate limits (app/services/limits.py, RATE_LIMITS=db).

The settings, guard and engine tests need no database; the limiter tests need DATABASE_URL.
"""

import os
import threading

import psycopg
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import NullPool, QueuePool

from app.api.limits import SlidingWindow
from app.db import session as db_session
from app.db.session import make_engine
from app.main import ClientAddressHeader, create_app
from app.services.limits import DbSlidingWindow
from app.settings import Settings, get_settings

PUBLIC = "https://kalo.example"
needs_db = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set")


# ---- Settings ----


def test_defaults_keep_the_local_behaviour():
    s = get_settings({})
    assert (s.serve_api_publicly, s.rate_limits, s.client_ip_header) == (False, "memory", None)
    assert (s.db_pool_size, s.db_pool_pre_ping, s.db_pool_recycle, s.db_connect_timeout) == (10, False, -1, None)


def test_vercel_settings_are_read():
    s = get_settings(
        {
            "SERVE_API_PUBLICLY": "true",
            "RATE_LIMITS": "DB",
            "VERCEL": "1",
            "DB_POOL_SIZE": "0",
            "DB_POOL_PRE_PING": "yes",
            "DB_POOL_RECYCLE": "300",
            "DB_CONNECT_TIMEOUT": "10",
        }
    )
    assert (s.serve_api_publicly, s.rate_limits, s.client_ip_header) == (True, "db", "x-forwarded-for")
    assert (s.db_pool_size, s.db_pool_pre_ping, s.db_pool_recycle, s.db_connect_timeout) == (0, True, 300, 10)
    # An explicit header wins over Vercel's default.
    assert get_settings({"VERCEL": "1", "CLIENT_IP_HEADER": "X-Vercel-Forwarded-For"}).client_ip_header == (
        "x-vercel-forwarded-for"
    )


@pytest.mark.parametrize(
    ("env", "message"),
    [
        ({"RATE_LIMITS": "redis"}, "RATE_LIMITS"),
        ({"SERVE_API_PUBLICLY": "ture"}, "SERVE_API_PUBLICLY"),
        ({"DB_POOL_SIZE": "-1"}, "DB_POOL_SIZE"),
        ({"DB_POOL_SIZE": "ten"}, "DB_POOL_SIZE"),
        ({"DB_POOL_RECYCLE": "0"}, "DB_POOL_RECYCLE"),
        ({"DB_CONNECT_TIMEOUT": "0"}, "DB_CONNECT_TIMEOUT"),
    ],
)
def test_bad_values_are_refused(env, message):
    with pytest.raises(ValueError, match=message):
        get_settings(env)


# ---- The public-host guard switch ----


def bare(settings: Settings) -> TestClient:
    """The app without its lifespan (no database): /openapi.json answers without one."""
    return TestClient(create_app("postgresql://nowhere.invalid/none", settings=settings), follow_redirects=False)


def test_the_api_is_hidden_on_the_public_host_by_default():
    client = bare(Settings(public_url=PUBLIC, secret=b"s" * 32))
    assert client.get("/openapi.json", headers={"Host": "kalo.example"}).status_code == 404
    assert client.get("/openapi.json", headers={"Host": "localhost"}).status_code == 200


def test_serve_api_publicly_serves_the_whole_api_on_the_public_host_without_docs():
    client = bare(Settings(public_url=PUBLIC, secret=b"s" * 32, serve_api_publicly=True))
    for path in ("/openapi.json", "/docs", "/redoc"):
        r = client.get(path, headers={"Host": "kalo.example"})
        assert r.status_code == 404 and r.json() == {"detail": "Not Found"}  # FastAPI's 404: no such route
    # A route is reached (its 405 is FastAPI's JSON, not the guard's plain-text 404).
    r = client.get("/api/v1/devices", headers={"Host": "kalo.example"})
    assert r.status_code == 405
    assert r.json() == {"detail": "Method Not Allowed"}


# ---- The client address header ----


def peer_app():
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/plain")]})
        await send({"type": "http.response.body", "body": (scope["client"] or ("none",))[0].encode()})

    return app


@pytest.mark.parametrize(
    ("headers", "seen"),
    [
        ({"X-Forwarded-For": "203.0.113.7"}, "203.0.113.7"),
        ({"X-Forwarded-For": " 203.0.113.7, 10.0.0.1"}, "203.0.113.7"),
        ({"X-Forwarded-For": ""}, "testclient"),
        ({"X-Real-IP": "198.51.100.9"}, "testclient"),  # only the configured header counts
        ({}, "testclient"),
    ],
)
def test_client_address_comes_from_the_header(headers, seen):
    client = TestClient(ClientAddressHeader(peer_app(), header="x-forwarded-for"))
    assert client.get("/", headers=headers).text == seen


@needs_db
def test_rate_limits_key_on_the_header_address(migrated_url):
    settings = Settings(client_ip_header="x-forwarded-for")
    with TestClient(create_app(migrated_url, settings=settings)) as client:
        from app.main import REGISTRATIONS_PER_HOUR

        for _ in range(REGISTRATIONS_PER_HOUR):
            assert client.post("/api/v1/devices", headers={"X-Forwarded-For": "203.0.113.7"}).status_code == 201
        assert client.post("/api/v1/devices", headers={"X-Forwarded-For": "203.0.113.7"}).status_code == 429
        assert client.post("/api/v1/devices", headers={"X-Forwarded-For": "203.0.113.8"}).status_code == 201


# ---- Engine settings ----


def test_engine_defaults_are_unchanged():
    for engine in (make_engine("postgresql://u@localhost/db"), make_engine("postgresql://u@localhost/db", Settings())):
        assert isinstance(engine.pool, QueuePool)
        assert (engine.pool.size(), engine.pool._max_overflow, engine.pool._timeout) == (10, 0, 5)
        assert (engine.pool._pre_ping, engine.pool._recycle) == (False, -1)


def test_engine_for_serverless(monkeypatch):
    seen = {}
    real = db_session.create_engine

    def spy(url, **kwargs):
        seen.update(kwargs)
        return real(url, **kwargs)

    monkeypatch.setattr(db_session, "create_engine", spy)
    small = make_engine("postgresql://u@h/db", Settings(db_pool_size=3, db_pool_pre_ping=True, db_pool_recycle=300))
    assert (small.pool.size(), small.pool._pre_ping, small.pool._recycle) == (3, True, 300)
    assert seen["connect_args"] == {}
    none = make_engine("postgresql://u@h/db", Settings(db_pool_size=0, db_connect_timeout=10))
    assert isinstance(none.pool, NullPool)
    assert seen["connect_args"] == {"connect_timeout": 10}


# ---- Rate limits in Postgres ----


@pytest.fixture
def engine(migrated_url):
    e = make_engine(migrated_url)
    yield e
    e.dispose()


def window(engine, limit, per_seconds, now, name="test"):
    return DbSlidingWindow(engine, name, limit, per_seconds, clock=lambda: now[0])


@needs_db
def test_db_window_allows_up_to_the_limit_then_says_how_long_to_wait(engine):
    now = [1000.0]
    w = window(engine, 3, 60, now)
    assert [w.retry_after("a") for _ in range(3)] == [None, None, None]
    now[0] = 1010.0
    assert w.retry_after("a") == pytest.approx(50.0)
    assert w.retry_after("b") is None


@needs_db
def test_db_window_refusals_and_checks_are_not_counted_and_old_events_age_out(engine):
    now = [1000.0]
    w = window(engine, 2, 60, now)
    assert w.retry_after("a", record=False) is None  # a check only
    assert w.retry_after("a") is None
    now[0] = 1030.0
    assert w.retry_after("a") is None
    for _ in range(5):
        assert w.retry_after("a") is not None
    now[0] = 1060.0
    assert w.retry_after("a") is None
    assert w.retry_after("a") == pytest.approx(30.0)


@needs_db
def test_db_window_is_shared_between_instances_but_not_between_names(engine):
    now = [1000.0]
    one, two = window(engine, 2, 60, now), window(engine, 2, 60, now)
    assert one.retry_after("a") is None
    assert two.retry_after("a") is None
    assert one.retry_after("a") is not None  # the second instance's event counts here
    assert window(engine, 2, 60, now, name="other").retry_after("a") is None


@needs_db
def test_db_window_sweeps_keys_whose_events_all_aged_out(engine, migrated_url):
    now = [1000.0]
    w = window(engine, 1, 60, now)
    for key in ("a", "b", "c"):
        w.retry_after(key)
    window(engine, 1, 60, now, name="other").retry_after("x")
    now[0] = 1061.0  # past the window and past SWEEP_EVERY since the limiter was made
    w.retry_after("d")
    with psycopg.connect(migrated_url) as conn:
        rows = conn.execute("SELECT name, key FROM rate_limits ORDER BY name, key").fetchall()
    assert rows == [("other", "x"), ("test", "d")]  # another limiter's rows are its own to sweep


@needs_db
def test_db_window_concurrent_calls_never_exceed_the_limit(engine):
    w = DbSlidingWindow(engine, "test", 20, 3600)
    allowed, errors = [], []

    def hammer():
        try:
            for _ in range(10):
                allowed.append(w.retry_after("shared") is None)
        except Exception as e:  # noqa: BLE001 - any failure here is the bug
            errors.append(e)

    threads = [threading.Thread(target=hammer) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert sum(allowed) == 20


@needs_db
def test_rate_limits_db_puts_every_limiter_in_postgres(migrated_url):
    names = ("registrations", "pairing_codes", "pairing_attempts", "pairing_attempts_overall")
    names += ("barcode_lookups", "off_reads", "food_searches")
    names += ("link_codes", "link_attempts", "link_attempts_overall")
    with TestClient(create_app(migrated_url)) as memory:
        assert all(isinstance(getattr(memory.app.state, n), SlidingWindow) for n in names)
    with TestClient(create_app(migrated_url, settings=Settings(rate_limits="db"))) as client:
        assert all(isinstance(getattr(client.app.state, n), DbSlidingWindow) for n in names)
        from app.main import REGISTRATIONS_PER_HOUR

        for _ in range(REGISTRATIONS_PER_HOUR):
            assert client.post("/api/v1/devices").status_code == 201
        refused = client.post("/api/v1/devices")
        assert refused.status_code == 429
        assert 0 < int(refused.headers["retry-after"]) <= 3600
    # A new app (another instance, or the next cold start) still refuses: the count is in the database.
    with TestClient(create_app(migrated_url, settings=Settings(rate_limits="db"))) as again:
        assert again.post("/api/v1/devices").status_code == 429


@needs_db
def test_db_limiters_have_their_own_pool(migrated_url):
    """A request holding its connection while its limiter runs must not wait on the requests' pool."""
    import concurrent.futures

    settings = Settings(rate_limits="db", db_pool_size=1)
    with TestClient(create_app(migrated_url, settings=settings)) as client:
        app = client.app
        with app.state.engine.connect():  # the requests' only connection is taken
            assert app.state.food_searches.retry_after("x") is None  # answered at once, not after 5 s
        # Many concurrent limited requests through a pool of one: none times out (503).
        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            codes = list(pool.map(lambda _: client.get("/api/v1/foods/search?q=banana").status_code, range(24)))
        assert codes == [200] * 24
        assert app.state.limits_engine is not app.state.engine


@needs_db
def test_food_search_and_lookup_are_limited_per_address(migrated_url):
    with TestClient(create_app(migrated_url)) as client:
        client.app.state.food_searches = SlidingWindow(3, per_seconds=3600)
        assert client.get("/api/v1/foods/search?q=banana").status_code == 200
        assert client.get("/api/v1/foods/123").status_code == 404
        assert client.get("/api/v1/foods/search?q=rice").status_code == 200
        for path in ("/api/v1/foods/search?q=apple", "/api/v1/foods/123"):  # one allowance for both
            refused = client.get(path)
            assert refused.status_code == 429
            assert 0 < int(refused.headers["retry-after"]) <= 3600


def test_food_searches_allow_a_busy_hour_of_typing():
    from app.api.v1.foods import FOOD_SEARCHES_PER_HOUR

    # 30 searches of up to 15 keystrokes, each a request (150 ms debounce, no cache hits): 450.
    assert FOOD_SEARCHES_PER_HOUR >= 30 * 15
