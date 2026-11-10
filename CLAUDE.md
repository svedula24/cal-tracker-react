@AGENTS.md

## This repo
- Scope: the Expo / React Native UI in `src/` (built with the `clone-app` skill) plus
  `backend/`, a Python (uv) project with Postgres (docker-compose) and the USDA loader;
  FastAPI comes later. The app is not wired to the database yet: data actions are
  on-device (`src/lib/store.ts`) and Food Database searches a bundled copy of USDA
  FoodData Central's generic foods (`src/data/usda-foods.json`, `npm run build:foods`).
  See `backend/README.md`.
- Reviews and the commit gate come from the user-level defaults (`full-review`).
  The CI copies live in `.github/claude-review/`; refresh them with `/bootstrap-repo`
  after changing the user-level skills.
