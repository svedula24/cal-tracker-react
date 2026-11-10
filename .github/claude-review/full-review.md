---
name: full-review
description: >
  The default code review: one pass over the union of the /code-review checklist
  (line scan, removed behavior, callers, language pitfalls, wrappers, reuse,
  simplification, efficiency, altitude, CLAUDE.md conventions) and the ponytail-review
  checklist (bug, risk, load, missing test, speed, lean), reported in ponytail's format.
  Depth scales with the size of the change. Use for any review: "review this",
  "code review", /code-review, and before a major commit (the commit gate requires it).
argument-hint: "[staged | <commit/branch/PR> | <path>]  (default: staged changes)"
---

# Full review (code-review + ponytail checklists, one pass)

One review, not two. Work through the checklist below yourself; do not also invoke
the `code-review` skill. Report format and tone come from ponytail-review
(`~/.claude/skills/ponytail-review/SKILL.md`; in CI,
`.github/claude-review/ponytail-review.md`).

Review target: what the user names; otherwise the **staged** changes
(`git diff --cached`); if nothing is staged, the uncommitted changes.

## 1. Size the change

Count added + deleted lines with `git diff --numstat` on the target. Do not count
Markdown, files under `docs/`, lockfiles or binary files.

- **Small:** 50 lines or fewer in 5 files or fewer.
- **Major:** anything bigger, or any size when the user asks for a full review.

## 2. Checklist (union of code-review and ponytail)

Items marked **[small]** are the only ones a small change gets. A major change gets all.

**Correctness**
1. **Line scan [small]:** read every hunk line by line, then the enclosing function;
   bugs in unchanged lines of a touched function count. Ask what input, state, timing
   or platform makes each line wrong: inverted condition, off-by-one, null/undefined,
   missing `await`, falsy zero, wrong-variable copy-paste, swallowed error, unescaped
   regex. Edge cases: empty, zero, last item, rounding, time zones.
2. **Removed behavior [small]:** for every deleted or replaced line, name the guard or
   behavior it enforced and find where the new code keeps it. A dropped guard, error
   path, validation or covering test is a finding.
3. **Callers and callees:** grep every caller of each changed function. Check for a
   new precondition, changed return shape, new error, or ordering dependency. Flag a
   fix applied in one caller while the shared function stays broken.
4. **Language pitfalls [small]:** the classic traps of the language and framework
   (JS `==` and falsy zero, closure-captured loop var, Python mutable defaults,
   SQL injection, float equality, DST drift).
5. **Wrappers:** a cache, proxy, adapter or decorator must route every method to the
   wrapped object, not back through a global, and forward every method callers use.

**Safety and load**
6. **Risk [small]:** security holes (injection, weak randomness, secrets, unchecked
   user input) and data loss (swallowed errors, writes in the wrong order, no transaction).
7. **Scale:** judge against the expected load in the repo (README, deploy config) and
   say which load you assumed. Check-then-write races, the same work in every process,
   lists or memory that only grow, a query per item, O(n^2) on big input,
   per-process state that must be shared.

**Tests**
8. **Missing test:** risky new logic (a branch, parser, money, security, data write,
   bug fix) with no test that fails when it breaks. One good test, not coverage.

**Speed**
9. **Efficiency:** repeated computation or I/O, independent work run one after another,
   blocking work on startup or a hot path, long-lived closures that keep a large scope
   alive. Big slowdowns are Should fix; small wins are Nice to have.

**Lean and design**
10. **Reuse:** the repo already has this helper. Grep shared and nearby modules, and
    name the path. Also the standard library or platform already does it, or a new
    dependency is added for a few lines.
11. **Simplify:** dead code, unused options, speculative features, redundant or
    derivable state, deep nesting, an abstraction with one implementation, config
    nobody sets, near-copies that must change together, a function doing unrelated
    jobs (split by job, never by line count).
12. **Altitude:** the fix should address the root cause at the right depth. Special
    cases layered on shared code mean the fix is too shallow; name the general change.
13. **Conventions:** read the CLAUDE.md files that govern the changed files (user-level,
    repo root, and any in an ancestor directory). Flag only a clear violation: quote
    the exact rule and the exact line.

## 3. Verify every candidate

- Each candidate needs a concrete case: this input or situation leads to this wrong
  result, or for cleanup, this concrete cost. No case, no finding.
- Re-read the lines and give it one verdict:
  - **CONFIRMED:** you can name the trigger and the wrong result. Quote the line.
  - **PLAUSIBLE:** the mechanism is real but the trigger is uncertain (timing, env,
    a rare but reachable path). Say what would confirm it.
  - **REFUTED:** the code doesn't say that, it's guarded elsewhere, or it is style
    with no effect. Drop it.
- Keep CONFIRMED and PLAUSIBLE, and mark PLAUSIBLE ones as such.
- A shortcut marked with a `shortcut:` (or `ponytail:`) comment that names its limit
  is a decision, not a finding, unless the expected load already crosses it.
- Merge duplicates: same location and same root cause is one finding.
- Major change only: take one last pass over the diff looking only for defects not
  yet listed, such as moved code that lost a guard, config defaults flipped, or test
  setup without matching teardown.
- Propose the smallest fix that works; prefer fixes that delete code.

## 4. Report

**Small change:** `What this change does:` in one sentence, then any Must fix items
with a `file:line` and the failing case, or `Looks good. Ship.`

**Major change:** ponytail's format. Start with `What this change does:` in two or
three sentences. Group as **Must fix** (bug, security, data loss, breaks at the
expected load), **Should fix** (untested risky logic, real slowness, duplication,
code that should not exist, wrong altitude, CLAUDE.md violation) and **Nice to have**.
Number findings across groups and anchor each to `file:line`. Must fix and Should fix
items get the four parts (What this is / Problem / Fix / If we skip it). Nice to have
items get one line each. End with `Verdict:`, plus `Lean: -<N> lines possible.` and
`Not checked:` when they apply.

Lists findings and changes no code unless the user asks for fixes.

## 5. Commit gate (local only)

The gate lets small staged changes through without a review. For a major change,
run this review on the staged diff. When it has no **Must fix** items (or the user
chose to commit anyway after seeing them), run
`node ~/.claude/hooks/ponytail-commit-gate.mjs --mark`, then commit.
