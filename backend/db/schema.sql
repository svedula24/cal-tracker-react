-- One row per USDA FoodData Central food. Nutrients are per 100 g; a value the
-- source does not report is NULL, never 0. See kalo/usda/nutrients.py for how
-- each column is chosen from the USDA nutrient records.
CREATE TABLE IF NOT EXISTS foods (
    fdc_id            BIGINT PRIMARY KEY,
    description       TEXT   NOT NULL,
    data_type         TEXT   NOT NULL CHECK (data_type IN ('Foundation', 'SR Legacy', 'Survey (FNDDS)')),
    brand_name        TEXT,
    calories_per_100g REAL,
    protein_per_100g  REAL,
    carbs_per_100g    REAL,
    fat_per_100g      REAL
);
