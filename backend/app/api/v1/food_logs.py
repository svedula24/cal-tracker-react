"""/api/v1/food-logs: a user's food logs over plain REST, for clients other than the app.

The app syncs through POST /api/v1/sync. These routes write through the same core
(app/services/logs.py: `upsert_food_log`), so a log made or changed here gets a new `rev` and
reaches the phone on its next pull, and the same rules apply (last write wins on `updated_at`).
Every write locks the user row first and ends with one commit. The user is the bearer token's.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.api.deps import CurrentUser, DbSession
from app.models.foods import Food
from app.models.user_data import FoodLog, User
from app.schemas.log_api import FoodLogCreate, FoodLogList, FoodLogPatch
from app.schemas.logs import FoodLogOut, FoodLogRow, rejection_reason
from app.services import foods as food_service
from app.services import log_queries
from app.services import logs as log_service

router = APIRouter(prefix="/api/v1/food-logs", tags=["food logs"])

NOT_FOUND = "food log not found"


def utc_now() -> datetime:
    """The request's "now". A dependency, so a test can set the clock (app.dependency_overrides)."""
    return datetime.now(UTC)


Now = Annotated[datetime, Depends(utc_now)]
# `date` is the query parameter's name; in Python it would shadow the type.
Day = Annotated[date | None, Query(alias="date", description="YYYY-MM-DD. Default: today in the user's timezone.")]


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
            raise HTTPException(422, "unknown fdc_id")
        if body.unit == "serving":
            raise HTTPException(422, "a database food is logged in grams")
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
            raise HTTPException(422, "a custom entry (no fdc_id) needs name and values")
        if body.food_name is not None or body.food_values is not None:
            raise HTTPException(422, "food_name and food_values belong to a database food (fdc_id)")
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
    """Upserts `row` through the sync core. A row the core refuses is a 404 (not this user's) or a 422."""
    try:
        log, _ = log_service.upsert_food_log(session, user, FoodLogRow.model_validate(row))
    except ValidationError as e:
        raise HTTPException(422, rejection_reason(e.errors())) from e  # e.g. a blank name: "invalid name"
    except log_service.LogRejected as e:
        if e.reason == "not_found":
            raise HTTPException(404, NOT_FOUND) from e
        raise HTTPException(422, e.reason) from e
    return log


def edit_time(log: FoodLog, now: datetime) -> datetime:
    """`now`, or the stored `updated_at` if that is later (a phone whose clock runs ahead): never
    older than the stored copy, so the core applies the edit instead of keeping what it has."""
    return max(now, log.updated_at)


@router.post("", status_code=201, responses={200: {"description": "This id was already created: the stored log"}})
def create_food_log(
    session: DbSession, user: CurrentUser, now: Now, body: FoodLogCreate, response: Response
) -> FoodLogOut:
    """Log a food. `{"fdc_id": 2709224, "quantity": 150}` is "150 g of that food, now, today".

    Idempotent by `id`: sending the same id again returns the stored log with 200 and writes nothing.
    """
    log_service.lock_user(session, user.id)
    if body.id is not None:
        existing = log_service.get_food_log(session, user, body.id, include_deleted=True)
        if existing is not None:
            if existing.deleted_at is not None:
                raise HTTPException(404, NOT_FOUND)  # deleted: a repeated create must not bring it back
            response.status_code = 200
            return log_service.food_log_out(existing)
    out = log_service.food_log_out(write(session, user, new_row(session, user, body, now)))
    session.commit()
    return out


@router.get("")
def list_food_logs(session: DbSession, user: CurrentUser, now: Now, day: Day = None) -> FoodLogList:
    """The logs of one day, newest first."""
    day = day or log_queries.local_date(user, now)
    return FoodLogList(logs=[log_service.food_log_out(log) for log in log_queries.day_logs(session, user.id, day)])


@router.patch("/{log_id}")
def edit_food_log(session: DbSession, user: CurrentUser, now: Now, log_id: uuid.UUID, body: FoodLogPatch) -> FoodLogOut:
    """Change any of name, quantity, log_date, logged_at and values (any subset of the nutrients).

    The nutrient values are per 100 g (or per serving), so a new quantity scales the totals,
    typed-over values included.
    """
    log_service.lock_user(session, user.id)
    log = log_service.get_food_log(session, user, log_id)
    if log is None:
        raise HTTPException(404, NOT_FOUND)
    changes = body.model_dump(exclude_unset=True)
    values = changes.pop("values", {})
    row = stored_row(log)
    row.update(changes)
    row["values"] = {**row["values"], **values}
    row["updated_at"] = edit_time(log, now)
    out = log_service.food_log_out(write(session, user, row))
    session.commit()
    return out


@router.delete("/{log_id}", status_code=204)
def delete_food_log(session: DbSession, user: CurrentUser, now: Now, log_id: uuid.UUID) -> None:
    """Soft delete: the log stays as a tombstone, so the phone learns of it. Deleting it again is also 204."""
    log_service.lock_user(session, user.id)
    log = log_service.get_food_log(session, user, log_id, include_deleted=True)
    if log is None:
        raise HTTPException(404, NOT_FOUND)
    if log.deleted_at is None:
        at = edit_time(log, now)
        write(session, user, {**stored_row(log), "updated_at": at, "deleted_at": at})
        session.commit()
