"""Model for the shared rate-limit counts (revision 0006). The DDL lives in the migration;
tests/test_migrations.py checks that these columns match it. app/services/limits.py reads and writes it
with plain SQL."""

from datetime import datetime

from sqlalchemy import ARRAY, Double, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.foods import Base
from app.models.user_data import TIMESTAMPTZ


class RateLimit(Base):
    """One limiter's (`name`) events for one key, as epoch seconds, oldest first."""

    __tablename__ = "rate_limits"

    name: Mapped[str] = mapped_column(Text, primary_key=True)
    key: Mapped[str] = mapped_column(Text, primary_key=True)
    events: Mapped[list[float]] = mapped_column(ARRAY(Double))
    last_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ)
