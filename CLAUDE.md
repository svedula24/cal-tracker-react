@AGENTS.md

## This repo
- Scope: UI only (Expo / React Native) built with the `clone-app` skill. No backend,
  no `--backend` mode; data actions are on-device (`src/lib/store.ts`) or stubbed.
- Reviews and the commit gate come from the user-level defaults (`full-review`).
  The CI copies live in `.github/claude-review/`; refresh them with `/bootstrap-repo`
  after changing the user-level skills.
