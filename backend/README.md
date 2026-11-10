# Kalo backend

Postgres with USDA FoodData Central's generic foods, loaded by a small Python
package. FastAPI comes later; this is the data layer it will read.

## What's in the database

One table, `foods` (`db/schema.sql`): one row per USDA food, nutrients per 100 g.

| Column | Source |
| --- | --- |
| `fdc_id` | USDA FDC id (primary key) |
| `description`, `data_type` | USDA's; `data_type` is `Foundation`, `SR Legacy` or `Survey (FNDDS)` |
| `brand_name` | NULL for every generic food (the Branded dataset is not loaded) |
| `calories_per_100g` | nutrient 1008 (kcal); else Atwater Specific 2048, else Atwater General 2047, else kJ 1062 ÷ 4.184 |
| `protein_per_100g` | 1003 |
| `carbs_per_100g` | 1005, carbohydrate by difference (a negative value is stored as 0, as in the app's mapper) |
| `fat_per_100g` | 1004 |

A nutrient the source does not report is **NULL**, never 0; the schema also
rejects negative values. The loader checks
each nutrient's unit (and each record's dataType and description): a load with
any unmappable record loads nothing and lists every bad record, by dataset and
fdc_id, before exiting. Details: `kalo/usda/nutrients.py`.

Releases: Foundation 2026-10-29, SR Legacy 2018-04 (final), FNDDS 2024-10-31
(`kalo/usda/datasets.py`; the same releases the app's bundled JSON is built from).
Each download is verified against a SHA-256 pinned in `kalo/usda/datasets.py`,
so bumping a release means updating its pin.

## Run it

Needs Docker (colima on this Mac) and [uv](https://docs.astral.sh/uv/).

```sh
cd backend
colima start                 # once per boot, if Docker isn't running
docker-compose up -d         # Postgres 17 on localhost:5432, db/user/password: kalo
uv sync                      # Python deps
uv run python -m kalo.usda.load
```

The loader downloads the three USDA zips to `data/usda/` (cached, gitignored),
creates the table if missing and replaces its rows: a few seconds, plus the
download the first time. It parses each JSON file in memory (peak about 1.5 GB
for the FNDDS file); it is a one-off tool, not a service.

There are no migrations yet: after a schema change, `DROP TABLE foods` and reload.

Check:

```sh
docker exec kalo-db psql -U kalo -d kalo -c \
  "SELECT data_type, count(*) AS foods, count(calories_per_100g) AS with_energy FROM foods GROUP BY 1"
docker exec kalo-db psql -U kalo -d kalo -c \
  "SELECT fdc_id, description, calories_per_100g FROM foods WHERE fdc_id = 2709224"   -- Banana, raw: 97
```

`DATABASE_URL` overrides the connection. Nothing reads `.env` on its own: copy
`.env.example` to `.env` and run `uv run --env-file .env python -m kalo.usda.load`,
or set the variable inline.

## Develop

```sh
uv run pytest          # mapping tests, no database needed
uv run ruff check .
```
