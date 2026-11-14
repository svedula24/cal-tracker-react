"""/api/v1/pairing-codes and /api/v1/connections: what the app shows on its Connect ChatGPT screen.

All take the device token (CurrentUser). They exist whether or not PUBLIC_URL is set, so the app can
ask for a code before the tunnel is up. An OAuth access token is never accepted here: CurrentUser
looks only in user_tokens.
"""

from __future__ import annotations

import math
import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from app.api.deps import CurrentUser, DbSession
from app.services import oauth, pairing

router = APIRouter(prefix="/api/v1", tags=["connections"])

CODES_PER_HOUR = 10  # per user (the limiter is made in app/main.py: app.state.pairing_codes)


class PairingCodeOut(BaseModel):
    code: str  # XXXX-XXXX
    expires_at: datetime


class Connection(BaseModel):
    id: uuid.UUID
    client_name: str
    scopes: list[str]
    created_at: datetime
    last_used_at: datetime | None


class Connections(BaseModel):
    connections: list[Connection]


@router.post("/pairing-codes", status_code=201)
def create_pairing_code(user: CurrentUser, session: DbSession, request: Request, response: Response) -> PairingCodeOut:
    """A one-time code (10 minutes) to type on the sign-in page ChatGPT opens. Replaces the user's earlier
    codes. At most 10 an hour per user: 429 with Retry-After above that."""
    wait = request.app.state.pairing_codes.retry_after(str(user.id))
    if wait is not None:
        raise HTTPException(429, "too many codes, try again later", headers={"Retry-After": str(math.ceil(wait))})
    code, expires_at = pairing.create(session, user.id)
    session.commit()
    response.headers["Cache-Control"] = "no-store"
    return PairingCodeOut(code=code, expires_at=expires_at)


@router.get("/connections")
def list_connections(user: CurrentUser, session: DbSession) -> Connections:
    """The user's live connections (apps signed in through OAuth), newest first."""
    return Connections(
        connections=[
            Connection(
                id=grant.id,
                client_name=grant.client_name,
                scopes=[s for s in oauth.SCOPES if s in grant.scopes],
                created_at=grant.created_at,
                last_used_at=grant.last_used_at,
            )
            for grant in oauth.list_grants(session, user.id)
        ]
    )


@router.delete("/connections/{connection_id}", status_code=204)
def disconnect(connection_id: uuid.UUID, user: CurrentUser, session: DbSession) -> Response:
    """Revoke a connection: its tokens stop working on the next request. 404 for a missing or another
    user's; a disconnected one again is 204."""
    if not oauth.revoke_grant(session, user.id, connection_id):
        raise HTTPException(404, "connection not found")
    session.commit()
    return Response(status_code=204)
