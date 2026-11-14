"""Models for users, their tokens and their synced data. The DDL (CHECKs, indexes, the `rev`
trigger) lives in the Alembic migration; tests/test_migrations.py checks that these columns match it."""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Computed,
    Date,
    DateTime,
    Double,
    FetchedValue,
    ForeignKey,
    Integer,
    LargeBinary,
    Text,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.foods import Base

TIMESTAMPTZ = DateTime(timezone=True)
NEW_UUID = text("gen_random_uuid()")


def user_id_column(primary_key: bool = False) -> Mapped[uuid.UUID]:
    return mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=primary_key)


def rev_column() -> Mapped[int]:
    """Set by the table's trigger on every insert and update (never by the application)."""
    return mapped_column(BigInteger, server_default=FetchedValue(), server_onupdate=FetchedValue())


def total_column(unit_column: str) -> Mapped[float | None]:
    """A generated total: the per-unit value times the quantity (a 'g' entry's unit is 100 g)."""
    expression = f"{unit_column} * quantity / CASE unit WHEN 'g' THEN 100 ELSE 1 END"
    return mapped_column(Double, Computed(expression, persisted=True))


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, server_default=NEW_UUID)
    email: Mapped[str | None] = mapped_column(Text)
    auth_provider: Mapped[str | None] = mapped_column(Text)
    auth_subject: Mapped[str | None] = mapped_column(Text)
    timezone: Mapped[str] = mapped_column(Text, server_default="UTC")
    created_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ, server_default=func.now())


class UserToken(Base):
    __tablename__ = "user_tokens"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, server_default=NEW_UUID)
    user_id: Mapped[uuid.UUID] = user_id_column()
    token_hash: Mapped[bytes] = mapped_column(LargeBinary)  # SHA-256 of the token
    label: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ, server_default=func.now())
    last_used_at: Mapped[datetime | None] = mapped_column(TIMESTAMPTZ)
    revoked_at: Mapped[datetime | None] = mapped_column(TIMESTAMPTZ)


class FoodLog(Base):
    __tablename__ = "food_logs"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, server_default=NEW_UUID)
    user_id: Mapped[uuid.UUID] = user_id_column()
    fdc_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("foods.fdc_id"))
    log_date: Mapped[date] = mapped_column(Date)
    logged_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ)
    name: Mapped[str] = mapped_column(Text)
    food_name: Mapped[str | None] = mapped_column(Text)
    unit: Mapped[str] = mapped_column(Text)
    quantity: Mapped[float] = mapped_column(Double)
    unit_calories: Mapped[float] = mapped_column(Double)
    unit_protein_g: Mapped[float] = mapped_column(Double)
    unit_carbs_g: Mapped[float] = mapped_column(Double)
    unit_fat_g: Mapped[float] = mapped_column(Double)
    unit_fiber_g: Mapped[float | None] = mapped_column(Double)
    unit_sugar_g: Mapped[float | None] = mapped_column(Double)
    unit_sodium_mg: Mapped[float | None] = mapped_column(Double)
    food_calories_per_100g: Mapped[float | None] = mapped_column(Double)
    food_protein_per_100g: Mapped[float | None] = mapped_column(Double)
    food_carbs_per_100g: Mapped[float | None] = mapped_column(Double)
    food_fat_per_100g: Mapped[float | None] = mapped_column(Double)
    food_fiber_per_100g: Mapped[float | None] = mapped_column(Double)
    food_sugar_per_100g: Mapped[float | None] = mapped_column(Double)
    food_sodium_mg_per_100g: Mapped[float | None] = mapped_column(Double)
    # Generated totals (read-only). The columns are nullable in the table, but the first four are
    # never NULL: their inputs are NOT NULL.
    calories: Mapped[float | None] = total_column("unit_calories")
    protein_g: Mapped[float | None] = total_column("unit_protein_g")
    carbs_g: Mapped[float | None] = total_column("unit_carbs_g")
    fat_g: Mapped[float | None] = total_column("unit_fat_g")
    fiber_g: Mapped[float | None] = total_column("unit_fiber_g")
    sugar_g: Mapped[float | None] = total_column("unit_sugar_g")
    sodium_mg: Mapped[float | None] = total_column("unit_sodium_mg")
    created_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ)
    deleted_at: Mapped[datetime | None] = mapped_column(TIMESTAMPTZ)
    rev: Mapped[int] = rev_column()


class UserGoal(Base):
    __tablename__ = "user_goals"

    user_id: Mapped[uuid.UUID] = user_id_column(primary_key=True)
    effective_date: Mapped[date] = mapped_column(Date, primary_key=True)
    calories: Mapped[float] = mapped_column(Double)
    protein_g: Mapped[float] = mapped_column(Double)
    carbs_g: Mapped[float] = mapped_column(Double)
    fat_g: Mapped[float] = mapped_column(Double)
    fiber_g: Mapped[float] = mapped_column(Double)
    sugar_g: Mapped[float] = mapped_column(Double)
    sodium_mg: Mapped[float] = mapped_column(Double)
    steps: Mapped[int] = mapped_column(Integer)
    goal: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ)
    deleted_at: Mapped[datetime | None] = mapped_column(TIMESTAMPTZ)
    rev: Mapped[int] = rev_column()
    # Revision 0003 (so after `rev`, in the table's column order).
    source: Mapped[str] = mapped_column(Text, server_default="manual")  # 'computed' or 'manual'
    workout_kcal: Mapped[float] = mapped_column(Double, server_default="0")  # added on a workout day
    active_rest_kcal: Mapped[float] = mapped_column(Double, server_default="0")  # on an active-rest day


class DailyActivity(Base):
    """A user's day: steps, what kind of day it was and that day's workout calories. Revision 0003
    renamed it from daily_steps (and log_date to activity_date)."""

    __tablename__ = "daily_activity"

    user_id: Mapped[uuid.UUID] = user_id_column(primary_key=True)
    activity_date: Mapped[date] = mapped_column(Date, primary_key=True)
    steps: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ)
    deleted_at: Mapped[datetime | None] = mapped_column(TIMESTAMPTZ)
    rev: Mapped[int] = rev_column()
    day_type: Mapped[str | None] = mapped_column(Text)  # 'workout', 'active_rest', 'rest'; NULL = not said
    # That day's workout calories, whatever the day type; NULL = the goal's amount (app/services/targets.py).
    workout_kcal: Mapped[float | None] = mapped_column(Double)


class SavedFood(Base):
    __tablename__ = "saved_foods"

    user_id: Mapped[uuid.UUID] = user_id_column(primary_key=True)
    fdc_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("foods.fdc_id"), primary_key=True, autoincrement=False)
    saved_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ)
    updated_at: Mapped[datetime] = mapped_column(TIMESTAMPTZ)
    deleted_at: Mapped[datetime | None] = mapped_column(TIMESTAMPTZ)
    rev: Mapped[int] = rev_column()
