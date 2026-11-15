"""Link codes (revision 0007): the one-time code a signed-in install shows so another install can join the
same user (app/services/linking.py). The same shape as pairing_codes, in a table of its own so the two
kinds of code never stand in for each other. The DDL lives in the migration; tests/test_migrations.py
checks that these columns match it.
"""

import uuid
from datetime import datetime

from sqlalchemy import LargeBinary, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.foods import Base
from app.models.user_data import TIMESTAMPTZ, user_id_column


class LinkCode(Base):
    __tablename__ = "link_codes"

    code_hash: Mapped[bytes] = mapped_column(LargeBinary, primary_key=True)  # SHA-256 of the normalised code
    user_id: Mapped[uuid.UUID] = user_id_column()
    created_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ, server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ)
    used_at: Mapped[datetime | None] = mapped_column(TIMESTAMPTZ)
