"""Request and response models for the REST log endpoints (/api/v1/food-logs, /nutrition/daily, /foods/recent,
/goals, /daily-activity).

The row types themselves (`FoodLogRow`, `FoodLogOut`, `NutrientValues`) are the sync wire format, in
app/schemas/logs.py: these endpoints write through the same core as POST /api/v1/sync.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.foods import FoodSearchItem
from app.schemas.logs import (
    Amount,
    Day,
    DayType,
    FdcId,
    FiniteNumber,
    FoodLogOut,
    GoalSource,
    Name,
    NutrientValues,
    Quantity,
    Steps,
    Timestamp,
)

# Amount, Quantity, Name, Day and Timestamp are the wire format's own types, so a value these
# endpoints accept is one the core accepts: finite, in range, timestamps with a zone.


class FoodLogCreate(BaseModel):
    """A `FoodLogRow` in which only `quantity`, and either `fdc_id` or `name` + `values`, are required.

    With an `fdc_id`, whatever is left out is taken from the `foods` row; without one it is a custom entry.
    """

    id: uuid.UUID | None = None
    fdc_id: FdcId | None = None
    quantity: Quantity
    unit: Literal["g", "serving"] | None = None  # default: 'g' with an fdc_id, else 'serving'
    log_date: Day | None = None  # default: today in the user's timezone
    logged_at: Timestamp | None = None  # default: now
    name: Name | None = None
    food_name: Name | None = None
    values: NutrientValues | None = None
    food_values: NutrientValues | None = None
    updated_at: Timestamp | None = None  # default: now


class NutrientPatch(BaseModel):
    """Any subset of the nutrients. A key that is left out keeps its stored value; 0 is a value.

    Only fiber, sugar and sodium may be set to null ("not reported"). The defaults are never
    validated, so `None` here only ever means "not sent": read the model with `exclude_unset`.
    """

    model_config = ConfigDict(extra="forbid")

    calories: Amount = None  # type: ignore[assignment]
    protein_g: Amount = None  # type: ignore[assignment]
    carbs_g: Amount = None  # type: ignore[assignment]
    fat_g: Amount = None  # type: ignore[assignment]
    fiber_g: Amount | None = None
    sugar_g: Amount | None = None
    sodium_mg: Amount | None = None


class FoodLogPatch(BaseModel):
    """The fields of a log that may be edited here. Anything else in the body (unit, fdc_id, …) is a 422.

    As in NutrientPatch, a default of None means "not sent"; an explicit null is refused.
    """

    model_config = ConfigDict(extra="forbid")

    name: Name = None  # type: ignore[assignment]
    quantity: Quantity = None  # type: ignore[assignment]
    log_date: Day = None  # type: ignore[assignment]
    logged_at: Timestamp = None  # type: ignore[assignment]
    values: NutrientPatch = None  # type: ignore[assignment]


class FoodLogList(BaseModel):
    logs: list[FoodLogOut]


class GoalOut(BaseModel):
    """A `GoalRow` without its sync fields."""

    model_config = ConfigDict(from_attributes=True)

    effective_date: date
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float
    fiber_g: float
    sugar_g: float
    sodium_mg: float
    steps: int
    goal: Literal["lose", "maintain", "gain"]
    source: GoalSource
    workout_kcal: float
    active_rest_kcal: float


class GoalPut(BaseModel):
    """PUT /api/v1/goals/{effective_date}: the whole goal (it replaces a stored one). Unknown keys are a 422."""

    model_config = ConfigDict(extra="forbid")

    calories: Amount
    protein_g: Amount
    carbs_g: Amount
    fat_g: Amount
    fiber_g: Amount
    sugar_g: Amount
    sodium_mg: Amount
    steps: Steps
    goal: Literal["lose", "maintain", "gain"]
    source: GoalSource = "manual"
    workout_kcal: Amount = 0
    active_rest_kcal: Amount = 0


class Activity(BaseModel):
    """A day's activity. `workout_kcal`: that day's workout calories, whatever the day type; None =
    the goal's amount for the day type."""

    steps: int
    day_type: DayType | None
    workout_kcal: float | None


class DailyActivityPut(BaseModel):
    """PUT /api/v1/daily-activity/{activity_date}: the whole day (it replaces a stored one), so a field
    left out is cleared."""

    model_config = ConfigDict(extra="forbid")

    steps: Steps
    day_type: DayType | None = None
    workout_kcal: Amount | None = None


class DailyActivityOut(Activity):
    activity_date: date


class SuggestIn(BaseModel):
    """POST /api/v1/goals/suggest. Used for the answer only: none of it is stored."""

    model_config = ConfigDict(extra="forbid")

    sex: Literal["male", "female"]
    # The ranges are shared/targets-fixtures.json's (`_rules`): outside them is invalid input.
    age: Annotated[FiniteNumber, Field(ge=10, le=120)]  # years
    height_cm: Annotated[FiniteNumber, Field(ge=50, le=300)]
    weight_kg: Annotated[FiniteNumber, Field(ge=20, le=500)]
    goal: Literal["lose", "maintain", "gain"]


class SuggestOut(BaseModel):
    """The suggested daily targets (whole numbers), to put in a goal with source 'computed'."""

    calories: int
    protein_g: int
    carbs_g: int
    fat_g: int


class DayTotals(BaseModel):
    """A day's sums. A log that does not report fiber, sugar or sodium adds 0 to that sum (see `unknown`)."""

    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float
    fiber_g: float
    sugar_g: float
    sodium_mg: float


class UnknownCounts(BaseModel):
    """How many of the day's logs do not report each nutrient."""

    fiber_g: int
    sugar_g: int
    sodium_mg: int


class DayTarget(DayTotals):
    """The day's targets: the goal's, with `adjustment_kcal` (steps and the day type) added to calories
    and a quarter of it to carbs_g (app/services/targets.py)."""

    adjustment_kcal: float


class DailyNutrition(BaseModel):
    date: date
    totals: DayTotals
    unknown: UnknownCounts
    goal: GoalOut | None  # the goal in force that day: the latest one starting on or before it
    steps: int | None  # = activity.steps; kept for clients from before `activity`
    activity: Activity | None  # None when the day has no activity row
    target: DayTarget | None  # None when no goal is in force
    remaining: DayTotals | None  # target - totals, negative when over; None when no goal is in force
    log_count: int


class RecentFood(FoodSearchItem):
    """A search item, plus when this user last logged the food and how much."""

    grams: float
    logged_at: datetime


class RecentFoodsResponse(BaseModel):
    foods: list[RecentFood]
