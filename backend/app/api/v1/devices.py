"""/api/v1/devices and /api/v1/me: register this install as an anonymous user, and check a token."""

from __future__ import annotations

import math

from fastapi import APIRouter, HTTPException, Request, Response

from app.api.deps import CurrentUser, DbSession
from app.schemas.users import DeviceRegistered, DeviceRegistration, Me
from app.services import users as user_service

router = APIRouter(prefix="/api/v1", tags=["devices"])


@router.post("/devices", status_code=201)
def register_device(
    session: DbSession, request: Request, response: Response, body: DeviceRegistration | None = None
) -> DeviceRegistered:
    """A new user and a bearer token for it. The token is shown once, here; the server stores only its hash.

    Needs no token, so it is limited per client address (app.state.registrations): 429 when over.
    """
    address = request.client.host if request.client else "unknown"
    wait = request.app.state.registrations.retry_after(address)
    if wait is not None:
        retry = {"Retry-After": str(math.ceil(wait))}
        raise HTTPException(429, "too many registrations, try again later", headers=retry)
    user, token = user_service.register_device(session, body.label() if body else None)
    session.commit()
    response.headers["Cache-Control"] = "no-store"
    return DeviceRegistered(user_id=user.id, token=token)


@router.get("/me")
def me(user: CurrentUser) -> Me:
    """The user the bearer token belongs to."""
    return Me.model_validate(user)
