"""users, their tokens and their synced data; foods can be retired

Revision ID: 0002
Revises: 0001
"""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

# Tables a device syncs: every write takes the next number of one sequence into `rev`, so "what
# changed since rev N" is one indexed range per table, and deletes are soft (`deleted_at`).
SYNCED_TABLES = ("food_logs", "user_goals", "daily_steps", "saved_foods")

# A logged total: the per-unit value times the quantity, where a 'g' entry's unit is 100 g.
# NULL when the per-unit value is NULL.
TOTAL = "DOUBLE PRECISION GENERATED ALWAYS AS ({} * quantity / CASE unit WHEN 'g' THEN 100 ELSE 1 END) STORED"


def upgrade() -> None:
    # A food that a later USDA release drops is kept (logs and bookmarks reference it) and marked
    # retired; search skips it. NULL = current. Not indexed: nearly every row is NULL.
    op.execute("ALTER TABLE foods ADD COLUMN retired_at TIMESTAMPTZ")

    # A user starts as an anonymous device (no email, no provider) and may sign in later.
    op.execute(
        """
        CREATE TABLE users (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email         TEXT,
            auth_provider TEXT,
            auth_subject  TEXT,
            timezone      TEXT NOT NULL DEFAULT 'UTC',
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK ((auth_provider IS NULL) = (auth_subject IS NULL)),
            UNIQUE (auth_provider, auth_subject)
        )
        """
    )
    op.execute("CREATE UNIQUE INDEX users_email_key ON users (lower(email))")

    # Bearer tokens. Only the SHA-256 of a token is stored, so a leaked table gives no access.
    op.execute(
        """
        CREATE TABLE user_tokens (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token_hash   BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
            label        TEXT,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_used_at TIMESTAMPTZ,
            revoked_at   TIMESTAMPTZ
        )
        """
    )
    op.execute("CREATE INDEX user_tokens_user_id_idx ON user_tokens (user_id)")

    op.execute("CREATE SEQUENCE sync_rev_seq AS BIGINT")
    op.execute(
        """
        CREATE FUNCTION set_sync_rev() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN NEW.rev := nextval('sync_rev_seq'); RETURN NEW; END $$
        """
    )

    # One row per thing eaten. `unit_*` is what one unit holds (100 g for 'g', one serving for
    # 'serving'); the totals are generated from it. A log of a USDA food (fdc_id set, always in
    # grams) also keeps the food's name and per-100 g values as they were when logged (`food_*`),
    # beside the user's own (`name`, `unit_*`); a custom entry has none of them.
    totals = ",\n            ".join(
        f"{column} {TOTAL.format('unit_' + column)}"
        for column in ("calories", "protein_g", "carbs_g", "fat_g", "fiber_g", "sugar_g", "sodium_mg")
    )
    op.execute(
        f"""
        CREATE TABLE food_logs (
            id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            fdc_id    BIGINT REFERENCES foods(fdc_id),
            log_date  DATE NOT NULL,
            logged_at TIMESTAMPTZ NOT NULL,
            name      TEXT NOT NULL CHECK (name <> ''),
            food_name TEXT,
            unit      TEXT NOT NULL CHECK (unit IN ('g', 'serving')),
            quantity  DOUBLE PRECISION NOT NULL CHECK (quantity > 0),
            unit_calories  DOUBLE PRECISION NOT NULL CHECK (unit_calories >= 0),
            unit_protein_g DOUBLE PRECISION NOT NULL CHECK (unit_protein_g >= 0),
            unit_carbs_g   DOUBLE PRECISION NOT NULL CHECK (unit_carbs_g >= 0),
            unit_fat_g     DOUBLE PRECISION NOT NULL CHECK (unit_fat_g >= 0),
            unit_fiber_g   DOUBLE PRECISION CHECK (unit_fiber_g >= 0),
            unit_sugar_g   DOUBLE PRECISION CHECK (unit_sugar_g >= 0),
            unit_sodium_mg DOUBLE PRECISION CHECK (unit_sodium_mg >= 0),
            food_calories_per_100g  DOUBLE PRECISION CHECK (food_calories_per_100g >= 0),
            food_protein_per_100g   DOUBLE PRECISION CHECK (food_protein_per_100g >= 0),
            food_carbs_per_100g     DOUBLE PRECISION CHECK (food_carbs_per_100g >= 0),
            food_fat_per_100g       DOUBLE PRECISION CHECK (food_fat_per_100g >= 0),
            food_fiber_per_100g     DOUBLE PRECISION CHECK (food_fiber_per_100g >= 0),
            food_sugar_per_100g     DOUBLE PRECISION CHECK (food_sugar_per_100g >= 0),
            food_sodium_mg_per_100g DOUBLE PRECISION CHECK (food_sodium_mg_per_100g >= 0),
            {totals},
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL,
            deleted_at TIMESTAMPTZ,
            rev        BIGINT NOT NULL,
            CHECK (fdc_id IS NULL OR unit = 'g'),
            CHECK (num_nulls(food_name, food_calories_per_100g, food_protein_per_100g, food_carbs_per_100g,
                             food_fat_per_100g)
                   = CASE WHEN fdc_id IS NULL THEN 5 ELSE 0 END),
            CHECK (fdc_id IS NOT NULL
                   OR num_nulls(food_fiber_per_100g, food_sugar_per_100g, food_sodium_mg_per_100g) = 3)
        )
        """
    )
    # A day's entries; a user's recently logged foods; and the sync range (which includes deleted rows).
    op.execute("CREATE INDEX food_logs_user_date_idx ON food_logs (user_id, log_date) WHERE deleted_at IS NULL")
    op.execute(
        "CREATE INDEX food_logs_user_recent_idx ON food_logs (user_id, fdc_id, logged_at DESC)"
        " WHERE deleted_at IS NULL AND fdc_id IS NOT NULL"
    )
    op.execute("CREATE INDEX food_logs_user_rev_idx ON food_logs (user_id, rev)")

    # Daily targets from `effective_date` until the next row's date.
    op.execute(
        """
        CREATE TABLE user_goals (
            user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            effective_date DATE NOT NULL,
            calories  DOUBLE PRECISION NOT NULL CHECK (calories >= 0),
            protein_g DOUBLE PRECISION NOT NULL CHECK (protein_g >= 0),
            carbs_g   DOUBLE PRECISION NOT NULL CHECK (carbs_g >= 0),
            fat_g     DOUBLE PRECISION NOT NULL CHECK (fat_g >= 0),
            fiber_g   DOUBLE PRECISION NOT NULL CHECK (fiber_g >= 0),
            sugar_g   DOUBLE PRECISION NOT NULL CHECK (sugar_g >= 0),
            sodium_mg DOUBLE PRECISION NOT NULL CHECK (sodium_mg >= 0),
            steps     INTEGER NOT NULL CHECK (steps >= 0),
            goal      TEXT NOT NULL CHECK (goal IN ('lose', 'maintain', 'gain')),
            updated_at TIMESTAMPTZ NOT NULL,
            deleted_at TIMESTAMPTZ,
            rev        BIGINT NOT NULL,
            PRIMARY KEY (user_id, effective_date)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE daily_steps (
            user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            log_date DATE NOT NULL,
            steps    INTEGER NOT NULL CHECK (steps >= 0),
            updated_at TIMESTAMPTZ NOT NULL,
            deleted_at TIMESTAMPTZ,
            rev        BIGINT NOT NULL,
            PRIMARY KEY (user_id, log_date)
        )
        """
    )
    # A user's bookmarked USDA foods.
    op.execute(
        """
        CREATE TABLE saved_foods (
            user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            fdc_id   BIGINT NOT NULL REFERENCES foods(fdc_id),
            saved_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            deleted_at TIMESTAMPTZ,
            rev        BIGINT NOT NULL,
            PRIMARY KEY (user_id, fdc_id)
        )
        """
    )
    for table in SYNCED_TABLES:
        if table != "food_logs":
            op.execute(f"CREATE INDEX {table}_user_rev_idx ON {table} (user_id, rev)")
        op.execute(
            f"CREATE TRIGGER {table}_rev BEFORE INSERT OR UPDATE ON {table}"
            " FOR EACH ROW EXECUTE FUNCTION set_sync_rev()"
        )


def downgrade() -> None:
    for table in SYNCED_TABLES:
        op.execute(f"DROP TABLE {table}")
    op.execute("DROP FUNCTION set_sync_rev()")
    op.execute("DROP SEQUENCE sync_rev_seq")
    op.execute("DROP TABLE user_tokens")
    op.execute("DROP TABLE users")
    op.execute("ALTER TABLE foods DROP COLUMN retired_at")
