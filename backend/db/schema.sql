-- One row per USDA FoodData Central food. Nutrients are per 100 g; a value the
-- source does not report is NULL, never 0, and never negative. See
-- kalo/usda/nutrients.py for how each column is chosen from the USDA records.
-- No migrations yet: after a schema change, DROP TABLE foods and reload.
CREATE TABLE IF NOT EXISTS foods (
    fdc_id            BIGINT PRIMARY KEY,
    description       TEXT   NOT NULL,
    data_type         TEXT   NOT NULL CHECK (data_type IN ('Foundation', 'SR Legacy', 'Survey (FNDDS)')),
    brand_name        TEXT,
    calories_per_100g REAL CHECK (calories_per_100g >= 0),
    protein_per_100g  REAL CHECK (protein_per_100g >= 0),
    carbs_per_100g    REAL CHECK (carbs_per_100g >= 0),
    fat_per_100g      REAL CHECK (fat_per_100g >= 0)
);
