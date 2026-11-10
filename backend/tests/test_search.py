"""The pure query-building half of food search (kalo/api/search.py): no database."""

import pytest

from kalo.api.search import like_prefix, normalize, params, tsquery


@pytest.mark.parametrize(
    "q, want",
    [
        ("  Chicken   BREAST ", "chicken breast"),
        ("Bananas, raw", "bananas, raw"),
        ("\tbanana\n", "banana"),
    ],
)
def test_normalize_strips_lowercases_and_collapses_whitespace(q, want):
    assert normalize(q) == want


@pytest.mark.parametrize(
    "q, want",
    [
        ("chicken bre", "chicken & bre:*"),
        ("banana", "banana:*"),
        ("Bananas, raw", "bananas & raw:*"),
        ("  Greek   YOGURT ", "greek & yogurt:*"),
        ("milk 2%", "milk & 2:*"),
        ("whole-wheat", "whole & wheat:*"),
        ("snake_case", "snake & case:*"),  # _ is not a word character here
        ("crème brûlée", "crème & brûlée:*"),  # unicode letters are words
    ],
)
def test_tsquery_ands_the_words_and_prefixes_the_last(q, want):
    assert tsquery(q) == want


@pytest.mark.parametrize("q", ["%%", "", "   ", "_", "&|!:*()'"])
def test_tsquery_is_none_without_words(q):
    assert tsquery(q) is None


@pytest.mark.parametrize(
    "q, want",
    [
        ("banana", "banana%"),
        ("50%_x\\", "50\\%\\_x\\\\%"),
        ("2%", "2\\%%"),
        ("", "%"),
    ],
)
def test_like_prefix_escapes_wildcards_and_appends_percent(q, want):
    assert like_prefix(q) == want


def test_params_has_every_placeholder_the_query_uses():
    got = params("chicken bre", 20)
    assert set(got) == {"q", "prefix", "tsq", "limit"}
    assert got["limit"] == 20
    assert got["tsq"] == "chicken & bre:*"
