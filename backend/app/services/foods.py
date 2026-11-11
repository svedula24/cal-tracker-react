"""Food search and lookup: pure helpers that turn a query into SQL parameters, and the queries themselves.

One search query, ranked in tiers: the exact description, then descriptions that start with the
query, then full-text matches (every word, the last as a prefix), then misspellings (trigram word
similarity). The WHERE clause uses the exact expressions of the indexes in the baseline migration.
Search skips retired foods (dropped by a later USDA release, kept for the logs that reference them);
lookup by id still returns them, with their portions.
The order is total (it ends in fdc_id), so limit/offset pages are stable.

A page's portions come from one more query, by the page's ids (portions_for): joining them into the
ranked query would multiply its rows, so LIMIT would count portions instead of foods.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from typing import Any

from sqlalchemy import RowMapping, TextClause, select, text
from sqlalchemy.orm import Session

from app.models.foods import Food, FoodPortion

# Transaction-local, so a pooled connection keeps the server default for anything else.
SET_THRESHOLD = text("SELECT set_config('pg_trgm.word_similarity_threshold', '0.4', true)")

COLUMNS = """fdc_id, description, data_type, brand_name,
       calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g,
       fiber_per_100g, sugar_per_100g, sodium_mg_per_100g"""

# In text(), `%` is written once (SQLAlchemy doubles it for psycopg) and a cast is spelled CAST(),
# because in `:tsq::text` the bind is not recognised at all.
SEARCH_SQL = text(f"""
SELECT {COLUMNS}
FROM foods
WHERE (lower(description) LIKE :prefix
    OR to_tsvector('english', description) @@ to_tsquery('english', CAST(:tsq AS text))
    OR :q <% lower(description))
  AND retired_at IS NULL
ORDER BY
    CASE
        WHEN lower(description) = :q THEN 0
        WHEN lower(description) LIKE :prefix THEN 1
        WHEN to_tsvector('english', description) @@ to_tsquery('english', CAST(:tsq AS text)) THEN 2
        ELSE 3
    END,
    word_similarity(:q, lower(description)) DESC,
    length(description),
    fdc_id
LIMIT :limit OFFSET :offset
""")

# Queries shorter than this only match descriptions that start with them: "s" alone would
# full-text and fuzzy match over half the table (~300 ms to rank).
MIN_FULL_SEARCH = 3

PREFIX_SQL = text(f"""
SELECT {COLUMNS}
FROM foods
WHERE lower(description) LIKE :prefix
  AND retired_at IS NULL
ORDER BY lower(description) = :q DESC, length(description), fdc_id
LIMIT :limit OFFSET :offset
""")


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


def params(q: str, limit: int, offset: int) -> dict[str, Any]:
    """SEARCH_SQL's parameters for an already-normalized q (PREFIX_SQL uses a subset of them)."""
    return {"q": q, "prefix": like_prefix(q), "tsq": tsquery(q), "limit": limit, "offset": offset}


def sql_for(q: str) -> TextClause:
    """The query search() runs for an already-normalized q."""
    return PREFIX_SQL if len(q) < MIN_FULL_SEARCH else SEARCH_SQL


def search(session: Session, q: str, limit: int, offset: int = 0) -> Sequence[RowMapping]:
    """`limit` foods for q, best first, skipping the best `offset`."""
    q = normalize(q)
    # Both statements run in the session's one transaction, which is what makes the threshold apply.
    session.execute(SET_THRESHOLD)
    return session.execute(sql_for(q), params(q, limit, offset)).mappings().all()


def portions_for(session: Session, fdc_ids: Iterable[int]) -> dict[int, list[FoodPortion]]:
    """Each food's portions, smallest first, in one query. Every id asked for is a key; a food with none has []."""
    by_food: dict[int, list[FoodPortion]] = {fdc_id: [] for fdc_id in fdc_ids}
    if not by_food:
        return by_food
    stmt = (
        select(FoodPortion)
        .where(FoodPortion.fdc_id.in_(by_food))
        .order_by(FoodPortion.fdc_id, FoodPortion.gram_weight, FoodPortion.id)
    )
    for portion in session.scalars(stmt):
        by_food[portion.fdc_id].append(portion)
    return by_food


def search_page(
    session: Session, q: str, limit: int, offset: int = 0
) -> tuple[Sequence[RowMapping], dict[int, list[FoodPortion]]]:
    """What the search endpoint reads: the ranked page (search) and its foods' portions (portions_for)."""
    rows = search(session, q, limit, offset)
    return rows, portions_for(session, [row["fdc_id"] for row in rows])


def get_food(session: Session, fdc_id: int) -> Food | None:
    """One food with every nutrient column, or None. A retired food is still found: logs reference it."""
    return session.get(Food, fdc_id)


def get_portions(session: Session, fdc_id: int) -> Sequence[FoodPortion]:
    """A food's portions, smallest first."""
    stmt = select(FoodPortion).where(FoodPortion.fdc_id == fdc_id).order_by(FoodPortion.gram_weight, FoodPortion.id)
    return session.scalars(stmt).all()
