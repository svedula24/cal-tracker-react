"""The Cal AI report import (kalo/calai.py): parsing the report's text, and writing it to food_logs."""

import subprocess
import uuid
from datetime import date
from zoneinfo import ZoneInfo

import psycopg
import pytest

from kalo.calai import ReportError, parse, pdf_text, write

# The shape of `pdftotext -layout` on a Cal AI report (made-up entries): a summary page, then one
# table per day. Long names wrap above and below the numbers; page headers can fall inside a day.
REPORT = """\
   Weight History
   158.5 lbs                                                                                       January 13, 2026

   Summary for January 7 - 9, 2026                4696      398g    420g    156g    56g     121g   6675mg

                                                    January 7, 2026

  Foods                                 Calories     Protein      Carbs     Fat    Fiber    Sugar    Sodium     Time

  Cooked Quinoa                              229             8g    42g       3g       4g      0g     314mg    6:33pm

  Tofu, Quinoa, Broccoli, Black
                                             537         30g       73g      16g       1g       1g      11mg   6:33pm
  Olives, Banana Peppers Meal

  TOTAL                               Calories eaten: 766              Calories burned: 0    Net (eaten-burned): 766
Alex Example's Report
Start: 01/07/2026 · End: 11/13/2026

                                                    January 8, 2026

  Foods                                 Calories     Protein      Carbs     Fat    Fiber    Sugar    Sodium     Time

  Teriyaki Chicken                           750         45g       85g       22g       0g      14g   1,053mg 12:28pm
Alex Example's Report
Start: 01/07/2026 · End: 11/13/2026

  Kit Kat                                     76             1g     14g     6g        1g      12g      15mg   2:18pm

  Exercise                              Calories                    Time taken                                   Time

  Weight lifting                             233                          60 mins                             1:06am

  TOTAL                               Calories eaten: 826           Calories burned: 233     Net (eaten-burned): 593
"""


def test_every_day_and_entry_is_parsed():
    days = parse(REPORT.splitlines())

    assert [d.date for d in days] == [date(2026, 1, 7), date(2026, 1, 8)]
    first, second = days
    meal_name = "Tofu, Quinoa, Broccoli, Black Olives, Banana Peppers Meal"  # wrapped above and below the numbers
    assert [e.name for e in first.entries] == ["Cooked Quinoa", meal_name]
    meal = first.entries[1]
    assert (meal.time, meal.calories, meal.protein_g, meal.carbs_g, meal.fat_g) == ("6:33pm", 537, 30, 73, 16)
    assert (meal.fiber_g, meal.sugar_g, meal.sodium_mg) == (1, 1, 11)
    # The page header between entries is not part of a name; the workout is not an entry.
    assert [e.name for e in second.entries] == ["Teriyaki Chicken", "Kit Kat"]
    assert second.entries[0].sodium_mg == 1053


def test_a_date_line_without_a_table_is_not_a_day():
    trailing = "\n   Body Stats\n\n                         January 13, 2026\n\n   158.5 lbs\n"
    days = parse((REPORT.replace("   Weight History", "   January 5, 2026\n   Weight History") + trailing).splitlines())
    assert [d.date for d in days] == [date(2026, 1, 7), date(2026, 1, 8)]


def test_foods_after_a_workout_table_are_entries():
    foods_header = next(line for line in REPORT.splitlines() if line.lstrip().startswith("Foods"))
    workout = next(line for line in REPORT.splitlines() if line.lstrip().startswith("Exercise"))
    lifting = next(line for line in REPORT.splitlines() if "Weight lifting" in line)
    second_day = REPORT.index("January 8, 2026")
    head, tail = REPORT[:second_day], REPORT[second_day:]
    tail = tail.replace(foods_header, f"{workout}\n\n{lifting}\n\n{foods_header}", 1)

    days = parse((head + tail).splitlines())

    assert [e.name for e in days[1].entries] == ["Teriyaki Chicken", "Kit Kat"]


def test_a_day_that_does_not_add_up_is_refused():
    with pytest.raises(ReportError, match=r"2026-01-07: entries add up to 766 kcal, the report says 767"):
        parse(REPORT.replace("Calories eaten: 766", "Calories eaten: 767").splitlines())


def test_a_line_that_is_not_an_entry_is_refused():
    with pytest.raises(ReportError, match="expected one entry row"):  # Kit Kat's row without its time
        parse(REPORT.replace("      15mg   2:18pm", "      15mg").splitlines())


def test_a_day_without_a_total_is_refused():
    with pytest.raises(ReportError, match="2026-01-07: no TOTAL line"):
        parse([line for line in REPORT.splitlines() if "Calories eaten: 766" not in line])


@pytest.fixture
def user(migrated_url):
    with psycopg.connect(migrated_url) as conn:
        return conn.execute("INSERT INTO users DEFAULT VALUES RETURNING id").fetchone()[0]


def test_write_stores_custom_servings_once(migrated_url, user):
    days = parse(REPORT.splitlines())
    tz = ZoneInfo("America/Los_Angeles")

    assert write(days, user, tz, migrated_url) == 4
    assert write(days, user, tz, migrated_url) == 0  # the same report again adds nothing

    with psycopg.connect(migrated_url) as conn:
        got = conn.execute(
            "SELECT log_date, to_char(logged_at AT TIME ZONE 'America/Los_Angeles', 'HH24:MI'), name, fdc_id, unit,"
            " quantity, calories, sodium_mg FROM food_logs ORDER BY logged_at, name"
        ).fetchall()
    assert got[1] == (date(2026, 1, 7), "18:33", "Tofu, Quinoa, Broccoli, Black Olives, Banana Peppers Meal",
                      None, "serving", 1.0, 537.0, 11.0)
    assert [row[2] for row in got] == ["Cooked Quinoa", got[1][2], "Teriyaki Chicken", "Kit Kat"]


def test_a_newer_export_adds_only_new_entries_and_deletions_stick(migrated_url, user):
    tz = ZoneInfo("America/Los_Angeles")
    write(parse(REPORT.splitlines()), user, tz, migrated_url)
    with psycopg.connect(migrated_url) as conn:  # deleted in the app since the first import
        conn.execute("UPDATE food_logs SET deleted_at = now(), updated_at = now() WHERE name = 'Kit Kat'")
    # The newer export: Cooked Quinoa removed in Cal AI (shifting the entry after it), a second
    # identical Teriyaki Chicken added.
    newer = (REPORT.replace("  Cooked Quinoa                              229             8g    42g       3g       4g"
                            "      0g     314mg    6:33pm\n", "")
             .replace("Calories eaten: 766", "Calories eaten: 537")
             .replace("  Kit Kat ", "  Teriyaki Chicken                           750         45g       85g       22g"
                      "       0g      14g   1,053mg 12:28pm\n\n  Kit Kat ")
             .replace("Calories eaten: 826", "Calories eaten: 1576"))

    assert write(parse(newer.splitlines()), user, tz, migrated_url) == 1  # only the second Teriyaki Chicken

    with psycopg.connect(migrated_url) as conn:
        live = conn.execute("SELECT name, count(*) FROM food_logs WHERE deleted_at IS NULL GROUP BY name ORDER BY name")
        assert live.fetchall() == [("Cooked Quinoa", 1), ("Teriyaki Chicken", 2),
                                   ("Tofu, Quinoa, Broccoli, Black Olives, Banana Peppers Meal", 1)]


@pytest.mark.parametrize(
    ("error", "message"),
    [
        (FileNotFoundError("pdftotext"), r"pdftotext not found \(brew install poppler\)"),
        (subprocess.CalledProcessError(1, "pdftotext", stderr="Syntax Error: May not be a PDF file\n"),
         r"pdftotext could not read x\.pdf: Syntax Error: May not be a PDF file$"),
    ],
)
def test_pdftotext_failures_are_report_errors(monkeypatch, error, message):
    # Faked, so the test does not depend on poppler being installed (CI has no pdftotext).
    def run(*args, **kwargs):
        raise error

    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(ReportError, match=message):
        pdf_text("x.pdf")


def test_write_to_an_unknown_user_is_refused(migrated_url):
    with pytest.raises(ReportError, match="no user"):
        write(parse(REPORT.splitlines()), uuid.uuid4(), ZoneInfo("UTC"), migrated_url)
