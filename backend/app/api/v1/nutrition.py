"""/api/v1/nutrition: a day's totals for the bearer token's user."""

from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import CurrentUser, DbSession
from app.api.v1.food_logs import Day, Now
from app.schemas.log_api import DailyNutrition, DayTotals, GoalOut, UnknownCounts
from app.services import log_queries

router = APIRouter(prefix="/api/v1/nutrition", tags=["nutrition"])


@router.get("/daily")
def daily(session: DbSession, user: CurrentUser, now: Now, day: Day = None) -> DailyNutrition:
    """One day: what was eaten in total, the goal in force, the steps. A day with no logs is zeros, not a 404.

    A log that does not report fiber, sugar or sodium adds 0 to that total; `unknown` counts those
    logs, so a client can say "at least 12 g".
    """
    day = day or log_queries.local_date(user, now)
    sums = log_queries.day_totals(session, user.id, day)
    goal = log_queries.goal_on(session, user.id, day)
    return DailyNutrition(
        date=day,
        totals=DayTotals.model_validate(dict(sums)),
        unknown=UnknownCounts(
            fiber_g=sums["fiber_g_unknown"], sugar_g=sums["sugar_g_unknown"], sodium_mg=sums["sodium_mg_unknown"]
        ),
        goal=GoalOut.model_validate(goal) if goal else None,
        steps=log_queries.steps_on(session, user.id, day),
        log_count=sums["log_count"],
    )
