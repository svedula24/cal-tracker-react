"""Load every USDA generic food, and its portions, into `foods` and `food_portions`.

    uv run alembic upgrade head
    uv run python -m kalo.usda.load

Reads DATABASE_URL (default: the docker-compose database). The schema belongs to
the Alembic migrations: the loader refuses a database that is not at their head,
then replaces both tables' contents in one transaction, so a rerun is a clean reload.
"""

from __future__ import annotations

import sys
import time
from collections import Counter

import psycopg

from ..db import database_url, require_head
from .datasets import DATASETS, records
from .nutrients import FoodRow, RecordError, to_row
from .portions import Portion, portions_of


def read_rows() -> tuple[list[FoodRow], list[Portion]]:
    """Every food row to load, and the portions of those foods (a skipped food's portions are dropped).

    A record that cannot be mapped is reported, with every other one, and the load is refused.
    """
    rows: list[FoodRow] = []
    portions: list[Portion] = []
    seen: set[int] = set()
    errors: dict[str, list[RecordError]] = {}  # release → the records that could not be mapped
    for dataset in DATASETS:
        started = time.monotonic()
        found = records(dataset)
        duplicates = incomplete = 0
        bad: list[RecordError] = []
        for index, record in enumerate(found):
            try:
                row = to_row(record, index)
            except RecordError as e:
                bad.append(e)
                continue
            if row.fdc_id in seen:  # the three datasets should not overlap; the first wins
                duplicates += 1
                continue
            seen.add(row.fdc_id)
            if not row.complete:  # missing calories, protein, carbs or fat: not useful for tracking
                incomplete += 1
                continue
            rows.append(row)
            portions.extend(portions_of(record, row.fdc_id))
        if bad:
            errors[dataset.release] = bad
        note = f", {duplicates} duplicate fdc_ids skipped" if duplicates else ""
        note += f", {incomplete} without calories, protein, carbs and fat skipped" if incomplete else ""
        note += f", {len(bad)} could not be mapped" if bad else ""
        print(f"{dataset.release}: {len(found)} foods{note} ({time.monotonic() - started:.1f}s)")
    if errors:
        for release, bad in errors.items():
            print(f"{release}:", file=sys.stderr)
            for e in bad:
                print(f"  fdc_id {e.fdc_id}: {e.message}", file=sys.stderr)
        raise SystemExit(f"{sum(len(bad) for bad in errors.values())} records could not be mapped; nothing loaded")
    return rows, portions


def load(rows: list[FoodRow], portions: list[Portion], url: str) -> tuple[Counter[str], int]:
    """Replace the contents of both tables in one transaction. Returns foods per data_type and the portion count."""
    with psycopg.connect(url) as conn, conn.cursor() as cur:
        require_head(cur)
        cur.execute("TRUNCATE food_portions, foods RESTART IDENTITY")  # one statement: portions reference foods
        with cur.copy(f"COPY foods ({', '.join(FoodRow.columns())}) FROM STDIN") as copy:
            for row in rows:
                copy.write_row(row.values())
        with cur.copy(f"COPY food_portions ({', '.join(Portion.columns())}) FROM STDIN") as copy:
            for portion in portions:
                copy.write_row(portion.values())
        cur.execute("SELECT data_type, count(*) FROM foods GROUP BY data_type ORDER BY data_type")
        counts = Counter({data_type: n for data_type, n in cur.fetchall()})
        cur.execute("SELECT count(*) FROM food_portions")
        return counts, cur.fetchone()[0]


def main() -> int:
    url = database_url()
    rows, portions = read_rows()
    counts, portion_count = load(rows, portions, url)
    for data_type, n in counts.items():
        print(f"  {data_type}: {n}")
    print(f"✓ foods: {sum(counts.values())} rows")
    without = len(rows) - len({portion.fdc_id for portion in portions})
    print(f"✓ food_portions: {portion_count} rows ({without} foods with none)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
