"""Import the food log from a Cal AI "Summary Report" PDF into food_logs.

    uv run python -m kalo.calai report.pdf --user <uuid> --tz America/Los_Angeles            # check only
    uv run python -m kalo.calai report.pdf --user <uuid> --tz America/Los_Angeles --write    # import

Needs `pdftotext` (poppler: `brew install poppler`). Reads DATABASE_URL (default: the docker-compose
database), which must be migrated to head.

Each entry becomes a custom log of 1 serving with the report's values (the report has no amounts and no
link to a USDA food), which the app shows as a hand-written entry. The report's times are local, so
--tz is required. Nothing is written unless every day's entries add up to the report's "Calories eaten".
An entry is skipped when the user already has a custom log with the same day, time and name (counting
repeats, and deleted logs too, so a deletion sticks): importing a newer all-time export adds only what is
new. Workouts, weight and profile pages are not imported.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import uuid
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, datetime
from zoneinfo import ZoneInfo

import psycopg

from .db import database_url, require_head

MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December"
DAY = re.compile(rf"^\s*({MONTHS}) (\d{{1,2}}), (\d{{4}})\s*$")
NUM = r"([\d,]+(?:\.\d+)?)"
# name, calories, protein, carbs, fat, fiber, sugar (g), sodium (mg), time. A long name wraps onto lines
# above and below this one, so the name here may be empty.
ROW = re.compile(
    rf"^\s*(?P<name>.*?)\s*{NUM}\s+{NUM}g\s+{NUM}g\s+{NUM}g\s+{NUM}g\s+{NUM}g\s+{NUM}mg\s*"
    r"(?P<time>\d{1,2}:\d{2}[ap]m)\s*$"
)
TOTAL = re.compile(r"^\s*TOTAL\s+Calories eaten:\s*([\d,]+)")
EXERCISE = re.compile(r"^\s*Exercise\s+Calories\s+Time taken")
FOODS = re.compile(r"^\s*Foods\s+Calories\b")  # a day's table header
# The running page header ("<Name>'s Report", "Start: … · End: …").
CHROME = re.compile(r"^\s*(.*'s Report\s*$|Start: \d)")


class ReportError(ValueError):
    """The report's text is not laid out as expected, or a day does not add up."""


@dataclass(frozen=True)
class Entry:
    name: str
    time: str  # as printed, e.g. "6:33pm"
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float
    fiber_g: float
    sugar_g: float
    sodium_mg: float


@dataclass
class Day:
    date: date
    entries: list[Entry] = field(default_factory=list)
    total: float | None = None  # the report's "Calories eaten"
    has_table: bool = False  # a "Foods" header followed the date: it is a day of the log, not a stray date


def _num(s: str) -> float:
    return float(s.replace(",", ""))


def _entry(block: list[str], day: date) -> Entry:
    """One entry from its lines: exactly one has the numbers; the name is every line's text, in order."""
    matches = [ROW.match(line) for line in block]
    rows = [m for m in matches if m]
    if len(rows) != 1:
        raise ReportError(f"{day}: expected one entry row in {block!r}")
    row = rows[0]
    name = " ".join(" ".join(m["name"] if m else line for line, m in zip(block, matches, strict=True)).split())
    if not name:
        raise ReportError(f"{day}: entry without a name: {block!r}")
    values = (_num(row.group(i)) for i in range(2, 9))
    return Entry(name, row["time"], *values)


def parse(lines: Iterable[str]) -> list[Day]:
    """Every day of the report's daily log (the text of `pdftotext -layout`). Raises ReportError."""
    days: list[Day] = []
    day: Day | None = None
    block: list[str] = []  # the lines of the current entry; entries are separated by blank lines
    in_exercise = False

    def flush() -> None:
        if block:
            day.entries.append(_entry(block, day.date))
            block.clear()

    def close() -> None:
        """Before the next date or the end: a day with a table needs its TOTAL; a lone date line is dropped."""
        if day and day.total is None:
            if day.has_table:
                raise ReportError(f"{day.date}: no TOTAL line")
            days.remove(day)

    for line in lines:
        line = line.rstrip("\n")
        if m := DAY.match(line):
            close()
            day = Day(datetime.strptime(f"{m[1]} {m[2]} {m[3]}", "%B %d %Y").date())
            days.append(day)
            block.clear()
            in_exercise = False
        elif day is None or day.total is not None:
            continue  # before the daily log, or between a TOTAL and the next day
        elif m := TOTAL.match(line):
            flush()
            day.total = _num(m[1])
        elif FOODS.match(line):
            flush()
            day.has_table = True
            in_exercise = False  # foods after a workout table, or a header repeated after a page break
        elif EXERCISE.match(line):
            flush()
            in_exercise = True  # workouts are not imported; they run until the day's TOTAL
        elif in_exercise or not day.has_table:
            continue  # a workout, or text under a date that has no table (not a day of the log)
        elif not line.strip() or CHROME.match(line):
            flush()
        else:
            block.append(line)
    close()
    for d in days:
        eaten = sum(e.calories for e in d.entries)
        if abs(eaten - d.total) > 0.5:
            raise ReportError(f"{d.date}: entries add up to {eaten:g} kcal, the report says {d.total:g}")
    return days


def logged_at(day: Day, entry: Entry, tz: ZoneInfo) -> datetime:
    # shortcut: in the hour repeated when DST ends, the report cannot say which 1:30am it was; both get the
    # first. A nonexistent spring-forward time is shifted by zoneinfo. A few entries a year at most.
    return datetime.strptime(f"{day.date} {entry.time.upper()}", "%Y-%m-%d %I:%M%p").replace(tzinfo=tz)


INSERT = """
INSERT INTO food_logs (id, user_id, fdc_id, log_date, logged_at, name, food_name, unit, quantity,
                       unit_calories, unit_protein_g, unit_carbs_g, unit_fat_g,
                       unit_fiber_g, unit_sugar_g, unit_sodium_mg, updated_at)
VALUES (gen_random_uuid(), %s, NULL, %s, %s, %s, NULL, 'serving', 1, %s, %s, %s, %s, %s, %s, %s, now())
"""
# The user's custom logs (deleted ones included) on the report's days, as (day, time, name).
EXISTING = """
SELECT log_date, logged_at, name FROM food_logs
WHERE user_id = %s AND fdc_id IS NULL AND unit = 'serving' AND log_date BETWEEN %s AND %s
"""


def write(days: list[Day], user_id: uuid.UUID, tz: ZoneInfo, url: str) -> int:
    """Insert every entry the user does not already have, in one transaction. Returns how many were new."""
    with psycopg.connect(url) as conn, conn.cursor() as cur:
        require_head(cur)
        # One import per user at a time: two concurrent runs would both see no existing logs.
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"calai:{user_id}",))
        cur.execute("SELECT 1 FROM users WHERE id = %s", (user_id,))
        if cur.fetchone() is None:
            raise ReportError(f"no user {user_id}")
        if not days:
            return 0
        cur.execute(EXISTING, (user_id, min(d.date for d in days), max(d.date for d in days)))
        have = Counter(cur.fetchall())
        new = []
        for d in days:
            for e in d.entries:
                key = (d.date, logged_at(d, e, tz), e.name)
                if have[key]:
                    have[key] -= 1  # already there (two identical entries need two existing logs)
                    continue
                new.append((user_id, d.date, key[1], e.name, e.calories, e.protein_g, e.carbs_g, e.fat_g,
                            e.fiber_g, e.sugar_g, e.sodium_mg))
        cur.executemany(INSERT, new)
        return len(new)


def pdf_text(path: str) -> list[str]:
    try:
        done = subprocess.run(["pdftotext", "-layout", path, "-"], capture_output=True, text=True, check=True)
    except FileNotFoundError:
        raise ReportError("pdftotext not found (brew install poppler)") from None
    except subprocess.CalledProcessError as e:
        raise ReportError(f"pdftotext could not read {path}: {e.stderr.strip()}") from None
    return done.stdout.splitlines()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m kalo.calai", description=__doc__.split("\n\n")[0])
    parser.add_argument("pdf")
    parser.add_argument("--user", required=True, type=uuid.UUID, help="users.id to log the entries under")
    parser.add_argument("--tz", required=True, type=ZoneInfo, help="the report's time zone, e.g. America/Los_Angeles")
    parser.add_argument("--write", action="store_true", help="import (default: parse and check only)")
    args = parser.parse_args(argv)
    try:
        days = parse(pdf_text(args.pdf))
        if not days:
            raise ReportError("no daily log found")
        count = sum(len(d.entries) for d in days)
        print(f"{len(days)} days, {count} entries, {days[0].date} to {days[-1].date}; every day adds up")
        if args.write:
            print(f"✓ {write(days, args.user, args.tz, database_url())} new entries ({count} in the report)")
        else:
            print("check only, nothing written; add --write to import")
    except ReportError as e:
        raise SystemExit(f"error: {e}; nothing written") from None
    return 0


if __name__ == "__main__":
    sys.exit(main())
