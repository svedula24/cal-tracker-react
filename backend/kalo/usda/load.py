"""Load every USDA generic food, and its portions, into `foods` and `food_portions`.

    uv run alembic upgrade head
    uv run python -m kalo.usda.load

Reads DATABASE_URL (default: the docker-compose database). The schema belongs to
the Alembic migrations: the loader refuses a database that is not at their head,
then updates both tables in one transaction. Food logs and bookmarks reference foods,
so no food is ever deleted: one that a later release drops is kept and marked
`retired_at`, and a rerun with the same data changes no food row.
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


def load(rows: list[FoodRow], portions: list[Portion], url: str) -> tuple[Counter[str], int, int]:
    """Bring both tables up to date with `rows` and `portions`, in one transaction.

    A food in the load is inserted, or updated when a value changed (or it was retired); a food not
    in the load is kept and marked retired, with its portions, because logs and bookmarks reference it.
    Returns the current foods per data_type, their portion count, and how many foods this load retired.
    """
    loaded = {row.fdc_id for row in rows}
    strays = sorted({portion.fdc_id for portion in portions} - loaded)
    if strays:  # the foreign key would let these through for a retired food, and add to its portions
        raise ValueError(f"portions for foods that are not in the load: {strays[:10]}")
    columns = FoodRow.columns()
    listed = ", ".join(columns)
    values = [column for column in columns if column != "fdc_id"]
    with psycopg.connect(url) as conn, conn.cursor() as cur:
        require_head(cur)
        # Same column types as foods, so a REAL compares equal to the stored one; the key rejects a duplicate id.
        cur.execute("CREATE TEMP TABLE foods_stage (LIKE foods) ON COMMIT DROP")
        cur.execute("ALTER TABLE foods_stage ADD PRIMARY KEY (fdc_id)")
        with cur.copy(f"COPY foods_stage ({listed}) FROM STDIN") as copy:
            for row in rows:
                copy.write_row(row.values())
        # The WHERE skips a row that would not change, so an unchanged reload writes no food row or index entry.
        cur.execute(
            f"""
            INSERT INTO foods ({listed})
            SELECT {listed} FROM foods_stage
            ON CONFLICT (fdc_id) DO UPDATE
            SET ({", ".join(values)}, retired_at) = ({", ".join(f"EXCLUDED.{c}" for c in values)}, NULL)
            WHERE foods.retired_at IS NOT NULL
               OR ({", ".join(f"foods.{c}" for c in values)}) IS DISTINCT FROM
                  ({", ".join(f"EXCLUDED.{c}" for c in values)})
            """
        )
        cur.execute(
            """
            UPDATE foods SET retired_at = now()
            WHERE retired_at IS NULL
              AND NOT EXISTS (SELECT FROM foods_stage WHERE foods_stage.fdc_id = foods.fdc_id)
            """
        )
        retired = cur.rowcount
        # Portions carry no key of their own to match on, so those of the loaded foods are replaced.
        cur.execute("DELETE FROM food_portions WHERE fdc_id IN (SELECT fdc_id FROM foods_stage)")
        with cur.copy(f"COPY food_portions ({', '.join(Portion.columns())}) FROM STDIN") as copy:
            for portion in portions:
                copy.write_row(portion.values())
        cur.execute(
            "SELECT data_type, count(*) FROM foods WHERE retired_at IS NULL GROUP BY data_type ORDER BY data_type"
        )
        counts = Counter({data_type: n for data_type, n in cur.fetchall()})
        cur.execute("SELECT count(*) FROM food_portions JOIN foods USING (fdc_id) WHERE foods.retired_at IS NULL")
        return counts, cur.fetchone()[0], retired


def main() -> int:
    url = database_url()
    rows, portions = read_rows()
    counts, portion_count, retired = load(rows, portions, url)
    for data_type, n in counts.items():
        print(f"  {data_type}: {n}")
    print(f"✓ foods: {sum(counts.values())} current, {retired} retired by this load")
    without = len(rows) - len({portion.fdc_id for portion in portions})
    print(f"✓ food_portions: {portion_count} of current foods ({without} foods with none)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
