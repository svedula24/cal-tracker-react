"""Time the food search SQL against the loaded database.

    uv run python scripts/bench_search.py            # p50/p95 per query, 50 runs each
    uv run python scripts/bench_search.py --n 200
    uv run python scripts/bench_search.py --explain  # also EXPLAIN (ANALYZE, BUFFERS) each query

Measures app.services.foods.search() over one SQLAlchemy session (one connection): the SQL
round trip only, not HTTP or JSON. Target: search p95 < 100 ms. The database must be migrated
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
from app.services.foods import SET_THRESHOLD, normalize, params, search, sql_for  # noqa: E402
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
LIMIT = 20
TARGET_MS = 100.0


def p95(samples: list[float]) -> float:
    return statistics.quantiles(samples, n=20, method="inclusive")[-1]


def time_query(session: Session, q: str, n: int) -> tuple[list[float], int]:
    rows = search(session, q, LIMIT, 0)  # warm-up, untimed
    session.rollback()  # ends the transaction, and with it the transaction-local threshold
    samples = []
    for _ in range(n):
        start = time.perf_counter()
        search(session, q, LIMIT, 0)
        session.rollback()
        samples.append((time.perf_counter() - start) * 1000)
    return samples, len(rows)


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
    args = parser.parse_args()
    if args.n < 2:
        parser.error("--n must be at least 2")

    print(f"search(session, q, {LIMIT}, 0) x {args.n} per query; SQL only (one connection, no HTTP)\n")
    print(f"{'query':<22}{'results':>8}{'p50 ms':>10}{'p95 ms':>10}")
    everything: list[float] = []
    engine = make_engine(database_url())
    with Session(engine) as session:
        for q in QUERIES:
            samples, count = time_query(session, q, args.n)
            everything += samples
            print(f"{q:<22}{count:>8}{statistics.median(samples):>10.2f}{p95(samples):>10.2f}")
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
