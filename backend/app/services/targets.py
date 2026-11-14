"""A day's targets, what is left of them, and suggested goals. Pure: no database, no I/O.

The rules, and the cases both this module and the app's copy are tested against, are in
shared/targets-fixtures.json (repo root): change them there first.

- A goal row holds the baseline targets. The day's target adds `adjustment_kcal` to calories and
  adjustment_kcal / 4 to carbs (the extra energy is eaten as carbohydrate); the rest is unchanged.
  adjustment_kcal = round(steps × STEP_KCAL) + the day's kcal: the day row's own workout_kcal when it
  is not None (0 is a value), whatever the day type; else the goal's workout_kcal on a workout day,
  its active_rest_kcal on an active-rest day, 0 otherwise. No activity row, or no steps, is 0 steps.
- `suggest`: Mifflin–St Jeor BMR × ACTIVITY × the goal's factor; protein PROTEIN_G_PER_KG per kg; fat
  FAT_SHARE of the calories; carbs the rest. Calories, fat and carbs are never below 0. Nothing it is
  given is stored.
- Rounding is half away from zero (`round_half_away`), not Python's banker's `round()`.
"""

from __future__ import annotations

from collections.abc import Mapping
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Literal

NUTRIENTS = ("calories", "protein_g", "carbs_g", "fat_g", "fiber_g", "sugar_g", "sodium_mg")
STEP_KCAL = 0.035  # kcal per step
KCAL_PER_G_CARBS = 4
KCAL_PER_G_PROTEIN = 4
KCAL_PER_G_FAT = 9
ACTIVITY = 1.2  # sedentary: steps and workouts are added per day instead
GOAL_FACTOR = {"lose": 0.8, "maintain": 1.0, "gain": 1.1}
PROTEIN_G_PER_KG = 1.8
FAT_SHARE = 0.25

Sex = Literal["male", "female"]
Goal = Literal["lose", "maintain", "gain"]


def round_half_away(value: float) -> int:
    """Rounds to the nearest integer, a half away from zero (2.5 -> 3, -2.5 -> -3).

    Through Decimal, which holds the float exactly, so a value just under a half is never pushed over
    it by the addition `floor(x + 0.5)` would do.
    """
    return int(Decimal(value).to_integral_value(rounding=ROUND_HALF_UP))


def adjustment_kcal(goal: Mapping[str, Any], activity: Mapping[str, Any] | None) -> float:
    """What the day's activity adds to the goal's calories. `activity`: the day's `steps`, `day_type`
    and `workout_kcal` (each may be None), or None when the day has no activity row."""
    activity = activity or {}
    day_kcal = activity.get("workout_kcal")
    if day_kcal is None:
        by_day_type = {"workout": goal["workout_kcal"], "active_rest": goal["active_rest_kcal"]}
        day_kcal = by_day_type.get(activity.get("day_type") or "", 0)
    return round_half_away((activity.get("steps") or 0) * STEP_KCAL) + day_kcal


def day_target(goal: Mapping[str, Any], activity: Mapping[str, Any] | None) -> dict[str, float]:
    """The day's seven targets and `adjustment_kcal`. `goal` has the seven nutrients, `workout_kcal`
    and `active_rest_kcal` (wire names); `activity` as in `adjustment_kcal`."""
    adjustment = adjustment_kcal(goal, activity)
    target = {nutrient: goal[nutrient] for nutrient in NUTRIENTS}
    target["calories"] += adjustment
    target["carbs_g"] += adjustment / KCAL_PER_G_CARBS
    return {**target, "adjustment_kcal": adjustment}


def remaining(target: Mapping[str, float], totals: Mapping[str, float]) -> dict[str, float]:
    """Target minus what was eaten, per nutrient. Negative when the day went over."""
    return {nutrient: target[nutrient] - totals[nutrient] for nutrient in NUTRIENTS}


def suggest(sex: Sex, age: float, height_cm: float, weight_kg: float, goal: Goal) -> dict[str, int]:
    """Suggested calories, protein, carbs and fat (whole numbers) for the person described."""
    bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age + (5 if sex == "male" else -161)
    calories = max(0, round_half_away(bmr * ACTIVITY * GOAL_FACTOR[goal]))
    protein_g = round_half_away(PROTEIN_G_PER_KG * weight_kg)
    fat_g = max(0, round_half_away(FAT_SHARE * calories / KCAL_PER_G_FAT))
    rest = calories - KCAL_PER_G_PROTEIN * protein_g - KCAL_PER_G_FAT * fat_g
    carbs_g = max(0, round_half_away(rest / KCAL_PER_G_CARBS))
    return {"calories": calories, "protein_g": protein_g, "carbs_g": carbs_g, "fat_g": fat_g}
