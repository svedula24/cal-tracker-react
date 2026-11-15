"""link_codes: one-time codes that link another install to the same user

Revision ID: 0007
Revises: 0006
"""

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # A code a signed-in install shows (10 minutes, single use); another install sends it to
    # POST /api/v1/devices/link and gets its own token for the same user. Only the SHA-256 of the
    # normalised code is stored. The same shape as pairing_codes (0004), kept apart so that neither
    # kind of code can be used as the other.
    op.execute(
        """
        CREATE TABLE link_codes (
            code_hash  BYTEA PRIMARY KEY CHECK (octet_length(code_hash) = 32),
            user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at TIMESTAMPTZ NOT NULL,
            used_at    TIMESTAMPTZ
        )
        """
    )
    op.execute("CREATE INDEX link_codes_user_id_idx ON link_codes (user_id)")


def downgrade() -> None:
    op.execute("DROP TABLE link_codes")
