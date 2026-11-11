"""Reads over a user's logs: a day's logs, a day's totals, the goal and steps of a day, recent foods.

Every query is scoped by the user id, which always comes from the bearer token. Writes go through
app/services/logs.py (the core shared with sync), not through here.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import date, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import RowMapping, select, text
from sqlalchemy.orm import Session

from app.models.foods import FoodPortion
from app.models.user_data import DailySteps, FoodLog, User, UserGoal
from app.services import foods as food_service


def local_date(user: User, now: datetime) -> date:
    """The calendar day it is for the user at `now` (an aware datetime), by `users.timezone`.

    A timezone name this machine does not know counts as UTC rather than failing the request.
    """
    try:
        zone = ZoneInfo(user.timezone)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo("UTC")
    return now.astimezone(zone).date()


def day_logs(session: Session, user_id: uuid.UUID, day: date) -> Sequence[FoodLog]:
    """The user's logs of one day that are not deleted, newest first (food_logs_user_date_idx)."""
    stmt = (
        select(FoodLog)
        .where(FoodLog.user_id == user_id, FoodLog.log_date == day, FoodLog.deleted_at.is_(None))
        .order_by(FoodLog.logged_at.desc(), FoodLog.id)
    )
    return session.scalars(stmt).all()


# The generated total columns, summed. A NULL total (the nutrient is not reported) adds nothing, and
# the *_unknown counts say how many logs that was. Always one row, also for a day with no logs.
DAY_TOTALS_SQL = text("""
SELECT COALESCE(sum(calories), 0)  AS calories,
       COALESCE(sum(protein_g), 0) AS protein_g,
       COALESCE(sum(carbs_g), 0)   AS carbs_g,
       COALESCE(sum(fat_g), 0)     AS fat_g,
       COALESCE(sum(fiber_g), 0)   AS fiber_g,
       COALESCE(sum(sugar_g), 0)   AS sugar_g,
       COALESCE(sum(sodium_mg), 0) AS sodium_mg,
       count(*) FILTER (WHERE fiber_g IS NULL)   AS fiber_g_unknown,
       count(*) FILTER (WHERE sugar_g IS NULL)   AS sugar_g_unknown,
       count(*) FILTER (WHERE sodium_mg IS NULL) AS sodium_mg_unknown,
       count(*) AS log_count
FROM food_logs
WHERE user_id = :user_id AND log_date = :day AND deleted_at IS NULL
""")


def day_totals(session: Session, user_id: uuid.UUID, day: date) -> RowMapping:
    """One row: the day's seven sums, the three `*_unknown` counts and `log_count`."""
    return session.execute(DAY_TOTALS_SQL, {"user_id": user_id, "day": day}).mappings().one()


def goal_on(session: Session, user_id: uuid.UUID, day: date) -> UserGoal | None:
    """The goal in force on `day`: the latest one that starts on or before it and is not deleted."""
    stmt = (
        select(UserGoal)
        .where(UserGoal.user_id == user_id, UserGoal.effective_date <= day, UserGoal.deleted_at.is_(None))
        .order_by(UserGoal.effective_date.desc())
        .limit(1)
    )
    return session.scalars(stmt).first()


def steps_on(session: Session, user_id: uuid.UUID, day: date) -> int | None:
    """The steps recorded for `day`, or None when there are none (or they were deleted)."""
    stmt = select(DailySteps.steps).where(
        DailySteps.user_id == user_id, DailySteps.log_date == day, DailySteps.deleted_at.is_(None)
    )
    return session.scalars(stmt).first()


# Each USDA food the user has logged, once, at its latest log (food_logs_user_recent_idx gives the
# inner query its order), then most recent first. Custom entries have no fdc_id and are left out.
# A retired food is kept: the user did log it, and it can still be looked up and logged by id.
RECENT_SQL = text(f"""
SELECT {", ".join("f." + column.strip() for column in food_service.COLUMNS.split(","))},
       recent.quantity AS grams, recent.logged_at
FROM (
    SELECT DISTINCT ON (fdc_id) fdc_id, quantity, logged_at
    FROM food_logs
    WHERE user_id = :user_id AND deleted_at IS NULL AND fdc_id IS NOT NULL
    ORDER BY fdc_id, logged_at DESC, id DESC  -- id: two logs of one food at the same instant give one answer
) recent
JOIN foods f ON f.fdc_id = recent.fdc_id
ORDER BY recent.logged_at DESC, f.fdc_id
LIMIT :limit
""")


def recent_foods(
    session: Session, user_id: uuid.UUID, limit: int
) -> tuple[Sequence[RowMapping], dict[int, list[FoodPortion]]]:
    """The user's `limit` most recently logged foods (search columns + `grams`, `logged_at`) and their portions."""
    rows = session.execute(RECENT_SQL, {"user_id": user_id, "limit": limit}).mappings().all()
    return rows, food_service.portions_for(session, [row["fdc_id"] for row in rows])
