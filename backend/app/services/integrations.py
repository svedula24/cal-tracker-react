"""Integration tokens and the one write they may make: a day's step count.

An integration token is for an automation outside the app, such as an Apple Shortcuts automation that
reads today's steps from Apple Health on the iPhone and sends them (see docs/health-shortcut.md). It is
a bearer token in `user_tokens` like a device token ("kalo_" + 43 characters, only its SHA-256 stored),
told apart by its label, which starts with `users.INTEGRATION_LABEL` (no migration needed). A device's
label is "<platform> <app version>" (or the version alone), and registration refuses a version that
starts with the prefix (app/schemas/users.py), so a device token never carries it. The auth dependencies accept an
integration token only on PUT /api/v1/daily-activity/{date}/steps (app/api/deps.py `steps_user`), so a
token copied out of a Shortcut can set steps and nothing else: it cannot read the diary, make more
tokens or revoke any.

Nothing here commits: the route commits once.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.models.user_data import DailyActivity, User, UserToken
from app.services import goal_writes
from app.services import logs as log_service
from app.services import sync as sync_service
from app.services.errors import Invalid
from app.services.users import INTEGRATION_LABEL, hash_token, new_token

MAX_LIVE = 10  # live integration tokens per user


def _integration(user_id: uuid.UUID):
    """The conditions for this user's live integration tokens."""
    return (
        UserToken.user_id == user_id,
        UserToken.label.startswith(INTEGRATION_LABEL, autoescape=True),
        UserToken.revoked_at.is_(None),
    )


def display_label(token: UserToken) -> str:
    """The label as the user gave it (without the integration prefix)."""
    return (token.label or "").removeprefix(INTEGRATION_LABEL)


def create(session: Session, user_id: uuid.UUID, label: str) -> tuple[UserToken, str]:
    """A new integration token: the row and the token in the clear (returned once, stored hashed).
    Invalid when the user already has MAX_LIVE live ones. Locks the user row, so two requests cannot
    both pass the count."""
    log_service.lock_user(session, user_id)
    live = session.execute(select(func.count()).select_from(UserToken).where(*_integration(user_id))).scalar_one()
    if live >= MAX_LIVE:
        raise Invalid(f"at most {MAX_LIVE} integration tokens: revoke one first")
    token = new_token()
    row = UserToken(user_id=user_id, token_hash=hash_token(token), label=INTEGRATION_LABEL + label)
    session.add(row)
    session.flush()  # sets id and created_at
    session.refresh(row)
    return row, token


def list_live(session: Session, user_id: uuid.UUID) -> list[UserToken]:
    """The user's live integration tokens, newest first."""
    stmt = select(UserToken).where(*_integration(user_id)).order_by(UserToken.created_at.desc(), UserToken.id)
    return list(session.execute(stmt).scalars())


def revoke(session: Session, user_id: uuid.UUID, token_id: uuid.UUID) -> bool:
    """Revokes one of the user's integration tokens (never a device token). True when it is revoked now
    or was already; False when the user has no integration token with that id."""
    stmt = select(UserToken).where(
        UserToken.id == token_id,
        UserToken.user_id == user_id,
        UserToken.label.startswith(INTEGRATION_LABEL, autoescape=True),
    )
    row = session.execute(stmt).scalar_one_or_none()
    if row is None:
        return False
    session.execute(
        update(UserToken).where(UserToken.id == row.id, UserToken.revoked_at.is_(None)).values(revoked_at=func.now())
    )
    return True


def put_steps(session: Session, user: User, activity_date: date, steps: int, now: datetime) -> DailyActivity:
    """Sets the day's steps and keeps its day type and workout calories, through the sync core (a new
    rev, so the phone pulls it). The count replaces the stored one even when it is lower: the Shortcut
    sends the day's total so far each time. Sending the stored count again writes nothing (same rev).

    0 never replaces a count above 0: a Shortcut that runs while the iPhone is locked cannot read Health
    and sums nothing, and that must not wipe the day. Such a call returns the stored day unchanged."""
    log_service.lock_user(session, user.id)
    stored = sync_service.stored_row(session, user.id, "daily_activity", activity_date)
    live = stored if stored is not None and stored.deleted_at is None else None
    if live is not None and (live.steps == steps or (steps == 0 and live.steps > 0)):
        return live
    values = {
        "activity_date": activity_date,
        "steps": steps,
        "day_type": live.day_type if live is not None else None,
        "workout_kcal": live.workout_kcal if live is not None else None,
    }
    return goal_writes.write_row(session, user, "daily_activity", activity_date, values, now)
