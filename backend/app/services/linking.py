"""Linking another install to a user: the signed-in install asks for a one-time code, the new install
sends it and gets its own device token for the same user (users are anonymous installs, one token each;
this is how one person's second device reaches the same data).

The codes are pairing codes (app/services/pairing.py: 8 Crockford base32 characters, XXXX-XXXX, single
use, 10 minutes, only the SHA-256 stored) kept in their own table, link_codes. Nothing here commits.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy.orm import Session

from app.models.linking import LinkCode
from app.models.user_data import User
from app.services import pairing
from app.services import users as user_service


def create(session: Session, user_id: uuid.UUID) -> tuple[str, datetime]:
    """A new link code for the user (XXXX-XXXX) and when it expires. Replaces the user's earlier link
    codes; leaves their pairing codes alone. Does not commit."""
    return pairing.create(session, user_id, LinkCode)


def link(session: Session, typed: str, label: str | None) -> tuple[User, str] | None:
    """Uses the code: the user it belongs to and a new device token for them, labelled `label`. None for
    a wrong, expired or used code (nothing is written then). Does not commit."""
    user_id = pairing.consume(session, typed, LinkCode)
    if user_id is None:
        return None
    return session.get_one(User, user_id), user_service.issue_token(session, user_id, label)
