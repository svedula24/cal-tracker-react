"""Food search: pure helpers that turn a query into SQL parameters, and the queries themselves.

One query, ranked in tiers: the exact description, then descriptions that start with the query,
then full-text matches (every word, the last as a prefix), then misspellings (trigram word
similarity). The WHERE clause uses the exact expressions of the indexes in db/schema.sql.
"""

from __future__ import annotations

import re
from typing import Any

import psycopg
from psycopg.rows import dict_row

# Transaction-local, so a pooled connection keeps the server default for anything else.
SET_THRESHOLD = "SELECT set_config('pg_trgm.word_similarity_threshold', '0.4', true)"

SEARCH_SQL = """
SELECT fdc_id, description, data_type, brand_name, calories_per_100g
FROM foods
WHERE lower(description) LIKE %(prefix)s
   OR to_tsvector('english', description) @@ to_tsquery('english', %(tsq)s::text)
   OR %(q)s <%% lower(description)
ORDER BY
    CASE
        WHEN lower(description) = %(q)s THEN 0
        WHEN lower(description) LIKE %(prefix)s THEN 1
        WHEN to_tsvector('english', description) @@ to_tsquery('english', %(tsq)s::text) THEN 2
        ELSE 3
    END,
    word_similarity(%(q)s, lower(description)) DESC,
    length(description),
    fdc_id
LIMIT %(limit)s
"""

# Queries shorter than this only match descriptions that start with them: "s" alone would
# full-text and fuzzy match over half the table (~300 ms to rank).
MIN_FULL_SEARCH = 3

PREFIX_SQL = """
SELECT fdc_id, description, data_type, brand_name, calories_per_100g
FROM foods
WHERE lower(description) LIKE %(prefix)s
ORDER BY lower(description) = %(q)s DESC, length(description), fdc_id
LIMIT %(limit)s
"""

FOOD_SQL = """
SELECT fdc_id, description, data_type, brand_name,
       calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g
FROM foods
WHERE fdc_id = %(fdc_id)s
"""


def normalize(q: str) -> str:
    """Trimmed, lowercased, single-spaced."""
    return " ".join(q.lower().split())


def tsquery(q: str) -> str | None:
    """Every word must match, the last as a prefix (the user may still be typing); None if q has no words."""
    words = re.findall(r"[^\W_]+", q.lower())
    if not words:
        return None
    return " & ".join(words) + ":*"


def like_prefix(q: str) -> str:
    """A LIKE pattern for descriptions that start with q, with q's own wildcards escaped."""
    return q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def params(q: str, limit: int) -> dict[str, Any]:
    """SEARCH_SQL's parameters for an already-normalized q."""
    return {"q": q, "prefix": like_prefix(q), "tsq": tsquery(q), "limit": limit}


def sql_for(q: str) -> str:
    """The query search() runs for an already-normalized q."""
    return PREFIX_SQL if len(q) < MIN_FULL_SEARCH else SEARCH_SQL


def search(conn: psycopg.Connection, q: str, limit: int) -> list[dict[str, Any]]:
    """The best `limit` foods for q, best first."""
    q = normalize(q)
    with conn.transaction(), conn.cursor(row_factory=dict_row) as cur:
        cur.execute(SET_THRESHOLD)
        cur.execute(sql_for(q), params(q, limit))
        return cur.fetchall()


def get_food(conn: psycopg.Connection, fdc_id: int) -> dict[str, Any] | None:
    """One food with every nutrient column, or None."""
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(FOOD_SQL, {"fdc_id": fdc_id})
        return cur.fetchone()
