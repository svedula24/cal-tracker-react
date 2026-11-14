"""barcode_products: the shared cache of Open Food Facts product lookups

Revision ID: 0005
Revises: 0004
"""

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # One row per normalised barcode (app/services/barcodes.py), shared by every user: what Open Food
    # Facts said about it, and when. found = false is "not on OFF" (reason 'not_found') or "on OFF without
    # a name and the four main nutrients" (reason 'incomplete'); such a row keeps only the name and brand.
    # Nutrients are per 100 g, sodium in mg. A serving has a label and a gram weight, or neither.
    op.execute(
        """
        CREATE TABLE barcode_products (
            code          TEXT PRIMARY KEY CHECK (code ~ '^[0-9]{8,14}$'),
            found         BOOLEAN NOT NULL,
            reason        TEXT CHECK (reason IN ('not_found', 'incomplete')),
            name          TEXT CHECK (name <> ''),
            brand         TEXT,
            calories      REAL CHECK (calories >= 0),
            protein_g     REAL CHECK (protein_g >= 0),
            carbs_g       REAL CHECK (carbs_g >= 0),
            fat_g         REAL CHECK (fat_g >= 0),
            fiber_g       REAL CHECK (fiber_g >= 0),
            sugar_g       REAL CHECK (sugar_g >= 0),
            sodium_mg     REAL CHECK (sodium_mg >= 0),
            serving_label TEXT,
            serving_grams REAL CHECK (serving_grams > 0),
            fetched_at    TIMESTAMPTZ NOT NULL,
            CHECK ((reason IS NULL) = found),
            CHECK (NOT found OR num_nulls(name, calories, protein_g, carbs_g, fat_g) = 0),
            CHECK ((serving_label IS NULL) = (serving_grams IS NULL))
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE barcode_products")
