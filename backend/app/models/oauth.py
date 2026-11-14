"""Models for pairing codes and OAuth connections (revision 0004). The DDL lives in the migration;
tests/test_migrations.py checks that these columns match it.

An OAuth grant is a "connection": one client (ChatGPT) allowed into one user's data with some scopes,
until revoked. Codes and tokens hang off it. Every code and token is stored only as its SHA-256.
"""

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, LargeBinary, Text, Uuid, func
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.models.foods import Base
from app.models.user_data import NEW_UUID, TIMESTAMPTZ, user_id_column


class PairingCode(Base):
    """A one-time code shown in the app, typed on the authorize page to say which user is signing in."""

    __tablename__ = "pairing_codes"

    code_hash: Mapped[bytes] = mapped_column(LargeBinary, primary_key=True)  # SHA-256 of the normalised code
    user_id: Mapped[uuid.UUID] = user_id_column()
    created_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ, server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ)
    used_at: Mapped[datetime | None] = mapped_column(TIMESTAMPTZ)


class OAuthGrant(Base):
    __tablename__ = "oauth_grants"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, server_default=NEW_UUID)
    user_id: Mapped[uuid.UUID] = user_id_column()
    client_id: Mapped[str] = mapped_column(Text)
    client_name: Mapped[str] = mapped_column(Text)
    scopes: Mapped[list[str]] = mapped_column(ARRAY(Text))
    resource: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ, server_default=func.now())
    last_used_at: Mapped[datetime | None] = mapped_column(TIMESTAMPTZ)
    revoked_at: Mapped[datetime | None] = mapped_column(TIMESTAMPTZ)


class OAuthCode(Base):
    """An authorization code: what the user approved, until the client exchanges it (once, within 60 s).
    `grant_id` is set by the exchange, so a replayed code can revoke the grant it created."""

    __tablename__ = "oauth_codes"

    code_hash: Mapped[bytes] = mapped_column(LargeBinary, primary_key=True)
    user_id: Mapped[uuid.UUID] = user_id_column()
    client_id: Mapped[str] = mapped_column(Text)
    client_name: Mapped[str] = mapped_column(Text)
    scopes: Mapped[list[str]] = mapped_column(ARRAY(Text))
    resource: Mapped[str] = mapped_column(Text)
    redirect_uri: Mapped[str] = mapped_column(Text)
    code_challenge: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ, server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ)
    used_at: Mapped[datetime | None] = mapped_column(TIMESTAMPTZ)
    grant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("oauth_grants.id", ondelete="CASCADE"))


class OAuthToken(Base):
    """An access token (1 h) or a refresh token (90 days). A refresh token is used once: `rotated_at`."""

    __tablename__ = "oauth_tokens"

    token_hash: Mapped[bytes] = mapped_column(LargeBinary, primary_key=True)
    grant_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("oauth_grants.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(Text)  # 'access' or 'refresh'
    created_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ, server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ)
    rotated_at: Mapped[datetime | None] = mapped_column(TIMESTAMPTZ)
