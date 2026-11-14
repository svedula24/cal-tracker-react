"""A day's nutrition (what was eaten, the goal, the activity, the day's target and what remains), and the
same per day over a range, for /api/v1/nutrition/daily and the MCP tools. Reads only.

A log that does not report fiber, sugar or sodium adds 0 to that total; `unknown` counts those logs.
The target is the goal in force that day adjusted for the day's activity (app/services/targets.py);
it is None when no goal is in force.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date, timedelta
from typing import Any

from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.user_data import User, UserGoal
from app.schemas.log_api import Activity, DailyNutrition, DayTarget, DayTotals, GoalOut, UnknownCounts
from app.services import log_queries, targets


def _target(goal: GoalOut | None, activity: Activity | None) -> DayTarget | None:
    if goal is None:
        return None
    on_day = activity.model_dump() if activity is not None else None
    return DayTarget(**targets.day_target(goal.model_dump(), on_day))


def _activity(found: Mapping[str, Any] | None) -> Activity | None:
    return Activity.model_validate(dict(found)) if found is not None else None


def _unknown(sums: Mapping[str, Any]) -> UnknownCounts:
    return UnknownCounts(
        fiber_g=sums["fiber_g_unknown"], sugar_g=sums["sugar_g_unknown"], sodium_mg=sums["sodium_mg_unknown"]
    )


def daily_summary(session: Session, user: User, day: date) -> DailyNutrition:
    """One day: totals, the goal in force, the activity, the target and what remains. A day with no
    logs is zeros."""
    sums = log_queries.day_totals(session, user.id, day)
    goal = log_queries.goal_on(session, user.id, day)
    activity = _activity(log_queries.activity_on(session, user.id, day))
    totals = DayTotals.model_validate(dict(sums))
    goal_out = GoalOut.model_validate(goal) if goal is not None else None
    target = _target(goal_out, activity)
    remaining = DayTotals(**targets.remaining(target.model_dump(), totals.model_dump())) if target else None
    return DailyNutrition(
        date=day,
        totals=totals,
        unknown=_unknown(sums),
        goal=goal_out,
        steps=activity.steps if activity is not None else None,
        activity=activity,
        target=target,
        remaining=remaining,
        log_count=sums["log_count"],
    )


ZERO_SUMS = {
    **dict.fromkeys(targets.NUTRIENTS, 0.0),
    "fiber_g_unknown": 0,
    "sugar_g_unknown": 0,
    "sodium_mg_unknown": 0,
    "log_count": 0,
}


class HistoryDay(BaseModel):
    date: date
    log_count: int
    totals: DayTotals
    unknown: UnknownCounts
    activity: Activity | None
    target: DayTarget | None  # None when no goal is in force that day


def history(session: Session, user: User, start: date, end: date) -> list[HistoryDay]:
    """Every day from `start` to `end` (inclusive), oldest first: totals (zeros for a day without
    logs), activity and target. Three queries, whatever the length of the range."""
    sums_by_day = log_queries.range_totals(session, user.id, start, end)
    activity_by_day = log_queries.activity_for_range(session, user.id, start, end)
    goals: list[UserGoal] = log_queries.goals_for_range(session, user.id, start, end)
    goal_outs = [GoalOut.model_validate(goal) for goal in goals]
    days = []
    for offset in range((end - start).days + 1):
        day = start + timedelta(days=offset)
        sums = sums_by_day.get(day, ZERO_SUMS)
        in_force = [goal for goal in goal_outs if goal.effective_date <= day]
        activity = _activity(activity_by_day.get(day))
        days.append(
            HistoryDay(
                date=day,
                log_count=sums["log_count"],
                totals=DayTotals.model_validate(dict(sums)),
                unknown=_unknown(sums),
                activity=activity,
                target=_target(in_force[-1] if in_force else None, activity),
            )
        )
    return days
