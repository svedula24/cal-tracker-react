"""Pairing codes: the one-time code the app shows and the authorize page asks for.

8 characters of Crockford base32 (no I, L, O or U), shown as XXXX-XXXX: 40 bits, single use, 10
minutes. Typing is forgiving: case, spaces and dashes are ignored, O reads as 0 and I or L as 1.
Only the SHA-256 of the normalised code is stored. Nothing here commits.

Link codes (app/services/linking.py) are made and used the same way, in their own table: `create` and
`consume` take the table, so a code of one kind can never be used as the other.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta

from sqlalchemy import delete, func, insert, or_, update
from sqlalchemy.orm import Session

from app.models.linking import LinkCode
from app.models.oauth import PairingCode

ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford base32
LENGTH = 8
LIFETIME = timedelta(minutes=10)
_CONFUSABLE = str.maketrans({"O": "0", "I": "1", "L": "1", " ": None, "-": None})


def new_code() -> str:
    """A fresh code, normalised (8 characters, no dash)."""
    return "".join(secrets.choice(ALPHABET) for _ in range(LENGTH))


def display(code: str) -> str:
    return f"{code[:4]}-{code[4:]}"


def normalise(typed: str) -> str | None:
    """The code as stored (hashed), or None when what was typed cannot be a code."""
    code = typed.strip().upper().translate(_CONFUSABLE)
    if len(code) != LENGTH or any(c not in ALPHABET for c in code):
        return None
    return code


def hash_code(code: str) -> bytes:
    return hashlib.sha256(code.encode()).digest()


Codes = type[PairingCode] | type[LinkCode]


def create(session: Session, user_id: uuid.UUID, table: Codes = PairingCode) -> tuple[str, datetime]:
    """A new code for the user, shown as XXXX-XXXX, and when it expires. Replaces the user's earlier codes
    (of this table) and clears everyone's expired ones. Does not commit."""
    session.execute(delete(table).where(or_(table.user_id == user_id, table.expires_at < func.now())))
    code = new_code()
    expires_at = session.execute(
        insert(table)
        .values(code_hash=hash_code(code), user_id=user_id, expires_at=func.now() + LIFETIME)
        .returning(table.expires_at)
    ).scalar_one()
    return display(code), expires_at


def consume(session: Session, typed: str, table: Codes = PairingCode) -> uuid.UUID | None:
    """The user a live code belongs to, marking it used in the same statement (so two requests cannot
    both use it); None for a wrong, expired or used code. Does not commit."""
    code = normalise(typed)
    if code is None:
        return None
    return session.execute(
        update(table)
        .where(table.code_hash == hash_code(code), table.used_at.is_(None), table.expires_at > func.now())
        .values(used_at=func.now())
        .returning(table.user_id)
    ).scalar_one_or_none()
