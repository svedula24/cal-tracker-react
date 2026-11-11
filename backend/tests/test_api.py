"""The foods API (app/): search ranking, paging, portions, validation, food lookup and CORS.

Needs Postgres: set DATABASE_URL.

Each test seeds a freshly migrated scratch schema (see conftest.py) and runs the app's lifespan against it.
"""

import os

import pytest
import sqlalchemy.exc
from fastapi.testclient import TestClient
from sqlalchemy import event

from app.main import create_app
from kalo.db import SchemaOutOfDate
from kalo.usda.load import load
from kalo.usda.nutrients import FoodRow
from kalo.usda.portions import Portion

pytestmark = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set")

ITEM_KEYS = {
    "fdc_id", "description", "data_type", "brand_name",
    "calories_per_100g", "protein_per_100g", "carbs_per_100g", "fat_per_100g",
    "fiber_per_100g", "sugar_per_100g", "sodium_mg_per_100g",
    "portions",
}  # fmt: skip
DETAIL_KEYS = {"fdc_id", "description", "data_type", "brand_name", "nutrients_per_100g", "portions"}
NUTRIENT_KEYS = {"calories", "protein_g", "carbs_g", "fat_g", "fiber_g", "sugar_g", "sodium_mg"}
PORTION_KEYS = {"id", "description", "gram_weight"}

BANANAS_RAW = 1
BANANA_POWDER = 2
BANANAS_OVERRIPE = 3
CHICKEN_BREAST = 4
CHICKEN_THIGH = 5
BROCCOLI = 6
YOGURT = 7
BREAD = 8
APPLES = 9
MILK_2 = 10

FOODS = [
    # fdc_id, description, data_type, calories, protein, carbs, fat, fiber, sugar, sodium (mg)
    (BANANAS_RAW, "Bananas, raw", "SR Legacy", 89.0, 1.09, 22.84, 0.33, 2.6, 12.23, 1.0),
    (BANANA_POWDER, "Banana, dehydrated, or banana powder", "SR Legacy", 346.0, 3.89, 88.28, 1.81, 9.9, 47.3, 3.0),
    # Foundation foods often report no sugar; this one reports none of the three optional nutrients.
    (BANANAS_OVERRIPE, "Bananas, overripe, raw", "Foundation", 85.0, 0.73, 20.1, 0.22, None, None, None),
    (CHICKEN_BREAST, "Chicken, broilers or fryers, breast, meat only, cooked, roasted", "SR Legacy",
     165.0, 31.02, 0.0, 3.57, 0.0, 0.0, 74.0),
    (CHICKEN_THIGH, "Chicken, broilers or fryers, thigh, meat only, raw", "SR Legacy",
     120.0, 19.66, 0.0, 3.91, 0.0, None, 95.0),
    (BROCCOLI, "Broccoli, raw", "Foundation", 39.0, 2.57, 6.27, 0.34, 2.4, None, 36.0),
    (YOGURT, "Yogurt, Greek, plain, nonfat", "SR Legacy", 59.0, 10.19, 3.6, 0.39, 0.0, 3.24, 36.0),
    (BREAD, "Bread, whole-wheat", "Survey (FNDDS)", 252.0, 12.45, 42.71, 3.5, 6.0, 4.34, 455.0),
    (APPLES, "Apples, raw, with skin", "SR Legacy", 52.0, 0.26, 13.81, 0.17, 2.4, 10.39, 1.0),
    (MILK_2, "Milk, reduced fat, fluid, 2% milkfat", "SR Legacy", 50.0, 3.3, 4.8, 1.98, 0.0, 5.06, 47.0),
]

# In load order, which is the order the ids are handed out in: not sorted by weight, and the two
# 118 g portions are loaded in the opposite of alphabetical order, so only (gram_weight, id) gives
# the order asserted below.
PORTIONS = [
    (BANANAS_RAW, "1 cup, mashed", 225.0),
    (BANANAS_RAW, "1 medium (7 inches to 7-7/8 inches long)", 118.0),
    (BANANAS_RAW, "1 NLEA serving", 126.0),
    (BROCCOLI, "1 cup chopped", 91.0),
    (BANANAS_RAW, "1 extra small (less than 6 inches long)", 81.0),
    (BANANAS_RAW, "1 cup, sliced", 118.0),
    (BROCCOLI, "1 spear (about 5 inches long)", 30.8),
]
BANANA_PORTIONS_IN_ORDER = [
    ("1 extra small (less than 6 inches long)", 81.0),
    ("1 medium (7 inches to 7-7/8 inches long)", 118.0),
    ("1 cup, sliced", 118.0),
    ("1 NLEA serving", 126.0),
    ("1 cup, mashed", 225.0),
]


@pytest.fixture
def client(migrated_url):
    rows = [
        FoodRow(fdc_id=i, description=d, data_type=t, brand_name=None, calories_per_100g=kcal,
                protein_per_100g=p, carbs_per_100g=c, fat_per_100g=f,
                fiber_per_100g=fiber, sugar_per_100g=sugar, sodium_mg_per_100g=sodium)
        for i, d, t, kcal, p, c, f, fiber, sugar, sodium in FOODS
    ]  # fmt: skip
    portions = [Portion(fdc_id=i, description=d, gram_weight=g) for i, d, g in PORTIONS]
    load(rows, portions, migrated_url)
    with TestClient(create_app(migrated_url)) as c:
        yield c


class AnyId:
    def __eq__(self, other):
        return isinstance(other, int) and other > 0


ANY_ID = AnyId()


def search(client, q, **extra):
    r = client.get("/api/v1/foods/search", params={"q": q, **extra})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"foods", "limit", "offset"}
    return body["foods"]


def ids(foods):
    return [f["fdc_id"] for f in foods]


def test_search_response_is_an_envelope_of_full_rows(client):
    r = client.get("/api/v1/foods/search", params={"q": "bananas, raw"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"foods", "limit", "offset"}
    assert (body["limit"], body["offset"]) == (20, 0)  # the defaults
    assert body["foods"]
    for food in body["foods"]:
        assert set(food) == ITEM_KEYS
    assert body["foods"][0] == {
        "fdc_id": BANANAS_RAW,
        "description": "Bananas, raw",
        "data_type": "SR Legacy",
        "brand_name": None,
        "calories_per_100g": pytest.approx(89.0),
        "protein_per_100g": pytest.approx(1.09),
        "carbs_per_100g": pytest.approx(22.84),
        "fat_per_100g": pytest.approx(0.33),
        "fiber_per_100g": pytest.approx(2.6),
        "sugar_per_100g": pytest.approx(12.23),
        "sodium_mg_per_100g": pytest.approx(1.0),
        "portions": [
            {"id": ANY_ID, "description": description, "gram_weight": grams}
            for description, grams in BANANA_PORTIONS_IN_ORDER
        ],
    }


def test_search_echoes_limit_and_offset(client):
    body = client.get("/api/v1/foods/search", params={"q": "banana", "limit": 2, "offset": 1}).json()
    assert (body["limit"], body["offset"]) == (2, 1)
    assert len(body["foods"]) == 2


@pytest.mark.parametrize("q", ["bananas, raw", "Bananas, raw", "  BANANAS,   RAW "])
def test_exact_match_ranks_first_regardless_of_case_and_whitespace(client, q):
    assert ids(search(client, q))[0] == BANANAS_RAW


def test_prefix_returns_banana_foods_only(client):
    got = ids(search(client, "banana"))
    # All three are prefix matches. Ties go to higher word similarity ("banana" is a whole word only in the
    # powder), then the shorter description.
    assert got == [BANANA_POWDER, BANANAS_RAW, BANANAS_OVERRIPE]


def test_prefix_matches_rank_ahead_of_full_text_matches(client):
    # Two descriptions start with "bananas"; the powder matches only by stemming ("bananas" -> "banana").
    got = ids(search(client, "bananas"))
    assert got[:3] == [BANANAS_RAW, BANANAS_OVERRIPE, BANANA_POWDER]


def test_full_text_matches_a_word_anywhere(client):
    got = ids(search(client, "raw"))
    assert BANANAS_RAW in got and BROCCOLI in got and APPLES in got and CHICKEN_THIGH in got
    assert CHICKEN_BREAST not in got  # roasted, not raw


def test_every_word_must_match_for_full_text(client):
    got = ids(search(client, "chicken breast"))
    assert got[0] == CHICKEN_BREAST
    if CHICKEN_THIGH in got:  # only via fuzzy, which ranks after full text
        assert got.index(CHICKEN_THIGH) > got.index(CHICKEN_BREAST)


def test_full_text_uses_english_stemming(client):
    # "apple" stems to the same lexeme as "Apples"; "roast" matches "roasted".
    assert APPLES in ids(search(client, "apple skin"))
    assert ids(search(client, "chicken roast"))[0] == CHICKEN_BREAST


def test_last_word_is_a_prefix(client):
    assert ids(search(client, "chicken bre"))[0] == CHICKEN_BREAST
    assert ids(search(client, "greek yog"))[0] == YOGURT


@pytest.mark.parametrize(
    "q, want",
    [("brocoli", BROCCOLI), ("chiken brest", CHICKEN_BREAST), ("yoghurt", YOGURT), ("bananna", BANANAS_RAW)],
)
def test_misspellings_match_fuzzily(client, q, want):
    assert want in ids(search(client, q))


def test_percent_is_not_a_wildcard(client):
    got = ids(search(client, "2%"))
    assert APPLES not in got
    assert len(got) < len(FOODS)
    assert set(got) <= {MILK_2}


def test_short_queries_match_only_descriptions_that_start_with_them(client):
    # "br" is in "broilers" and "fryers" too, but under 3 characters only the start of a description counts.
    assert ids(search(client, "br")) == [BROCCOLI, BREAD]  # shorter description first


def test_limit_caps_the_results(client):
    assert len(search(client, "banana", limit=1)) == 1
    assert ids(search(client, "banana", limit=2)) == ids(search(client, "banana"))[:2]


@pytest.mark.parametrize(
    "q, size",
    [
        ("raw", 2),  # the full query: full-text and fuzzy matches
        ("banana", 1),
        ("b", 1),  # the prefix-only query: Bananas x3, Broccoli, Bread
    ],
)
def test_offset_pages_are_disjoint_and_add_up_to_the_unpaged_result(client, q, size):
    everything = ids(search(client, q, limit=50))
    assert len(everything) > size  # more than one page, or this proves nothing
    pages = [ids(search(client, q, limit=size, offset=start)) for start in range(0, len(everything) + size, size)]
    paged = [fdc_id for page in pages for fdc_id in page]
    assert len(paged) == len(set(paged))
    assert paged == everything
    assert pages[-1] == []  # past the end is an empty page, not an error


def test_offset_past_the_last_match_is_empty(client):
    assert search(client, "banana", offset=3) == []
    assert search(client, "banana", offset=1000) == []


def test_nonsense_finds_nothing(client):
    assert search(client, "zzzzqqq") == []


@pytest.mark.parametrize("q", ["a", "the", "and the of"])
def test_one_letter_and_stopword_only_queries_still_work(client, q):
    # "a" takes the prefix-only path; stopwords give an empty full-text query. Neither may error.
    assert isinstance(search(client, q), list)


def test_search_keeps_unreported_nutrients_null(client):
    by_id = {f["fdc_id"]: f for f in search(client, "banana")}
    overripe = by_id[BANANAS_OVERRIPE]
    assert overripe["fiber_per_100g"] is None
    assert overripe["sugar_per_100g"] is None
    assert overripe["sodium_mg_per_100g"] is None
    assert overripe["calories_per_100g"] == pytest.approx(85.0)
    # A reported zero is a zero, not null.
    chicken = search(client, "chicken breast")[0]
    assert chicken["fiber_per_100g"] == 0
    assert chicken["sugar_per_100g"] == 0


def test_search_items_carry_their_portions_ordered_by_gram_weight_then_id(client):
    by_id = {f["fdc_id"]: f for f in search(client, "raw")}
    portions = by_id[BANANAS_RAW]["portions"]
    for p in portions:
        assert set(p) == PORTION_KEYS
    assert [(p["description"], p["gram_weight"]) for p in portions] == BANANA_PORTIONS_IN_ORDER
    medium, sliced = portions[1], portions[2]
    assert medium["gram_weight"] == sliced["gram_weight"]  # the tie
    assert medium["id"] < sliced["id"]  # broken by id (load order), not by description
    # Each food gets its own portions, not its neighbour's; 30.8 is a REAL and must come back as 30.8.
    assert [(p["description"], p["gram_weight"]) for p in by_id[BROCCOLI]["portions"]] == [
        ("1 spear (about 5 inches long)", 30.8),
        ("1 cup chopped", 91.0),
    ]
    # A food with none has an empty list, not a missing key or null.
    assert by_id[APPLES]["portions"] == []
    assert by_id[CHICKEN_THIGH]["portions"] == []


def test_search_portions_are_the_same_as_the_food_lookup_returns(client):
    for food in search(client, "raw"):
        assert food["portions"] == client.get(f"/api/v1/foods/{food['fdc_id']}").json()["portions"]


def test_portions_do_not_multiply_or_shorten_the_page(client):
    # "Bananas, raw" has five portions and the powder none: a join in the ranked query would return
    # the banana five times (or, as an inner join, drop the powder), and LIMIT would count portions.
    foods = search(client, "banana", limit=2)
    assert ids(foods) == [BANANA_POWDER, BANANAS_RAW]
    assert [len(f["portions"]) for f in foods] == [0, 5]
    everything = ids(search(client, "raw", limit=50))
    assert len(everything) == len(set(everything))
    assert search(client, "raw", limit=1, offset=1)[0]["fdc_id"] == everything[1]


@pytest.fixture
def statements(client):
    seen = []

    def record(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    engine = client.app.state.engine
    event.listen(engine, "before_cursor_execute", record)
    yield seen
    event.remove(engine, "before_cursor_execute", record)


@pytest.mark.parametrize("q, limit", [("raw", 1), ("raw", 50), ("b", 50)])
def test_a_page_costs_one_portions_query_whatever_its_size(client, statements, q, limit):
    assert search(client, q, limit=limit)
    portion_queries = [s for s in statements if "food_portions" in s]
    assert len(portion_queries) == 1
    assert len(statements) == 3  # the trigram threshold, the ranked page, its portions
    ranked = [s for s in statements if "FROM foods" in s]
    assert len(ranked) == 1 and "JOIN" not in ranked[0].upper()


def test_an_empty_page_skips_the_portions_query(client, statements):
    assert search(client, "zzzzqqq") == []
    assert not [s for s in statements if "food_portions" in s]


ORIGIN = {"Origin": "http://localhost:8081"}


@pytest.mark.parametrize(
    "path, status",
    [
        ("/api/v1/foods/search?q=banana", 200),
        (f"/api/v1/foods/{BANANAS_RAW}", 200),
        ("/api/v1/foods/999999", 404),
        ("/api/v1/foods/search?q=", 422),  # the app must be able to read an error too
    ],
)
def test_any_origin_may_read_a_get(client, path, status):
    r = client.get(path, headers=ORIGIN)
    assert r.status_code == status
    assert r.headers["access-control-allow-origin"] == "*"
    assert "access-control-allow-credentials" not in r.headers


def test_a_page_of_results_is_gzipped_when_the_client_accepts_it(client):
    url, params = "/api/v1/foods/search", {"q": "raw", "limit": 50}
    plain = client.get(url, params=params, headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in plain.headers
    zipped = client.get(url, params=params, headers={"Accept-Encoding": "gzip"})
    assert zipped.headers["content-encoding"] == "gzip"
    assert zipped.json() == plain.json()  # the client library decompresses: same body
    assert int(zipped.headers["content-length"]) < len(plain.content)
    # A small body is not worth compressing.
    assert "content-encoding" not in client.get("/api/v1/foods/999999", headers={"Accept-Encoding": "gzip"}).headers


def test_a_request_without_an_origin_gets_no_cors_headers(client):
    r = client.get("/api/v1/foods/search?q=banana")
    assert r.status_code == 200
    assert "access-control-allow-origin" not in r.headers


def test_preflight_allows_get_from_any_origin(client):
    r = client.options("/api/v1/foods/search", headers={**ORIGIN, "Access-Control-Request-Method": "GET"})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "*"
    assert "GET" in r.headers["access-control-allow-methods"]
    assert "access-control-allow-credentials" not in r.headers


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_preflight_allows_the_methods_the_api_uses(client, method):
    r = client.options("/api/v1/foods/search", headers={**ORIGIN, "Access-Control-Request-Method": method})
    assert r.status_code == 200
    assert method in r.headers["access-control-allow-methods"]
    assert "access-control-allow-credentials" not in r.headers


@pytest.mark.parametrize("method", ["PUT", "PATCH", "DELETE"])
def test_preflight_refuses_a_method_the_api_does_not_use(client, method):
    r = client.options("/api/v1/foods/search", headers={**ORIGIN, "Access-Control-Request-Method": method})
    assert r.status_code == 400
    assert method not in r.headers.get("access-control-allow-methods", "")


def test_preflight_refuses_a_header_the_api_does_not_use(client):
    asks = {"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "X-User-Id"}
    r = client.options("/api/v1/foods/search", headers={**ORIGIN, **asks})
    assert r.status_code == 400
    assert "x-user-id" not in r.headers.get("access-control-allow-headers", "").lower()


def test_a_503_is_readable_cross_origin(client, monkeypatch):
    def timed_out():
        raise sqlalchemy.exc.TimeoutError("QueuePool limit of size 10 overflow 0 reached, connection timed out")

    monkeypatch.setattr(client.app.state.engine.pool, "connect", timed_out)
    r = client.get("/api/v1/foods/search?q=banana", headers=ORIGIN)
    assert r.status_code == 503
    assert r.headers["access-control-allow-origin"] == "*"


@pytest.mark.parametrize("path", ["/api/v1/foods/search?q=banana", f"/api/v1/foods/{BANANAS_RAW}"])
def test_no_free_connection_is_503(client, monkeypatch, path):
    def timed_out():
        raise sqlalchemy.exc.TimeoutError("QueuePool limit of size 10 overflow 0 reached, connection timed out")

    # Where the pool raises it for real: when the session checks a connection out for its first statement.
    monkeypatch.setattr(client.app.state.engine.pool, "connect", timed_out)
    r = client.get(path)
    assert r.status_code == 503
    assert r.headers["retry-after"] == "1"
    assert r.json() == {"detail": "database busy, try again"}


@pytest.mark.parametrize(
    "query",
    [
        {},
        {"q": ""},
        {"q": "   "},
        {"q": "a" * 101},
        {"q": "banana", "limit": 0},
        {"q": "banana", "limit": 51},
        {"q": "banana", "limit": "ten"},
        {"q": "banana", "offset": -1},
        {"q": "banana", "offset": 1001},
        {"q": "banana", "offset": "two"},
    ],
)
def test_bad_search_parameters_are_422(client, query):
    assert client.get("/api/v1/foods/search", params=query).status_code == 422


def test_blank_q_says_why(client):
    r = client.get("/api/v1/foods/search", params={"q": "   "})
    assert r.status_code == 422
    assert r.json() == {"detail": "q must contain text"}


def test_search_accepts_the_boundaries(client):
    assert client.get("/api/v1/foods/search", params={"q": "a" * 100}).status_code == 200
    assert client.get("/api/v1/foods/search", params={"q": "banana", "limit": 50}).status_code == 200
    assert client.get("/api/v1/foods/search", params={"q": "b", "limit": 1}).status_code == 200
    assert client.get("/api/v1/foods/search", params={"q": "banana", "offset": 0}).status_code == 200
    assert client.get("/api/v1/foods/search", params={"q": "banana", "offset": 1000}).status_code == 200


def test_food_by_id_nests_the_nutrients(client):
    r = client.get(f"/api/v1/foods/{BANANAS_RAW}")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == DETAIL_KEYS  # so none of the flat *_per_100g columns
    assert not ITEM_KEYS & set(body["nutrients_per_100g"])
    assert {k: body[k] for k in ("fdc_id", "description", "data_type", "brand_name")} == {
        "fdc_id": BANANAS_RAW,
        "description": "Bananas, raw",
        "data_type": "SR Legacy",
        "brand_name": None,
    }
    assert body["nutrients_per_100g"] == {
        "calories": pytest.approx(89.0),
        "protein_g": pytest.approx(1.09),
        "carbs_g": pytest.approx(22.84),
        "fat_g": pytest.approx(0.33),
        "fiber_g": pytest.approx(2.6),
        "sugar_g": pytest.approx(12.23),
        "sodium_mg": pytest.approx(1.0),
    }


def test_portions_are_ordered_by_gram_weight_then_id(client):
    portions = client.get(f"/api/v1/foods/{BANANAS_RAW}").json()["portions"]
    for p in portions:
        assert set(p) == PORTION_KEYS
    assert [(p["description"], p["gram_weight"]) for p in portions] == BANANA_PORTIONS_IN_ORDER
    medium, sliced = portions[1], portions[2]
    assert medium["gram_weight"] == sliced["gram_weight"]  # the tie
    assert medium["id"] < sliced["id"]  # broken by id (load order), not by description
    assert len({p["id"] for p in portions}) == len(portions)


def test_portions_belong_to_the_food_asked_for(client):
    portions = client.get(f"/api/v1/foods/{BROCCOLI}").json()["portions"]
    assert [p["description"] for p in portions] == ["1 spear (about 5 inches long)", "1 cup chopped"]


def test_gram_weight_is_not_rounded_or_widened(client):
    # 30.8 is stored as a REAL; it must not come back as 30.799999237060547 or 31.
    portions = client.get(f"/api/v1/foods/{BROCCOLI}").json()["portions"]
    assert portions[0]["gram_weight"] == 30.8


def test_food_without_portions_has_an_empty_list(client):
    body = client.get(f"/api/v1/foods/{YOGURT}").json()
    assert body["portions"] == []
    assert set(body["nutrients_per_100g"]) == NUTRIENT_KEYS


def test_detail_keeps_unreported_nutrients_null(client):
    nutrients = client.get(f"/api/v1/foods/{BANANAS_OVERRIPE}").json()["nutrients_per_100g"]
    assert set(nutrients) == NUTRIENT_KEYS  # null, not left out
    assert nutrients["fiber_g"] is None
    assert nutrients["sugar_g"] is None
    assert nutrients["sodium_mg"] is None
    assert nutrients["calories"] == pytest.approx(85.0)
    # One null does not null the others.
    broccoli = client.get(f"/api/v1/foods/{BROCCOLI}").json()["nutrients_per_100g"]
    assert broccoli["sugar_g"] is None
    assert broccoli["fiber_g"] == pytest.approx(2.4)
    assert broccoli["sodium_mg"] == pytest.approx(36.0)


def test_unknown_food_is_404(client):
    r = client.get("/api/v1/foods/999999")
    assert r.status_code == 404
    assert r.json() == {"detail": "food not found"}


def test_largest_bigint_id_is_a_404_not_an_error(client):
    assert client.get(f"/api/v1/foods/{2**63 - 1}").status_code == 404
    assert client.get(f"/api/v1/foods/{2**63}").status_code == 422


@pytest.mark.parametrize("fdc_id", ["0", "-1", "banana", "1.5"])
def test_bad_food_id_is_422(client, fdc_id):
    assert client.get(f"/api/v1/foods/{fdc_id}").status_code == 422


def test_an_unmigrated_database_fails_at_startup(scratch_url):
    with pytest.raises(SchemaOutOfDate, match="run `uv run alembic upgrade head`"), TestClient(create_app(scratch_url)):
        pass


def test_bad_database_url_fails_at_startup(migrated_url):
    bad = migrated_url.replace("@", "wrong@", 1)  # a wrong password
    with pytest.raises(sqlalchemy.exc.OperationalError), TestClient(create_app(bad)):
        pass


def test_importing_the_app_module_does_not_connect(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://nobody@localhost:1/none")
    assert create_app().title == "Kalo"
