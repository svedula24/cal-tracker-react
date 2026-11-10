# cal-tracker-react

Calorie tracker UI built with Expo / React Native (Expo Router, NativeWind,
TypeScript). The screens are generated from screenshots with the `clone-app` skill
(from [ai-app-cloner](https://github.com/Birkenpapier/ai-app-cloner), MIT). UI only:
there is no backend. Data the app keeps is stored on the device.

## Run

Needs Node 20.19.4+ for the app; `npm test` needs Node 22.18+ (it imports TypeScript directly).

```bash
npm install
npm run web        # or: npm run ios / npm run android
npm run verify     # web export + headless check that every route renders and flows pass
npm test           # unit tests: USDA data mapping and food search (Node's built-in runner)
```

## Food database

Food Database searches every generic food in USDA FoodData Central (Foundation
Foods, SR Legacy and FNDDS, about 13,400 foods), bundled in the app as
`src/data/usda-foods.json` (1.4 MB). It is loaded the first time Food Database
opens, not at app start (on web it is a separate chunk; if that fetch fails the
screen offers Retry). Search runs offline; there are no API calls or keys. USDA
data is public domain.

`npm run build:foods` downloads the USDA releases, trims them to what Kalo uses
(name, per-100 g calories, macros, fiber, sugar and sodium, and the food's USDA
portions with their weights) and rewrites the file. Tapping a food opens the
Nutrition screen, where the amount can be entered in any of its portions, in
ounces or in grams; nutrients are per100g × grams × quantity / 100. Update the release names in `scripts/build-usda-foods.mjs`
when USDA publishes new data. Branded/packaged products are not included yet.

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
