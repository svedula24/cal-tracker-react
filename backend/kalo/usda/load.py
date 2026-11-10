"""Load every USDA generic food into the `foods` table.

    uv run python -m kalo.usda.load

Reads DATABASE_URL (default: the docker-compose database). Applies
db/schema.sql (CREATE TABLE IF NOT EXISTS), then replaces the table's contents
in one transaction, so a rerun is a clean reload.
"""

from __future__ import annotations

import os
import sys
import time
from collections import Counter
from pathlib import Path

import psycopg

from .datasets import DATASETS, records
from .nutrients import FoodRow, RecordError, to_row

DEFAULT_URL = "postgresql://kalo:kalo@localhost:5432/kalo"
SCHEMA = Path(__file__).resolve().parents[2] / "db" / "schema.sql"


def read_rows() -> list[FoodRow]:
    """Every row to load. A record that cannot be mapped is reported, with every other one, and the load is refused."""
    rows: list[FoodRow] = []
    seen: set[int] = set()
    errors: dict[str, list[RecordError]] = {}  # release → the records that could not be mapped
    for dataset in DATASETS:
        started = time.monotonic()
        found = records(dataset)
        duplicates = 0
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
            rows.append(row)
        if bad:
            errors[dataset.release] = bad
        note = f", {duplicates} duplicate fdc_ids skipped" if duplicates else ""
        note += f", {len(bad)} could not be mapped" if bad else ""
        print(f"{dataset.release}: {len(found)} foods{note} ({time.monotonic() - started:.1f}s)")
    if errors:
        for release, bad in errors.items():
            print(f"{release}:", file=sys.stderr)
            for e in bad:
                print(f"  fdc_id {e.fdc_id}: {e.message}", file=sys.stderr)
        raise SystemExit(f"{sum(len(bad) for bad in errors.values())} records could not be mapped; nothing loaded")
    return rows


# Every constraint db/schema.sql declares, by Postgres's generated name. An existing table
# that lacks one predates a schema change: CREATE TABLE IF NOT EXISTS would silently keep it.
EXPECTED_CONSTRAINTS = frozenset(
    {
        "foods_pkey",
        "foods_data_type_check",
        "foods_calories_per_100g_check",
        "foods_protein_per_100g_check",
        "foods_carbs_per_100g_check",
        "foods_fat_per_100g_check",
    }
)


class SchemaOutOfDate(RuntimeError):
    """The existing foods table does not match db/schema.sql."""


def ensure_schema(cur: psycopg.Cursor) -> None:
    cur.execute(SCHEMA.read_text())
    cur.execute("SELECT conname FROM pg_constraint WHERE conrelid = 'foods'::regclass")
    missing = EXPECTED_CONSTRAINTS - {name for (name,) in cur.fetchall()}
    if missing:
        raise SchemaOutOfDate(
            f"the foods table predates db/schema.sql (missing {', '.join(sorted(missing))}); "
            "run DROP TABLE foods and load again"
        )


def load(rows: list[FoodRow], url: str) -> Counter[str]:
    columns = ", ".join(FoodRow.columns())
    with psycopg.connect(url) as conn, conn.cursor() as cur:
        ensure_schema(cur)
        cur.execute("TRUNCATE foods")
        with cur.copy(f"COPY foods ({columns}) FROM STDIN") as copy:
            for row in rows:
                copy.write_row(row.values())
        cur.execute("SELECT data_type, count(*) FROM foods GROUP BY data_type ORDER BY data_type")
        return Counter({data_type: n for data_type, n in cur.fetchall()})


def main() -> int:
    url = os.environ.get("DATABASE_URL", DEFAULT_URL)
    rows = read_rows()
    counts = load(rows, url)
    for data_type, n in counts.items():
        print(f"  {data_type}: {n}")
    print(f"✓ foods: {sum(counts.values())} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
