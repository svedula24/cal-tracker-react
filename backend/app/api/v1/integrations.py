"""/api/v1/integration-tokens and PUT /api/v1/daily-activity/{date}/steps: what an automation outside
the app (the Apple Health Shortcut, docs/health-shortcut.md) uses to send the day's steps.

The token routes take the device token (CurrentUser, which refuses an integration token). The steps
route takes either (StepsUser): it is the only route an integration token works on. See
app/services/integrations.py.
"""

from __future__ import annotations

import math
import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StringConstraints
from pydantic_core import PydanticCustomError

from app.api.deps import CurrentUser, DbSession, StepsUser
from app.api.v1.food_logs import Now, service_error
from app.schemas.log_api import DailyActivityOut
from app.schemas.logs import MAX_INT, Day
from app.services import integrations, log_queries
from app.services.errors import ServiceError

router = APIRouter(prefix="/api/v1", tags=["integrations"])


class TokenIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)] = "Apple Health"


class TokenOut(BaseModel):
    id: uuid.UUID
    label: str
    created_at: datetime
    last_used_at: datetime | None


class TokenCreated(BaseModel):
    """The only response that carries the token: the server keeps its hash and cannot show it again."""

    id: uuid.UUID
    token: str
    label: str
    created_at: datetime


class Tokens(BaseModel):
    tokens: list[TokenOut]


# Thousands separators a Shortcut's text may carry: "8,123", "8 123", "8\u00a0123", "8\u202f123", "8'123".
_GROUPING = str.maketrans("", "", ",' \u00a0\u202f")


def _whole_steps(value: Any) -> Any:
    """A Shortcut may send the count as a number with decimals (the sum of Health samples) or as text
    (with thousands separators): both are read as a number and rounded to whole steps. A boolean or
    anything else is refused. Text with a dot is read as a decimal point ("8.123" is 8)."""
    if isinstance(value, bool):
        raise PydanticCustomError("steps", "must be a number")
    if isinstance(value, str):
        try:
            value = float(value.translate(_GROUPING))
        except ValueError as e:
            raise PydanticCustomError("steps", "must be a number") from e
    if isinstance(value, float):
        if not math.isfinite(value):
            raise PydanticCustomError("steps", "must be a number")
        return math.floor(value + 0.5)
    return value


class StepsPut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    steps: Annotated[int, BeforeValidator(_whole_steps), Field(strict=True, ge=0, le=MAX_INT)]


@router.post("/integration-tokens", status_code=201)
def create_token(
    user: CurrentUser, session: DbSession, response: Response, body: TokenIn | None = None
) -> TokenCreated:
    """A token for an automation (the Apple Health Shortcut) that can set a day's steps and nothing
    else. Shown once, here. At most 10 live per user: 409 above that."""
    try:
        row, token = integrations.create(session, user.id, (body or TokenIn()).label)
    except ServiceError as e:
        raise HTTPException(409, e.message) from e
    out = TokenCreated(id=row.id, token=token, label=integrations.display_label(row), created_at=row.created_at)
    session.commit()
    response.headers["Cache-Control"] = "no-store"
    return out


@router.get("/integration-tokens")
def list_tokens(user: CurrentUser, session: DbSession) -> Tokens:
    """The user's live integration tokens (never the tokens themselves), newest first."""
    return Tokens(
        tokens=[
            TokenOut(
                id=row.id,
                label=integrations.display_label(row),
                created_at=row.created_at,
                last_used_at=row.last_used_at,
            )
            for row in integrations.list_live(session, user.id)
        ]
    )


@router.delete("/integration-tokens/{token_id}", status_code=204)
def revoke_token(token_id: uuid.UUID, user: CurrentUser, session: DbSession) -> Response:
    """Revoke an integration token: it stops working on the next request. 404 for a missing one, another
    user's or a device token; revoking one again is 204."""
    if not integrations.revoke(session, user.id, token_id):
        raise HTTPException(404, "integration token not found")
    session.commit()
    return Response(status_code=204)


@router.put("/daily-activity/{activity_date}/steps")
def put_steps(session: DbSession, user: StepsUser, now: Now, activity_date: Day, body: StepsPut) -> DailyActivityOut:
    """Sets the day's step count and keeps its day type and workout calories. The day is a date in the
    user's calendar (their timezone); a day after today there is 422. A lower count than the stored one
    replaces it (the Shortcut sends the day's total so far). Sending the same count again changes nothing."""
    if activity_date > log_queries.local_date(user, now):
        raise HTTPException(422, "that day has not started yet")
    try:
        written = integrations.put_steps(session, user, activity_date, body.steps, now)
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
