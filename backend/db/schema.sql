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

-- Search (kalo/api/search.py). Both indexes are on lower(description) or its tsvector, so the
-- search query must use these exact expressions for Postgres to use them.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Full-text: every query word matches a description word (stemmed; the last word as a prefix).
CREATE INDEX IF NOT EXISTS foods_description_fts ON foods USING GIN (to_tsvector('english', description));
-- Trigrams: prefix match (LIKE 'q%') and misspellings (word similarity, the <% operator).
CREATE INDEX IF NOT EXISTS foods_description_trgm ON foods USING GIN (lower(description) gin_trgm_ops);
-- No pending list: the loader's bulk insert would otherwise leave ~13k unsorted entries that
-- every search scans (about 100 ms a query) until autovacuum merges them.
ALTER INDEX foods_description_fts SET (fastupdate = off);
ALTER INDEX foods_description_trgm SET (fastupdate = off);
