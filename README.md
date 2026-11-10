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
