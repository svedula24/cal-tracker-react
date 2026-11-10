"""The foods API (kalo/api): search ranking, validation, and food lookup. Needs Postgres: set DATABASE_URL.

Each test seeds a fresh scratch schema (see conftest.py) and runs the app's lifespan against it.
"""

import os

import pytest
from fastapi.testclient import TestClient

from kalo.api.app import create_app
from kalo.usda.load import load
from kalo.usda.nutrients import FoodRow

pytestmark = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set")

SUMMARY_KEYS = {"fdc_id", "description", "data_type", "brand_name", "calories_per_100g"}
DETAIL_KEYS = SUMMARY_KEYS | {"protein_per_100g", "carbs_per_100g", "fat_per_100g"}

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
    # fdc_id, description, data_type, calories, protein, carbs, fat
    (BANANAS_RAW, "Bananas, raw", "SR Legacy", 89.0, 1.09, 22.84, 0.33),
    (BANANA_POWDER, "Banana, dehydrated, or banana powder", "SR Legacy", 346.0, 3.89, 88.28, 1.81),
    (BANANAS_OVERRIPE, "Bananas, overripe, raw", "Foundation", 85.0, 0.73, 20.1, 0.22),
    (CHICKEN_BREAST, "Chicken, broilers or fryers, breast, meat only, cooked, roasted", "SR Legacy",
     165.0, 31.02, 0.0, 3.57),
    (CHICKEN_THIGH, "Chicken, broilers or fryers, thigh, meat only, raw", "SR Legacy", 120.0, 19.66, 0.0, 3.91),
    (BROCCOLI, "Broccoli, raw", "Foundation", 39.0, 2.57, 6.27, 0.34),
    (YOGURT, "Yogurt, Greek, plain, nonfat", "SR Legacy", 59.0, 10.19, 3.6, 0.39),
    (BREAD, "Bread, whole-wheat", "Survey (FNDDS)", 252.0, 12.45, 42.71, 3.5),
    (APPLES, "Apples, raw, with skin", "SR Legacy", 52.0, 0.26, 13.81, 0.17),
    (MILK_2, "Milk, reduced fat, fluid, 2% milkfat", "SR Legacy", 50.0, 3.3, 4.8, 1.98),
]


@pytest.fixture
def client(scratch_url):
    rows = [
        FoodRow(fdc_id=i, description=d, data_type=t, brand_name=None, calories_per_100g=kcal,
                protein_per_100g=p, carbs_per_100g=c, fat_per_100g=f)
        for i, d, t, kcal, p, c, f in FOODS
    ]
    load(rows, scratch_url)
    with TestClient(create_app(scratch_url)) as c:
        yield c


def search(client, q, **extra):
    r = client.get("/api/v1/foods/search", params={"q": q, **extra})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"results"}
    return body["results"]


def ids(results):
    return [r["fdc_id"] for r in results]


def test_search_results_are_summaries(client):
    results = search(client, "bananas, raw")
    assert results
    for r in results:
        assert set(r) == SUMMARY_KEYS
    assert results[0] == {
        "fdc_id": BANANAS_RAW,
        "description": "Bananas, raw",
        "data_type": "SR Legacy",
        "brand_name": None,
        "calories_per_100g": pytest.approx(89.0),
    }


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


def test_nonsense_finds_nothing(client):
    assert search(client, "zzzzqqq") == []


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
    ],
)
def test_bad_search_parameters_are_422(client, query):
    assert client.get("/api/v1/foods/search", params=query).status_code == 422


def test_search_accepts_the_boundaries(client):
    assert client.get("/api/v1/foods/search", params={"q": "a" * 100}).status_code == 200
    assert client.get("/api/v1/foods/search", params={"q": "banana", "limit": 50}).status_code == 200
    assert client.get("/api/v1/foods/search", params={"q": "b", "limit": 1}).status_code == 200


def test_food_by_id_has_every_column(client):
    r = client.get(f"/api/v1/foods/{BANANAS_RAW}")
    assert r.status_code == 200
    assert r.json() == {
        "fdc_id": BANANAS_RAW,
        "description": "Bananas, raw",
        "data_type": "SR Legacy",
        "brand_name": None,
        "calories_per_100g": pytest.approx(89.0),
        "protein_per_100g": pytest.approx(1.09),
        "carbs_per_100g": pytest.approx(22.84),
        "fat_per_100g": pytest.approx(0.33),
    }


def test_unknown_food_is_404(client):
    assert client.get("/api/v1/foods/999999").status_code == 404


@pytest.mark.parametrize("fdc_id", ["0", "-1", "banana", "1.5"])
def test_bad_food_id_is_422(client, fdc_id):
    assert client.get(f"/api/v1/foods/{fdc_id}").status_code == 422
