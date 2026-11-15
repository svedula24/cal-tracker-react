"""The public-host guard (app/main.py `PublicHostGuard`): on PUBLIC_URL's host only /mcp, /oauth/* and
/.well-known/* are served; every other host (localhost, the LAN address the phone uses) sees the whole API.

The 404 tests run without a database (the guard answers before routing); the rest need DATABASE_URL.
"""

import asyncio
import os
from urllib.parse import unquote

import pytest
from fastapi.testclient import TestClient

from app.main import create_app, public_path
from app.settings import Settings, host_name

PUBLIC = "https://kalo.example"
SETTINGS = Settings(public_url=PUBLIC, secret=b"s" * 32)
needs_db = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set")

HIDDEN = [
    "/api/v1/me",
    "/api/v1/devices",
    "/api/v1/foods/search?q=banana",
    "/docs",
    "/openapi.json",
    "/",
    "/oauthx",
    "/oauth",
    "/mcpx",
    "/mcpfoo/bar",
    "/.well-knownx",
    "/.well-known/%2e%2e/api/v1/me",
    "/oauth//authorize",
]


@pytest.fixture
def bare():
    """The app without its lifespan (no database)."""
    return TestClient(create_app("postgresql://nowhere.invalid/none", settings=SETTINGS), follow_redirects=False)


@pytest.fixture
def client(migrated_url):
    with TestClient(create_app(migrated_url, settings=SETTINGS), follow_redirects=False) as c:
        yield c


def test_host_name_drops_port_case_and_trailing_dot():
    assert host_name("Kalo.Example:443") == "kalo.example"
    assert host_name("kalo.example.") == "kalo.example"
    assert host_name("KALO.EXAMPLE.:8000") == "kalo.example"
    assert host_name("192.168.1.20:8000") == "192.168.1.20"
    assert host_name("[::1]:8000") == "::1"
    assert SETTINGS.public_host == "kalo.example"


def test_the_guard_is_off_without_a_real_public_url():
    assert Settings().public_host is None
    # http://localhost is for local testing: that host is where the web build calls the API.
    assert Settings(public_url="http://localhost:8000", secret=b"s" * 32).public_host is None


@pytest.mark.parametrize(
    ("path", "public"),
    [("/mcp", True), ("/mcp/", True), ("/oauth/authorize", True), ("/.well-known/oauth-authorization-server", True),
     ("/mcpx", False), ("/oauthx/a", False), ("/oauth", False), ("/.well-known", False), ("/api/v1/me", False),
     ("/.well-known/../api", False), ("/oauth/./token", False), ("/mcp//x", False)],
)  # fmt: skip
def test_public_path(path, public):
    assert public_path(path) is public


@pytest.mark.parametrize("path", HIDDEN)
@pytest.mark.parametrize("host", ["kalo.example", "KALO.Example:443", "kalo.example:8000", "kalo.example."])
def test_hidden_paths_are_404_on_the_public_host(bare, path, host):
    for method in ("GET", "POST", "OPTIONS"):
        r = bare.request(method, path, headers={"Host": host, "Origin": "https://evil.example"})
        assert r.status_code == 404, (method, path, host)
        assert r.text == "Not found"
        assert "access-control-allow-origin" not in r.headers


@pytest.mark.parametrize(
    "raw", [b"/.well-known/../api/v1/me", b"/oauth/../docs", b"/mcp/./x", b"/mcp/..", b"/.well-known/%2e%2e/api"]
)
def test_dot_segments_are_404_as_sent(bare, raw):
    # httpx removes dot segments before sending, so the request goes to the app as an HTTP server hands it
    # over: the path as sent (percent-decoded), never normalised.
    sent = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET", "scheme": "https",
        "path": unquote(raw.decode()), "raw_path": raw, "root_path": "", "query_string": b"",
        "headers": [(b"host", b"kalo.example")], "client": ("1.2.3.4", 1), "server": ("kalo.example", 443),
    }  # fmt: skip
    asyncio.run(bare.app(scope, receive, send))
    assert sent[0]["status"] == 404 and sent[1]["body"] == b"Not found"


def test_a_hidden_path_is_refused_before_the_body_limit(bare):
    big = {"Host": "kalo.example", "Content-Length": str(10 * 1024 * 1024)}
    assert bare.post("/api/v1/sync", headers=big).status_code == 404


def test_public_paths_reach_the_app_on_the_public_host(bare):
    host = {"Host": "kalo.example"}
    assert bare.get("/.well-known/oauth-authorization-server", headers=host).status_code == 200
    assert bare.get("/.well-known/oauth-protected-resource/mcp", headers=host).status_code == 200
    assert bare.get("/.well-known/oauth-protected-resource", headers=host).status_code == 200
    # Not a guard 404: the sign-in page refuses a request without its parameters itself.
    r = bare.get("/oauth/authorize", headers=host)
    assert r.status_code != 404 and r.text != "Not found"
    # A real but unknown path under a public prefix is the router's JSON 404, not the guard's.
    r = bare.get("/oauth/nothing-here", headers=host)
    assert (r.status_code, r.json()) == (404, {"detail": "Not Found"})


@needs_db
def test_mcp_is_served_on_the_public_host(client):
    r = client.post("/mcp", json={}, headers={"Host": "kalo.example"})
    assert r.status_code == 401  # the bearer check, not the guard
    assert "resource_metadata" in r.headers["www-authenticate"]


@needs_db
@pytest.mark.parametrize(
    "host", ["localhost:8000", "127.0.0.1", "192.168.1.20:8000", "testserver", "kalo.example.evil"]
)
def test_other_hosts_see_the_whole_api(client, host):
    assert client.get("/api/v1/me", headers={"Host": host}).status_code == 401
    assert client.get("/openapi.json", headers={"Host": host}).status_code == 200
    assert client.post("/api/v1/devices", json={}, headers={"Host": host}).status_code == 201


@needs_db
def test_a_second_host_header_naming_the_public_host_is_guarded(client):
    r = client.get("/api/v1/me", headers=[("Host", "localhost"), ("Host", "kalo.example")])
    assert r.status_code == 404
