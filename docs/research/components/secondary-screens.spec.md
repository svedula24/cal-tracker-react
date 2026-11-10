# Secondary screens Specification (designed, no reference screenshot)

## Overview
- **Routes/files:** `src/app/(tabs)/progress.tsx`, `src/app/(tabs)/groups.tsx`, `src/app/(tabs)/profile.tsx`, `src/app/score-info.tsx`
- **Navigation:** Progress / Groups / Profile are tabs (floating TabBar already rendered by `src/app/(tabs)/_layout.tsx`; leave `TAB_BAR_SPACE` (from `src/components/TabBar.tsx`) as bottom padding in scroll content). Score info is pushed from the Daily Score sheet ("How Daily Score Works").
- **Chrome:** `TabScreen` (large title) for tabs, `PushedScreen` for score-info — both in `src/components/Screen.tsx`. Also `Card`, `ComingSoon`.
- **Style:** match Home (`docs/design-references/home-*.jpeg`): `bg-background`, white `rounded-card` cards with ~20px padding, numbers bold black, labels `text-muted`, macro colors `protein`/`carbs`/`fat` (tokens in `tailwind.config.js`, runtime hex in `src/lib/tokens.ts` for SVG). System font. lucide icons.

## Data (all on-device)
- `src/lib/data.ts`: `useEntries()`, `useGoals()` → `{ goals, setGoals(patch) }`, `useDay(date)` (totals, budget, burned, score, ...).
- `src/lib/nutrition.ts`: `sum`, `dayKey`, `addDays`, `parseDay`, `Goals` type, `dailyScore`.

## Screens
### Progress (tab)
- Card "Calories, last 7 days": bar chart (react-native-svg) of daily calories for today-6 … today from `useEntries()` (`sum` per day), dashed goal line at `goals.calories`, weekday letters under bars, today's bar black, others `track`-gray darker (#D4D4DA). Value labels optional.
- Card "Daily averages (7 days)": average calories + protein/carbs/fat with small horizontal bars vs goals in macro colors.
- Card "Logged days": "N of 7 days logged".
### Groups (tab)
- `ComingSoon`: Users icon, "Groups are coming soon", "Sharing progress with friends needs an online account, which this offline version doesn't include."
### Profile (tab)
- Card "Goal": segmented Lose / Maintain / Gain → `setGoals({ goal })`.
- Card "Daily targets": rows Calories (kcal), Protein (g), Carbs (g), Fat (g), Fiber (g), Sugar (g), Sodium (mg), Water (cups), Steps — each a numeric `TextInput` (keyboardType number-pad, accessibilityLabel `<Label> goal`) writing `setGoals({ key: Number })` on change when it is a valid positive integer.
- Footer muted text: "Kalo stores everything on this device."
### How Daily Score Works (`/score-info`)
- Explain: score is 0–100 from calories (30%), protein (30%), carbs (20%), fat (20%); each is "On track" between 70% and 115% of its goal; points drop the further outside that band; calories goal = daily goal + rollover + calories burned. Short paragraphs in cards, plus the four weights shown as a small list.

## Interactions
| Element | Affordance | Mechanism | On-device / Backend |
| --- | --- | --- | --- |
| Goal segment | select | `setGoals({goal})` | on-device |
| Target inputs | edit | `setGoals({...})` | on-device |
| Groups | social | cut (coming soon) | backend (cut) |

## Text Content (verbatim)
Titles: "Progress", "Groups", "Profile", "How Daily Score Works".
