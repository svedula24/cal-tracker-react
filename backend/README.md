# Kalo backend

Postgres with USDA FoodData Central's generic foods and their serving portions,
loaded by a small Python package and served by a FastAPI app (SQLAlchemy 2.0,
schema owned by Alembic): food search and lookup by FDC id. The Expo app's Food
Database searches it when `EXPO_PUBLIC_API_URL` is set, and otherwise (or when
the API cannot be reached) its bundled copy of the same foods
(`src/data/usda-foods.json`).

## What's in the database

Two tables, created by the Alembic migration
(`migrations/versions/0001_foods_and_portions.py`).

`foods`: one row per USDA food, nutrients per 100 g.

| Column | Source |
| --- | --- |
| `fdc_id` | USDA FDC id (primary key) |
| `description`, `data_type` | USDA's; `data_type` is `Foundation`, `SR Legacy` or `Survey (FNDDS)` |
| `brand_name` | NULL for every generic food (the Branded dataset is not loaded) |
| `calories_per_100g` | nutrient 1008 (kcal); else Atwater Specific 2048, else Atwater General 2047, else kJ 1062 ÷ 4.184 |
| `protein_per_100g` | 1003 |
| `carbs_per_100g` | 1005, carbohydrate by difference (a negative value is stored as 0, as in the app's mapper) |
| `fat_per_100g` | 1004 |
| `fiber_per_100g` | 1079 (g); NULL when USDA does not report it |
| `sugar_per_100g` | 2000 (g), else 1063; NULL when USDA reports neither |
| `sodium_mg_per_100g` | 1093 (mg); NULL when USDA does not report it |

Only foods that report all four required nutrients (calories, protein, carbs,
fat) are loaded; the loader skips the rest (51 of 13,649 in the current releases,
all of them also missing energy) and prints how many per dataset. The schema makes
the four columns NOT NULL and rejects negative values. A reported 0 is kept.
Fiber, sugar and sodium are optional: a food that does not report one is still
loaded, with NULL in that column (263 of the 424 Foundation foods report no
sugar). The app's bundled JSON (`npm run build:foods`) drops foods with no energy
value, which today is the same set, and stores a missing fiber, sugar or sodium
as 0. The loader checks each nutrient's unit (and each record's dataType and
description): a load with any unmappable record loads nothing and lists every bad
record, by dataset and fdc_id, before exiting. Details: `kalo/usda/nutrients.py`.

`food_portions`: the serving sizes USDA gives for a food ("1 banana" = 126 g).

| Column | Source |
| --- | --- |
| `id` | generated (primary key); restarts at 1 on every load |
| `fdc_id` | the food (foreign key to `foods`) |
| `description` | the portion's label, cleaned |
| `gram_weight` | USDA's gram weight, not rounded to the app's 1 decimal; a `REAL` (about 7 significant digits); always > 0 |

Every usable USDA portion of a loaded food is stored. Labels are built, cleaned
and de-duplicated with the same rules as the app's mapper (`scripts/usda/map.mjs`):
USDA's `sequenceNumber` order; FNDDS uses its `portionDescription`, Foundation
`quantity unit (modifier)`, SR Legacy `quantity modifier`; "Quantity not specified",
`RACC`, empty and digits-only labels and portions without a positive gram weight
are skipped; "package" and "1 package" are one portion. Unlike the app's bundled
JSON there is no default portion and no cap of 8, and gram weights are not rounded.
The current releases give 31,375 portions; 556 of the 13,598 foods have none.
Details: `kalo/usda/portions.py`.

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
uv run alembic upgrade head  # create or update the schema
uv run python -m kalo.usda.load
```

`alembic upgrade head` creates both tables and the search indexes (`pg_trgm`, a
full-text and a trigram GIN index on `foods.description`). The loader does not
create anything: it refuses to load a database that is not at the migration head
and tells you to run the upgrade.

The loader downloads the three USDA zips to `data/usda/` (cached, gitignored)
and replaces the rows of both tables in one transaction: a few seconds, plus the
download the first time. It parses each JSON file in memory (peak about 1.5 GB
for the FNDDS file); it is a one-off tool, not a service.

Check:

```sh
docker exec kalo-db psql -U kalo -d kalo -c \
  "SELECT data_type, count(*) AS foods FROM foods GROUP BY 1"
docker exec kalo-db psql -U kalo -d kalo -c \
  "SELECT count(*) AS portions, count(DISTINCT fdc_id) AS foods_with_portions FROM food_portions"
docker exec kalo-db psql -U kalo -d kalo -c \
  "SELECT fdc_id, description, calories_per_100g FROM foods WHERE fdc_id = 2709224"   -- Banana, raw: 97
docker exec kalo-db psql -U kalo -d kalo -c \
  "SELECT description, gram_weight FROM food_portions WHERE fdc_id = 2709224 ORDER BY gram_weight, id"
```

`DATABASE_URL` overrides the connection for Alembic, the loader and the API. It must
be a URL (`postgresql://user:password@host:port/db`), not a libpq `key=value` string.
Nothing reads `.env` on its own: copy `.env.example` to `.env` and run
`uv run --env-file .env alembic upgrade head` (likewise for the other commands),
or set the variable inline.

### Upgrading a database created before migrations

A `foods` table created by the old `db/schema.sql` has no Alembic version, so the
upgrade would fail on the existing table. Drop it, then upgrade and reload (the
data is re-downloadable, and the zips are already cached):

```sh
docker exec kalo-db psql -U kalo -d kalo -c "DROP TABLE foods"
uv run alembic upgrade head
uv run python -m kalo.usda.load
```

## API

FastAPI over the two tables (`app/`), through SQLAlchemy 2.0: sync sessions on
the psycopg 3 driver. Migrate and load the database first (above); the server
reads it, it never writes. It refuses to start against a database that is not at
the migration head, with the same message as the loader.

```sh
uv run uvicorn app.main:app --reload   # http://localhost:8000, docs at /docs
```

`DATABASE_URL` overrides the database, as for the loader, and stays a plain
`postgresql://…` URL (the app selects the driver itself);
`app.main.create_app(url)` builds an app against any other.

The Expo app searches this API when it is built or started with
`EXPO_PUBLIC_API_URL` (for example `http://localhost:8000`). By default uvicorn
listens on localhost only; a phone on the same network needs the server on every
interface and the Mac's LAN address in the variable:

```sh
uv run uvicorn app.main:app --host 0.0.0.0   # then EXPO_PUBLIC_API_URL=http://<this Mac's LAN IP>:8000
```

That exposes the API to the whole network: it is read-only public data with no
auth, so use it on a network you trust.

CORS: any origin may `GET` (`Access-Control-Allow-Origin: *`), because the web
build and the Expo web dev server call the API from another origin and the data
is public. Credentials are not allowed, and a preflight for any other method is
refused.

Responses of 1 kB or more are gzipped when the client accepts it: a page of 50
foods with their portions is 18 to 36 kB of JSON and about 3 kB compressed.

Search, best first, one page at a time, each food with its portions:

```sh
curl 'localhost:8000/api/v1/foods/search?q=banana&limit=2&offset=0'
```

```json
{"foods": [
  {"fdc_id": 2709224, "description": "Banana, raw", "data_type": "Survey (FNDDS)", "brand_name": null,
   "calories_per_100g": 97.0, "protein_per_100g": 0.74, "carbs_per_100g": 22.7, "fat_per_100g": 0.28,
   "fiber_per_100g": 1.7, "sugar_per_100g": 15.8, "sodium_mg_per_100g": 0.0,
   "portions": [
     {"id": 26368, "description": "1 slice", "gram_weight": 6.0},
     {"id": 26371, "description": "1 linear inch", "gram_weight": 15.0},
     {"id": 26367, "description": "1 banana", "gram_weight": 126.0},
     {"id": 26369, "description": "1 cup", "gram_weight": 150.0},
     {"id": 26370, "description": "1 cup, mashed", "gram_weight": 225.0}
   ]},
  {"fdc_id": 2705660, "description": "Banana split", "data_type": "Survey (FNDDS)", "brand_name": null,
   "calories_per_100g": 199.0, "protein_per_100g": 2.42, "carbs_per_100g": 32.6, "fat_per_100g": 6.88,
   "fiber_per_100g": 1.0, "sugar_per_100g": 24.2, "sodium_mg_per_100g": 97.0,
   "portions": [{"id": 15231, "description": "1 banana split", "gram_weight": 490.0}]}
], "limit": 2, "offset": 0}
```

`limit` and `offset` echo the request. The order is total (ties end on `fdc_id`),
so pages do not overlap: `offset=2` continues where this page ends. A page shorter
than `limit` is the last one. A search result carries everything the food lookup
below does (the same portions, in the same order), so a client needs no second
request per food. The portions of a page come from one extra query for the page's
ids, not a join, so `limit` counts foods.

One food, with its portions:

```sh
curl localhost:8000/api/v1/foods/2709224
```

```json
{"fdc_id": 2709224, "description": "Banana, raw", "data_type": "Survey (FNDDS)", "brand_name": null,
 "nutrients_per_100g": {"calories": 97.0, "protein_g": 0.74, "carbs_g": 22.7, "fat_g": 0.28,
                        "fiber_g": 1.7, "sugar_g": 15.8, "sodium_mg": 0.0},
 "portions": [
   {"id": 26368, "description": "1 slice", "gram_weight": 6.0},
   {"id": 26371, "description": "1 linear inch", "gram_weight": 15.0},
   {"id": 26367, "description": "1 banana", "gram_weight": 126.0},
   {"id": 26369, "description": "1 cup", "gram_weight": 150.0},
   {"id": 26370, "description": "1 cup, mashed", "gram_weight": 225.0}
 ]}
```

Calories, protein, carbs and fat are always numbers, never null (the loader
skips foods missing any of them). Fiber, sugar and sodium are null when USDA does
not report them, in both endpoints: null means unknown, not 0. `brand_name` is
null for every generic food. `portions` is ordered by gram weight (then `id`) and
is `[]` for a food with none, in both endpoints; there is no default portion,
choosing one is the client's job (the app takes the one closest to 100 g). An unknown id is 404 `{"detail": "food not found"}`.

Ranking (`app/services/foods.py`), case-insensitive, whitespace collapsed:

1. the description is exactly the query;
2. the description starts with the query;
3. full text: every query word matches a description word (English stemming, the
   last word as a prefix, so `chicken bre` finds "Chicken breast, ...");
4. fuzzy: pg_trgm word similarity ≥ 0.4, for misspellings (`brocoli`, `chiken brest`).

Within a tier: higher word similarity, then the shorter description, then `fdc_id`.
`%`, `_` and `\` in the query are literal. A query under 3 characters uses only tiers
1 and 2 (shorter description first): `s` would otherwise full-text and fuzzy match half the table.

Limits: `q` is 1 to 100 characters and not only whitespace; `limit` is 1 to 50,
default 20; `offset` is 0 to 1000, default 0. Anything else is 422.

The connection pool holds 10 connections. A request that waits more than 5
seconds for one gets 503 with `Retry-After: 1`.

Benchmark what the search endpoint reads (the ranked query and the portions
query; SQL only, no HTTP) against the loaded database: p50/p95 per query for a
fixed set of queries, against a target of p95 < 100 ms. `--explain` prints each
ranked query's plan, to check it uses the GIN indexes.

```sh
uv run python scripts/bench_search.py            # --n 200 for more runs per query
uv run python scripts/bench_search.py --limit 50 # the page size the app asks for (default 20)
uv run python scripts/bench_search.py --explain
```

## Layout

```
app/
  main.py              create_app(url=None), engine lifespan, CORS, 503 handler
  api/v1/foods.py      the two routes and their validation
  schemas/foods.py     Pydantic response models
  models/foods.py      SQLAlchemy Food and FoodPortion (read models)
  services/foods.py    ranked search SQL, portions_for (a page's portions), get_food, get_portions
  db/session.py        engine, session dependency
alembic.ini
migrations/
  env.py
  versions/            0001_foods_and_portions.py: tables, checks, indexes
kalo/
  db.py                database_url(): the one source of the connection URL
  usda/                the loader: datasets, nutrients, portions, load
scripts/
  bench_search.py      search benchmark
tests/
```

## Develop

```sh
uv run pytest          # mapping, portion, download and search-query tests; database and API tests skip without DATABASE_URL
DATABASE_URL=postgresql://kalo:kalo@localhost:5432/kalo uv run pytest   # all, against docker-compose
uv run ruff check .
```

Each database test creates a throwaway schema, runs the migrations in it and
drops it afterwards. The tests never touch the real `foods` and `food_portions`
tables, and the database does not need to be migrated or loaded to run them.

Schema changes go through a migration:

```sh
uv run alembic revision -m "add foods.something"   # new file in migrations/versions/
uv run alembic upgrade head
```

Migrations are hand-written SQL in `op.execute(...)`; there is no autogenerate.
The classes in `app/models/` are read models, not the source of the schema:
change them in the same commit so they match the migration. A column the loader
fills also needs `kalo/usda/` updated, and a reload.
