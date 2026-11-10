# Home Specification

## Overview
- **Target route/file:** `src/app/index.tsx` (the only main screen; no tab bar)
- **Screenshots:** `docs/design-references/home-macros.jpeg` (+ `home-micros`, `home-activity`, `home-add-menu`)
- **Navigation:** root of the stack; pushes Daily Score, Entry detail, and the + menu screens
- **States:** carousel page 1 (macros), page 2 (micros + Health Score), page 3 (steps, burned, water), + menu open, any past day selected

## Layout (pt; reference is 706px = 393pt, ×1.8)
Header (Kalo logo · score pill · streak pill) → week strip (5 past days, today, tomorrow) → horizontal 3-page carousel (cards 24pt from the edges, 10pt gaps) → dots → "Recently uploaded" → entry cards. Black + button floats bottom right.

## Components
- **Score pill**: 33pt tall, 2pt `good` border, target icon + score (18pt semibold). Opens Daily Score.
- **Streak pill**: white with card shadow, orange flame + 16. Display only.
- **Week strip**: 35pt rings, 1.8pt stroke; past days red (`bad`) off budget, green (`good`) within 90–110%, dashed when empty; today shows a black progress arc; tomorrow is faint and disabled; the selected day sits on a white rounded card.
- **Calorie card** (148pt): eaten 39pt bold + "/budget" 15pt muted; "Calories eaten ⌃⌄" toggles to "Calories left"; chips +rollover / +burned; 107pt black ring with a flame.
- **Nutrient cards** (143pt, three per row): value 16.5pt + "/goal" 10pt, label 12.5pt muted, 66pt ring in the nutrient colour.
- **Health Score card** (142pt): title, x/10, green bar, 3-line summary.
- **Steps / Calories burned** (216pt, two up) and **Water** (75pt) with "Log Water".
- **Entry card** (120pt, `entry` fill, 16pt radius): name 15pt, time 11pt, "N Calories consumed", macro row.

All values were refined in the diff loop; tokens in `tailwind.config.js` / `src/lib/tokens.ts`.

## Interactions
| Element | Affordance | Mechanism | On-device / Backend |
| --- | --- | --- | --- |
| Week strip day | select | shared `useSelectedDay` | on-device |
| Calories eaten ⌃⌄ | toggle | eaten ↔ left | on-device |
| Score pill | navigate | `/daily-score` | on-device |
| Carousel / dots | swipe / tap | paging ScrollView | on-device |
| Log Water | add | `setWater(cups + 1)` | on-device |
| Entry card | tap / swipe left | `/entry/[id]` / `remove(id)` | on-device |
| + button | open menu | AddMenu: Saved foods, Food Database, Scan food | on-device |

## Mock Data
First launch is seeded to the reference (2543/3429 kcal, 174/322/59 g, fiber 13, sugar 54, sodium 3791 mg, 5,782 steps, +200 rollover, score 89, 7/10). See `src/lib/data.ts`.
