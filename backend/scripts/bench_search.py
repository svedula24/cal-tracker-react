"""Time what the search endpoint reads (the ranked page and its portions) against the loaded database.

    uv run python scripts/bench_search.py            # p50/p95 per query, 50 runs each
    uv run python scripts/bench_search.py --n 200
    uv run python scripts/bench_search.py --limit 50 # the page size the app asks for (default 20)
    uv run python scripts/bench_search.py --explain  # also EXPLAIN (ANALYZE, BUFFERS) each query

Measures app.services.foods.search_page() over one SQLAlchemy session (one connection): the two
queries the endpoint runs, the ranked search and the portions of the page's foods. SQL round
trips only, not HTTP or JSON. --explain covers the ranked query. Target: p95 < 100 ms. The database must be migrated
and loaded (see README).
"""

import argparse
import statistics
import sys
import time
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.orm import Session

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # backend/, so `import app, kalo` works

from app.db.session import make_engine  # noqa: E402
from app.services.foods import SET_THRESHOLD, normalize, params, search_page, sql_for  # noqa: E402
from kalo.db import database_url  # noqa: E402

QUERIES = [
    "banana",
    "apple",
    "chicken breast",
    "chicken bre",
    "brocoli",
    "chiken brest",
    "yoghurt",
    "milk 2%",
    "greek yogurt plain",
    "rice",
    "egg",
    "cheddar cheese",
    "s",
    "xyzzy",
]
LIMIT = 20  # --explain's page size, and the default for the timings
TARGET_MS = 100.0


def p95(samples: list[float]) -> float:
    return statistics.quantiles(samples, n=20, method="inclusive")[-1]


def time_query(session: Session, q: str, n: int, limit: int) -> tuple[list[float], int, int]:
    """n timings in ms, and how many foods and portions the page holds."""
    rows, portions = search_page(session, q, limit, 0)  # warm-up, untimed
    counts = len(rows), sum(len(p) for p in portions.values())
    session.rollback()  # ends the transaction, and with it the transaction-local threshold
    samples = []
    for _ in range(n):
        start = time.perf_counter()
        search_page(session, q, limit, 0)
        session.rollback()
        samples.append((time.perf_counter() - start) * 1000)
    return samples, *counts


def explain(session: Session, q: str) -> str:
    q = normalize(q)
    session.execute(SET_THRESHOLD)  # same transaction as the EXPLAIN, as in search()
    plan = session.execute(text("EXPLAIN (ANALYZE, BUFFERS) " + sql_for(q).text), params(q, LIMIT, 0)).all()
    session.rollback()
    return "\n".join(row[0] for row in plan)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--n", type=int, default=50, help="timed runs per query (default 50)")
    parser.add_argument("--explain", action="store_true", help="print EXPLAIN (ANALYZE, BUFFERS) per query")
    parser.add_argument("--limit", type=int, default=LIMIT, help=f"page size, 1 to 50 (default {LIMIT})")
    args = parser.parse_args()
    if args.n < 2:
        parser.error("--n must be at least 2")
    if not 1 <= args.limit <= 50:
        parser.error("--limit must be 1 to 50, as in the API")

    print(f"search_page(session, q, {args.limit}, 0) x {args.n} per query: ranked search + the page's portions;")
    print("SQL only (one connection, no HTTP)\n")
    print(f"{'query':<22}{'foods':>6}{'portions':>10}{'p50 ms':>10}{'p95 ms':>10}")
    everything: list[float] = []
    engine = make_engine(database_url())
    with Session(engine) as session:
        for q in QUERIES:
            samples, foods, portions = time_query(session, q, args.n, args.limit)
            everything += samples
            print(f"{q:<22}{foods:>6}{portions:>10}{statistics.median(samples):>10.2f}{p95(samples):>10.2f}")
        overall = p95(everything)
        verdict = "PASS" if overall < TARGET_MS else "FAIL"
        print(f"\noverall p95 {overall:.2f} ms (target < {TARGET_MS:.0f} ms): {verdict}")

        if args.explain:
            for q in QUERIES:
                print(f"\n--- EXPLAIN {q!r}\n{explain(session, q)}")
    engine.dispose()
    return 0 if overall < TARGET_MS else 1


if __name__ == "__main__":
    sys.exit(main())
