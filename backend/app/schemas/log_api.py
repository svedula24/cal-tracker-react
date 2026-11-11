"""Request and response models for the REST log endpoints (/api/v1/food-logs, /nutrition/daily, /foods/recent).

The row types themselves (`FoodLogRow`, `FoodLogOut`, `NutrientValues`) are the sync wire format, in
app/schemas/logs.py: these endpoints write through the same core as POST /api/v1/sync.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

from app.schemas.foods import FoodSearchItem
from app.schemas.logs import Amount, Day, FdcId, FoodLogOut, Name, NutrientValues, Quantity, Timestamp

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


class DailyNutrition(BaseModel):
    date: date
    totals: DayTotals
    unknown: UnknownCounts
    goal: GoalOut | None  # the goal in force that day: the latest one starting on or before it
    steps: int | None
    log_count: int


class RecentFood(FoodSearchItem):
    """A search item, plus when this user last logged the food and how much."""

    grams: float
    logged_at: datetime


class RecentFoodsResponse(BaseModel):
    foods: list[RecentFood]
