"""app/services/targets.py against shared/targets-fixtures.json (repo root), the cases the app's copy
(tests/targets.test.mjs) is tested against too. No database."""

import json
from pathlib import Path

import pytest

from app.services.targets import day_target, remaining, round_half_away, suggest

FIXTURES = json.loads((Path(__file__).resolve().parents[2] / "shared" / "targets-fixtures.json").read_text())
TOLERANCE = 1e-9


def close(got: dict, expected: dict) -> bool:
    return got.keys() == expected.keys() and all(abs(got[k] - expected[k]) <= TOLERANCE for k in expected)


@pytest.mark.parametrize("case", FIXTURES["day_target"], ids=lambda case: case["name"])
def test_day_target(case):
    target = day_target(case["goal"], case["activity"])
    assert close(target, case["expected"]["target"]), target
    if case["totals"] is None:
        assert case["expected"]["remaining"] is None
    else:
        left = remaining(target, case["totals"])
        assert close(left, case["expected"]["remaining"]), left


@pytest.mark.parametrize("case", FIXTURES["suggest"], ids=lambda case: case["name"])
def test_suggest(case):
    got = suggest(**case["input"])
    assert got == case["expected"]
    assert all(type(value) is int for value in got.values())


@pytest.mark.parametrize(
    ("value", "rounded"),
    [(0.5, 1), (1.5, 2), (2.5, 3), (-0.5, -1), (-2.5, -3), (77.5, 78)]
    + [(2.4999999999999996, 2), (0.49999999999999994, 0)],  # just under a half: floor(x + 0.5) gets these wrong
)
def test_round_is_half_away_from_zero(value, rounded):
    assert round_half_away(value) == rounded


def test_every_fixture_section_is_covered():
    assert set(FIXTURES) == {"_rules", "day_target", "suggest"}
    assert FIXTURES["day_target"] and FIXTURES["suggest"]
