"""Creating, editing and deleting one food log, for the REST routes (/api/v1/food-logs) and the MCP tools.

Everything is written through the sync core (app/services/logs.py: `upsert_food_log`), so a log made
or changed here gets a new `rev` and reaches the phone on its next pull, and the same rules apply
(last write wins on `updated_at`). Each function locks the user row first and does not commit: the
caller commits once. A refusal is `NotFound` (no such log for this user) or `Invalid` (app/services/errors.py).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models.foods import Food
from app.models.user_data import FoodLog, User
from app.schemas.log_api import FoodLogCreate
from app.schemas.logs import FoodLogOut, FoodLogRow, rejection_reason
from app.services import foods as food_service
from app.services import log_queries
from app.services import logs as log_service
from app.services.errors import Invalid, NotFound

NOT_FOUND = "food log not found"


def food_per_100g(food: Food) -> dict[str, float | None]:
    """A foods row's nutrients under the wire names. The values are passed on as they were read.

    Calories, protein, carbs and fat are NOT NULL in `foods` (a food without one is never loaded), so
    only fiber, sugar and sodium can be None here, which the wire format allows.
    """
    return {
        "calories": food.calories_per_100g,
        "protein_g": food.protein_per_100g,
        "carbs_g": food.carbs_per_100g,
        "fat_g": food.fat_per_100g,
        "fiber_g": food.fiber_per_100g,
        "sugar_g": food.sugar_per_100g,
        "sodium_mg": food.sodium_mg_per_100g,
    }


def new_row(session: Session, user: User, body: FoodLogCreate, now: datetime) -> dict[str, Any]:
    """The full log row for a create request: what the client left out comes from `foods`, the user and `now`."""
    if body.fdc_id is not None:
        food = food_service.get_food(session, body.fdc_id)  # a retired food can still be logged by id
        if food is None:
            raise Invalid("unknown fdc_id")
        if body.unit == "serving":
            raise Invalid("a database food is logged in grams")
        per_100g = food_per_100g(food)
        described: dict[str, Any] = {
            "unit": "g",
            "name": body.name or food.description,
            "food_name": body.food_name or food.description,
            "values": body.values or per_100g,
            "food_values": body.food_values or per_100g,
        }
    else:
        if body.name is None or body.values is None:
            raise Invalid("a custom entry (no fdc_id) needs name and values")
        if body.food_name is not None or body.food_values is not None:
            raise Invalid("food_name and food_values belong to a database food (fdc_id)")
        described = {
            "unit": body.unit or "serving",
            "name": body.name,
            "food_name": None,
            "values": body.values,
            "food_values": None,
        }
    return {
        "id": body.id or uuid.uuid4(),
        "fdc_id": body.fdc_id,
        "log_date": body.log_date or log_queries.local_date(user, now),
        "logged_at": body.logged_at or now,
        "quantity": body.quantity,
        "updated_at": body.updated_at or now,
        "deleted_at": None,
        **described,
    }


def stored_row(log: FoodLog) -> dict[str, Any]:
    """A stored log as a wire row, to change and send back through the core."""
    return log_service.food_log_out(log).model_dump(exclude={"totals", "rev"})


def write(session: Session, user: User, row: dict[str, Any]) -> FoodLog:
    """Upserts `row` through the sync core. A row the core refuses is NotFound (not this user's) or Invalid."""
    try:
        log, _ = log_service.upsert_food_log(session, user, FoodLogRow.model_validate(row))
    except ValidationError as e:
        raise Invalid(rejection_reason(e.errors())) from e  # e.g. a blank name: "invalid name"
    except log_service.LogRejected as e:
        if e.reason == "not_found":
            raise NotFound(NOT_FOUND) from e
        raise Invalid(e.reason) from e
    return log


def edit_time(log: FoodLog, now: datetime) -> datetime:
    """`now`, or the stored `updated_at` if that is later (a phone whose clock runs ahead): never
    older than the stored copy, so the core applies the edit instead of keeping what it has."""
    return max(now, log.updated_at)


def create_log(session: Session, user: User, body: FoodLogCreate, now: datetime) -> tuple[FoodLogOut, bool]:
    """Logs a food. Returns (the stored log, created). Idempotent by `body.id`: an id this user already
    created returns the stored log with created False and writes nothing; a deleted one is NotFound
    (a repeated create must not bring it back). Commit when created."""
    log_service.lock_user(session, user.id)
    if body.id is not None:
        existing = log_service.get_food_log(session, user, body.id, include_deleted=True)
        if existing is not None:
            if existing.deleted_at is not None:
                raise NotFound(NOT_FOUND)
            return log_service.food_log_out(existing), False
    return log_service.food_log_out(write(session, user, new_row(session, user, body, now))), True


def edit_log(session: Session, user: User, log_id: uuid.UUID, changes: dict[str, Any], now: datetime) -> FoodLogOut:
    """Changes any of name, quantity, log_date, logged_at and values (a dict of any subset of the
    nutrients) of a live log: `changes` is a `FoodLogPatch` dumped with `exclude_unset`."""
    log_service.lock_user(session, user.id)
    log = log_service.get_food_log(session, user, log_id)
    if log is None:
        raise NotFound(NOT_FOUND)
    changes = dict(changes)
    values = changes.pop("values", None) or {}
    row = stored_row(log)
    row.update(changes)
    row["values"] = {**row["values"], **values}
    row["updated_at"] = edit_time(log, now)
    return log_service.food_log_out(write(session, user, row))


def delete_log(session: Session, user: User, log_id: uuid.UUID, now: datetime) -> FoodLogOut:
    """Soft delete: the log stays as a tombstone, so the phone learns of it. Deleting a deleted log
    again writes nothing. Returns the log as stored (with its name and amount, for the caller to say
    what was deleted). NotFound for a log this user never had."""
    log_service.lock_user(session, user.id)
    log = log_service.get_food_log(session, user, log_id, include_deleted=True)
    if log is None:
        raise NotFound(NOT_FOUND)
    if log.deleted_at is None:
        at = edit_time(log, now)
        log = write(session, user, {**stored_row(log), "updated_at": at, "deleted_at": at})
    return log_service.food_log_out(log)
