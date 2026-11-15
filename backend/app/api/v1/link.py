"""/api/v1/link-codes and /api/v1/devices/link: link another install to the same user.

A signed-in install asks for a code (POST /api/v1/link-codes, device token); the new install sends it
(POST /api/v1/devices/link, no token) and gets its own device token for that user, in the shape
registration answers with. The new token is a row in user_tokens like any other, labelled
"<platform> (linked)", so it can be revoked the same way. Linking does not create a user, so it works
when ALLOW_REGISTRATION is false. Neither the code nor the token is ever logged.

Limits (`register_limits`): codes per user, like pairing codes; and, since /devices/link needs no token,
every try per client address and wrong codes from everyone, like the pairing-code attempts on the OAuth
sign-in page (app/api/oauth.py). See `devices.register_device` about the client address behind a proxy.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from datetime import datetime
from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.api.deps import CurrentUser, DbSession
from app.api.limits import SlidingWindow
from app.api.oauth import ATTEMPTS_OVERALL, ATTEMPTS_PER_ADDRESS
from app.schemas.users import DeviceRegistered, DeviceRegistration
from app.services import linking

router = APIRouter(prefix="/api/v1", tags=["devices"])

CODES_PER_HOUR = 10  # per user, as for pairing codes


def register_limits(app: FastAPI, make: Callable[[int, float], Any] = SlidingWindow) -> None:
    """Puts this module's limiters on app.state (create_app calls it). `make(limit, per_seconds)` builds one;
    anything with `retry_after(key, record=True)` will do (a shared, database-backed limiter, say).

    - link_codes: POST /link-codes per user;
    - link_attempts: POST /devices/link per client address, every try;
    - link_attempts_overall: wrong codes from everyone (key "all"), a backstop against many addresses.
    """
    app.state.link_codes = make(CODES_PER_HOUR, 3600)
    app.state.link_attempts = make(*ATTEMPTS_PER_ADDRESS)
    app.state.link_attempts_overall = make(*ATTEMPTS_OVERALL)


class LinkCodeOut(BaseModel):
    code: str  # XXXX-XXXX
    expires_at: datetime


class DeviceLink(DeviceRegistration):
    """What the new install sends: the code, and about itself as at registration (the label of its token).
    `timezone` is accepted but not applied: the user keeps theirs (the app PATCHes /me when its zone differs)."""

    code: str = Field(max_length=32)


INVALID = "invalid or expired code"


@router.post("/link-codes", status_code=201)
def create_link_code(user: CurrentUser, session: DbSession, request: Request, response: Response) -> LinkCodeOut:
    """A one-time code (10 minutes) to enter on another install. Replaces the user's earlier link codes.
    At most 10 an hour per user: 429 with Retry-After above that."""
    wait = request.app.state.link_codes.retry_after(str(user.id))
    if wait is not None:
        raise HTTPException(429, "too many codes, try again later", headers={"Retry-After": str(math.ceil(wait))})
    code, expires_at = linking.create(session, user.id)
    session.commit()
    response.headers["Cache-Control"] = "no-store"
    return LinkCodeOut(code=code, expires_at=expires_at)


@router.post("/devices/link", status_code=201)
def link_device(session: DbSession, request: Request, response: Response, body: DeviceLink) -> DeviceRegistered:
    """A new device token for the user whose link code this is; the code is used up. 400 for a wrong,
    expired or used code (one answer for all three). 429 with Retry-After over the limits."""
    address = request.client.host if request.client else "unknown"
    wait = request.app.state.link_attempts.retry_after(address)
    if wait is None:
        wait = request.app.state.link_attempts_overall.retry_after("all", record=False)
    if wait is not None:
        raise HTTPException(429, "too many tries, try again later", headers={"Retry-After": str(math.ceil(wait))})
    linked = linking.link(session, body.code, f"{body.label() or 'device'} (linked)")
    if linked is None:
        request.app.state.link_attempts_overall.retry_after("all")  # a wrong code counts overall
        raise HTTPException(400, INVALID)
    user, token = linked
    session.commit()
    response.headers["Cache-Control"] = "no-store"
    return DeviceRegistered(user_id=user.id, token=token, timezone=user.timezone)
