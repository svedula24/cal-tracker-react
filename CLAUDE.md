@AGENTS.md

## This repo
- Scope: the Expo / React Native UI in `src/` (built with the `clone-app` skill) plus
  `backend/`, a Python (uv) project with Postgres (docker-compose): a FastAPI +
  SQLAlchemy 2.0 foods API in `backend/app/` (search and lookup, with portions), the
  schema in Alembic migrations (`backend/migrations/`) and the USDA loader in
  `backend/kalo/usda/`. Data actions are on-device (`src/lib/store.ts`). Food Database
  searches the API when `EXPO_PUBLIC_API_URL` is set (`src/lib/foodSearch.ts`), and
  otherwise, or when the API cannot be reached, a bundled copy of USDA FoodData Central's
  generic foods (`src/data/usda-foods.json`, `npm run build:foods`). See `backend/README.md`.
- Reviews and the commit gate come from the user-level defaults (`full-review`).
  The CI copies live in `.github/claude-review/`; refresh them with `/bootstrap-repo`
  after changing the user-level skills.
