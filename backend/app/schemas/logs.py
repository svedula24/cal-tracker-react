"""The sync wire format: the rows a device pushes and pulls (POST /api/v1/sync), also used by the REST log routes.

The row models validate what a client sends, so a bad row is refused here and never reaches a CHECK
constraint (an IntegrityError would abort the request's transaction). What they refuse:
- a number that is not a JSON number, is NaN or ±Infinity, is negative, or is above MAX_NUMBER
  (a total is value × quantity: the cap keeps it finite); a quantity that is not > 0;
- a timestamp without a zone, or a date or timestamp outside MIN_YEAR..MAX_YEAR (or sent as a number);
- an empty or blank name, a name over MAX_NAME characters or with a NUL (Postgres cannot store one);
- unit 'serving' together with an fdc_id (a database food is logged in grams).
Unknown keys are ignored. Rows built from the database (`*_row`, `food_log_out` in the services) are
made with `model_construct`, so reading never fails on a stored value.

In a SyncRequest the rows are plain objects: each is validated on its own (app/services/sync.py), so
one bad row is reported in `rejected` and the rest of the batch is applied. Only a malformed envelope is a 422.
"""

from __future__ import annotations

import math
import uuid
from datetime import date
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, AwareDatetime, BaseModel, BeforeValidator, ConfigDict, Field, model_validator
from pydantic_core import PydanticCustomError

MAX_SYNC_ROWS = 500  # rows in one request (all tables together), and rows in one pulled page
MAX_NUMBER = 1e9
MAX_NAME = 500
MIN_YEAR, MAX_YEAR = 1900, 2200
MAX_INT = 2**31 - 1  # INTEGER columns (steps)
MAX_BIGINT = 2**63 - 1

TABLES = ("food_logs", "saved_foods", "goals", "daily_activity")
# daily_steps: the name an app from before daily_activity pushes its days under (key log_date). It is
# still accepted on push, and a rejection of one of those rows names it; a pull never returns it.
TableName = Literal["food_logs", "saved_foods", "goals", "daily_activity", "daily_steps"]


def _number(value: Any) -> Any:
    """Only a real, finite JSON number: not true/false, not "12", not NaN (which json.loads accepts)."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise PydanticCustomError("not_a_number", "must be a number")
    try:
        finite = math.isfinite(value)
    except OverflowError:  # an integer too large for a float
        finite = False
    if not finite:
        raise PydanticCustomError("not_finite", "must be a finite number")
    return value


def _not_a_number(value: Any) -> Any:
    """Dates and timestamps are strings on the wire (Pydantic would read a number as a Unix time)."""
    if isinstance(value, bool | int | float):
        raise PydanticCustomError("not_a_date", "must be an ISO 8601 string")
    return value


def _sane_year(value: date) -> date:
    if not MIN_YEAR <= value.year <= MAX_YEAR:
        raise PydanticCustomError("out_of_range", "year out of range")
    return value


def _text(value: str) -> str:
    if "\x00" in value:
        raise PydanticCustomError("nul", "must not contain a NUL character")
    return value


def _not_blank(value: str) -> str:
    if not value.strip():
        raise PydanticCustomError("blank", "must not be blank")
    return value


FiniteNumber = Annotated[float, BeforeValidator(_number)]
Amount = Annotated[float, BeforeValidator(_number), Field(ge=0, le=MAX_NUMBER)]
Quantity = Annotated[float, BeforeValidator(_number), Field(gt=0, le=MAX_NUMBER)]
Steps = Annotated[int, Field(strict=True, ge=0, le=MAX_INT)]
FdcId = Annotated[int, Field(strict=True, ge=0, le=MAX_BIGINT)]
Day = Annotated[date, BeforeValidator(_not_a_number), AfterValidator(_sane_year)]
Timestamp = Annotated[AwareDatetime, BeforeValidator(_not_a_number), AfterValidator(_sane_year)]
Name = Annotated[str, Field(strict=True, min_length=1, max_length=MAX_NAME), AfterValidator(_text)]
GoalSource = Literal["computed", "manual"]
DayType = Literal["workout", "active_rest", "rest"]


class NutrientValues(BaseModel):
    """Per 100 g (unit 'g') or per serving. null fiber/sugar/sodium = not reported (the app shows 0)."""

    calories: Amount
    protein_g: Amount
    carbs_g: Amount
    fat_g: Amount
    fiber_g: Amount | None = None
    sugar_g: Amount | None = None
    sodium_mg: Amount | None = None


class FoodLogRow(BaseModel):
    id: uuid.UUID  # made by the client
    fdc_id: FdcId | None = None  # None = custom entry
    log_date: Day  # the local day eaten
    logged_at: Timestamp
    name: Annotated[Name, AfterValidator(_not_blank)]  # user-editable
    food_name: Name | None = None  # the database name; None for a custom entry
    unit: Literal["g", "serving"]
    quantity: Quantity  # grams, or servings
    values: NutrientValues  # the entry's own
    food_values: NutrientValues | None = None  # the database food's per 100 g when logged
    updated_at: Timestamp  # the client's edit time
    deleted_at: Timestamp | None = None

    @model_validator(mode="after")
    def _database_food_is_in_grams(self) -> FoodLogRow:
        if self.fdc_id is not None and self.unit != "g":
            raise PydanticCustomError("serving_with_fdc_id", "a database food (fdc_id) is logged in grams")
        return self


class FoodLogOut(FoodLogRow):
    """A stored log: the row, the totals for its quantity (generated columns) and its `rev`."""

    totals: NutrientValues
    rev: int


class SavedFoodRow(BaseModel):
    fdc_id: FdcId
    saved_at: Timestamp
    updated_at: Timestamp
    deleted_at: Timestamp | None = None


class GoalRow(BaseModel):
    effective_date: Day
    calories: Amount
    protein_g: Amount
    carbs_g: Amount
    fat_g: Amount
    fiber_g: Amount
    sugar_g: Amount
    sodium_mg: Amount
    steps: Steps
    goal: Literal["lose", "maintain", "gain"]
    updated_at: Timestamp
    deleted_at: Timestamp | None = None
    # Added later: a row from an app that does not send them still syncs, with these defaults.
    source: GoalSource = "manual"
    workout_kcal: Amount = 0  # added to the day's calories on a workout day
    active_rest_kcal: Amount = 0  # on an active-rest day


class DailyActivityRow(BaseModel):
    activity_date: Day
    steps: Steps
    updated_at: Timestamp
    deleted_at: Timestamp | None = None
    # Added later; None is also what a row from an app that does not send them gets.
    day_type: DayType | None = None  # None = not said
    workout_kcal: Amount | None = None  # that day's workout calories, whatever the day type; None = the goal's


# A deletion needs only the key, `updated_at` and `deleted_at`. A pushed row whose `deleted_at` is
# set is read as one of these: whatever else it carries is ignored (and not validated).
class Tombstone(BaseModel):
    updated_at: Timestamp
    deleted_at: Timestamp


class FoodLogTombstone(Tombstone):
    id: uuid.UUID


class SavedFoodTombstone(Tombstone):
    fdc_id: FdcId


class GoalTombstone(Tombstone):
    effective_date: Day


class DailyActivityTombstone(Tombstone):
    activity_date: Day


RawRow = dict[str, Any]


class SyncPush(BaseModel):
    """The rows a client pushes, per table, not yet validated (see the module docstring).
    A table this server does not know is a 422, not silently dropped."""

    model_config = ConfigDict(extra="forbid")

    food_logs: list[RawRow] = []
    saved_foods: list[RawRow] = []
    goals: list[RawRow] = []
    daily_activity: list[RawRow] = []
    daily_steps: list[RawRow] = []  # the legacy name of daily_activity, rows keyed by log_date

    def row_count(self) -> int:
        tables = (self.food_logs, self.saved_foods, self.goals, self.daily_activity, self.daily_steps)
        return sum(len(rows) for rows in tables)


class SyncRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cursor: Annotated[int, Field(strict=True, ge=0, le=MAX_BIGINT)] | None = None  # None = from the start
    changes: SyncPush = SyncPush()


class SyncChanges(BaseModel):
    food_logs: list[FoodLogRow] = []
    saved_foods: list[SavedFoodRow] = []
    goals: list[GoalRow] = []
    daily_activity: list[DailyActivityRow] = []


class Rejected(BaseModel):
    table: TableName
    key: str  # the row's key as the client sent it ("" when it sent none)
    reason: str


class SyncResponse(BaseModel):
    cursor: int
    has_more: bool
    changes: SyncChanges
    rejected: list[Rejected]


def rejection_reason(errors: list[dict[str, Any]]) -> str:
    """A short reason from a ValidationError's `errors()`: `serving_with_fdc_id`, or `invalid <field>`
    (`invalid quantity`, `invalid values.calories`). Never echoes what the client sent."""
    first = errors[0]
    if first["type"] == "serving_with_fdc_id":
        return first["type"]
    where = ".".join(str(part) for part in first["loc"])
    return f"invalid {where}" if where else "invalid row"
