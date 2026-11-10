# Logging screens Specification (designed, no reference screenshot)

## Overview
- **Routes/files:** `src/app/food-database.tsx`, `src/app/saved-foods.tsx`, `src/app/scan-food.tsx`, `src/app/entry/[id].tsx`
- **Navigation:** pushed from the + menu (AddMenu tiles) or from a Home entry card (`/entry/<id>`). Use `PushedScreen` from `src/components/Screen.tsx` (back chevron + title).
- **Style:** match Home (`docs/design-references/home-*.jpeg`): bg `bg-background` (#F6F6F8), white `rounded-card` cards, black primary buttons (rounded-full, white text, ~52px tall), muted text `text-muted`, system font, generous spacing (px-[22px]). Tokens: `tailwind.config.js` / `src/lib/tokens.ts`. Icons: lucide-react-native.

## Data (all on-device)
- `src/lib/data.ts`: `useEntries()`, `useSavedFoods()`, `newEntry(food, servings, date)`, types `Entry`, `SavedFood`.
- `src/lib/selectedDay.ts`: `useSelectedDay()` → `[day, setDay]` (the day Home shows; log to this day).
- `src/data/foods.ts`: `foods`, `foodById` (~60 foods, per-serving nutrients).
- `src/lib/nutrition.ts`: `formatTime`, `parseDay`, `todayKey`.
- Collections come from `useCollection` (`src/lib/store.ts`): `{ items, add, update, remove }`, persisted, shared across screens.

## Screens
### Food Database (`/food-database`)
- Search `TextInput` (placeholder "Search foods", Search icon, white rounded pill, autofocus) filtering `foods` by name (case-insensitive). Empty query shows all foods.
- Row per food: name, `serving · N cal`, macros line `P g · C g · F g` (use protein/carbs/fat token colors for small icons Drumstick / Wheat / Droplet, like the Home entry card). Bookmark toggle on the right (filled when saved; add/remove in `useSavedFoods`).
- Tap a row → inline bottom sheet / expanded panel: servings stepper (−/+ by 0.5, min 0.5), live calories, **"Add to log"** button → `useEntries().add(newEntry(food, servings, day))` then `router.back()`.
- No results: "No foods match "<query>"" text.
### Saved foods (`/saved-foods`)
- List of saved foods (resolve via `foodById`), same row style; tap → same add flow (servings stepper + "Add to log"). Swipe left to remove (react-native-gesture-handler `ReanimatedSwipeable` from `react-native-gesture-handler/ReanimatedSwipeable`, red "Remove" action) **and** an accessible remove button (accessibilityLabel `Remove <name>`) so it is testable on web.
- Empty state: Bookmark icon, "No saved foods yet", "Tap the bookmark in Food Database to save foods you log often." + button "Browse foods" → `/food-database`.
### Scan food (`/scan-food`)
- `ComingSoon` (from `Screen.tsx`): ScanLine icon, title "Scan food is coming soon", body "Photo recognition needs a camera and an AI service, which this offline version doesn't include. You can search the food database instead." Action button **"Search food database"** → `router.replace('/food-database')`.
### Entry detail (`/entry/[id]`)
- `useLocalSearchParams<{ id: string }>()`; find entry. Missing → "Entry not found" + back.
- Editable name: `TextInput` (accessibilityLabel "Food name") writing `update(id, { name })` on change/blur.
- Time (formatTime), servings stepper (−/+ 0.5, min 0.5) → `update(id, { servings })`.
- Nutrition card: big calories (`nutrients.calories × servings`, rounded) and rows Protein / Carbs / Fat / Fiber / Sugar / Sodium (g, g, g, g, g, mg) × servings.
- **"Delete entry"** red-text button → `remove(id)`, `router.back()`.

## Interactions
| Element | Affordance | Mechanism | On-device / Backend |
| --- | --- | --- | --- |
| Food search | filter | local `foods` | on-device |
| Food row | add | servings + `useEntries().add` | on-device |
| Bookmark | toggle | `useSavedFoods` add/remove | on-device |
| Saved row | swipe / button remove | `remove(id)` | on-device |
| Entry name | editable text | `update(id, {name})` | on-device |
| Entry servings | stepper | `update(id, {servings})` | on-device |
| Entry | delete | `remove(id)` | on-device |
| Scan food | camera/AI | cut, links to Food Database | backend (cut) |

## Text Content (verbatim)
Titles: "Food Database", "Saved foods", "Scan food", "Edit entry". Buttons: "Add to log", "Delete entry", "Search food database", "Browse foods".
