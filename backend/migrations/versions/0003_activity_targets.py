"""goals say where they came from and what a workout or active-rest day adds; daily_steps becomes
daily_activity, with the day's type and workout calories

Revision ID: 0003
Revises: 0002
"""

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

# daily_steps' objects and their new names (constraint, index, trigger), so a name always says its table.
RENAMED_CONSTRAINTS = ("pkey", "user_id_fkey", "steps_check")


def upgrade() -> None:
    # Additive, with defaults: every stored goal reads as a manual one that no day type adjusts. A
    # constant default is metadata-only (no table rewrite), and ALTER TABLE fires no row trigger, so
    # no `rev` changes and no device pulls its goals again.
    # `source`: 'computed' = taken from a suggestion (POST /goals/suggest or the app's), 'manual' = typed.
    # The day's target is worked out when it is read (app/services/targets.py), never stored.
    op.execute(
        """
        ALTER TABLE user_goals
            ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('computed', 'manual')),
            ADD COLUMN workout_kcal DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (workout_kcal >= 0),
            ADD COLUMN active_rest_kcal DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (active_rest_kcal >= 0)
        """
    )

    # A day is more than its steps now. Renames keep the rows, their `rev` and the trigger.
    op.execute("ALTER TABLE daily_steps RENAME TO daily_activity")
    op.execute("ALTER TABLE daily_activity RENAME COLUMN log_date TO activity_date")
    for suffix in RENAMED_CONSTRAINTS:
        op.execute(f"ALTER TABLE daily_activity RENAME CONSTRAINT daily_steps_{suffix} TO daily_activity_{suffix}")
    op.execute("ALTER INDEX daily_steps_user_rev_idx RENAME TO daily_activity_user_rev_idx")
    op.execute("ALTER TRIGGER daily_steps_rev ON daily_activity RENAME TO daily_activity_rev")
    # day_type NULL = the user did not say. workout_kcal: that day's workout calories, whatever the
    # day type; NULL = the goal's amount for the day type (0 is a value).
    op.execute(
        """
        ALTER TABLE daily_activity
            ADD COLUMN day_type TEXT CHECK (day_type IN ('workout', 'active_rest', 'rest')),
            ADD COLUMN workout_kcal DOUBLE PRECISION CHECK (workout_kcal >= 0)
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE daily_activity DROP COLUMN day_type, DROP COLUMN workout_kcal")
    op.execute("ALTER TRIGGER daily_activity_rev ON daily_activity RENAME TO daily_steps_rev")
    op.execute("ALTER INDEX daily_activity_user_rev_idx RENAME TO daily_steps_user_rev_idx")
    for suffix in RENAMED_CONSTRAINTS:
        op.execute(f"ALTER TABLE daily_activity RENAME CONSTRAINT daily_activity_{suffix} TO daily_steps_{suffix}")
    op.execute("ALTER TABLE daily_activity RENAME COLUMN activity_date TO log_date")
    op.execute("ALTER TABLE daily_activity RENAME TO daily_steps")
    op.execute("ALTER TABLE user_goals DROP COLUMN source, DROP COLUMN workout_kcal, DROP COLUMN active_rest_kcal")
