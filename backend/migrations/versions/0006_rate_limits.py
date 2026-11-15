"""rate_limits: rate-limit events shared by every server instance (app/services/limits.py)

Revision ID: 0006
Revises: 0005
"""

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # One row per limiter (`name`, e.g. 'registrations') and key (a client address or a user id): the wall-clock
    # times (epoch seconds) of its events still inside the window, oldest first, at most the limit's count.
    # last_at is the newest event (or when the row was made), for sweeping keys that have gone quiet.
    # Not user data: nothing references it, and losing it only resets the limits.
    op.execute(
        """
        CREATE TABLE rate_limits (
            name    TEXT NOT NULL,
            key     TEXT NOT NULL,
            events  DOUBLE PRECISION[] NOT NULL,
            last_at TIMESTAMPTZ NOT NULL,
            PRIMARY KEY (name, key)
        )
        """
    )
    op.execute("CREATE INDEX rate_limits_name_last_at_idx ON rate_limits (name, last_at)")


def downgrade() -> None:
    op.execute("DROP TABLE rate_limits")
