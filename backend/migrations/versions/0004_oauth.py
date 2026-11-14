"""pairing codes and OAuth connections (grants, authorization codes, tokens) for the MCP server

Revision ID: 0004
Revises: 0003
"""

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

SCOPES = "ARRAY['nutrition:read', 'nutrition:write']"
# Every grant and code can read; write is optional.
SCOPES_CHECK = f"CHECK (scopes <@ {SCOPES} AND 'nutrition:read' = ANY (scopes))"
SHA256 = "BYTEA PRIMARY KEY CHECK (octet_length({}) = 32)"


def upgrade() -> None:
    # A one-time code the app shows (10 minutes, single use) and the authorize page asks for: it says
    # which user is connecting. Only the SHA-256 of the normalised code is stored.
    op.execute(
        f"""
        CREATE TABLE pairing_codes (
            code_hash  {SHA256.format("code_hash")},
            user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at TIMESTAMPTZ NOT NULL,
            used_at    TIMESTAMPTZ
        )
        """
    )
    op.execute("CREATE INDEX pairing_codes_user_id_idx ON pairing_codes (user_id)")

    # A connection: one client allowed into one user's data with some scopes, for one resource (the
    # MCP endpoint's URL), until revoked. Revoked rows are kept (the app lists only live ones).
    op.execute(
        f"""
        CREATE TABLE oauth_grants (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            client_id    TEXT NOT NULL,
            client_name  TEXT NOT NULL,
            scopes       TEXT[] NOT NULL {SCOPES_CHECK},
            resource     TEXT NOT NULL,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_used_at TIMESTAMPTZ,
            revoked_at   TIMESTAMPTZ
        )
        """
    )
    op.execute("CREATE INDEX oauth_grants_user_id_idx ON oauth_grants (user_id)")

    # An authorization code (60 s, single use) with everything the token request is checked against.
    # The grant is made when the code is exchanged; grant_id then lets a replay revoke it.
    op.execute(
        f"""
        CREATE TABLE oauth_codes (
            code_hash      {SHA256.format("code_hash")},
            user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            client_id      TEXT NOT NULL,
            client_name    TEXT NOT NULL,
            scopes         TEXT[] NOT NULL {SCOPES_CHECK},
            resource       TEXT NOT NULL,
            redirect_uri   TEXT NOT NULL,
            code_challenge TEXT NOT NULL,
            created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at     TIMESTAMPTZ NOT NULL,
            used_at        TIMESTAMPTZ,
            grant_id       UUID REFERENCES oauth_grants(id) ON DELETE CASCADE
        )
        """
    )
    op.execute("CREATE INDEX oauth_codes_expires_at_idx ON oauth_codes (expires_at)")

    # Access (1 h) and refresh (90 days) tokens of a grant. A refresh token is exchanged once
    # (rotated_at); one presented again is refused, and long after its rotation it revokes the grant.
    op.execute(
        f"""
        CREATE TABLE oauth_tokens (
            token_hash {SHA256.format("token_hash")},
            grant_id   UUID NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
            kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at TIMESTAMPTZ NOT NULL,
            rotated_at TIMESTAMPTZ,
            CHECK (kind = 'refresh' OR rotated_at IS NULL)
        )
        """
    )
    op.execute("CREATE INDEX oauth_tokens_grant_id_idx ON oauth_tokens (grant_id)")


def downgrade() -> None:
    op.execute("DROP TABLE oauth_tokens, oauth_codes, oauth_grants, pairing_codes")
