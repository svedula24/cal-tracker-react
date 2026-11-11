"""foods and food_portions

Revision ID: 0001
Revises:
"""

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # One row per USDA FoodData Central food that reports calories, protein, carbs and fat.
    # Nutrients are per 100 g and never negative; a food missing any of the four is not loaded
    # (kalo/usda/load.py), so none of those is NULL. Fiber, sugar and sodium are NULL when USDA
    # does not report them. See kalo/usda/nutrients.py for how each column is chosen.
    op.execute(
        """
        CREATE TABLE foods (
            fdc_id            BIGINT PRIMARY KEY,
            description       TEXT   NOT NULL,
            data_type         TEXT   NOT NULL CHECK (data_type IN ('Foundation', 'SR Legacy', 'Survey (FNDDS)')),
            brand_name        TEXT,
            calories_per_100g REAL NOT NULL CHECK (calories_per_100g >= 0),
            protein_per_100g  REAL NOT NULL CHECK (protein_per_100g >= 0),
            carbs_per_100g    REAL NOT NULL CHECK (carbs_per_100g >= 0),
            fat_per_100g      REAL NOT NULL CHECK (fat_per_100g >= 0),
            fiber_per_100g     REAL CHECK (fiber_per_100g >= 0),
            sugar_per_100g     REAL CHECK (sugar_per_100g >= 0),
            sodium_mg_per_100g REAL CHECK (sodium_mg_per_100g >= 0)
        )
        """
    )
    # Every usable USDA serving of a food ("1 cup, sliced" = 150 g). See kalo/usda/portions.py.
    op.execute(
        """
        CREATE TABLE food_portions (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            fdc_id BIGINT NOT NULL REFERENCES foods(fdc_id),
            description TEXT NOT NULL,
            gram_weight REAL NOT NULL CHECK (gram_weight > 0)
        )
        """
    )
    op.execute("CREATE INDEX food_portions_fdc_id_idx ON food_portions(fdc_id)")

    # Search (app/services/foods.py). Both indexes are on lower(description) or its tsvector, so
    # the search query must use these exact expressions for Postgres to use them.
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    # fastupdate = off, no pending list: the loader's bulk insert would otherwise leave ~13k
    # unsorted entries that every search scans (about 100 ms a query) until autovacuum merges them.
    # Full-text: every query word matches a description word (stemmed; the last word as a prefix).
    op.execute(
        "CREATE INDEX foods_description_fts ON foods USING GIN (to_tsvector('english', description))"
        " WITH (fastupdate = off)"
    )
    # Trigrams: prefix match (LIKE 'q%') and misspellings (word similarity, the <% operator).
    op.execute(
        "CREATE INDEX foods_description_trgm ON foods USING GIN (lower(description) gin_trgm_ops)"
        " WITH (fastupdate = off)"
    )


def downgrade() -> None:
    # The pg_trgm extension stays: it is database-wide and may be used by other schemas.
    op.execute("DROP TABLE food_portions")
    op.execute("DROP TABLE foods")
