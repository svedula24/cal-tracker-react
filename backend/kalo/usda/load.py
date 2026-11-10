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
from .nutrients import FoodRow, to_row

DEFAULT_URL = "postgresql://kalo:kalo@localhost:5432/kalo"
SCHEMA = Path(__file__).resolve().parents[2] / "db" / "schema.sql"


def read_rows() -> list[FoodRow]:
    rows: list[FoodRow] = []
    seen: set[int] = set()
    for dataset in DATASETS:
        started = time.monotonic()
        found = records(dataset)
        duplicates = 0
        for record in found:
            row = to_row(record)
            if row.fdc_id in seen:  # the three datasets should not overlap; the first wins
                duplicates += 1
                continue
            seen.add(row.fdc_id)
            rows.append(row)
        note = f", {duplicates} duplicate fdc_ids skipped" if duplicates else ""
        print(f"{dataset.release}: {len(found)} foods{note} ({time.monotonic() - started:.1f}s)")
    return rows


def load(rows: list[FoodRow], url: str) -> Counter[str]:
    columns = ", ".join(FoodRow.columns())
    with psycopg.connect(url) as conn, conn.cursor() as cur:
        cur.execute(SCHEMA.read_text())
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
