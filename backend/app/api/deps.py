"""Dependencies shared by the routers: the request's database session and its authenticated user.

Writing: `get_session` closes the session WITHOUT committing, so a route that writes ends with one
`session.commit()` after its service calls (services never commit). A route that raises before that
commits nothing.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.db.session import get_session
from app.models.user_data import User
from app.services import users as user_service

DbSession = Annotated[Session, Depends(get_session)]


def _unauthorized(detail: str) -> HTTPException:
    # The detail never includes what the client sent.
    return HTTPException(401, detail, headers={"WWW-Authenticate": "Bearer"})


def bearer_token(request: Request) -> str:
    """The token of `Authorization: Bearer <token>`; 401 when the header is missing or not of that form."""
    scheme, _, token = request.headers.get("Authorization", "").partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        raise _unauthorized("missing bearer token")
    return token


def current_user(request: Request, session: DbSession) -> User:
    """The user the request's bearer token belongs to; 401 for an unknown or revoked token.

    The user comes from the token and from nothing else: no endpoint takes a user id from the client.
    """
    user = user_service.user_for_token(session, bearer_token(request))
    if user is None:
        raise _unauthorized("invalid token")
    # Commits the last_used_at update (if there was one: at most once a minute per token) here, in its
    # own transaction, so it is kept for read-only routes and for routes that fail, and so the row lock
    # is not held while the route runs. Otherwise it only ends a read. The route starts a new transaction.
    session.commit()
    return user


CurrentUser = Annotated[User, Depends(current_user)]
