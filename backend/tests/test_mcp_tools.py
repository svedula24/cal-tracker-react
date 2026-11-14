"""The MCP server (app/mcp/): its tools, called through the MCP protocol by the SDK's own client.

The client speaks Streamable HTTP to the FastAPI app in-process (an httpx2 ASGITransport; the app's
lifespan is entered by hand, since the transport does not run it). Tokens come from a stub verifier
(`create_app(token_verifier=...)`) that maps a test token to a user and scopes; the real verifier and
the OAuth flow are tested in tests/test_oauth.py and the end-to-end tests.

Needs Postgres: set DATABASE_URL. Foods and helpers come from tests/test_food_logs.py.
"""

import json
import os
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx2
import psycopg
import pytest
import test_food_logs as logs
from fastapi.testclient import TestClient
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.server.auth.provider import AccessToken
from test_food_logs import BANANA, CHICKEN, RETIRED

from app.main import create_app
from app.settings import Settings
from kalo.usda.load import load
from kalo.usda.nutrients import FoodRow
from kalo.usda.portions import Portion

pytestmark = [
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
    pytest.mark.anyio,
]

BASE = "http://localhost"
SETTINGS = Settings(public_url=BASE, secret=b"test-secret-" * 4)
READ = ["nutrition:read"]
READ_WRITE = ["nutrition:read", "nutrition:write"]
TOOLS = {
    # name: (readOnlyHint, destructiveHint, idempotentHint)
    "search_foods": (True, False, True),
    "get_recent_foods": (True, False, True),
    "get_daily_macros": (True, False, True),
    "get_nutrition_history": (True, False, True),
    "log_food": (False, False, False),
    "log_custom_food": (False, False, False),
    "update_food_log": (False, False, True),
    "delete_food_log": (False, True, True),
    "update_daily_goal": (False, False, True),
}
WRITE_CALLS = {
    "log_food": {"fdc_id": BANANA, "grams": 100},
    "log_custom_food": {"name": "Soup", "calories": 100, "protein_g": 5, "carbs_g": 10, "fat_g": 3},
    "update_food_log": {"log_id": str(uuid.uuid4()), "amount": 50},
    "delete_food_log": {"log_id": str(uuid.uuid4())},
    "update_daily_goal": {"calories": 2000, "protein_g": 150, "carbs_g": 200, "fat_g": 60},
}


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def foods(migrated_url):
    rows = [
        FoodRow(fdc_id=i, description=d, data_type="SR Legacy", brand_name=None, calories_per_100g=kcal,
                protein_per_100g=p, carbs_per_100g=c, fat_per_100g=f,
                fiber_per_100g=fiber, sugar_per_100g=sugar, sodium_mg_per_100g=sodium)
        for i, d, kcal, p, c, f, fiber, sugar, sodium in logs.FOODS
    ]  # fmt: skip
    load(rows, [Portion(fdc_id=i, description=d, gram_weight=g) for i, d, g in logs.PORTIONS], migrated_url)
    with psycopg.connect(migrated_url, autocommit=True) as conn:
        conn.execute("UPDATE foods SET retired_at = now() WHERE fdc_id = %s", (RETIRED,))
    return migrated_url


db = logs.db


@dataclass
class StubVerifier:
    """Test tokens: token -> (user id, scopes)."""

    tokens: dict[str, tuple[str, list[str]]] = field(default_factory=dict)

    async def verify_token(self, token: str) -> AccessToken | None:
        if token not in self.tokens:
            return None
        user_id, scopes = self.tokens[token]
        return AccessToken(token=token, client_id="test", scopes=scopes, resource=SETTINGS.resource, subject=user_id)


@dataclass
class Kalo:
    """The running app: plain HTTP (`http`), and MCP sessions as a given user (`mcp`)."""

    app: object
    http: httpx2.AsyncClient
    verifier: StubVerifier

    async def device(self) -> tuple[dict[str, str], str]:
        """A new user: its device-token headers and its id."""
        r = await self.http.post("/api/v1/devices", json={})
        assert r.status_code == 201, r.text
        headers = {"Authorization": f"Bearer {r.json()['token']}"}
        return headers, r.json()["user_id"]

    def token(self, user_id: str, scopes: list[str] = READ_WRITE) -> str:
        token = f"test_{uuid.uuid4().hex}"
        self.verifier.tokens[token] = (user_id, scopes)
        return token

    @asynccontextmanager
    async def mcp(self, token: str) -> AsyncIterator["Mcp"]:
        transport = httpx2.ASGITransport(app=self.app)
        headers = {"Authorization": f"Bearer {token}"}
        async with (
            httpx2.AsyncClient(transport=transport, base_url=BASE, headers=headers) as http,
            Client(streamable_http_client(f"{BASE}/mcp", http_client=http), cache=None) as client,
        ):
            yield Mcp(client)


@dataclass
class Mcp:
    client: Client

    async def call(self, tool: str, /, **arguments) -> dict:
        """The tool's result (its structured content); fails the test on a tool error."""
        result = await self.client.call_tool(tool, arguments)
        assert not result.is_error, result.content[0].text
        assert json.loads(result.content[0].text) == result.structured_content
        return result.structured_content

    async def error(self, tool: str, /, **arguments) -> str:
        """The message of a call that must fail as a tool error (isError), not a protocol error or a 500."""
        result = await self.client.call_tool(tool, arguments)
        assert result.is_error, result.structured_content
        return result.content[0].text


@asynccontextmanager
async def kalo(url: str, settings: Settings = SETTINGS) -> AsyncIterator[Kalo]:
    verifier = StubVerifier()
    app = create_app(url, settings=settings, token_verifier=verifier)
    async with (
        app.router.lifespan_context(app),
        httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=BASE) as http,
    ):
        yield Kalo(app, http, verifier)


@asynccontextmanager
async def user(url: str, scopes: list[str] = READ_WRITE) -> AsyncIterator[tuple[Kalo, Mcp, dict[str, str], str]]:
    """The app, an MCP session for a new user, that user's device headers and id."""
    async with kalo(url) as k:
        headers, user_id = await k.device()
        async with k.mcp(k.token(user_id, scopes)) as m:
            yield k, m, headers, user_id


def today() -> str:
    return datetime.now(UTC).date().isoformat()


# --- the protocol surface ------------------------------------------------------------------------------


async def test_tools_list_names_every_tool_with_all_annotations(foods):
    async with user(foods) as (_k, m, _h, _u):
        listed = (await m.client.list_tools()).tools
    assert {tool.name for tool in listed} == set(TOOLS)
    for tool in listed:
        hints = tool.annotations
        assert (hints.read_only_hint, hints.destructive_hint, hints.idempotent_hint) == TOOLS[tool.name], tool.name
        assert hints.open_world_hint is False, tool.name
        assert tool.description and len(tool.description) > 60, tool.name
        assert tool.input_schema["type"] == "object"
    schemas = {tool.name: tool.input_schema for tool in listed}
    assert schemas["log_food"]["required"] == ["fdc_id"]
    assert schemas["log_food"]["properties"]["quantity"]["default"] == 1
    assert set(schemas["get_nutrition_history"]["required"]) == {"start_date", "end_date"}
    assert schemas["search_foods"]["properties"]["limit"]["maximum"] == 20
    assert set(schemas["delete_food_log"]["required"]) == {"log_id"}


async def test_no_token_is_a_401_naming_the_resource_metadata(foods):
    async with kalo(foods) as k:
        r = await k.http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        assert r.status_code == 401
        challenge = r.headers["www-authenticate"]
        assert challenge.startswith("Bearer ")
        assert f'resource_metadata="{BASE}/.well-known/oauth-protected-resource/mcp"' in challenge
        r = await k.http.post("/mcp", json={}, headers={"Authorization": "Bearer not-a-token"})
        assert r.status_code == 401
        # A token without nutrition:read is refused outright.
        _h, user_id = await k.device()
        r = await k.http.post("/mcp", json={}, headers={"Authorization": f"Bearer {k.token(user_id, [])}"})
        assert r.status_code == 403
        assert "insufficient_scope" in r.headers["www-authenticate"]
        # The protected-resource document, at the path the challenge names and at the bare path.
        for path in ("/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"):
            doc = (await k.http.get(path)).json()
            assert doc["resource"] == f"{BASE}/mcp"
            assert doc["authorization_servers"] == [BASE]  # no trailing slash: the issuer exactly
            assert doc["scopes_supported"] == READ_WRITE


async def test_a_device_token_is_not_an_mcp_token(foods):
    """With the real verifier (no stub): a device token, or anything else, is a 401 on /mcp."""
    app = create_app(foods, settings=SETTINGS)
    async with (
        app.router.lifespan_context(app),
        httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=BASE) as http,
    ):
        device = (await http.post("/api/v1/devices", json={})).json()["token"]
        for token in (device, "kalo_at_made-up"):
            r = await http.post("/mcp", json={}, headers={"Authorization": f"Bearer {token}"})
            assert r.status_code == 401


async def test_another_host_is_refused(foods):
    async with user(foods) as (k, _m, _h, user_id):
        r = await k.http.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            headers={"Authorization": f"Bearer {k.token(user_id)}", "Host": "evil.example"},
        )
        assert r.status_code in (400, 421)


def test_without_public_url_there_is_no_mcp_and_no_oauth(foods):
    with TestClient(create_app(foods, settings=Settings())) as client:
        assert client.post("/mcp", json={}).status_code == 404
        assert client.get("/.well-known/oauth-protected-resource/mcp").status_code == 404
        assert client.get("/.well-known/oauth-authorization-server").status_code == 404
        # The pairing and connection endpoints exist either way.
        token = client.post("/api/v1/devices", json={}).json()["token"]
        assert client.get("/api/v1/connections", headers={"Authorization": f"Bearer {token}"}).status_code == 200


# --- reads ---------------------------------------------------------------------------------------------


async def test_search_foods(foods):
    async with user(foods) as (_k, m, _h, _u):
        out = await m.call("search_foods", query="banana")
        assert out["today"] == today() and out["timezone"] == "UTC"
        banana = next(food for food in out["foods"] if food["fdc_id"] == BANANA)
        assert banana["name"] == "Bananas, raw"
        assert banana["per_100g"] == {
            "calories": 89.0, "protein_g": 0.7, "carbs_g": 23.0, "fat_g": 0.3,
            "fiber_g": 1.7, "sugar_g": 15.8, "sodium_mg": 1.0,
        }  # fmt: skip
        assert banana["portions"] == [{"name": "1 extra small", "grams": 81.0}, {"name": "1 medium", "grams": 118.0}]
        assert "Kale" not in json.dumps(out)  # retired foods are not found
        assert "must contain text" in await m.error("search_foods", query="   ")
        assert "limit" in await m.error("search_foods", query="banana", limit=500)


async def test_daily_macros_entries_totals_target_and_remaining(foods):
    async with user(foods) as (k, m, headers, _u):
        empty = await m.call("get_daily_macros")
        assert empty["date"] == today() and empty["entries"] == []
        assert empty["target"] is None and empty["remaining"] is None and empty["goal"] is None
        goal = {
            "calories": 2000, "protein_g": 150, "carbs_g": 200, "fat_g": 65, "fiber_g": 30, "sugar_g": 50,
            "sodium_mg": 2300, "steps": 10000, "goal": "lose", "workout_kcal": 300,
        }  # fmt: skip
        assert (await k.http.put("/api/v1/goals/2026-01-01", json=goal, headers=headers)).status_code == 200
        day = "2026-03-01"
        r = await k.http.put(
            f"/api/v1/daily-activity/{day}", json={"steps": 2000, "day_type": "workout"}, headers=headers
        )
        assert r.status_code == 200
        logged = await m.call("log_food", fdc_id=BANANA, grams=150, date=day)
        await m.call("log_food", fdc_id=CHICKEN, grams=100, date=day, name="Lunch chicken")
        out = await m.call("get_daily_macros", date=day)
        assert out["date"] == day and out["today"] == today()
        assert [e["name"] for e in out["entries"]] == ["Lunch chicken", "Bananas, raw"]  # newest first
        assert out["entries"][1] == {**logged["logged"]}
        assert out["entries"][1]["amount"] == "150 g"
        assert out["totals"]["calories"] == round(89 * 1.5 + 165, 1)
        # 2000 steps x 0.035 = 70 kcal, plus the goal's 300 workout kcal on a workout day.
        assert out["activity"] == {"steps": 2000, "day_type": "workout", "workout_kcal": None}
        assert out["activity_kcal"] == 370
        assert out["target"]["calories"] == 2370 and out["target"]["carbs_g"] == 292.5
        assert out["remaining"]["calories"] == round(2370 - (89 * 1.5 + 165), 1)
        assert out["goal"]["since"] == "2026-01-01" and out["goal"]["workout_kcal"] == 300
        assert "real day" in await m.error("get_daily_macros", date="2026-02-30")
        assert "date" in await m.error("get_daily_macros", date="March 1")


async def test_nutrition_history(foods):
    async with user(foods) as (k, m, headers, _u):
        goal = {
            "calories": 2000, "protein_g": 150, "carbs_g": 200, "fat_g": 65, "fiber_g": 30, "sugar_g": 50,
            "sodium_mg": 2300, "steps": 10000, "goal": "lose",
        }  # fmt: skip
        await k.http.put("/api/v1/goals/2026-03-02", json=goal, headers=headers)
        await k.http.put("/api/v1/goals/2026-03-03", json={**goal, "calories": 1800}, headers=headers)
        await m.call("log_food", fdc_id=BANANA, grams=100, date="2026-03-01")
        await m.call("log_food", fdc_id=BANANA, grams=200, date="2026-03-03")
        await m.call("log_food", fdc_id=BANANA, grams=999, date="2026-03-05")  # outside the range
        out = await m.call("get_nutrition_history", start_date="2026-03-01", end_date="2026-03-03")
        assert out["today"] == today()
        days = out["days"]
        assert [d["date"] for d in days] == ["2026-03-01", "2026-03-02", "2026-03-03"]
        assert [d["entries"] for d in days] == [1, 0, 1]
        assert [d["totals"]["calories"] for d in days] == [89.0, 0.0, 178.0]
        assert [d["target"] and d["target"]["calories"] for d in days] == [None, 2000.0, 1800.0]
        # 31 days is the most: 2026-03-01..2026-03-31 is fine, one more day is not.
        assert (
            len((await m.call("get_nutrition_history", start_date="2026-03-01", end_date="2026-03-31"))["days"]) == 31
        )
        assert "at most 31 days" in await m.error(
            "get_nutrition_history", start_date="2026-03-01", end_date="2026-04-01"
        )
        assert "before start_date" in await m.error(
            "get_nutrition_history", start_date="2026-03-02", end_date="2026-03-01"
        )


async def test_recent_foods(foods):
    async with user(foods) as (_k, m, _h, _u):
        assert (await m.call("get_recent_foods"))["foods"] == []
        await m.call("log_food", fdc_id=BANANA, grams=100)
        await m.call("log_food", fdc_id=CHICKEN, grams=180)
        out = await m.call("get_recent_foods", limit=5)
        assert [(f["fdc_id"], f["last_grams"]) for f in out["foods"]] == [(CHICKEN, 180.0), (BANANA, 100.0)]
        assert out["foods"][0]["last_logged_on"] == today()
        # Yesterday's dinner logged now: its day is the log's date, not when it was logged.
        yesterday = (date.fromisoformat(today()) - timedelta(days=1)).isoformat()
        await m.call("log_food", fdc_id=BANANA, grams=120, date=yesterday)
        out = await m.call("get_recent_foods", limit=5)
        assert (out["foods"][0]["fdc_id"], out["foods"][0]["last_logged_on"]) == (BANANA, yesterday)


# --- writes --------------------------------------------------------------------------------------------


async def test_log_food_by_grams_or_portion(foods):
    async with user(foods) as (_k, m, _h, _u):
        out = await m.call("log_food", fdc_id=BANANA, grams=150)
        assert out["today"] == today() and out["timezone"] == "UTC"
        logged = out["logged"]
        uuid.UUID(logged["log_id"])
        assert logged["date"] == today() and logged["unit"] == "g" and logged["quantity"] == 150
        assert logged["calories"] == 133.5
        assert out["day"]["totals"]["calories"] == 133.5 and out["day"]["remaining"] is None
        # A portion, any case, times a quantity; "medium" also finds "1 medium".
        two = (await m.call("log_food", fdc_id=BANANA, portion="1 MEDIUM", quantity=2))["logged"]
        assert two["quantity"] == 236 and two["amount"] == "236 g"
        assert (await m.call("log_food", fdc_id=BANANA, portion="medium"))["logged"]["quantity"] == 118
        # A retired food can still be logged by id.
        assert (await m.call("log_food", fdc_id=RETIRED, grams=50))["logged"]["fdc_id"] == RETIRED


async def test_log_food_errors(foods):
    async with user(foods) as (_k, m, _h, _u):
        assert "no food with fdc_id 999999" in await m.error("log_food", fdc_id=999999, grams=100)
        message = await m.error("log_food", fdc_id=BANANA, portion="1 large")
        assert "no portion called '1 large'" in message
        assert "1 extra small (81 g)" in message and "1 medium (118 g)" in message
        assert "no portions" in await m.error("log_food", fdc_id=CHICKEN, portion="1 breast")
        assert "either grams or portion" in await m.error("log_food", fdc_id=BANANA)
        assert "either grams or portion" in await m.error("log_food", fdc_id=BANANA, grams=10, portion="1 medium")
        assert "quantity goes with portion" in await m.error("log_food", fdc_id=BANANA, grams=10, quantity=2)
        assert "grams" in await m.error("log_food", fdc_id=BANANA, grams=-5)
        assert "real day" in await m.error("log_food", fdc_id=BANANA, grams=10, date="2026-13-01")
        assert "invalid log_date" in await m.error("log_food", fdc_id=BANANA, grams=10, date="1800-01-01")
        assert (await m.call("get_daily_macros"))["entries"] == []


async def test_log_custom_food(foods):
    async with user(foods) as (_k, m, _h, _u):
        out = await m.call(
            "log_custom_food", name="Lasagna", calories=450, protein_g=25, carbs_g=40, fat_g=20, servings=1.5
        )
        logged = out["logged"]
        assert logged["fdc_id"] is None and logged["unit"] == "serving" and logged["amount"] == "1.5 servings"
        assert logged["calories"] == 675 and logged["fiber_g"] is None
        assert "calories" in await m.error("log_custom_food", name="X", calories=-1, protein_g=0, carbs_g=0, fat_g=0)


async def test_update_and_delete_food_log(foods):
    async with user(foods) as (_k, m, _h, _u):
        log_id = (await m.call("log_food", fdc_id=BANANA, grams=100))["logged"]["log_id"]
        out = await m.call("update_food_log", log_id=log_id, amount=200, name="Snack", date="2026-03-01")
        assert out["updated"]["quantity"] == 200 and out["updated"]["calories"] == 178
        assert out["updated"]["name"] == "Snack" and out["updated"]["date"] == "2026-03-01"
        assert (await m.call("get_daily_macros"))["entries"] == []
        assert [e["log_id"] for e in (await m.call("get_daily_macros", date="2026-03-01"))["entries"]] == [log_id]
        assert "nothing to change" in await m.error("update_food_log", log_id=log_id)
        assert "blank" in await m.error("update_food_log", log_id=log_id, name="   ")
        out = await m.call("delete_food_log", log_id=log_id)
        assert out["deleted"] == {"log_id": log_id, "date": "2026-03-01", "name": "Snack", "amount": "200 g"}
        assert (await m.call("get_daily_macros", date="2026-03-01"))["entries"] == []
        assert (await m.call("delete_food_log", log_id=log_id))["deleted"]["log_id"] == log_id  # again: no change
        assert "food log not found" in await m.error("update_food_log", log_id=log_id, amount=5)  # deleted
        missing = str(uuid.uuid4())
        assert "food log not found" in await m.error("update_food_log", log_id=missing, amount=5)
        assert "food log not found" in await m.error("delete_food_log", log_id=missing)
        assert "not a Kalo log id" in await m.error("delete_food_log", log_id="banana")


async def test_another_users_log_is_not_found(foods, db):
    async with kalo(foods) as k:
        _h, me = await k.device()
        _h, other = await k.device()
        async with k.mcp(k.token(other)) as theirs:
            log_id = (await theirs.call("log_food", fdc_id=BANANA, grams=100))["logged"]["log_id"]
        async with k.mcp(k.token(me)) as mine:
            assert "food log not found" in await mine.error("update_food_log", log_id=log_id, amount=1)
            assert "food log not found" in await mine.error("delete_food_log", log_id=log_id)
            assert (await mine.call("get_daily_macros"))["entries"] == []
    assert db.execute("SELECT quantity, deleted_at FROM food_logs").fetchall() == [(100.0, None)]


async def test_update_daily_goal(foods):
    async with user(foods) as (k, m, headers, _u):
        message = await m.error("update_daily_goal", protein_g=160)
        assert "no goal yet" in message and "calories, carbs_g, fat_g" in message
        out = await m.call("update_daily_goal", calories=2200, protein_g=150, carbs_g=250, fat_g=70)
        assert out["today"] == today()
        assert out["goal"]["since"] == today() and out["goal"]["calories"] == 2200
        assert out["goal"]["sodium_mg"] == 2300 and out["goal"]["steps"] == 10000 and out["goal"]["goal"] == "maintain"
        # An older goal with workout kcal: replaced from today on, its kcal kept; earlier days keep theirs.
        old = {
            "calories": 3000, "protein_g": 180, "carbs_g": 380, "fat_g": 90, "fiber_g": 38, "sugar_g": 113,
            "sodium_mg": 2300, "steps": 8000, "goal": "gain", "source": "computed", "workout_kcal": 250,
            "active_rest_kcal": 100,
        }  # fmt: skip
        yesterday = (date.fromisoformat(today()) - timedelta(days=1)).isoformat()
        assert (await k.http.put(f"/api/v1/goals/{yesterday}", json=old, headers=headers)).status_code == 200
        out = await m.call("update_daily_goal", protein_g=160)
        goal = out["goal"]
        assert goal["protein_g"] == 160 and goal["calories"] == 2200  # merged over today's goal
        r = await k.http.get("/api/v1/goals", headers=headers)
        assert r.json()["source"] == "manual" and r.json()["protein_g"] == 160
        r = await k.http.get("/api/v1/goals", params={"day": yesterday}, headers=headers)
        assert r.json()["calories"] == 3000 and r.json()["source"] == "computed"
        # Today's row is replaced again, the workout kcal stays.
        await k.http.put(f"/api/v1/goals/{today()}", json={**old, "calories": 2500}, headers=headers)
        goal = (await m.call("update_daily_goal", calories=2400))["goal"]
        assert goal["calories"] == 2400 and goal["workout_kcal"] == 250 and goal["active_rest_kcal"] == 100
        assert goal["goal"] == "gain" and goal["protein_g"] == 180
        assert "nothing to change" in await m.error("update_daily_goal")
        assert "calories" in await m.error("update_daily_goal", calories=-10)


# --- scopes, sync, timezone ----------------------------------------------------------------------------


async def test_a_read_only_token_cannot_write(foods, db):
    async with user(foods, scopes=READ) as (_k, m, _h, _u):
        for name, arguments in WRITE_CALLS.items():
            assert "read-only" in await m.error(name, **arguments), name
        assert (await m.call("get_daily_macros"))["entries"] == []
        assert (await m.call("search_foods", query="banana"))["foods"]
    assert db.execute("SELECT count(*) FROM food_logs").fetchone() == (0,)
    assert db.execute("SELECT count(*) FROM user_goals").fetchone() == (0,)


async def test_a_log_made_through_mcp_reaches_the_phone_on_its_next_sync(foods):
    async with user(foods) as (k, m, headers, _u):
        first = await k.http.post("/api/v1/sync", json={"cursor": None}, headers=headers)
        assert first.status_code == 200, first.text
        cursor = first.json()["cursor"]
        log_id = (await m.call("log_food", fdc_id=BANANA, portion="1 medium"))["logged"]["log_id"]
        pulled = (await k.http.post("/api/v1/sync", json={"cursor": cursor}, headers=headers)).json()
        assert pulled["cursor"] > cursor
        assert [(row["id"], row["quantity"]) for row in pulled["changes"]["food_logs"]] == [(log_id, 118.0)]
        # An edit and a delete get newer revs too.
        await m.call("update_food_log", log_id=log_id, amount=90)
        again = (await k.http.post("/api/v1/sync", json={"cursor": pulled["cursor"]}, headers=headers)).json()
        assert again["cursor"] > pulled["cursor"] and again["changes"]["food_logs"][0]["quantity"] == 90
        await m.call("delete_food_log", log_id=log_id)
        gone = (await k.http.post("/api/v1/sync", json={"cursor": again["cursor"]}, headers=headers)).json()
        assert gone["changes"]["food_logs"][0]["deleted_at"] is not None


async def test_today_is_the_users_day(foods, db):
    # A zone whose date is not UTC's right now: UTC+14 is a day ahead from 10:00 UTC, UTC-11 a day
    # behind until 11:00 UTC. (Run within a second of 10:00 or 11:00 UTC this could still flake.)
    zone = "Pacific/Kiritimati" if datetime.now(UTC).hour >= 10 else "Pacific/Pago_Pago"
    async with user(foods) as (_k, m, _h, _u):
        db.execute("UPDATE users SET timezone = %s", (zone,))
        out = await m.call("get_daily_macros")
        local = datetime.now(ZoneInfo(zone)).date().isoformat()
        assert local != datetime.now(UTC).date().isoformat()
        assert out["timezone"] == zone and out["today"] == local and out["date"] == local
        assert (await m.call("log_food", fdc_id=BANANA, grams=10))["logged"]["date"] == local
