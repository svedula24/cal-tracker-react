# cal-tracker-react

Calorie tracker UI built with Expo / React Native (Expo Router, NativeWind,
TypeScript). The screens are generated from screenshots with the `clone-app` skill
(from [ai-app-cloner](https://github.com/Birkenpapier/ai-app-cloner), MIT). UI only:
there is no backend. Data the app keeps is stored on the device.

## Run

Needs Node 20.19.4+ (22 recommended).

```bash
npm install
npm run web        # or: npm run ios / npm run android
npm run verify     # web export + headless check that every route renders and flows pass
```

## Food search

Food Database searches the bundled foods plus two online databases, called
straight from the app (no Kalo backend):

- **USDA FoodData Central**: generic foods, lab-measured, per 100 g. Get a free
  key at https://api.data.gov/signup and put it in `.env` as
  `EXPO_PUBLIC_USDA_API_KEY` (see `.env.example`). Without one the app uses
  USDA's `DEMO_KEY`, which allows only a few searches per hour.
- **Open Food Facts**: packaged and branded products (ODbL, crowdsourced). Its
  search API does not allow browser requests, so it works in the iOS/Android
  app but not in the web preview, where results come from USDA only.

## Build the UI from screenshots

1. Put screenshots of the app's states in `docs/screenshots/` (naming tips in
   [docs/screenshots/README.md](docs/screenshots/README.md)).
2. In Claude Code, run `/clone-app`. It uses the Playwright MCP from `.mcp.json`
   to screenshot the clone and diff it against the originals.

## Review and CI

- **Locally:** every commit Claude makes is gated on the `full-review` skill
  (Claude Code `/code-review` + [ponytail-review](https://github.com/DietrichGebert/ponytail), MIT).
- **GitHub Actions:** `ci.yml` typechecks and runs `npm run verify`.
  `claude-review.yml` posts a full review on every PR and push to `main`. It needs
  the repo secret `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`; run
  `/install-github-app` in Claude Code to set it.
