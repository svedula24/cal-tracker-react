# Kalo

A personal calorie and macro tracker. Log what you eat from USDA's food database, a barcode or by
hand; see each day's calories, protein, carbs and fat against your goals; and let ChatGPT read and
log for you. Kalo runs on your iPhone as a home-screen web app, with its server on Vercel and its
database on Neon, both on free plans.

- **App:** Expo / React Native (SDK 58, Expo Router, NativeWind, TypeScript) in `src/`. The same
  code builds for iOS, Android and the web; the web build is what goes on the iPhone.
- **Server:** Python (FastAPI, SQLAlchemy 2.0, Alembic, Postgres) in `backend/`. Details, the
  API and the deploy steps are in [backend/README.md](backend/README.md).

## What it does

- **Log food:**
  - Search about 13,400 generic USDA foods. The amount can be in grams, ounces or the food's own portions ("1 banana").
  - Scan a packaged food's barcode with the camera; the product comes from Open Food Facts.
  - Write an entry by hand.
  - Save favorites.
- **Home:**
  - The day's calories and macros against its target, plus fiber, sugar, sodium and a health score.
  - Steps, and the day type (workout, active rest, rest), which add to the day's calorie budget.
  - A strip of days that scrolls back week by week; tap any day to see or log it.
- **Goals:** targets you set, or ones Kalo suggests from your body and goal. They're dated, so a past day keeps the target it had.
- **Phone first:** everything is saved on the device at once and works offline. When a server is set, it syncs in the background.
- **ChatGPT:** connect Kalo in ChatGPT (web, Developer mode). ChatGPT can then:
  - read your day and history;
  - search foods;
  - log, edit and delete entries;
  - change your goal.

  It signs in with a one-time code from the app (Goals → Connect ChatGPT). Read only or read and write is your choice.
- **Apple Health steps:** an Apple Shortcuts automation sends each day's step count to Kalo (Goals → Apple Health steps; the full recipe is in [docs/health-shortcut.md](docs/health-shortcut.md)).
- **More than one device:** Goals → Link another device shows a one-time code. Enter it on the new install and it opens the same account. If you linked the wrong way, you can switch back.

## Use it on your iPhone

Kalo is installed from Safari as a web app: it's free, never expires and isn't on the App Store.

1. Deploy it once: see **Deploy on Vercel** in [backend/README.md](backend/README.md#deploy-on-vercel). You need free Vercel and Neon accounts. The steps cover copying your data across, closing registration and reconnecting ChatGPT.
2. On the iPhone, open `https://<your-project>.vercel.app` in Safari → Share → **Add to Home Screen**.
3. Open Kalo from the home screen. To keep an existing account, choose "Already use Kalo on another device? Link this device" and enter a code from that device (Goals → Link another device).
4. Optional: set up the Apple Health steps Shortcut, and connect ChatGPT at `https://<your-project>.vercel.app/mcp`.

It opens offline too: the service worker caches the whole app, including the bundled food list.
The barcode scanner uses the camera, and iOS may ask for camera permission again each time the
app starts.

## Develop

Needs Node 20.19.4+ (`npm test` needs Node 22.18+, since it imports TypeScript directly), and for the server Docker and [uv](https://docs.astral.sh/uv/).

```bash
npm install
npm run web            # or: npm start, then Expo Go on a phone (npm run ios / android)
npm test               # unit tests (Node's built-in runner)
npm run verify         # web export + Playwright: every route renders and the flows pass
npm run verify:api     # the same with a mocked API: sync, ChatGPT, linking, Health, the web app offline and the camera scanner
```

With no `EXPO_PUBLIC_API_URL` the app runs on its own: the bundled USDA list, everything on the
device, no sync. To run against a local server, start the backend ([backend/README.md](backend/README.md#run-it):
`docker-compose up -d`, `uv run alembic upgrade head`, load the USDA foods, `uv run uvicorn app.main:app`)
and put `EXPO_PUBLIC_API_URL=http://<your Mac's LAN address>:8000` in `.env.local`.

`npm run build:foods` refreshes the bundled USDA list (`src/data/usda-foods.json`) from USDA's
releases; `npm run build:web` makes the deployable web export (with the service worker's file list).

### Layout

| Path | What |
| --- | --- |
| `src/app/` | screens (Expo Router) |
| `src/components/` | UI pieces (Home cards, the day strip, the scanner, …) |
| `src/lib/` | data and sync (`store.ts`, `data.ts`, `sync/`), API clients, nutrition maths, design tokens |
| `public/` | the web app's shell: `index.html`, manifest, icons, service worker |
| `backend/` | the server: API, MCP server for ChatGPT, OAuth, migrations, USDA loader |
| `e2e/`, `tests/` | Playwright flows and unit tests |
| `docs/` | the Health Shortcut recipe; screenshots and research from the UI's origin |
| `vercel.json` | the Vercel deployment (web app at `/`, the API beside it) |

## Reviews, CI and merging

- **CI** (`.github/workflows/ci.yml`):
  - backend: ruff and pytest against Postgres;
  - app: typecheck, unit tests, `verify` and `verify:api`.
- **Claude review** (`.github/workflows/claude-review.yml`) runs on every PR. A PR whose review passes (no Must fix or Should fix items) and whose checks pass **merges itself**. So don't stack PRs on each other's branches: a stacked PR merges into its parent branch, not `main`. Branch from `main`.
- **Locally**, commits made with Claude Code go through the `full-review` skill.

## Origin

The UI was first built from screenshots with the `clone-app` skill, from
[ai-app-cloner](https://github.com/Birkenpapier/ai-app-cloner) (MIT). `docs/screenshots/` and
`docs/research/` are from that step. Design decisions since then are in the project's Notion
(Architecture Decision Log). USDA FoodData Central data is public domain; Open Food Facts data is
[ODbL](https://opendatacommons.org/licenses/odbl/).
