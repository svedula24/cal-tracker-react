# Daily Score Specification

## Overview
- **Target route/file:** `src/app/daily-score.tsx` (transparent modal); `src/app/score-info.tsx` (pushed)
- **Screenshot:** `docs/design-references/home-daily-score.jpeg`
- **Navigation:** opened from Home's score pill; "How Daily Score Works" pushes `/score-info`; tapping the dim closes it.

## Layout
Home's header stays bright above the sheet; the dim (black 45%) starts where the sheet starts (safe area + 88pt). Sheet: full width, 26pt radius, 27pt padding.
- "<Month day> • Daily Score" 12.5pt muted, headline 20pt bold, tip 12pt muted (max 2 lines); 83pt green gradient ring with the score (32pt).
- Divider, then four rows (27pt each): label, bar (green on track / red adjust), "eaten/goal", "On track" / "Adjust".
- Divider, info icon + "How Daily Score Works" + chevron.

## Logic (`dailyScore` in `src/lib/nutrition.ts`)
Calories 30%, protein 30%, carbs 20%, fat 20%. On track at 70–115% of goal (calorie goal = daily goal + rollover + burned). 7.5 points lost per percent outside the band. ≥85 "Great balance", 70–84 "Good progress", else "Needs attention". The tip names the two macros furthest below goal.

## Text Content (verbatim, seeded day)
"November 9 • Daily Score", "Great balance", "Shift your next meal toward carbs and fat.", "On track", "Adjust", "How Daily Score Works".
