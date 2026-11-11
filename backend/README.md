# Kalo backend

Postgres with USDA FoodData Central's generic foods, loaded by a small Python
package and served by a FastAPI app: food search and lookup by FDC id. The Expo
app is not wired to it yet; it still searches its bundled copy of the same foods
(`src/data/usda-foods.json`).

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

Only foods that report all four nutrients (calories, protein, carbs, fat) are
loaded; the loader skips the rest (51 of 13,649 in the current releases, all of
them also missing energy) and prints how many per dataset. The schema makes the
four columns NOT NULL and rejects negative values. A reported 0 is kept. The
app's bundled JSON (`npm run build:foods`) drops foods with no energy value, which
today is the same set. The loader checks
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
creates the table and its search indexes if missing (`pg_trgm`, a full-text
and a trigram GIN index on `description`) and replaces its rows: a few seconds, plus the
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

## API

FastAPI over the `foods` table (`kalo/api/`). Load the database first (above);
the server reads it, it never writes.

```sh
uv run uvicorn kalo.api.app:app --reload   # http://localhost:8000, docs at /docs
```

`DATABASE_URL` overrides the database, as for the loader; `kalo.api.app.create_app(url)`
builds an app against any other. The app is not wired to the API yet: the Expo
app still searches `src/data/usda-foods.json`.

Search, best first:

```sh
curl 'localhost:8000/api/v1/foods/search?q=banana&limit=3'
```

```json
{"results": [
  {"fdc_id": 2709224, "description": "Banana, raw", "data_type": "Survey (FNDDS)", "brand_name": null, "calories_per_100g": 97.0},
  {"fdc_id": 2705660, "description": "Banana split", "data_type": "Survey (FNDDS)", "brand_name": null, "calories_per_100g": 199.0},
  {"fdc_id": 2709200, "description": "Banana chips", "data_type": "Survey (FNDDS)", "brand_name": null, "calories_per_100g": 519.0}
]}
```

One food, every column:

```sh
curl localhost:8000/api/v1/foods/2709224
```

```json
{"fdc_id": 2709224, "description": "Banana, raw", "data_type": "Survey (FNDDS)", "brand_name": null,
 "calories_per_100g": 97.0, "protein_per_100g": 0.74, "carbs_per_100g": 22.7, "fat_per_100g": 0.28}
```

The four nutrients are always numbers, never null (the loader skips foods
missing any of them); `brand_name` is null for every generic food. An unknown id
is 404 `{"detail": "food not found"}`.

Ranking (`kalo/api/search.py`), case-insensitive, whitespace collapsed:

1. the description is exactly the query;
2. the description starts with the query;
3. full text: every query word matches a description word (English stemming, the
   last word as a prefix, so `chicken bre` finds "Chicken breast, ...");
4. fuzzy: pg_trgm word similarity ≥ 0.4, for misspellings (`brocoli`, `chiken brest`).

Within a tier: higher word similarity, then the shorter description, then `fdc_id`.
`%`, `_` and `\` in the query are literal. A query under 3 characters uses only tiers
1 and 2 (shorter description first): `s` would otherwise full-text and fuzzy match half the table.

Limits: `q` is 1 to 100 characters and not only whitespace; `limit` is 1 to 50,
default 20. Anything else is 422.

Benchmark the search SQL (no HTTP) against the loaded database: p50/p95 per query
for a fixed set of queries, against a target of p95 < 100 ms. `--explain` prints
each query's plan, to check it uses the GIN indexes.

```sh
uv run python scripts/bench_search.py            # --n 200 for more runs per query
uv run python scripts/bench_search.py --explain
```

## Develop

```sh
uv run pytest          # mapping, download and search-query tests; database and API tests skip without DATABASE_URL
DATABASE_URL=postgresql://kalo:kalo@localhost:5432/kalo uv run pytest   # all, against docker-compose
uv run ruff check .
```

The database tests run in a throwaway schema and never touch the `foods` table.
