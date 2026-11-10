---
name: full-review
description: >
  The default code review: Claude Code's /code-review (correctness bugs) fused with
  ponytail-review (safety, load, missing tests, speed, and lean / over-engineering),
  merged into one numbered report. Use for any review: "review this", "code review",
  /code-review, and before every commit (the commit gate requires it).
argument-hint: "[staged | <commit/branch/PR> | <path>]  (default: staged changes)"
---

# Full review (code-review + ponytail)

Review target: what the user names; otherwise the **staged** changes
(`git diff --cached`); if nothing is staged, the uncommitted changes.

## 1. Run both passes on the same target

1. **Correctness pass:** invoke the `code-review` skill on the target at `medium`
   effort (or the level the user gave). Keep its verified findings. If that skill
   is not available (e.g. in CI), do the correctness pass yourself: real bugs only,
   each with a concrete failing input.
2. **Ponytail pass:** follow the `ponytail-review` skill on the same target
   (`~/.claude/skills/ponytail-review/SKILL.md`; in CI,
   `.github/claude-review/ponytail-review.md`): read the connected code, not only
   the diff; check bug, risk, scale, missing test, speed, and lean
   (delete / reuse / stdlib / yagni / merge / split).

The passes overlap on bugs. That is intended; the merge step removes duplicates.

## 2. Merge into one report

- De-duplicate: same file and same root cause = one finding, tagged `[both]`.
- Every finding uses ponytail's four parts: **What this is / Problem / Fix /
  If we skip it**, plus a `file:line` anchor and a concrete failing case. No case,
  no finding.
- Group: **Must fix** (bug, security, data loss, breaks at expected load),
  **Should fix** (untested risky logic, real slowness, duplication, code that
  should not exist), **Nice to have**. Number findings across groups.
- Tag each finding with its source: `[code-review]`, `[ponytail]` or `[both]`.

Start with `What this change does:` (2-3 sentences). End with:
- `Verdict: Ship.` or `Verdict: fix N and M first.`
- `Lean: -<N> lines possible.` when lean findings exist.
- `Not checked:` one line, if something mattered and could not be checked.

Lists findings and changes no code unless the user asks for fixes.

## 3. Commit gate (local only)

When this review ran for a commit and has no **Must fix** items (or the user chose
to commit anyway after seeing them), run
`node ~/.claude/hooks/ponytail-commit-gate.mjs --mark`, then commit.
