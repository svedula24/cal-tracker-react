"""/api/v1/food-logs: a user's food logs over plain REST, for clients other than the app.

The app syncs through POST /api/v1/sync. These routes write through app/services/log_writes.py, which
uses the same core (app/services/logs.py: `upsert_food_log`), so a log made or changed here gets a new
`rev` and reaches the phone on its next pull, and the same rules apply (last write wins on `updated_at`).
Every write locks the user row first and ends with one commit. The user is the bearer token's.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from app.api.deps import CurrentUser, DbSession
from app.schemas.log_api import FoodLogCreate, FoodLogList, FoodLogPatch
from app.schemas.logs import FoodLogOut
from app.services import log_queries, log_writes
from app.services import logs as log_service
from app.services.errors import NotFound, ServiceError

router = APIRouter(prefix="/api/v1/food-logs", tags=["food logs"])


def utc_now() -> datetime:
    """The request's "now". A dependency, so a test can set the clock (app.dependency_overrides)."""
    return datetime.now(UTC)


Now = Annotated[datetime, Depends(utc_now)]
# `date` is the query parameter's name; in Python it would shadow the type.
Day = Annotated[date | None, Query(alias="date", description="YYYY-MM-DD. Default: today in the user's timezone.")]


def service_error(e: ServiceError) -> HTTPException:
    """A service's refusal as the HTTP error: NotFound is a 404, Invalid a 422, with its message as the detail."""
    return HTTPException(404 if isinstance(e, NotFound) else 422, e.message)


@router.post("", status_code=201, responses={200: {"description": "This id was already created: the stored log"}})
def create_food_log(
    session: DbSession, user: CurrentUser, now: Now, body: FoodLogCreate, response: Response
) -> FoodLogOut:
    """Log a food. `{"fdc_id": 2709224, "quantity": 150}` is "150 g of that food, now, today".

    Idempotent by `id`: sending the same id again returns the stored log with 200 and writes nothing.
    """
    try:
        out, created = log_writes.create_log(session, user, body, now)
    except ServiceError as e:
        raise service_error(e) from e
    if created:
        session.commit()
    else:
        response.status_code = 200
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
    try:
        out = log_writes.edit_log(session, user, log_id, body.model_dump(exclude_unset=True), now)
    except ServiceError as e:
        raise service_error(e) from e
    session.commit()
    return out


@router.delete("/{log_id}", status_code=204)
def delete_food_log(session: DbSession, user: CurrentUser, now: Now, log_id: uuid.UUID) -> None:
    """Soft delete: the log stays as a tombstone, so the phone learns of it. Deleting it again is also 204."""
    try:
        log_writes.delete_log(session, user, log_id, now)
    except ServiceError as e:
        raise service_error(e) from e
    session.commit()
