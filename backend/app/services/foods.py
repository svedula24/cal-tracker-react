"""Food search and lookup: pure helpers that turn a query into SQL parameters, and the queries themselves.

One search query, ranked in tiers: the exact description, then descriptions that start with the
query, then full-text matches (every word, the last as a prefix), then misspellings (trigram word
similarity). The WHERE clause uses the exact expressions of the indexes in the baseline migration.
The order is total (it ends in fdc_id), so limit/offset pages are stable.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
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
WHERE lower(description) LIKE :prefix
   OR to_tsvector('english', description) @@ to_tsquery('english', CAST(:tsq AS text))
   OR :q <% lower(description)
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


def get_food(session: Session, fdc_id: int) -> Food | None:
    """One food with every nutrient column, or None."""
    return session.get(Food, fdc_id)


def get_portions(session: Session, fdc_id: int) -> Sequence[FoodPortion]:
    """A food's portions, smallest first."""
    stmt = select(FoodPortion).where(FoodPortion.fdc_id == fdc_id).order_by(FoodPortion.gram_weight, FoodPortion.id)
    return session.scalars(stmt).all()
