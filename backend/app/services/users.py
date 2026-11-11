"""Users and their bearer tokens.

A token is "kalo_" + 32 random bytes (URL-safe base64, 43 characters). Only its SHA-256 is stored:
the token has 256 bits of entropy, so a plain hash (no salt, no slow KDF) is enough, and it can be
looked up by the unique index on token_hash.

Nothing here commits. A function writes into the caller's session (and flushes when it needs a
generated value); the route or dependency that owns the request commits once, when all of the
request's writes are in. So several service calls can share one transaction.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import timedelta

from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from app.models.user_data import User, UserToken

TOKEN_PREFIX = "kalo_"
# last_used_at is rewritten at most this often, so an authenticated read is normally one SELECT.
TOUCH_EVERY = timedelta(minutes=1)

_STALE = or_(UserToken.last_used_at.is_(None), UserToken.last_used_at < func.now() - TOUCH_EVERY)


def new_token() -> str:
    return TOKEN_PREFIX + secrets.token_urlsafe(32)


def hash_token(token: str) -> bytes:
    """What user_tokens.token_hash holds: 32 bytes."""
    return hashlib.sha256(token.encode()).digest()


def register_device(session: Session, label: str | None) -> tuple[User, str]:
    """A new anonymous user and its first token (returned in the clear, stored hashed). Does not commit."""
    user = User()
    token = new_token()
    session.add(user)
    session.flush()  # inserts the user, so its generated id can go in the token row
    session.add(UserToken(user_id=user.id, token_hash=hash_token(token), label=label))
    session.flush()
    return user, token


def user_for_token(session: Session, token: str) -> User | None:
    """The user a live (not revoked) token belongs to, or None. Does not commit.

    Records the use in last_used_at when the stored value is missing or older than TOUCH_EVERY (by
    the database's clock) and leaves that UPDATE pending, for the caller to commit (see
    app.api.deps.current_user). The UPDATE repeats the staleness test, so of several concurrent
    requests only one writes the row; a fresh token costs the one SELECT and no write.
    """
    stmt = (
        select(User, UserToken.id, _STALE)
        .join(UserToken, UserToken.user_id == User.id)
        .where(UserToken.token_hash == hash_token(token), UserToken.revoked_at.is_(None))
    )
    row = session.execute(stmt).one_or_none()
    if row is None:
        return None
    user, token_id, stale = row
    if stale:
        session.execute(update(UserToken).where(UserToken.id == token_id, _STALE).values(last_used_at=func.now()))
    return user
