"""Writing a goal or a day's activity, for the REST routes (/api/v1/goals, /api/v1/daily-activity) and
the MCP tools.

The writes go through the sync core (app/services/sync.py `upsert_row`, then app/services/logs.py
`write_row`), so a goal or a day set here gets a new `rev` and reaches the phone on its next pull.
Each function locks the user row first and does not commit: the caller commits once.

A write here is an edit made now: its `updated_at` is now, or the stored copy's if that is later (a
phone whose clock runs ahead), so it always replaces what is stored.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models.user_data import DailyActivity, User, UserGoal
from app.schemas.logs import rejection_reason
from app.services import logs as log_service
from app.services import sync as sync_service
from app.services.errors import Invalid


def write_row(session: Session, user: User, table: str, key: Any, values: dict[str, Any], now: datetime) -> Any:
    """Locks the user, then upserts the row (`values` under `key`) through the sync core and flushes.
    A row the core refuses is Invalid."""
    log_service.lock_user(session, user.id)
    stored = sync_service.stored_row(session, user.id, table, key)
    edited = max(now, stored.updated_at) if stored is not None else now
    try:
        row = sync_service.TABLE_BY_NAME[table].row.model_validate({**values, "updated_at": edited})
    except ValidationError as e:
        raise Invalid(rejection_reason(e.errors())) from e
    written, _ = sync_service.upsert_row(session, user.id, table, row, stored, now)
    return written


def put_goal(session: Session, user: User, effective_date: date, values: dict[str, Any], now: datetime) -> UserGoal:
    """Creates or replaces the goal that starts on `effective_date` (a deleted one comes back). `values`:
    the seven nutrients, `steps`, `goal`, and optionally `source`, `workout_kcal`, `active_rest_kcal`
    (left out: 'manual', 0, 0)."""
    return write_row(session, user, "goals", effective_date, {**values, "effective_date": effective_date}, now)


def put_activity(
    session: Session, user: User, activity_date: date, values: dict[str, Any], now: datetime
) -> DailyActivity:
    """Sets the day's `steps`, `day_type` and `workout_kcal` (a field left out is cleared)."""
    return write_row(session, user, "daily_activity", activity_date, {**values, "activity_date": activity_date}, now)
