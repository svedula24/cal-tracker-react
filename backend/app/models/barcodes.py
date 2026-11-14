"""Model for the barcode cache (revision 0005). The DDL lives in the migration; tests/test_migrations.py
checks that these columns match it."""

from datetime import datetime

from sqlalchemy import REAL, Boolean, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.foods import Base
from app.models.user_data import TIMESTAMPTZ


class BarcodeProduct(Base):
    """What Open Food Facts said about one normalised barcode, and when. Shared by every user.
    found = false: reason 'not_found' (not on OFF) or 'incomplete' (no name or a main nutrient missing)."""

    __tablename__ = "barcode_products"

    code: Mapped[str] = mapped_column(Text, primary_key=True)
    found: Mapped[bool] = mapped_column(Boolean)
    reason: Mapped[str | None] = mapped_column(Text)
    name: Mapped[str | None] = mapped_column(Text)
    brand: Mapped[str | None] = mapped_column(Text)
    calories: Mapped[float | None] = mapped_column(REAL)
    protein_g: Mapped[float | None] = mapped_column(REAL)
    carbs_g: Mapped[float | None] = mapped_column(REAL)
    fat_g: Mapped[float | None] = mapped_column(REAL)
    fiber_g: Mapped[float | None] = mapped_column(REAL)
    sugar_g: Mapped[float | None] = mapped_column(REAL)
    sodium_mg: Mapped[float | None] = mapped_column(REAL)
    serving_label: Mapped[str | None] = mapped_column(Text)
    serving_grams: Mapped[float | None] = mapped_column(REAL)
    fetched_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ)
