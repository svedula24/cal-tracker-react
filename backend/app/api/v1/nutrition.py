"""/api/v1/nutrition: a day's totals, targets and what is left of them, for the bearer token's user."""

from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import CurrentUser, DbSession
from app.api.v1.food_logs import Day, Now
from app.schemas.log_api import Activity, DailyNutrition, DayTarget, DayTotals, GoalOut, UnknownCounts
from app.services import log_queries, targets

router = APIRouter(prefix="/api/v1/nutrition", tags=["nutrition"])


@router.get("/daily")
def daily(session: DbSession, user: CurrentUser, now: Now, day: Day = None) -> DailyNutrition:
    """One day: what was eaten in total, the goal in force, the day's activity, the day's target and
    what remains of it. A day with no logs is zeros, not a 404.

    A log that does not report fiber, sugar or sodium adds 0 to that total; `unknown` counts those
    logs, so a client can say "at least 12 g". The target is the goal adjusted for the day's activity
    (app/services/targets.py); `target` and `remaining` are null when no goal is in force.
    """
    day = day or log_queries.local_date(user, now)
    sums = log_queries.day_totals(session, user.id, day)
    goal = log_queries.goal_on(session, user.id, day)
    found = log_queries.activity_on(session, user.id, day)
    activity = Activity.model_validate(dict(found)) if found is not None else None
    totals = DayTotals.model_validate(dict(sums))
    goal_out = GoalOut.model_validate(goal) if goal is not None else None
    target = remaining = None
    if goal_out is not None:
        on_day = activity.model_dump() if activity is not None else None
        target = DayTarget(**targets.day_target(goal_out.model_dump(), on_day))
        remaining = DayTotals(**targets.remaining(target.model_dump(), totals.model_dump()))
    return DailyNutrition(
        date=day,
        totals=totals,
        unknown=UnknownCounts(
            fiber_g=sums["fiber_g_unknown"], sugar_g=sums["sugar_g_unknown"], sodium_mg=sums["sodium_mg_unknown"]
        ),
        goal=goal_out,
        steps=activity.steps if activity is not None else None,
        activity=activity,
        target=target,
        remaining=remaining,
        log_count=sums["log_count"],
    )
