"""/api/v1/goals and /api/v1/daily-activity: a user's goals and days over plain REST, for clients other
than the app, plus suggested goals.

The app syncs these through POST /api/v1/sync. The writes here go through app/services/goal_writes.py
(the same core as sync), so a goal or a day set here gets a new `rev` and reaches the phone on its next
pull. Every write locks the user row first and ends with one commit. The user is the bearer token's;
no route takes a user id.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query

from app.api.deps import CurrentUser, DbSession
from app.api.v1.food_logs import Now, service_error
from app.schemas.log_api import DailyActivityOut, DailyActivityPut, GoalOut, GoalPut, SuggestIn, SuggestOut
from app.schemas.logs import Day
from app.services import goal_writes, log_queries, targets
from app.services.errors import ServiceError

goals_router = APIRouter(prefix="/api/v1/goals", tags=["goals"])
daily_activity_router = APIRouter(prefix="/api/v1/daily-activity", tags=["goals"])

OnDay = Annotated[Day | None, Query(description="YYYY-MM-DD. Default: today in the user's timezone.")]


@goals_router.get("", responses={404: {"description": "No goal is in force on that day"}})
def goal_in_force(session: DbSession, user: CurrentUser, now: Now, day: OnDay = None) -> GoalOut:
    """The goal in force on `day`: the latest one that starts on or before it."""
    goal = log_queries.goal_on(session, user.id, day or log_queries.local_date(user, now))
    if goal is None:
        raise HTTPException(404, "no goal in force on that day")
    return GoalOut.model_validate(goal)


@goals_router.put("/{effective_date}")
def put_goal(session: DbSession, user: CurrentUser, now: Now, effective_date: Day, body: GoalPut) -> GoalOut:
    """Creates or replaces the goal that starts on `effective_date` (a deleted one comes back). The goal
    is in force from that day until the next one starts. Leaving out `source`, `workout_kcal` or
    `active_rest_kcal` sets the default ('manual', 0, 0)."""
    try:
        out = GoalOut.model_validate(goal_writes.put_goal(session, user, effective_date, body.model_dump(), now))
    except ServiceError as e:  # the body was validated already; only a row the core refuses gets here
        raise service_error(e) from e
    session.commit()
    return out


@goals_router.post("/suggest")
def suggest_goal(user: CurrentUser, body: SuggestIn) -> SuggestOut:
    """Suggested calories, protein, carbs and fat for the person described (Mifflin–St Jeor; see
    app/services/targets.py). Nothing is stored: neither the inputs nor the answer."""
    return SuggestOut(**targets.suggest(body.sex, body.age, body.height_cm, body.weight_kg, body.goal))


@daily_activity_router.put("/{activity_date}")
def put_daily_activity(
    session: DbSession, user: CurrentUser, now: Now, activity_date: Day, body: DailyActivityPut
) -> DailyActivityOut:
    """Sets the day's steps, day type and workout calories (a field left out is cleared: null)."""
    try:
        written = goal_writes.put_activity(session, user, activity_date, body.model_dump(), now)
    except ServiceError as e:
        raise service_error(e) from e
    out = DailyActivityOut(
        activity_date=written.activity_date,
        steps=written.steps,
        day_type=written.day_type,
        workout_kcal=written.workout_kcal,
    )
    session.commit()
    return out
