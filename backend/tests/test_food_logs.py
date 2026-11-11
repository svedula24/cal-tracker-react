"""The REST food-log endpoints (app/api/v1/food_logs.py): create, list by day, edit, delete.

Needs Postgres: set DATABASE_URL. Each test runs the app against a freshly migrated scratch schema
with a few foods loaded. tests/test_nutrition.py and tests/test_recent_foods.py use the fixtures and
helpers defined here.
"""

import os
import uuid
from datetime import UTC, datetime, timedelta

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.api.v1.food_logs import utc_now
from app.main import create_app
from kalo.usda.load import load
from kalo.usda.nutrients import FoodRow
from kalo.usda.portions import Portion

pytestmark = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set")

BANANA = 1
OVERRIPE = 2  # reports no fiber, sugar or sodium
CHICKEN = 3
BROCCOLI = 4  # reports no sugar
RETIRED = 5

FOODS = [
    # fdc_id, description, calories, protein, carbs, fat, fiber, sugar, sodium (mg)
    (BANANA, "Bananas, raw", 89.0, 0.74, 23.0, 0.29, 1.7, 15.8, 1.0),
    (OVERRIPE, "Bananas, overripe, raw", 85.0, 0.73, 20.1, 0.22, None, None, None),
    (CHICKEN, "Chicken breast, roasted", 165.0, 31.02, 0.0, 3.57, 0.0, 0.0, 74.0),
    (BROCCOLI, "Broccoli, raw", 39.0, 2.57, 6.27, 0.34, 2.4, None, 36.0),
    (RETIRED, "Kale, discontinued", 35.0, 2.92, 4.42, 1.49, 4.1, 0.8, 53.0),
]
PORTIONS = [(BANANA, "1 medium", 118.0), (BANANA, "1 extra small", 81.0), (BROCCOLI, "1 spear", 30.8)]

BANANA_VALUES = {
    "calories": 89.0, "protein_g": 0.74, "carbs_g": 23.0, "fat_g": 0.29,
    "fiber_g": 1.7, "sugar_g": 15.8, "sodium_mg": 1.0,
}  # fmt: skip
EGGS = {"calories": 140, "protein_g": 12, "carbs_g": 1, "fat_g": 10, "fiber_g": 0, "sugar_g": 0.5, "sodium_mg": 140}
LOG_KEYS = {
    "id", "fdc_id", "log_date", "logged_at", "name", "food_name", "unit", "quantity",
    "values", "food_values", "updated_at", "deleted_at", "totals", "rev",
}  # fmt: skip
URL = "/api/v1/food-logs"


@pytest.fixture
def client(migrated_url):
    rows = [
        FoodRow(fdc_id=i, description=d, data_type="SR Legacy", brand_name=None, calories_per_100g=kcal,
                protein_per_100g=p, carbs_per_100g=c, fat_per_100g=f,
                fiber_per_100g=fiber, sugar_per_100g=sugar, sodium_mg_per_100g=sodium)
        for i, d, kcal, p, c, f, fiber, sugar, sodium in FOODS
    ]  # fmt: skip
    load(rows, [Portion(fdc_id=i, description=d, gram_weight=g) for i, d, g in PORTIONS], migrated_url)
    with psycopg.connect(migrated_url, autocommit=True) as conn:
        conn.execute("UPDATE foods SET retired_at = now() WHERE fdc_id = %s", (RETIRED,))
    with TestClient(create_app(migrated_url)) as c:
        yield c


@pytest.fixture
def db(migrated_url):
    """A second connection to the same scratch schema: it sees only what the app committed."""
    with psycopg.connect(migrated_url, autocommit=True) as conn:
        yield conn


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


def set_clock(client, now):
    client.app.dependency_overrides[utc_now] = lambda: now


def set_timezone(db, name):
    db.execute("UPDATE users SET timezone = %s", (name,))


def create(client, who, status=201, **body):
    r = client.post(URL, json=body, headers=who)
    assert r.status_code == status, r.text
    return r.json()


def day(client, who, date=None):
    r = client.get(URL, params={"date": date} if date else {}, headers=who)
    assert r.status_code == 200, r.text
    assert set(r.json()) == {"logs"}
    return r.json()["logs"]


def patch(client, who, log_id, status=200, **body):
    r = client.patch(f"{URL}/{log_id}", json=body, headers=who)
    assert r.status_code == status, r.text
    return r.json()


def when(text):
    return datetime.fromisoformat(text)


def count(db):
    return db.execute("SELECT count(*) FROM food_logs").fetchone()[0]


# --- auth ---


@pytest.mark.parametrize(
    "method, path",
    [
        ("POST", URL),
        ("GET", URL + "?date=2026-03-01"),
        ("PATCH", f"{URL}/{uuid.uuid4()}"),
        ("DELETE", f"{URL}/{uuid.uuid4()}"),
    ],
)
def test_every_endpoint_needs_a_token(client, db, method, path):
    body = {"json": {"fdc_id": BANANA, "quantity": 100}} if method in ("POST", "PATCH") else {}
    for headers in ({}, {"Authorization": "Bearer kalo_" + "A" * 43}):
        r = client.request(method, path, headers=headers, **body)
        assert r.status_code == 401, r.text
        assert r.headers["www-authenticate"] == "Bearer"
    assert count(db) == 0


# --- create ---


def test_logging_a_food_by_id_and_amount_snapshots_the_food(client, me, db):
    before = datetime.now(UTC)
    r = client.post(URL, json={"fdc_id": BANANA, "quantity": 150}, headers=me)
    assert r.status_code == 201, r.text
    log = r.json()
    assert set(log) == LOG_KEYS
    assert uuid.UUID(log["id"]).version == 4
    assert (log["fdc_id"], log["unit"], log["quantity"], log["deleted_at"]) == (BANANA, "g", 150, None)
    assert log["name"] == log["food_name"] == "Bananas, raw"
    # Exactly the numbers USDA gives: 0.74, not the REAL column's 0.7400000095.
    assert log["values"] == BANANA_VALUES
    assert log["food_values"] == BANANA_VALUES
    assert log["totals"] == {k: pytest.approx(v * 1.5) for k, v in BANANA_VALUES.items()}
    assert isinstance(log["rev"], int) and log["rev"] > 0
    assert log["log_date"] == datetime.now(UTC).date().isoformat()  # the user's timezone is UTC
    assert log["logged_at"] == log["updated_at"]
    assert timedelta(0) <= when(log["logged_at"]) - before < timedelta(minutes=1)
    stored = db.execute("SELECT id::text, fdc_id, unit, quantity, unit_protein_g, protein_g FROM food_logs").fetchall()
    assert stored == [(log["id"], BANANA, "g", 150.0, 0.74, pytest.approx(1.11))]


def test_unreported_nutrients_are_stored_null(client, me, db):
    log = create(client, me, fdc_id=OVERRIPE, quantity=200)
    for part in ("values", "food_values", "totals"):
        assert (log[part]["fiber_g"], log[part]["sugar_g"], log[part]["sodium_mg"]) == (None, None, None)
    assert log["totals"]["calories"] == pytest.approx(170)
    row = db.execute(
        "SELECT unit_fiber_g, unit_sugar_g, unit_sodium_mg, food_fiber_per_100g, fiber_g, sugar_g, sodium_mg"
        " FROM food_logs"
    ).fetchone()
    assert row == (None,) * 7
    # One unreported nutrient does not null the others; a reported 0 stays 0.
    broccoli = create(client, me, fdc_id=BROCCOLI, quantity=100)
    assert (broccoli["values"]["sugar_g"], broccoli["values"]["fiber_g"]) == (None, 2.4)
    chicken = create(client, me, fdc_id=CHICKEN, quantity=100)
    assert (chicken["values"]["fiber_g"], chicken["values"]["sugar_g"], chicken["totals"]["sugar_g"]) == (0, 0, 0)


def test_a_retired_food_can_still_be_logged_by_id(client, me):
    assert client.get("/api/v1/foods/search", params={"q": "kale"}).json()["foods"] == []
    log = create(client, me, fdc_id=RETIRED, quantity=50)
    assert (log["fdc_id"], log["name"]) == (RETIRED, "Kale, discontinued")
    assert log["totals"]["calories"] == pytest.approx(17.5)


def test_an_unknown_fdc_id_is_422_and_stores_nothing(client, me, db):
    r = client.post(URL, json={"fdc_id": 999999, "quantity": 100}, headers=me)
    assert r.status_code == 422
    assert r.json() == {"detail": "unknown fdc_id"}
    # Not even as a custom entry, which is what sync does with a food the server lacks.
    r = client.post(URL, json={"fdc_id": 999999, "quantity": 100, "name": "Mystery", "values": EGGS}, headers=me)
    assert r.status_code == 422
    assert count(db) == 0


def test_the_client_may_send_its_own_name_values_and_times(client, me):
    typed = {**BANANA_VALUES, "calories": 95}
    log = create(
        client, me,
        id="6f1c8f0a-52c5-4f7e-9d25-5a3f0f2f9b11", fdc_id=BANANA, quantity=118, unit="g", name="Breakfast banana",
        values=typed, log_date="2026-03-01", logged_at="2026-03-01T08:15:00+00:00",
        updated_at="2026-03-01T08:16:00.000Z",
    )  # fmt: skip
    assert log["id"] == "6f1c8f0a-52c5-4f7e-9d25-5a3f0f2f9b11"
    assert (log["name"], log["food_name"]) == ("Breakfast banana", "Bananas, raw")
    assert log["values"] == typed
    assert log["food_values"] == BANANA_VALUES  # the database food's own, kept beside the typed ones
    assert log["totals"]["calories"] == pytest.approx(95 * 1.18)
    assert log["log_date"] == "2026-03-01"
    assert when(log["logged_at"]) == when("2026-03-01T08:15:00+00:00")
    assert when(log["updated_at"]) == when("2026-03-01T08:16:00+00:00")


def test_a_custom_entry_has_no_food_behind_it(client, me):
    log = create(client, me, name="Two eggs", quantity=2, values=EGGS)
    assert (log["fdc_id"], log["food_name"], log["food_values"]) == (None, None, None)
    assert (log["unit"], log["quantity"], log["name"]) == ("serving", 2, "Two eggs")  # 'serving' is the default
    assert log["values"] == EGGS
    assert log["totals"] == {k: pytest.approx(v * 2) for k, v in EGGS.items()}
    # A custom entry may be in grams: then its values are per 100 g.
    grams = create(client, me, name="Home-made granola", quantity=60, unit="g", values={**EGGS, "fiber_g": None})
    assert (grams["unit"], grams["fdc_id"]) == ("g", None)
    assert grams["totals"]["calories"] == pytest.approx(84)
    assert grams["totals"]["fiber_g"] is None


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"fdc_id": BANANA},  # no quantity
        {"fdc_id": BANANA, "quantity": 0},
        {"fdc_id": BANANA, "quantity": -1},
        {"fdc_id": BANANA, "quantity": "lots"},
        {"fdc_id": BANANA, "quantity": 100, "unit": "serving"},  # a database food is logged in grams
        {"fdc_id": BANANA, "quantity": 100, "unit": "cup"},
        {"fdc_id": BANANA, "quantity": 100, "name": ""},
        {"fdc_id": BANANA, "quantity": 100, "id": "not-a-uuid"},
        {"fdc_id": BANANA, "quantity": 100, "log_date": "01/03/2026"},
        {"fdc_id": BANANA, "quantity": 100, "logged_at": "2026-03-01T08:15:00"},  # no zone
        {"fdc_id": BANANA, "quantity": 100, "values": {**BANANA_VALUES, "calories": -1}},
        {"fdc_id": BANANA, "quantity": 100, "values": {"calories": 100}},  # a create needs the whole set
        {"fdc_id": 0, "quantity": 100},
        {"quantity": 1},  # neither a food nor a custom entry
        {"quantity": 1, "name": "Two eggs"},  # a custom entry needs values
        {"quantity": 1, "values": EGGS},  # and a name
        {"quantity": 1, "name": "Two eggs", "values": EGGS, "unit": "cup"},
        {"quantity": 1, "name": "Two eggs", "values": EGGS, "food_values": EGGS},
    ],
)
def test_a_bad_create_is_422_and_stores_nothing(client, me, db, body):
    r = client.post(URL, json=body, headers=me)
    assert r.status_code == 422, r.text
    assert count(db) == 0


def test_creating_the_same_id_again_returns_the_stored_log_and_no_second_row(client, me, db):
    log_id = str(uuid.uuid4())
    first = create(client, me, id=log_id, fdc_id=BANANA, quantity=150)
    again = client.post(URL, json={"id": log_id, "fdc_id": BANANA, "quantity": 150}, headers=me)
    assert again.status_code == 200
    assert again.json() == first  # rev and updated_at included: nothing was written
    # A different body under the same id does not change it either: editing is PATCH.
    different = client.post(URL, json={"id": log_id, "fdc_id": CHICKEN, "quantity": 999}, headers=me)
    assert different.status_code == 200
    assert different.json() == first
    assert count(db) == 1
    assert day(client, me) == [first]


def test_without_an_id_every_create_is_a_new_log(client, me, db):
    # The same food twice in a day stays two rows.
    first = create(client, me, fdc_id=BANANA, quantity=100, log_date="2026-03-01")
    second = create(client, me, fdc_id=BANANA, quantity=100, log_date="2026-03-01")
    assert first["id"] != second["id"]
    assert count(db) == 2
    assert {log["id"] for log in day(client, me, "2026-03-01")} == {first["id"], second["id"]}


def test_an_id_that_belongs_to_another_user_is_404_and_is_not_overwritten(client, me, other, db):
    theirs = create(client, other, fdc_id=BANANA, quantity=150)
    r = client.post(URL, json={"id": theirs["id"], "fdc_id": CHICKEN, "quantity": 1}, headers=me)
    assert r.status_code == 404
    assert r.json() == {"detail": "food log not found"}
    assert "Bananas" not in r.text
    assert count(db) == 1
    assert day(client, other) == [theirs]
    assert day(client, me) == []


def test_creating_a_deleted_id_again_does_not_bring_it_back(client, me, db):
    log = create(client, me, fdc_id=BANANA, quantity=150)
    assert client.delete(f"{URL}/{log['id']}", headers=me).status_code == 204
    r = client.post(URL, json={"id": log["id"], "fdc_id": BANANA, "quantity": 150}, headers=me)
    assert r.status_code == 404
    assert day(client, me) == []
    assert db.execute("SELECT count(*) FROM food_logs WHERE deleted_at IS NOT NULL").fetchone()[0] == 1


# --- the day a log belongs to ---


@pytest.mark.parametrize(
    "timezone, now, today",
    [
        ("UTC", "2026-03-01T02:30:00+00:00", "2026-03-01"),
        ("America/Los_Angeles", "2026-03-01T02:30:00+00:00", "2026-02-28"),  # still yesterday there (18:30)
        ("Pacific/Auckland", "2026-03-01T12:30:00+00:00", "2026-03-02"),  # already tomorrow there (01:30)
        ("Asia/Kolkata", "2026-03-01T18:29:00+00:00", "2026-03-01"),  # 23:59
        ("Asia/Kolkata", "2026-03-01T18:30:00+00:00", "2026-03-02"),  # midnight
        ("Not/AZone", "2026-03-01T02:30:00+00:00", "2026-03-01"),  # an unknown name counts as UTC
    ],
)
def test_log_date_defaults_to_today_in_the_users_timezone(client, me, db, timezone, now, today):
    set_timezone(db, timezone)
    set_clock(client, when(now))
    log = create(client, me, fdc_id=BANANA, quantity=100)
    assert log["log_date"] == today
    assert when(log["logged_at"]) == when(now)  # the instant is kept; only the day is local
    # "Today" is the same local day when listing and totalling without a date.
    assert [x["id"] for x in day(client, me)] == [log["id"]]
    assert [x["id"] for x in day(client, me, today)] == [log["id"]]
    daily = client.get("/api/v1/nutrition/daily", headers=me).json()
    assert (daily["date"], daily["log_count"]) == (today, 1)


def test_a_log_late_in_the_evening_stays_on_its_local_day(client, me, db):
    set_timezone(db, "America/Los_Angeles")
    # 23:30 on 28 February in Los Angeles is 07:30 on 1 March in UTC.
    log = create(client, me, fdc_id=BANANA, quantity=100, log_date="2026-02-28", logged_at="2026-02-28T23:30:00-08:00")
    assert log["log_date"] == "2026-02-28"
    assert when(log["logged_at"]) == when("2026-03-01T07:30:00+00:00")
    assert [x["id"] for x in day(client, me, "2026-02-28")] == [log["id"]]
    assert day(client, me, "2026-03-01") == []
    assert db.execute("SELECT log_date::text FROM food_logs").fetchone()[0] == "2026-02-28"


# --- list ---


def test_a_days_logs_are_newest_first_and_only_that_day(client, me):
    at = {"log_date": "2026-03-01"}
    lunch = create(client, me, fdc_id=CHICKEN, quantity=120, logged_at="2026-03-01T12:00:00Z", **at)
    breakfast = create(client, me, fdc_id=BANANA, quantity=118, logged_at="2026-03-01T08:00:00Z", **at)
    dinner = create(client, me, name="Two eggs", quantity=2, values=EGGS, logged_at="2026-03-01T19:00:00Z", **at)
    create(client, me, fdc_id=BANANA, quantity=100, log_date="2026-03-02", logged_at="2026-03-02T08:00:00Z")
    logs = day(client, me, "2026-03-01")
    assert [log["id"] for log in logs] == [dinner["id"], lunch["id"], breakfast["id"]]
    assert logs == [dinner, lunch, breakfast]  # the same shape as the create response
    assert day(client, me, "2026-02-27") == []


def test_another_users_logs_are_never_listed(client, me, other):
    mine = create(client, me, fdc_id=BANANA, quantity=100, log_date="2026-03-01")
    theirs = create(client, other, fdc_id=CHICKEN, quantity=100, log_date="2026-03-01")
    assert day(client, me, "2026-03-01") == [mine]
    assert day(client, other, "2026-03-01") == [theirs]


@pytest.mark.parametrize("date", ["yesterday", "2026-02-30", "20260301x", ""])
def test_a_bad_date_is_422(client, me, date):
    assert client.get(URL, params={"date": date}, headers=me).status_code == 422


# --- edit ---


def test_patch_changes_only_what_is_sent(client, me):
    log = create(client, me, fdc_id=BANANA, quantity=150, log_date="2026-03-01", logged_at="2026-03-01T08:00:00Z")
    renamed = patch(client, me, log["id"], name="Morning banana")
    assert renamed["name"] == "Morning banana"
    assert renamed["food_name"] == "Bananas, raw"  # the database name is not the user's to change
    unchanged = ("id", "fdc_id", "log_date", "logged_at", "unit", "quantity", "values", "food_values", "totals")
    assert {k: renamed[k] for k in unchanged} == {k: log[k] for k in unchanged}

    moved = patch(client, me, log["id"], log_date="2026-02-28", logged_at="2026-02-28T21:00:00Z")
    assert (moved["log_date"], when(moved["logged_at"])) == ("2026-02-28", when("2026-02-28T21:00:00+00:00"))
    assert moved["name"] == "Morning banana"
    assert day(client, me, "2026-03-01") == []
    assert day(client, me, "2026-02-28") == [moved]


def test_a_partial_values_object_updates_just_those_nutrients(client, me):
    log = create(client, me, fdc_id=BANANA, quantity=200)
    edited = patch(client, me, log["id"], values={"calories": 100, "protein_g": 0})
    assert edited["values"] == {**BANANA_VALUES, "calories": 100, "protein_g": 0}  # 0 is a value
    assert edited["food_values"] == BANANA_VALUES
    assert edited["totals"]["calories"] == pytest.approx(200)
    assert edited["totals"]["protein_g"] == 0
    assert edited["totals"]["carbs_g"] == pytest.approx(46)
    # null means "not reported", for the three nutrients that may be.
    cleared = patch(client, me, log["id"], values={"sugar_g": None})
    assert cleared["values"] == {**BANANA_VALUES, "calories": 100, "protein_g": 0, "sugar_g": None}
    assert cleared["totals"]["sugar_g"] is None


def test_a_typed_over_value_scales_when_the_quantity_changes(client, me):
    log = create(client, me, fdc_id=BANANA, quantity=100)
    assert log["totals"]["calories"] == pytest.approx(89)
    typed = patch(client, me, log["id"], values={"calories": 120})
    assert typed["totals"]["calories"] == pytest.approx(120)
    scaled = patch(client, me, log["id"], quantity=250)
    assert scaled["quantity"] == 250
    assert scaled["values"]["calories"] == 120  # still per 100 g
    assert scaled["totals"]["calories"] == pytest.approx(300)
    assert scaled["totals"]["carbs_g"] == pytest.approx(57.5)  # the untouched ones scale too
    # A serving entry scales by servings.
    eggs = create(client, me, name="Two eggs", quantity=1, values=EGGS)
    assert patch(client, me, eggs["id"], quantity=1.5)["totals"]["protein_g"] == pytest.approx(18)


def test_an_edit_is_stamped_now_and_gets_a_new_rev(client, me, db):
    log = create(client, me, fdc_id=BANANA, quantity=100, updated_at="2026-03-01T08:00:00Z")
    before = datetime.now(UTC)
    edited = patch(client, me, log["id"], quantity=120)
    assert timedelta(0) <= when(edited["updated_at"]) - before < timedelta(minutes=1)
    assert edited["rev"] > log["rev"]
    assert db.execute("SELECT quantity, rev FROM food_logs").fetchall() == [(120.0, edited["rev"])]


def test_an_edit_wins_over_a_copy_stamped_by_a_clock_that_runs_ahead(client, me):
    # A phone whose clock is fast may have stamped the stored copy a few minutes from now.
    ahead = (datetime.now(UTC) + timedelta(minutes=3)).isoformat()
    log = create(client, me, fdc_id=BANANA, quantity=100, updated_at=ahead)
    edited = patch(client, me, log["id"], quantity=120)
    assert edited["quantity"] == 120
    assert when(edited["updated_at"]) >= when(log["updated_at"])
    assert client.delete(f"{URL}/{log['id']}", headers=me).status_code == 204
    assert day(client, me) == []


@pytest.mark.parametrize(
    "body",
    [
        {"quantity": 0},
        {"quantity": -5},
        {"quantity": None},
        {"name": ""},
        {"name": None},
        {"log_date": "soon"},
        {"logged_at": "2026-03-01T08:00:00"},  # no zone
        {"values": {"calories": -1}},
        {"values": {"calories": None}},  # only fiber, sugar and sodium may be unreported
        {"values": {"kcal": 100}},
        {"values": None},
        {"unit": "serving"},  # not editable here
        {"fdc_id": CHICKEN},
        {"food_values": BANANA_VALUES},
        {"deleted_at": "2026-03-01T08:00:00Z"},
    ],
)
def test_a_bad_patch_is_422_and_changes_nothing(client, me, body):
    log = create(client, me, fdc_id=BANANA, quantity=100)
    r = client.patch(f"{URL}/{log['id']}", json=body, headers=me)
    assert r.status_code == 422, r.text
    assert day(client, me) == [log]


def test_patch_is_404_for_another_users_a_deleted_and_an_unknown_log(client, me, other, db):
    theirs = create(client, other, fdc_id=BANANA, quantity=100)
    r = client.patch(f"{URL}/{theirs['id']}", json={"quantity": 1, "name": "mine now"}, headers=me)
    assert r.status_code == 404
    assert r.json() == {"detail": "food log not found"}
    assert day(client, other) == [theirs]  # untouched: same rev, same updated_at

    gone = create(client, me, fdc_id=BANANA, quantity=100)
    assert client.delete(f"{URL}/{gone['id']}", headers=me).status_code == 204
    assert client.patch(f"{URL}/{gone['id']}", json={"quantity": 1}, headers=me).status_code == 404
    assert client.patch(f"{URL}/{uuid.uuid4()}", json={"quantity": 1}, headers=me).status_code == 404
    assert client.patch(f"{URL}/not-a-uuid", json={"quantity": 1}, headers=me).status_code == 422
    assert db.execute("SELECT count(*) FROM food_logs WHERE quantity = 1").fetchone()[0] == 0


# --- delete ---


def test_delete_is_soft_and_can_be_repeated(client, me, db):
    log = create(client, me, fdc_id=BANANA, quantity=100, updated_at="2026-03-01T08:00:00Z")
    before = datetime.now(UTC)
    r = client.delete(f"{URL}/{log['id']}", headers=me)
    assert (r.status_code, r.content) == (204, b"")
    assert day(client, me) == []
    # The row is kept as a tombstone with a new rev, so a device that syncs learns of the deletion.
    deleted_at, updated_at, rev = db.execute("SELECT deleted_at, updated_at, rev FROM food_logs").fetchone()
    assert timedelta(0) <= deleted_at - before < timedelta(minutes=1)
    assert updated_at == deleted_at
    assert rev > log["rev"]
    # Again: still 204, and nothing is written.
    assert client.delete(f"{URL}/{log['id']}", headers=me).status_code == 204
    assert db.execute("SELECT deleted_at, updated_at, rev FROM food_logs").fetchone() == (deleted_at, updated_at, rev)


def test_delete_is_404_for_another_users_and_an_unknown_log(client, me, other, db):
    theirs = create(client, other, fdc_id=BANANA, quantity=100)
    r = client.delete(f"{URL}/{theirs['id']}", headers=me)
    assert r.status_code == 404
    assert r.json() == {"detail": "food log not found"}
    assert day(client, other) == [theirs]
    assert db.execute("SELECT count(*) FROM food_logs WHERE deleted_at IS NOT NULL").fetchone()[0] == 0
    assert client.delete(f"{URL}/{uuid.uuid4()}", headers=me).status_code == 404
    assert client.delete(f"{URL}/not-a-uuid", headers=me).status_code == 422


# --- the same core as sync ---


def pull(client, who, cursor=None):
    r = client.post("/api/v1/sync", json={"cursor": cursor, "changes": {}}, headers=who)
    assert r.status_code == 200, r.text
    return r.json()


def test_what_is_written_here_reaches_the_phone_on_its_next_pull(client, me, other):
    start = pull(client, me)
    assert start["changes"]["food_logs"] == []

    log = create(client, me, fdc_id=BANANA, quantity=150)
    made = pull(client, me, start["cursor"])
    wire = {k: v for k, v in log.items() if k not in ("totals", "rev")}
    assert [{k: row[k] for k in wire} for row in made["changes"]["food_logs"]] == [wire]

    edited = patch(client, me, log["id"], quantity=175, name="Big banana")
    changed = pull(client, me, made["cursor"])["changes"]["food_logs"]
    assert [(row["id"], row["quantity"], row["name"]) for row in changed] == [(log["id"], 175, "Big banana")]
    assert when(changed[0]["updated_at"]) == when(edited["updated_at"])

    assert client.delete(f"{URL}/{log['id']}", headers=me).status_code == 204
    after = pull(client, me, made["cursor"])
    tombstones = after["changes"]["food_logs"]
    assert [row["id"] for row in tombstones] == [log["id"]]
    assert tombstones[0]["deleted_at"] is not None
    assert pull(client, other)["changes"]["food_logs"] == []  # and only that user's phone


def test_a_log_the_phone_pushed_can_be_edited_and_deleted_here(client, me):
    row = {
        "id": str(uuid.uuid4()), "fdc_id": BANANA, "log_date": "2026-03-01", "logged_at": "2026-03-01T08:00:00.000Z",
        "name": "Bananas, raw", "food_name": "Bananas, raw", "unit": "g", "quantity": 118,
        "values": BANANA_VALUES, "food_values": BANANA_VALUES,
        "updated_at": "2026-03-01T08:00:00.000Z", "deleted_at": None,
    }  # fmt: skip
    r = client.post("/api/v1/sync", json={"cursor": None, "changes": {"food_logs": [row]}}, headers=me)
    assert r.status_code == 200 and r.json()["rejected"] == [], r.text
    assert [log["id"] for log in day(client, me, "2026-03-01")] == [row["id"]]
    assert patch(client, me, row["id"], quantity=100)["totals"]["calories"] == pytest.approx(89)
    # The phone's older copy, pushed again, loses to the edit made here.
    r = client.post("/api/v1/sync", json={"cursor": None, "changes": {"food_logs": [row]}}, headers=me)
    assert r.status_code == 200, r.text
    assert day(client, me, "2026-03-01")[0]["quantity"] == 100


# --- CORS and the API description ---


@pytest.mark.parametrize("method", ["POST", "PATCH", "DELETE"])
def test_a_browser_may_send_the_write_methods_with_a_token(client, method):
    headers = {
        "Origin": "http://localhost:8081",
        "Access-Control-Request-Method": method,
        "Access-Control-Request-Headers": "authorization, content-type",
    }
    r = client.options(f"{URL}/{uuid.uuid4()}", headers=headers)
    assert r.status_code == 200, r.text
    assert method in r.headers["access-control-allow-methods"]
    assert "access-control-allow-credentials" not in r.headers


def test_no_log_endpoint_declares_a_user_as_input(client):
    paths = client.get("/openapi.json").json()["paths"]
    mine = {"/api/v1/food-logs", "/api/v1/food-logs/{log_id}", "/api/v1/nutrition/daily", "/api/v1/foods/recent"}
    assert mine <= set(paths)
    for path, operations in paths.items():
        assert "user" not in path.lower()
        for operation in operations.values():
            assert all("user" not in p["name"].lower() for p in operation.get("parameters", [])), path
