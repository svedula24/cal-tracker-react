"""Read models for the foods tables. The DDL (CHECKs, indexes) lives in the Alembic migration;
tests/test_migrations.py checks that these columns match it."""

from sqlalchemy import REAL, BigInteger, ForeignKey, Identity, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Food(Base):
    __tablename__ = "foods"

    fdc_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    description: Mapped[str] = mapped_column(Text)
    data_type: Mapped[str] = mapped_column(Text)
    brand_name: Mapped[str | None] = mapped_column(Text)
    calories_per_100g: Mapped[float] = mapped_column(REAL)
    protein_per_100g: Mapped[float] = mapped_column(REAL)
    carbs_per_100g: Mapped[float] = mapped_column(REAL)
    fat_per_100g: Mapped[float] = mapped_column(REAL)
    fiber_per_100g: Mapped[float | None] = mapped_column(REAL)
    sugar_per_100g: Mapped[float | None] = mapped_column(REAL)
    sodium_mg_per_100g: Mapped[float | None] = mapped_column(REAL)


class FoodPortion(Base):
    __tablename__ = "food_portions"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    fdc_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("foods.fdc_id"))
    description: Mapped[str] = mapped_column(Text)
    gram_weight: Mapped[float] = mapped_column(REAL)
