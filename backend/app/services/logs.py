"""The log core shared by POST /api/v1/sync and the REST log routes: how one pushed row is applied.

Nothing here commits (see app/services/users.py): the route locks the user row first (`lock_user`),
calls these, and commits once.

Last write wins on `updated_at`, for every synced table (`write_row`):
- A row the server does not have is inserted; a deletion (tombstone) of a row it does not have is ignored.
- Otherwise the incoming row is applied when its `updated_at` is >= the stored one (a tie goes to
  the incoming row, so a replayed push is applied again and changes nothing). When it is older the
  stored row is kept and returned with applied = False: the caller sends it back as the winner.
- The stored row's being deleted or not plays no part: only `updated_at` decides. A newer live row
  brings a deleted row back; an older live row loses to a newer tombstone; a newer tombstone on a
  row that is already deleted moves its `updated_at` and `deleted_at`.
- A deletion changes `updated_at` and `deleted_at` only: the row keeps its data.
- An `updated_at` (or `deleted_at`) more than FUTURE_SLACK ahead of the server's clock is stored as
  now + FUTURE_SLACK, so a phone with a wrong clock cannot win for ever.
A row that is applied with nothing different from the stored one writes nothing (no UPDATE, no new `rev`).

food_logs also (`food_log_fields`):
- an id that exists under another user is rejected `not_found` and never read or overwritten;
- an `fdc_id` the server does not have becomes a custom entry (fdc_id, food_name, food_values NULL);
- for a known `fdc_id`, a missing food_name or food_values is taken from the foods row;
- only with `zero_means_unknown` (rows pushed through /sync: the app cannot tell "not reported"
  from 0): for a known `fdc_id`, a 0 for fiber, sugar or sodium is stored as NULL where the food's
  own column is NULL, in `unit_*` and in `food_*`. A REST client can tell, so its 0 is stored as 0.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.foods import Food
from app.models.user_data import FoodLog, User
from app.schemas.logs import FoodLogOut, FoodLogRow, FoodLogTombstone, NutrientValues

FUTURE_SLACK = timedelta(minutes=5)

NUTRIENTS = ("calories", "protein_g", "carbs_g", "fat_g", "fiber_g", "sugar_g", "sodium_mg")
OPTIONAL_NUTRIENTS = ("fiber_g", "sugar_g", "sodium_mg")
# wire name -> the food_logs snapshot column, and the foods column it is a copy of
FOOD_COLUMNS = {
    "calories": ("food_calories_per_100g", "calories_per_100g"),
    "protein_g": ("food_protein_per_100g", "protein_per_100g"),
    "carbs_g": ("food_carbs_per_100g", "carbs_per_100g"),
    "fat_g": ("food_fat_per_100g", "fat_per_100g"),
    "fiber_g": ("food_fiber_per_100g", "fiber_per_100g"),
    "sugar_g": ("food_sugar_per_100g", "sugar_per_100g"),
    "sodium_mg": ("food_sodium_mg_per_100g", "sodium_mg_per_100g"),
}


class LogRejected(Exception):
    """A row the core refuses. `reason` is short and safe to show the client (`not_found`, …)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def lock_user(session: Session, user_id: uuid.UUID) -> None:
    """Locks the user's row until the transaction ends: the first statement of every write transaction.

    One user's writes then run one after another, so their `rev` order is their commit order, and a
    sync can tell the rows it wrote from the rows that were there before.
    """
    session.execute(select(User.id).where(User.id == user_id).with_for_update())


def utc(value: datetime | None) -> datetime | None:
    return value.astimezone(UTC) if value is not None else None


def clamp_future(value: datetime, now: datetime) -> datetime:
    return min(value, now + FUTURE_SLACK)


def write_row(
    model: type,
    existing: Any | None,
    key: dict[str, Any],
    fields: dict[str, Any] | None,
    updated_at: datetime,
    deleted_at: datetime | None,
    now: datetime,
) -> tuple[Any | None, bool]:
    """Applies one pushed row of any synced table by the rules in the module docstring.

    `existing` is this user's stored row or None; `key` is the primary key of a new row (user_id
    included); `fields` is the row's data (unused for a deletion). Returns (stored row, applied);
    (None, False) for a deletion of a row the server never had. Touches no database: a stored row is
    changed in place for the caller's flush, and a new row is returned as a new object for the
    caller to insert (`session.add`, or one INSERT for a whole batch as sync does).
    """
    updated_at = clamp_future(updated_at, now)
    if deleted_at is not None:
        if existing is None:
            return None, False
        if updated_at < existing.updated_at:
            return existing, False
        existing.updated_at = updated_at
        existing.deleted_at = clamp_future(deleted_at, now)
        return existing, True
    if existing is None:
        return model(**key, **fields, updated_at=updated_at, deleted_at=None), True
    if updated_at < existing.updated_at:
        return existing, False
    for name, value in fields.items():
        setattr(existing, name, value)
    existing.updated_at = updated_at
    existing.deleted_at = None
    return existing, True


def food_log_fields(row: FoodLogRow, food: Food | None, zero_means_unknown: bool = False) -> dict[str, Any]:
    """The food_logs columns for a live row. `food` is the foods row of `row.fdc_id`, None when there is none."""
    fields: dict[str, Any] = {
        "fdc_id": food.fdc_id if food is not None else None,
        "log_date": row.log_date,
        "logged_at": row.logged_at,
        "name": row.name,
        "food_name": (row.food_name or food.description) if food is not None else None,
        "unit": row.unit,
        "quantity": row.quantity,
    }
    for nutrient in NUTRIENTS:
        log_column, food_column = FOOD_COLUMNS[nutrient]
        own = getattr(row.values, nutrient)
        if food is None:
            fields[f"unit_{nutrient}"] = own
            fields[log_column] = None
            continue
        current = getattr(food, food_column)
        snapshot = getattr(row.food_values, nutrient) if row.food_values is not None else current
        if zero_means_unknown and nutrient in OPTIONAL_NUTRIENTS and current is None:
            own = None if own == 0 else own
            snapshot = None if snapshot == 0 else snapshot
        fields[f"unit_{nutrient}"] = own
        fields[log_column] = snapshot
    return fields


def apply_food_log(
    user_id: uuid.UUID,
    row: FoodLogRow | FoodLogTombstone,
    existing: FoodLog | None,
    food: Food | None,
    now: datetime,
    *,
    zero_means_unknown: bool = False,
) -> tuple[FoodLog | None, bool]:
    """`write_row` for a food log whose stored row and food the caller has already looked up
    (sync looks them up for a whole batch). The caller has checked the id is not another user's."""
    deleted = row.deleted_at is not None
    fields = None if deleted else food_log_fields(row, food, zero_means_unknown)  # type: ignore[arg-type]
    key = {"id": row.id, "user_id": user_id}
    return write_row(FoodLog, existing, key, fields, row.updated_at, row.deleted_at, now)


def get_food_log(session: Session, user: User, log_id: uuid.UUID, include_deleted: bool = False) -> FoodLog | None:
    """This user's log with that id, or None: also None for another user's log."""
    stmt = select(FoodLog).where(FoodLog.id == log_id, FoodLog.user_id == user.id)
    if not include_deleted:
        stmt = stmt.where(FoodLog.deleted_at.is_(None))
    return session.execute(stmt).scalar_one_or_none()


def upsert_food_log(
    session: Session, user: User, row: FoodLogRow, *, zero_means_unknown: bool = False
) -> tuple[FoodLog, bool]:
    """Upserts one log for `user` by the rules in the module docstring. Flushes; does not commit.

    Returns (stored row, applied). applied False = the server's copy was newer and is returned
    unchanged. A row with `deleted_at` set is a deletion. Raises LogRejected("not_found") for an id
    that is another user's, and for a deletion of a log this user does not have.
    `zero_means_unknown`: see the module docstring (False for a client that can send null).
    """
    existing = get_food_log(session, user, row.id, include_deleted=True)
    if existing is None:
        if row.deleted_at is not None:
            raise LogRejected("not_found")
        # Only whether the id is taken: nothing of the other user's row is read.
        if session.execute(select(FoodLog.id).where(FoodLog.id == row.id)).first() is not None:
            raise LogRejected("not_found")
    food = None
    if row.deleted_at is None and row.fdc_id is not None:
        food = session.get(Food, row.fdc_id)
    log, applied = apply_food_log(
        user.id, row, existing, food, datetime.now(UTC), zero_means_unknown=zero_means_unknown
    )
    session.add(log)  # a new row; nothing to do for a stored one
    session.flush()
    return log, applied  # type: ignore[return-value]


def food_log_row_fields(log: FoodLog) -> dict[str, Any]:
    """A stored log's wire fields (see `food_log_row`, `food_log_out`)."""
    food_values = None
    if log.fdc_id is not None:
        food_values = NutrientValues.model_construct(**{n: getattr(log, FOOD_COLUMNS[n][0]) for n in NUTRIENTS})
    return {
        "id": log.id,
        "fdc_id": log.fdc_id,
        "log_date": log.log_date,
        "logged_at": utc(log.logged_at),
        "name": log.name,
        "food_name": log.food_name,
        "unit": log.unit,
        "quantity": log.quantity,
        "values": NutrientValues.model_construct(**{n: getattr(log, f"unit_{n}") for n in NUTRIENTS}),
        "food_values": food_values,
        "updated_at": utc(log.updated_at),
        "deleted_at": utc(log.deleted_at),
    }


def food_log_row(log: FoodLog) -> FoodLogRow:
    """A stored log as a wire row (what a pull returns)."""
    return FoodLogRow.model_construct(**food_log_row_fields(log))


def food_log_out(log: FoodLog) -> FoodLogOut:
    """A stored log with its totals and `rev`. After a write these are read back from the database
    (the totals are generated columns and `rev` is set by a trigger), so call it before the commit."""
    totals = NutrientValues.model_construct(**{n: getattr(log, n) for n in NUTRIENTS})
    return FoodLogOut.model_construct(**food_log_row_fields(log), totals=totals, rev=log.rev)
