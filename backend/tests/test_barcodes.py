"""Barcode lookups (app/services/barcodes.py, GET /api/v1/foods/barcode/{code}).

Open Food Facts is never called: the HTTP tests give `_fetch_off` a mock transport, and the endpoint
tests replace `fetch_off`. The endpoint tests need Postgres (DATABASE_URL); the rest do not.
"""

import os
from datetime import UTC, datetime, timedelta

import httpx2
import psycopg
import pytest
from fastapi.testclient import TestClient

from app.api.limits import SlidingWindow
from app.main import create_app
from app.services import barcodes
from app.services.barcodes import Product, Unavailable, map_product, normalize
from app.settings import Settings, get_settings

needs_db = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set")

CODE = "0737628064502"
URL = f"/api/v1/foods/barcode/{CODE}"
NUTRIMENTS = {
    "energy-kcal_100g": 385,
    "proteins_100g": 9.6,
    "carbohydrates_100g": 71.2,
    "fat_100g": 7.7,
    "fiber_100g": 1.9,
    "sugars_100g": 13.5,
    "sodium_100g": 1.25,
}
OFF_PRODUCT = {
    "code": CODE,
    "product_name": " Thai Peanut Noodle Kit ",
    "brands": "Simply Asia, Simply Asia Foods",
    "serving_size": "0.333 PACKAGE (52 g)",
    "serving_quantity": 52,
    "serving_quantity_unit": "g",
    "nutriments": NUTRIMENTS,
}
BODY = {
    "code": CODE,
    "name": "Thai Peanut Noodle Kit",
    "brand": "Simply Asia",
    "nutrients_per_100g": {
        "calories": 385.0, "protein_g": 9.6, "carbs_g": 71.2, "fat_g": 7.7,
        "fiber_g": 1.9, "sugar_g": 13.5, "sodium_mg": 1250.0,
    },
    "serving": {"label": "0.333 PACKAGE (52 g)", "grams": 52.0},
    "source": "openfoodfacts",
}  # fmt: skip


# ---- normalize ----


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("96385074", "96385074"),  # EAN-8
        ("737628064502", CODE),  # UPC-A gets a leading 0
        (CODE, CODE),  # EAN-13
        ("00737628064502", CODE),  # GTIN-14 with a leading 0 drops it
        ("10737628064509", "10737628064509"),  # other GTIN-14s stay
        (" 0737 6280 64502 ", CODE),  # whitespace is dropped
    ],
)
def test_normalize_accepts_gs1_codes(code, expected):
    assert normalize(code) == expected


@pytest.mark.parametrize(
    "code",
    [
        "0737628064503",  # wrong check digit
        "737628064501",  # UPC-A with a wrong check digit
        "96385075",
        "1234567",  # 7 digits
        "12345678901",  # 11 digits
        "123456789012345",  # 15 digits
        "07376280645O2",  # a letter O
        "0737628-064502",
        "٠٧٣٧٦٢٨٠٦٤٥٠٢",  # Arabic-Indic digits are not digits here
        "",
    ],
)
def test_normalize_refuses_everything_else(code):
    assert normalize(code) is None


# ---- mapping an OFF product ----


def test_map_product_found():
    assert map_product(CODE, OFF_PRODUCT) == Product(
        code=CODE, found=True, name="Thai Peanut Noodle Kit", brand="Simply Asia", calories=385.0,
        protein_g=9.6, carbs_g=71.2, fat_g=7.7, fiber_g=1.9, sugar_g=13.5, sodium_mg=1250.0,
        serving_label="0.333 PACKAGE (52 g)", serving_grams=52.0,
    )  # fmt: skip


def with_nutriments(**changes):
    nutriments = {k: v for k, v in {**NUTRIMENTS, **changes}.items() if v is not None}
    return {**OFF_PRODUCT, "nutriments": nutriments}


def test_calories_fall_back_to_kilojoules():
    product = map_product(CODE, with_nutriments(**{"energy-kcal_100g": None, "energy-kj_100g": 1611}))
    assert product.found and product.calories == 385.0


def test_numbers_may_be_numeric_strings_and_negatives_become_zero():
    product = map_product(CODE, with_nutriments(proteins_100g=" 9.6 ", fat_100g=-0.1, sodium_100g="0.0013"))
    assert (product.protein_g, product.fat_g, product.sodium_mg) == (9.6, 0.0, 1.3)


@pytest.mark.parametrize("bad", [True, "abc", float("nan"), float("inf"), "inf", None, [1]])
def test_an_unusable_main_nutrient_makes_it_incomplete(bad):
    product = map_product(CODE, with_nutriments(fat_100g=bad))
    assert product == Product(
        code=CODE, found=False, reason="incomplete", name="Thai Peanut Noodle Kit", brand="Simply Asia"
    )


def test_missing_optional_nutrients_are_null():
    product = map_product(CODE, with_nutriments(fiber_100g=None, sugars_100g=None, sodium_100g=None))
    assert product.found and (product.fiber_g, product.sugar_g, product.sodium_mg) == (None, None, None)


@pytest.mark.parametrize(
    "product", [{}, None, [], {**OFF_PRODUCT, "product_name": "  "}, {**OFF_PRODUCT, "nutriments": "x"}]
)
def test_an_empty_or_nameless_product_is_incomplete(product):
    mapped = map_product(CODE, product)
    assert (mapped.found, mapped.reason) == (False, "incomplete")


def test_brand_is_the_first_of_brands():
    assert map_product(CODE, {**OFF_PRODUCT, "brands": " Kroger ,Simple Truth"}).brand == "Kroger"
    assert map_product(CODE, {**OFF_PRODUCT, "brands": ""}).brand is None
    assert map_product(CODE, {**OFF_PRODUCT, "brands": None}).brand is None


@pytest.mark.parametrize(
    ("serving", "expected"),
    [
        ({}, ("0.333 PACKAGE (52 g)", 52.0)),
        ({"serving_quantity": "52", "serving_quantity_unit": "G"}, ("0.333 PACKAGE (52 g)", 52.0)),
        ({"serving_size": "1 cup (240 ml)", "serving_quantity": 240, "serving_quantity_unit": "ml"},
         ("1 cup (240 ml)", 240.0)),
        ({"serving_size": None, "serving_quantity": 30}, ("30 g", 30.0)),  # unit g, no label
        ({"serving_size": "1 bar (40g)", "serving_quantity": 40, "serving_quantity_unit": None}, ("1 bar (40g)", 40.0)),
        ({"serving_size": "1 egg", "serving_quantity": 1, "serving_quantity_unit": None}, (None, None)),
        ({"serving_quantity_unit": "oz"}, (None, None)),
        ({"serving_quantity": 0}, (None, None)),
        ({"serving_quantity": -5}, (None, None)),
        ({"serving_quantity": None}, (None, None)),
    ],
)  # fmt: skip
def test_serving(serving, expected):
    product = map_product(CODE, {**OFF_PRODUCT, **serving})
    assert (product.serving_label, product.serving_grams) == expected


# ---- the HTTP call (a mock transport, never the real OFF) ----


def mock_off(monkeypatch, handler):
    """Make _fetch_off's client answer with `handler(request)`; returns the requests it saw."""
    seen = []
    real_client = httpx2.Client

    def respond(request):
        seen.append(request)
        return handler(request)

    def client(**kwargs):
        assert kwargs == {"timeout": barcodes.TIMEOUT}
        return real_client(transport=httpx2.MockTransport(respond))

    monkeypatch.setattr(barcodes.httpx2, "Client", client)
    return seen


def test_fetch_off_request_and_found(monkeypatch):
    seen = mock_off(monkeypatch, lambda r: httpx2.Response(200, json={"status": 1, "product": OFF_PRODUCT}))
    settings = get_settings({"OFF_BASE_URL": "https://off.example/", "OFF_USER_AGENT": "Test/1 (+x)"})
    assert barcodes._fetch_off(CODE, settings).found
    (request,) = seen
    assert str(request.url).startswith(f"https://off.example/api/v2/product/{CODE}?fields=")
    assert request.url.params["fields"] == barcodes.FIELDS
    assert request.headers["User-Agent"] == "Test/1 (+x)"


def test_settings_default_to_the_real_off():
    settings = get_settings({})
    assert settings.off_base_url == "https://world.openfoodfacts.org"
    assert settings.off_user_agent == "Kalo/0.1 (+https://github.com/svedula24/cal-tracker-react)"


@pytest.mark.parametrize(
    "response",
    [
        httpx2.Response(404, json={"status": 0, "status_verbose": "product not found"}),
        httpx2.Response(200, json={"status": 0}),
    ],
)
def test_fetch_off_not_found(monkeypatch, response):
    mock_off(monkeypatch, lambda r: response)
    assert barcodes._fetch_off(CODE, Settings()) == Product(code=CODE, found=False, reason="not_found")


def raise_timeout(request):
    raise httpx2.ReadTimeout("slow", request=request)


def raise_connect(request):
    raise httpx2.ConnectError("down", request=request)


@pytest.mark.parametrize(
    "handler",
    [
        lambda r: httpx2.Response(503),
        lambda r: httpx2.Response(500, text="oops"),
        lambda r: httpx2.Response(429),
        lambda r: httpx2.Response(200, text="<html>"),
        lambda r: httpx2.Response(200, json=[1]),
        raise_timeout,
        raise_connect,
    ],
)
def test_fetch_off_unavailable(monkeypatch, handler):
    mock_off(monkeypatch, handler)
    with pytest.raises(Unavailable):
        barcodes._fetch_off(CODE, Settings())


# ---- the endpoint ----


@pytest.fixture
def client(migrated_url):
    with TestClient(create_app(migrated_url)) as c:
        yield c


@pytest.fixture
def db(migrated_url):
    with psycopg.connect(migrated_url, autocommit=True) as conn:
        yield conn


@pytest.fixture
def me(client):
    r = client.post("/api/v1/devices", json={})
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


class FakeOff:
    """Stands in for fetch_off: answers with `result` (a Product, or an exception to raise)."""

    def __init__(self, result):
        self.result = result
        self.calls = []

    def __call__(self, code, settings):
        self.calls.append(code)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


@pytest.fixture
def off(monkeypatch):
    fake = FakeOff(map_product(CODE, OFF_PRODUCT))
    monkeypatch.setattr(barcodes, "fetch_off", fake)
    return fake


def age(db, days):
    """Backdate every cached row by `days` from this clock (the database's may differ by seconds)."""
    db.execute("UPDATE barcode_products SET fetched_at = %s", (datetime.now(UTC) - timedelta(days=days),))


@needs_db
def test_found_then_served_from_the_cache(client, me, off, db):
    r = client.get(URL, headers=me)
    assert r.status_code == 200, r.text
    assert r.json() == BODY
    assert off.calls == [CODE]
    (fetched_at,) = db.execute("SELECT fetched_at FROM barcode_products WHERE code = %s", (CODE,)).fetchone()
    assert datetime.now(UTC) - fetched_at < timedelta(minutes=1)
    # The UPC-A spelling is the same product, from the cache.
    r = client.get("/api/v1/foods/barcode/737628064502", headers=me)
    assert r.status_code == 200 and r.json() == BODY
    assert off.calls == [CODE]


@needs_db
def test_brand_and_serving_may_be_null(client, me, off):
    off.result = map_product(CODE, {**OFF_PRODUCT, "brands": None, "serving_quantity": None})
    body = client.get(URL, headers=me).json()
    assert (body["brand"], body["serving"]) == (None, None)


@needs_db
def test_a_found_product_is_refetched_after_30_days(client, me, off, db):
    assert client.get(URL, headers=me).status_code == 200
    age(db, 29)
    assert client.get(URL, headers=me).status_code == 200
    assert off.calls == [CODE]
    age(db, 30)
    off.result = map_product(CODE, {**OFF_PRODUCT, "product_name": "Renamed Kit"})
    assert client.get(URL, headers=me).json()["name"] == "Renamed Kit"
    assert off.calls == [CODE, CODE]
    assert db.execute("SELECT name FROM barcode_products").fetchall() == [("Renamed Kit",)]


@needs_db
def test_not_found_is_cached_for_a_day(client, me, off, db):
    off.result = Product(code=CODE, found=False, reason="not_found")
    for _ in range(2):
        r = client.get(URL, headers=me)
        assert r.status_code == 404 and r.json() == {"detail": {"reason": "not_found"}}
    assert off.calls == [CODE]
    age(db, 1)
    off.result = map_product(CODE, OFF_PRODUCT)  # added to OFF since
    assert client.get(URL, headers=me).json() == BODY
    assert off.calls == [CODE, CODE]


@needs_db
def test_incomplete_says_so_with_the_name(client, me, off):
    off.result = map_product(CODE, with_nutriments(fat_100g=None))
    r = client.get(URL, headers=me)
    assert r.status_code == 404
    assert r.json() == {"detail": {"reason": "incomplete", "name": "Thai Peanut Noodle Kit"}}
    off.result = map_product(CODE, {})
    r = client.get(URL, headers=me)  # still cached: the same answer, and OFF is not asked again
    assert r.json()["detail"]["name"] == "Thai Peanut Noodle Kit"
    assert len(off.calls) == 1


@needs_db
def test_incomplete_without_a_name(client, me, off):
    off.result = map_product(CODE, {})
    assert client.get(URL, headers=me).json() == {"detail": {"reason": "incomplete", "name": None}}


@needs_db
def test_off_unavailable_serves_a_stale_row(client, me, off, db):
    assert client.get(URL, headers=me).status_code == 200
    age(db, 40)
    off.result = Unavailable("down")
    r = client.get(URL, headers=me)
    assert r.status_code == 200 and r.json() == BODY
    assert off.calls == [CODE, CODE]
    # The stale row is kept as it was, so the next lookup tries OFF again.
    (fetched_at,) = db.execute("SELECT fetched_at FROM barcode_products").fetchone()
    assert (datetime.now(UTC) - fetched_at).days == 40


@needs_db
def test_off_unavailable_without_a_row_is_503(client, me, off, db):
    off.result = Unavailable("down")
    r = client.get(URL, headers=me)
    assert r.status_code == 503 and r.json() == {"detail": "product lookup unavailable"}
    assert db.execute("SELECT count(*) FROM barcode_products").fetchone() == (0,)


@needs_db
def test_needs_a_token(client, off):
    r = client.get(URL)
    assert r.status_code == 401
    assert r.headers["WWW-Authenticate"] == "Bearer"
    assert off.calls == []


@needs_db
@pytest.mark.parametrize("code", ["0737628064503", "abc", "12345", "0" * 41])
def test_a_bad_code_is_422(client, me, off, code):
    r = client.get(f"/api/v1/foods/barcode/{code}", headers=me)
    assert r.status_code == 422
    assert off.calls == []


@needs_db
def test_rate_limited_per_user(client, me, off):
    client.app.state.barcode_lookups = SlidingWindow(2, per_seconds=3600)
    for _ in range(2):
        assert client.get(URL, headers=me).status_code == 200
    r = client.get(URL, headers=me)
    assert r.status_code == 429
    assert 3500 <= int(r.headers["Retry-After"]) <= 3600
    other = client.post("/api/v1/devices", json={}).json()["token"]
    assert client.get(URL, headers={"Authorization": f"Bearer {other}"}).status_code == 200


@needs_db
def test_the_server_wide_off_budget_is_spent_only_by_cache_misses(client, me, off, db):
    client.app.state.off_reads = SlidingWindow(1, per_seconds=60)
    assert client.get(URL, headers=me).status_code == 200  # a miss: spends the one call
    assert client.get(URL, headers=me).status_code == 200  # a hit: spends nothing
    assert off.calls == [CODE]
    # Another code needs OFF, and the budget is spent: 503 with Retry-After, OFF not called.
    r = client.get("/api/v1/foods/barcode/4006381333931", headers=me)
    assert r.status_code == 503 and r.json() == {"detail": "product lookup unavailable"}
    assert 1 <= int(r.headers["Retry-After"]) <= 60
    assert off.calls == [CODE]
    # A stale row is served instead while the budget is spent.
    age(db, 40)
    r = client.get(URL, headers=me)
    assert r.status_code == 200 and r.json() == BODY
    assert off.calls == [CODE]


@needs_db
def test_the_barcode_route_is_not_taken_for_an_fdc_id(client, me, off):
    assert client.get("/api/v1/foods/barcode", headers=me).status_code == 422  # /{fdc_id} with "barcode"
    assert client.get(URL, headers=me).status_code == 200
