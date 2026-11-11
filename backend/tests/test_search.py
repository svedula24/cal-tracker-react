"""The pure query-building half of food search (app/services/foods.py): no database."""

import pytest

from app.services.foods import MIN_FULL_SEARCH, PREFIX_SQL, SEARCH_SQL, like_prefix, normalize, params, sql_for, tsquery


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


def binds(sql):
    """The names of the statement's bind parameters."""
    return set(sql.compile().params)


def test_params_has_every_placeholder_the_query_uses():
    got = params("chicken bre", 20, 40)
    assert set(got) == {"q", "prefix", "tsq", "limit", "offset"} == binds(SEARCH_SQL)
    assert got["limit"] == 20
    assert got["offset"] == 40
    assert got["tsq"] == "chicken & bre:*"


def test_prefix_query_uses_a_subset_of_the_parameters():
    assert binds(PREFIX_SQL) == {"q", "prefix", "limit", "offset"}


def test_short_queries_take_the_prefix_only_statement():
    assert MIN_FULL_SEARCH == 3
    assert sql_for("br") is PREFIX_SQL
    assert sql_for("bre") is SEARCH_SQL


@pytest.mark.parametrize("sql", [SEARCH_SQL, PREFIX_SQL])
def test_statements_keep_the_index_expressions_and_page(sql):
    # The planner only uses the GIN indexes when the WHERE clause repeats their expressions exactly.
    assert "lower(description) LIKE :prefix" in sql.text
    assert sql.text.rstrip().endswith("LIMIT :limit OFFSET :offset")
    if sql is SEARCH_SQL:
        assert "to_tsvector('english', description) @@" in sql.text
        assert ":q <% lower(description)" in sql.text  # one %, which SQLAlchemy doubles for psycopg
