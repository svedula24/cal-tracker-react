# Kalo backend

Postgres with USDA FoodData Central's generic foods and their serving portions,
loaded by a small Python package and served by a FastAPI app (SQLAlchemy 2.0,
schema owned by Alembic): food search and lookup by FDC id, and the tables for
each user's data (food logs, goals, steps, saved foods). The Expo app's Food
Database searches it when `EXPO_PUBLIC_API_URL` is set, and otherwise (or when
the API cannot be reached) its bundled copy of the same foods
(`src/data/usda-foods.json`).

## What's in the database

The USDA tables `foods` and `food_portions` (migration
`migrations/versions/0001_foods_and_portions.py`), and the user-data tables
(`0002_user_data.py`, described under "User data" below).

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
| `retired_at` | NULL for a current food; set when a later load no longer contains the food (see "Reloading") |

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
| `id` | generated (primary key); changes on every load, so nothing may store it |
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

### User data

Six tables for what belongs to a user. Design and reasons: the Notion Architecture
Decision Log, records 14 to 20. Deleting a user deletes everything of theirs; a
food is never deleted.

| Table | One row per | Notes |
| --- | --- | --- |
| `users` | person | Anonymous for now: `email`, `auth_provider` and `auth_subject` are NULL until sign-in exists |
| `user_tokens` | device or integration | `token_hash` is the SHA-256 of a bearer token; the token itself is never stored. `revoked_at` turns one off |
| `food_logs` | logged food | `fdc_id` NULL = a custom entry. `quantity` + `unit` (`g` or `serving`). `unit_*`: the entry's own values per 100 g (or per serving), where a typed-over value lives. `food_*_per_100g`: the database food's values when it was logged. `calories`, `protein_g`, … are generated (`unit_* × quantity / 100`), so a day's totals are a plain `SUM` |
| `user_goals` | change of targets | Key `(user_id, effective_date)`: the goal for a day is the latest row on or before it. The baseline targets, `source` (`computed` from a suggestion, or `manual`), and what a `workout_kcal` / `active_rest_kcal` day adds (default 0) |
| `daily_activity` | user and day | Key `(user_id, activity_date)`. `steps`, `day_type` (`workout`, `active_rest`, `rest` or NULL) and `workout_kcal` (that day's own amount; NULL = the goal's). Called `daily_steps` (key `log_date`) before revision 0003. Rollover is calculated, not stored |
| `saved_foods` | bookmark | Key `(user_id, fdc_id)` |

The last four are synced with the app and carry `updated_at` (the client's edit
time; the newer edit wins), `deleted_at` (a deletion that syncs) and `rev`, set
by a trigger from one sequence on every write: a client asks for everything of
its user with `rev` above the last one it saw.

A day's target is never stored: it is worked out when it is read
(`app/services/targets.py`), from the goal in force and the day's activity.
`adjustment_kcal` = round(steps × 0.035) + the day's `workout_kcal` if set, else
the goal's `workout_kcal` on a workout day or `active_rest_kcal` on an active-rest
day, else 0. It is added to calories, and a quarter of it to carbs. The rules and
their test cases are shared with the app in `shared/targets-fixtures.json`.

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

`alembic upgrade head` creates every table and the search indexes (`pg_trgm`, a
full-text and a trigram GIN index on `foods.description`). The loader does not
create anything: it refuses to load a database that is not at the migration head
and tells you to run the upgrade.

The loader downloads the three USDA zips to `data/usda/` (cached, gitignored)
and brings both USDA tables up to date in one transaction: a few seconds, plus the
download the first time. It parses each JSON file in memory (peak about 1.5 GB
for the FNDDS file); it is a one-off tool, not a service.

### Reloading

Logs and saved foods reference `foods`, so a load never empties the table:

- a food in the load is inserted, or updated if a value changed;
- a food that is no longer in the load is kept and marked `retired_at`, with its
  portions. Search skips retired foods; lookup by id still returns them. A food
  that comes back is un-retired;
- the portions of the loaded foods are replaced, so their ids change.

A load that would retire more than 10% of the current foods is refused and
changes nothing, because that is what a truncated download looks like. If the
foods are meant to go, run `uv run python -m kalo.usda.load --allow-retire`.

Loading the same releases again rewrites no food row (about half a second after
the files are parsed) and takes no table lock, so the API keeps serving.

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

### Importing a Cal AI export

`kalo/calai.py` imports the food log from a Cal AI "Summary Report" PDF into
`food_logs`, under one user. It needs `pdftotext` (`brew install poppler`).

```sh
uv run python -m kalo.calai report.pdf --user <users.id> --tz America/Los_Angeles           # check only
uv run python -m kalo.calai report.pdf --user <users.id> --tz America/Los_Angeles --write   # import
```

Each entry becomes a custom log of 1 serving with the report's values (the report
has no amounts and no USDA link), which the app shows as a hand-written entry and
pulls on its next sync. `--tz` is the zone the report's times are in. Nothing is
written unless every day's entries add up to the report's "Calories eaten". An entry
is skipped when the user already has a custom log with the same day, time and name
(deleted ones too, so a deletion sticks), so a newer all-time export adds only what
is new. An entry renamed in the app since is imported again. In the hour repeated
when daylight saving ends, the report doesn't say which 1:30am it was, so both get
the first one. Workouts, weight and
profile pages are not imported.

## API

FastAPI over these tables (`app/`), through SQLAlchemy 2.0: sync sessions on
the psycopg 3 driver. Migrate and load the database first (above). It refuses to
start against a database that is not at the migration head, with the same message
as the loader.

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

That exposes the API to the whole network. The food data is public, but anyone
on the network can also register a device (below), so use it on a network you
trust, and close registration (`ALLOW_REGISTRATION=false`) once your phone has registered.

CORS: any origin may call the API (`Access-Control-Allow-Origin: *`) with `GET`,
`POST`, `PUT`, `PATCH` or `DELETE` and the `Authorization` and `Content-Type` headers,
because the web build and the Expo web dev server call it from another origin.
Cookies are never used (credentials are off): a user is identified only by the
bearer token the client sends itself.

### Identity

Users are anonymous for now: an install registers once and keeps the token.

```sh
curl -X POST localhost:8000/api/v1/devices -H 'Content-Type: application/json' \
  -d '{"platform": "ios", "app_version": "1.0.0"}'
# 201 {"user_id": "3f0e6c0a-…", "token": "kalo_…", "timezone": "UTC"}
#     (platform: ios | android | web; every field optional; timezone is the one stored: the IANA name
#     sent, or UTC when none was sent or the server does not know it)

curl localhost:8000/api/v1/me -H 'Authorization: Bearer kalo_…'
# 200 {"user_id": "3f0e6c0a-…", "timezone": "UTC", "created_at": "…"}

curl -X PATCH localhost:8000/api/v1/me -H 'Authorization: Bearer kalo_…' \
  -H 'Content-Type: application/json' -d '{"timezone": "America/Los_Angeles"}'
# 200 {"user_id": "3f0e6c0a-…", "timezone": "America/Los_Angeles", "created_at": "…"}
```

- The timezone is the user's calendar: "today" (the default day of `/food-logs`,
  `/nutrition/daily` and `/goals`) is today in that zone. Registration may send it
  (`"timezone": "Europe/Paris"`); without it, or with a name the server does not know,
  it is UTC (registration never fails over it). The app sends it at registration and
  `PATCH`es it when the device's zone changes. `PATCH` answers 422 for a name not in
  the server's IANA database (`zoneinfo.available_timezones()`, names are case-sensitive).

- The token (`kalo_` + 43 characters) is shown once, in that 201. The server keeps
  only its SHA-256, so a lost token cannot be recovered: register again.
- Every other user endpoint takes `Authorization: Bearer <token>` and resolves the
  user from it. No endpoint accepts a user id.
- A missing, malformed, unknown or revoked token is 401 with `WWW-Authenticate: Bearer`.
- Registration needs no token, so it is limited to 20 an hour per client address
  (429 with `Retry-After` above that). Two things to set when the API is deployed:
  - The address is the connection's peer. Behind a reverse proxy that is the
    proxy itself, so all clients would share the 20. Start uvicorn with
    `--proxy-headers --forwarded-allow-ips <the proxy's address>` so it uses the
    forwarded client address. Name the proxy: with `*`, any client could send its
    own forwarded address and get around the limit.
  - The count is kept in the server process. With several workers or instances,
    limit at the proxy as well.
- `ALLOW_REGISTRATION=false` closes registration: `POST /api/v1/devices` is 403
  (`registration is closed on this server`) and creates nothing, before the body is read or the
  limit counts. Default `true`. Tokens already issued keep working.
- To revoke a token, set `user_tokens.revoked_at`. There is no endpoint for it yet.

In the code, services write into the request's session and never commit; a route
that writes ends with one `session.commit()` (`app/api/deps.py`).

### Sync (the app)

The phone is the source of truth for what the user logs. It keeps its entries on
the device and copies them here with one endpoint, which pushes local changes and
pulls what changed on the server:

```sh
curl -X POST localhost:8000/api/v1/sync -H 'Authorization: Bearer kalo_…' \
  -H 'Content-Type: application/json' -d '{"cursor": null, "changes": {}}'
# 200 {"cursor": 42, "has_more": false,
#      "changes": {"food_logs": [...], "saved_foods": [...], "goals": [...], "daily_activity": [...]},
#      "rejected": []}
```

- **Push:** `changes` holds rows of the four synced tables. A food log is keyed by
  its `id` (a UUID the client makes), a saved food by `fdc_id`, a goal by
  `effective_date`, a day by `activity_date`. A deletion is the key with
  `updated_at` and `deleted_at`. A field added later (a goal's `source`,
  `workout_kcal`, `active_rest_kcal`; a day's `day_type`, `workout_kcal`) may be
  left out and gets its default, so an older app still syncs; a row replaces the
  whole stored row, so such an app's edit resets them.
- An app from before `daily_activity` pushes its days as `daily_steps` keyed by
  `log_date`: they are still accepted (a rejection names them as sent), but a pull
  only ever returns `daily_activity`.
- **The newer edit wins,** by the row's `updated_at`, which is the phone's clock.
  A time more than 5 minutes ahead of the server's is clamped. A phone whose clock
  is behind can still lose to an older edit made elsewhere: acceptable while one
  person uses one phone.
- **One bad row never fails the batch.** It is listed in `rejected` with a short
  reason (`invalid quantity`, `not_found`, `unknown_food`, …).
- A log whose `fdc_id` the server does not have is stored as a custom entry, not
  lost. A log id that belongs to another user is rejected `not_found`.
- For a row pushed here, a 0 for fiber, sugar or sodium is stored as NULL when the
  food itself does not report that nutrient: the app cannot tell the two apart.
- **Pull:** the user's rows with `rev` above `cursor`, at most 500 a call; call
  again with the returned cursor while `has_more`. The rows this request wrote are
  not sent back; a pushed row that lost to a newer copy is.
- More than 500 rows in one request is 413, and so is any request body over 2 MB,
  refused by its `Content-Length` before it is read. The whole request is one transaction,
  and it locks the user's row first, so one user's changes are numbered in the
  order they commit.

### Logs, totals, goals and recent foods (other clients)

For clients other than the app, such as the planned ChatGPT integration. They
write through the same code as sync, so a log, goal or day made, edited or deleted
here reaches the phone on its next pull. All need the bearer token; a missing,
deleted or another user's log is 404. Unknown keys in a body are 422.

| Endpoint | What it does |
| --- | --- |
| `POST /api/v1/food-logs` | `{"fdc_id": 2709224, "quantity": 150}` logs 150 g: the name and values are copied from `foods`. Without `fdc_id` it is a custom entry and needs `name` and `values` (unit `serving` by default, or `g`). 201; the same `id` again is 200 with the stored row. An unknown `fdc_id` is 422 |
| `GET /api/v1/food-logs?date=YYYY-MM-DD` | `{"logs": [...]}` for that local day, newest first. `date` defaults to today in the user's timezone |
| `PATCH /api/v1/food-logs/{log_id}` | Any of `name`, `quantity`, `log_date`, `logged_at`, `values` (any subset of nutrients). Values are per 100 g or per serving, so a change of quantity scales a typed-over value |
| `DELETE /api/v1/food-logs/{log_id}` | Soft delete. 204, repeatable |
| `GET /api/v1/nutrition/daily?date=` | `{"date", "totals", "unknown", "goal", "steps", "activity", "target", "remaining", "log_count"}`. A nutrient a log does not report adds 0 and is counted in `unknown`. `goal` is the latest one on or before the day. `activity` is the day's `{steps, day_type, workout_kcal}` (`steps` repeats its steps, for older clients). `target` is the goal adjusted for the activity, with `adjustment_kcal`; `remaining` is target − totals (negative when over). Both are null with no goal. An empty day is zeros |
| `GET /api/v1/goals?day=` | The goal in force that day (default today); 404 when there is none |
| `PUT /api/v1/goals/{effective_date}` | The whole goal from that day on: the seven targets, `steps`, `goal`, and optionally `source`, `workout_kcal`, `active_rest_kcal` (left out = `manual`, 0, 0) |
| `PUT /api/v1/daily-activity/{activity_date}` | The whole day: `steps`, and optionally `day_type` and `workout_kcal` (left out = null) |
| `POST /api/v1/goals/suggest` | `{"sex", "age", "height_cm", "weight_kg", "goal"}` to suggested `{"calories", "protein_g", "carbs_g", "fat_g"}` (Mifflin–St Jeor). Stores nothing |
| `GET /api/v1/foods/recent?limit=20` | The user's distinct logged foods, most recent first, as search items plus `grams` (the last amount) and `logged_at` |
| `GET /api/v1/foods/barcode/{code}` | A packaged food by barcode, from Open Food Facts: see "Barcodes" below |

A log in a response carries `values` (its own, per 100 g or per serving),
`food_values` (the database food's when it was logged), `totals` (the generated
columns) and `rev`.

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
     {"id": 89118, "description": "1 slice", "gram_weight": 6.0},
     {"id": 89121, "description": "1 linear inch", "gram_weight": 15.0},
     {"id": 89117, "description": "1 banana", "gram_weight": 126.0},
     {"id": 89119, "description": "1 cup", "gram_weight": 150.0},
     {"id": 89120, "description": "1 cup, mashed", "gram_weight": 225.0}
   ]},
  {"fdc_id": 2705660, "description": "Banana split", "data_type": "Survey (FNDDS)", "brand_name": null,
   "calories_per_100g": 199.0, "protein_per_100g": 2.42, "carbs_per_100g": 32.6, "fat_per_100g": 6.88,
   "fiber_per_100g": 1.0, "sugar_per_100g": 24.2, "sodium_mg_per_100g": 97.0,
   "portions": [{"id": 77981, "description": "1 banana split", "gram_weight": 490.0}]}
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
   {"id": 89118, "description": "1 slice", "gram_weight": 6.0},
   {"id": 89121, "description": "1 linear inch", "gram_weight": 15.0},
   {"id": 89117, "description": "1 banana", "gram_weight": 126.0},
   {"id": 89119, "description": "1 cup", "gram_weight": 150.0},
   {"id": 89120, "description": "1 cup, mashed", "gram_weight": 225.0}
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

### Barcodes

`GET /api/v1/foods/barcode/{code}` (bearer token) looks a packaged food up on
[Open Food Facts](https://openfoodfacts.org) (OFF). The app logs it as a custom
entry in grams: OFF products have no `fdc_id`.

```sh
curl localhost:8000/api/v1/foods/barcode/737628064502 -H 'Authorization: Bearer kalo_…'
```

```json
{"code": "0737628064502", "name": "Thai Peanut Noodle Kit", "brand": "Simply Asia",
 "nutrients_per_100g": {"calories": 385.0, "protein_g": 9.6, "carbs_g": 71.2, "fat_g": 7.7,
                        "fiber_g": 1.9, "sugar_g": 13.5, "sodium_mg": 288.0},
 "serving": {"label": "0.333 PACKAGE (52 g)", "grams": 52.0}, "source": "openfoodfacts"}
```

- The code is an EAN-8, UPC-A, EAN-13 or GTIN-14 with a valid check digit
  (spaces ignored); anything else is 422. It is normalised so each product has
  one spelling: UPC-A gets a leading 0, a GTIN-14's leading 0 is dropped. The
  response's `code` is the normalised one. UPC-E (8-digit short UPC) is not expanded.
- `brand` and `serving` may be null, and so may fiber, sugar and sodium. Sodium
  is in mg (OFF reports grams). Calories come from kJ ÷ 4.184 when OFF has no kcal.
  A serving is OFF's `serving_quantity` in g or ml (ml counted as grams); with no
  unit, only when `serving_size` reads like grams ("52 g").
- 404 `{"detail": {"reason": "not_found"}}` when OFF does not have it, or
  `{"detail": {"reason": "incomplete", "name": …}}` when it has no name or lacks
  one of calories, protein, carbs and fat (the same rule as the USDA foods).
- Answers are cached for every user in `barcode_products` (migration
  `0005_barcode_products.py`): a found product for 30 days, a miss for 1 day.
  When OFF is down, times out or refuses, a stale cached answer is served; with
  none it is 503 `{"detail": "product lookup unavailable"}`.
- OFF allows 15 product reads a minute per IP, shared by every user of the
  server, so the server calls OFF at most 12 times a minute (only cache misses
  count). Over that, a lookup is served from a stale cached answer, else 503
  with `Retry-After`. Each user may also look up 60 barcodes an hour (cached
  ones count; 429 with `Retry-After` above that). Like registrations, both
  counts are kept per process, or in Postgres with `RATE_LIMITS=db` (see "Deploy on Vercel").
- `OFF_BASE_URL` and `OFF_USER_AGENT` (`app/settings.py`) set where lookups go
  and the User-Agent OFF asks for.

Product data from Open Food Facts (openfoodfacts.org), available under the Open
Database License (ODbL).

## ChatGPT (MCP)

With `PUBLIC_URL` set, the API also serves an MCP server at `/mcp` and a small OAuth 2.1
authorization server, so ChatGPT can read and write the user's log. Without it, neither exists.

| Variable | |
| --- | --- |
| `PUBLIC_URL` | the public https origin (the ngrok domain), no trailing slash; `http://localhost:<port>` for local tests |
| `KALO_SECRET` | 32+ characters (`openssl rand -hex 32`); signs the sign-in page and the DCR client ids |
| `OAUTH_CLIENT_IDS`, `OAUTH_REDIRECT_URIS` | default to ChatGPT's; see `app/settings.py` |
| `ALLOW_REGISTRATION` | `false` once your phone has registered (default `true`); see "Identity" |

**Run it on the Mac** (ngrok's free static domain; `brew install ngrok`, `ngrok config add-authtoken …` once):

Put the settings in `backend/.env` (gitignored; start from `.env.example`), not on the command
line, where they end up in your shell history:

```sh
# backend/.env
DATABASE_URL=postgresql://kalo:kalo@localhost:5432/kalo
PUBLIC_URL=https://<your-domain>.ngrok-free.app
KALO_SECRET=<openssl rand -hex 32>
ALLOW_REGISTRATION=false
```

```sh
cd backend
uv run --env-file .env uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips 127.0.0.1
ngrok http 8000 --url https://<your-domain>.ngrok-free.app --traffic-policy-file ../ops/ngrok-policy.yml
```

`--proxy-headers` makes the sign-in rate limit see the caller's address rather than ngrok's. The
traffic policy (`ops/ngrok-policy.yml`) makes only `/mcp`, `/oauth/*` and `/.well-known/*` public;
the app keeps using the API on the local network as before. The app does the same on its own: a
request whose `Host` is `PUBLIC_URL`'s host (any port or case) and whose path is not `/mcp`, `/mcp/…`,
`/oauth/…` or `/.well-known/…` is a plain 404, so the REST API, `/docs` and `/openapi.json` stay off
the public host even if ngrok is started without the policy. Requests on any other host (`localhost`,
the Mac's LAN address the phone uses) are unaffected. (With an `http://localhost` `PUBLIC_URL`, for
local testing, there is no public host and nothing is hidden.)

**Registration:** register the phone first (start the server once with `ALLOW_REGISTRATION=true`,
or without the line, and open the app so it registers), then set `ALLOW_REGISTRATION=false` and
restart. From then on nobody else, on the LAN or anywhere, can create a user. To register a new
phone, reopen registration the same way, let it register, and close it again.

**Pairing codes:** only type a pairing code into a ChatGPT sign-in page you started yourself (by
adding the connector, above). Someone who sends you a sign-in link and asks for your code is asking
for access to your log.

**If `KALO_SECRET` was ever typed inline** (on a command line, so it is in your shell history),
replace it with a new one (`openssl rand -hex 32`) in `.env` and restart. That invalidates open
sign-in pages and the client ids handed out by `POST /oauth/register` (a client registered that way
registers again); nothing else: connections, access and refresh tokens and device tokens keep
working.

**Database password:** `docker-compose.yml` uses `kalo` unless `POSTGRES_PASSWORD` is set (in the
shell or in `backend/.env`, which docker-compose reads). Postgres applies it only when it creates
the data volume; for an existing one, change it with
`docker exec kalo-db psql -U kalo -d kalo -c "ALTER USER kalo PASSWORD '<new>'"`. Either way, put the
same password in `DATABASE_URL`.

**Connect:** in the app, Goals → Connect ChatGPT → Get code. In ChatGPT on the web: Settings → Apps &
Connectors → Advanced → Developer mode, then add a connector with the URL `<PUBLIC_URL>/mcp` and OAuth.
ChatGPT opens Kalo's sign-in page: enter the code (10 minutes, single use). Untick "also log, edit and
delete" for a read-only connection. Disconnect in the app revokes it on ChatGPT's next request.
Connecting ChatGPT again replaces its earlier connection.

Sign-in tries are limited to 10 per 15 minutes per address, and wrong codes to 1000 an hour from
everyone (8-character codes that last 10 minutes: about a one-in-a-billion chance of a guess). The
per-address limit needs uvicorn's `--proxy-headers`: without it every caller is ngrok's address and
shares one allowance. Locking the owner out would take wrong codes from about 25 addresses at once.

**How it works:**
- Discovery: `/.well-known/oauth-protected-resource/mcp` (RFC 9728) and
  `/.well-known/oauth-authorization-server` (RFC 8414); `/mcp` without a token is a 401 that points at them.
- Clients: ChatGPT's client ID metadata document (fetched once a day, nothing else is fetched) or
  `POST /oauth/register` (stateless, HMAC-signed client ids). Redirects only to allowlisted `https://chatgpt.com/` URIs.
- Authorization code + PKCE S256, codes single use for 60 s. Access tokens 1 h, refresh tokens
  90 days, rotated on use; a replayed code revokes the connection. Scopes `nutrition:read` and
  `nutrition:write`. Tokens are stored hashed, in their own tables: `/api/v1` never accepts them,
  and `/mcp` never accepts a device token.
- Tools (`app/mcp/tools.py`): `search_foods`, `get_recent_foods`, `get_daily_macros`,
  `get_nutrition_history` (read); `log_food`, `log_custom_food`, `update_food_log`,
  `delete_food_log`, `update_daily_goal` (need `nutrition:write`). They call the same services as
  the REST routes, so a change gets a new `rev` and reaches the phone on its next sync. Dates are in
  the user's timezone (`users.timezone`).

App-facing endpoints (device token), with or without `PUBLIC_URL`:

```sh
curl -X POST localhost:8000/api/v1/pairing-codes -H "Authorization: Bearer $TOKEN"
# 201 {"code": "K7QM-4XPA", "expires_at": "…"}      (429 over 10 an hour)
curl localhost:8000/api/v1/connections -H "Authorization: Bearer $TOKEN"
# 200 {"connections": [{"id", "client_name", "scopes", "created_at", "last_used_at"}]}
curl -X DELETE localhost:8000/api/v1/connections/<id> -H "Authorization: Bearer $TOKEN"   # 204
```

## Deploy on Vercel

One Vercel project (free Hobby plan) serves the web app and the API on one origin,
`https://<project>.vercel.app`, with the database on Neon (free plan, added from the Vercel
Marketplace). The Mac stops being the server: no ngrok, no uvicorn, no docker.

**How it is put together** (`vercel.json` at the repo root, Vercel
[Services](https://vercel.com/docs/services), in beta on all plans):

- `web`: the repo root. Vercel runs `npm ci`, then `npx expo export --platform web` with
  `EXPO_PUBLIC_API_URL` set to `PUBLIC_URL`, then, when the app has a service worker (`public/sw.js`, from the
  home-screen web app change), `node scripts/sw-manifest.mjs dist` (writes `dist/sw-files.json` and stamps a
  build id into `dist/sw.js`; the build fails if the worker exists but the script doesn't), and serves `dist/`
  from its CDN.
  Without `PUBLIC_URL`, or if that script is missing or fails, the build fails rather than ship a
  web app without its API or with a stale service worker. Every path that is not
  a file gets `index.html` (the app is a single-page export, `app.json` `web.output: "single"`).
- `api`: `backend/`, a [FastAPI](https://vercel.com/docs/frameworks/backend/fastapi) Vercel Function
  (`app/main.py`, `app`; dependencies from `pyproject.toml` and `uv.lock`, Python from
  `.python-version`). It gets `/api/*`, `/mcp`, `/mcp/*`, `/oauth/*` and `/.well-known/*`, with the
  path unchanged; everything else goes to `web`. With `SERVE_API_PUBLICLY` there is no `/docs`,
  `/redoc` or `/openapi.json` (and those paths are not routed to the API anyway).
- Files in the export (`/sw.js`, `/manifest.json`, the icons, `/assets/**`) are served as files:
  Vercel serves an existing file before applying rewrites, so the `index.html` fallback never
  replaces them. `vercel.json` sets `sw.js` and `sw-files.json` to `no-cache` (a new service worker is picked up on the
  next visit), `manifest.json` to `application/manifest+json`, and `.wasm` to `application/wasm`.
- The lifespan runs per instance (Vercel supports FastAPI lifespan events): it connects once,
  checks the schema is at head (one small query) and starts the MCP session manager. The MCP
  endpoint is stateless, so any instance can answer any request. The OAuth client-metadata cache is
  per instance (a cold instance fetches ChatGPT's metadata again; harmless).
- Instances share no memory, so the rate limits are counted in Postgres (`RATE_LIMITS=db`, table
  `rate_limits`, through a small pool of their own so they never wait on the requests' pool), and the
  client's address is the first entry of `x-forwarded-for`, which Vercel overwrites so a client
  cannot spoof it (`CLIENT_IP_HEADER`, on by default when `VERCEL=1`). Food search and lookup, which
  need no token, are limited to 600 an hour per address (429 with `Retry-After`; the app then
  searches its bundled list).
- The function connects to Neon's pooled endpoint (`DATABASE_URL`, PgBouncer in transaction mode)
  with a small pool that checks a connection before use (`DB_POOL_*` below), since Neon closes
  connections when its compute suspends. `DB_POOL_SIZE=0` turns the pool off (a connection per
  request) if that ever misbehaves.

### 1. Create the project

1. Sign up at [vercel.com](https://vercel.com) with GitHub (Hobby plan) and let it see the repo.
2. **Add New → Project**, import the repo. Leave Root Directory as the repo root; Vercel reads
   `vercel.json`. Note the project name: the address will be `https://<project-name>.vercel.app`.
3. Before **Deploy**, open **Environment Variables** and paste this block (Vercel accepts a pasted
   `.env`), with your values. Scope every one to **Production** only (untick Preview and
   Development): a preview would otherwise build the web app against the production URL, and it has
   no database.

   ```sh
   PUBLIC_URL=https://<project-name>.vercel.app
   KALO_SECRET=<the one in backend/.env, or a new one: openssl rand -hex 32>
   SERVE_API_PUBLICLY=true
   RATE_LIMITS=db
   ALLOW_REGISTRATION=false
   OFF_USER_AGENT=Kalo/0.1 (<your email>)
   DB_POOL_SIZE=5
   DB_POOL_PRE_PING=true
   DB_POOL_RECYCLE=300
   DB_CONNECT_TIMEOUT=10
   ```

   `ALLOW_REGISTRATION=false` from the start: your account arrives with the copied data (step 3),
   and a new device joins it with a link code, which works with registration closed.
4. **Deploy.** The web app comes up; the API answers 500 until it has a database (next step).
   Check **Settings → Domains**: if the production domain is not the `PUBLIC_URL` you set, change
   `PUBLIC_URL` to it.
5. Check **Settings → Deployment Protection**: the production domain must stay public (ChatGPT,
   the Shortcut and Safari reach it without a Vercel login). Protecting previews (Hobby's default,
   "Standard Protection") is fine; only use the production domain, never a per-deployment
   `…-<hash>.vercel.app` URL, which that protection covers.

### 2. Add Neon

1. In the project, **Storage → Create Database → Neon** (or the Neon page on the Vercel
   Marketplace → Install), create a Neon account through Vercel, plan **Free**.
2. Region: the one next to the function's (**Settings → Functions → Function Region**; Vercel's
   default is Washington, D.C., `iad1`, so pick AWS US East (N. Virginia)).
3. Connect it to the project for Production. Leave "Create database branch for deployment →
   Preview" unticked (preview branches would start without the copied data).
   Neon adds `DATABASE_URL` (pooled, the one the API uses) and `DATABASE_URL_UNPOOLED` (direct)
   to the project's environment variables, among others.

### 3. Copy the data from the Mac

Stop the Mac's API first (Ctrl-C the uvicorn and ngrok processes) so nothing changes during the
copy, but leave docker running. Then, in `backend/`:

```sh
# backend/.env.neon (gitignored): Neon's direct URL, DATABASE_URL_UNPOOLED (the host without
# -pooler), from the database's page under Vercel → Storage, or Neon's console → Connect with
# connection pooling off
TARGET_DATABASE_URL=postgresql://...@ep-....neon.tech/neondb?sslmode=require&channel_binding=require
```

```sh
uv run --env-file .env.neon python -m kalo.copy_db
```

It migrates Neon to head (Alembic, over the direct connection, as Neon recommends for migrations),
then copies every table from the docker database (`DATABASE_URL`, default the local one) in one
transaction: the USDA foods and portions, your user and device token, logs, goals, activity, saved
foods, ChatGPT connections, pairing codes and the barcode cache, ids, `rev`s and sequences included.
Before writing anything it refuses a target that is the source itself (however the URL is spelled)
or that already has rows in any of those tables, and it prints only
table names, row counts and the host. To redo it, delete and recreate the Neon database (or its
`public` schema) first. The local database only needs to be at any migration up to head; it is
only read.

Then **Deployments → … → Redeploy** the latest deployment, so the function starts against the
migrated database.

### 4. Verify

```sh
U=https://<project-name>.vercel.app
curl -sI $U/ | head -1                                        # 200, the web app
curl -s -o /dev/null -w '%{http_code}\n' $U/goals             # 200 (any app route serves index.html)
curl -s "$U/api/v1/foods/search?q=banana&limit=1"             # 200, JSON from the USDA foods
curl -s $U/api/v1/me                                          # 401 {"detail":"missing bearer token"}
curl -s -X POST $U/api/v1/devices                             # 403 registration is closed
curl -s $U/.well-known/oauth-authorization-server             # "issuer" is $U
curl -s $U/.well-known/oauth-protected-resource/mcp           # "resource" is $U/mcp
curl -s -i -X POST $U/mcp | head -1                           # 401 (needs a ChatGPT token)
curl -s -o /dev/null -w '%{http_code}\n' $U/docs              # 200 but the web app, not Swagger
# The next two need the home-screen web app (service worker) change:
curl -sI $U/sw.js | grep -iE '^(content-type|cache-control)'  # text/javascript, no-cache (not index.html)
curl -sI $U/sw-files.json | grep -iE '^(content-type|cache-control)'  # application/json, no-cache
curl -sI $U/manifest.json | grep -i '^content-type'          # application/manifest+json
curl -sI $U/apple-touch-icon.png | grep -i '^content-type'   # image/png
curl -sI $U/icon-192.png | grep -i '^content-type'           # image/png
curl -sI $U/icon-512.png | grep -i '^content-type'           # image/png
# a .wasm file: its path is in the export (find dist/assets -name '*.wasm' after a local build)
curl -sI $U/assets/<path>.wasm | grep -i '^content-type'     # application/wasm
```

Then the app: run Expo Go against the new API (`EXPO_PUBLIC_API_URL=$U npx expo start` in the repo
root). It keeps its device token, which was copied, so it sees all its data. Add the iPhone web app
by opening `$U` in Safari, Share → Add to Home Screen, and link it to your account from the app
(Goals → Link another device).

### 5. Reconnect ChatGPT

ChatGPT's connection is bound to the old URL. In ChatGPT, remove the old Kalo connector, add one
with the URL `$U/mcp` (OAuth), and sign in with a new pairing code from the app (Goals → Connect
ChatGPT). In the app, disconnect the old connection if it is still listed.

### Later changes

- Every push to `main` deploys. A change with a new migration: migrate Neon before the deploy that
  needs it (until then the API refuses to start: the schema check):
  `uv run --env-file .env.neon sh -c 'DATABASE_URL="$TARGET_DATABASE_URL" alembic upgrade head'`
- Reloading the USDA foods, likewise:
  `uv run --env-file .env.neon sh -c 'DATABASE_URL="$TARGET_DATABASE_URL" python -m kalo.usda.load'`
- Logs: Vercel → the project → Logs (the API's), Observability.

### Retire the Mac setup

Once the checks above pass and the phone works against `$U`:

- Stop uvicorn (`:8000`/`:8001`) and ngrok for good; remove any login item or script that starts
  them. The ngrok domain can be released in the ngrok dashboard.
- Keep the docker database a while as a backup (`docker compose stop` in `backend/`), then
  `docker compose down` (add `-v` to delete its data volume once you no longer want it).
- `backend/.env` (the tunnel's `PUBLIC_URL`) is no longer used; keep `KALO_SECRET` only in Vercel.

**Settings used only by this deployment** (`app/settings.py`): `SERVE_API_PUBLICLY` (the whole API
on `PUBLIC_URL`'s host; default false keeps the tunnel's public-host guard), `RATE_LIMITS`
(`memory` default, `db`), `CLIENT_IP_HEADER`, `DB_POOL_SIZE` (default 10, `0` = no pool),
`DB_POOL_PRE_PING`, `DB_POOL_RECYCLE`, `DB_CONNECT_TIMEOUT`. Their defaults leave the local setup as
it was (apart from the food-search limit, which applies everywhere, in memory by default).

## Layout

```
app/
  main.py              create_app(url=None), engine lifespan, CORS, 503 handler
  api/deps.py          DbSession, CurrentUser (the user of the request's bearer token)
  api/v1/foods.py      food search and lookup, barcode lookup, and their validation
  api/v1/devices.py    POST /devices (register), GET /me
  api/v1/sync.py       POST /sync (the app pushes and pulls)
  api/v1/food_logs.py  food-log create, read, edit, delete
  api/v1/nutrition.py  GET /nutrition/daily
  api/v1/goals.py      GET /goals, PUT /goals/{date}, POST /goals/suggest, PUT /daily-activity/{date}
  api/v1/connections.py  pairing codes, ChatGPT connections (list, disconnect)
  api/oauth.py         the OAuth authorization server: discovery, sign-in page, token, register
  mcp/                 the MCP server (/mcp): server.py, tools.py, auth.py (access tokens -> user)
  settings.py          PUBLIC_URL, KALO_SECRET, the OAuth allowlists, OFF_BASE_URL, OFF_USER_AGENT,
                       ALLOW_REGISTRATION, and the deployment switches (SERVE_API_PUBLICLY, RATE_LIMITS,
                       CLIENT_IP_HEADER, DB_POOL_*, DB_CONNECT_TIMEOUT)
  schemas/             Pydantic request and response models (foods, users, logs, log_api)
  models/foods.py      SQLAlchemy Food and FoodPortion
  models/user_data.py  User, UserToken, FoodLog, UserGoal, DailyActivity, SavedFood
  models/oauth.py      PairingCode, OAuthGrant, OAuthCode, OAuthToken
  models/barcodes.py   BarcodeProduct (the Open Food Facts cache)
  models/limits.py     RateLimit (the shared rate-limit counts)
  services/foods.py    ranked search SQL, portions_for (a page's portions), get_food, get_portions
  services/users.py    tokens (made, hashed, looked up), register_device
  services/logs.py     how one pushed row is applied: last write wins, the food-log rules
  services/sync.py     the push per table and the pull; upsert_row for the REST goal and day routes
  services/targets.py  a day's target and what remains, suggested goals (pure)
  services/log_queries.py  a day's logs and totals, the goal and activity on a date (and over a range), recent foods
  services/log_writes.py, goal_writes.py, daily.py  log and goal writes, a day's summary and history (REST and MCP)
  services/oauth.py, pairing.py  OAuth clients, codes, tokens and grants; pairing codes
  services/barcodes.py normalize, fetch_off (Open Food Facts), lookup (the cache)
  services/limits.py   rate limits in Postgres (RATE_LIMITS=db), make_limiter
  db/session.py        engine (pool settings), session dependency
alembic.ini
migrations/
  env.py
  versions/            0001_foods_and_portions.py: the USDA tables, checks, indexes
                       0002_user_data.py: users, tokens, logs, goals, steps, saved foods
                       0003_activity_targets.py: goal source and day amounts; daily_steps -> daily_activity
                       0004_oauth.py: pairing codes, OAuth grants, codes and tokens
                       0005_barcode_products.py: the Open Food Facts lookup cache
                       0006_rate_limits.py: rate-limit counts shared by serverless instances
kalo/
  db.py                database_url(): the one source of the connection URL
  calai.py             import a Cal AI report PDF's food log
  copy_db.py           copy every row into an empty database (the move to Neon)
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
