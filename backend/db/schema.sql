-- One row per USDA FoodData Central food that reports calories, protein, carbs
-- and fat. Nutrients are per 100 g and never negative; a food missing any of the
-- four is not loaded (kalo/usda/load.py), so none is NULL. See
-- kalo/usda/nutrients.py for how each column is chosen from the USDA records.
-- No migrations yet: after a schema change, DROP TABLE foods and reload.
CREATE TABLE IF NOT EXISTS foods (
    fdc_id            BIGINT PRIMARY KEY,
    description       TEXT   NOT NULL,
    data_type         TEXT   NOT NULL CHECK (data_type IN ('Foundation', 'SR Legacy', 'Survey (FNDDS)')),
    brand_name        TEXT,
    calories_per_100g REAL NOT NULL CHECK (calories_per_100g >= 0),
    protein_per_100g  REAL NOT NULL CHECK (protein_per_100g >= 0),
    carbs_per_100g    REAL NOT NULL CHECK (carbs_per_100g >= 0),
    fat_per_100g      REAL NOT NULL CHECK (fat_per_100g >= 0)
);
