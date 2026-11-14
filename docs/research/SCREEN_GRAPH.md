# Screen graph: Kalo

One main screen (Home). Everything else is pushed from it. The reference's tab
bar (Home / Progress / Groups / Profile) and its "Log exercise" action were
removed on purpose: the app is a single screen.

## Screens & states
| Screen | Route | States (screenshot) |
| --- | --- | --- |
| Home | `/` | macros page (home-macros), micros page (home-micros), activity page (home-activity), add-menu open (home-add-menu) |
| Daily Score | `/daily-score` (transparent modal) | default (home-daily-score) |
| How Daily Score Works | `/score-info` | designed |
| Food Database | `/food-database` | designed (search + add) |
| Saved foods | `/saved-foods` | designed |
| Scan barcode | `/scan-food` | camera (native) or typed code, looked up through the Kalo server (Open Food Facts); needs EXPO_PUBLIC_API_URL |
| Entry detail | `/entry/[id]` | designed (edit name/servings, delete) |

## Navigation
- **Stack** with Home as the root. No tab bar.
- Black round **+ button** (bottom right) opens the AddMenu overlay: Saved foods, Food Database, Scan barcode; the button turns into X.

```
Home ──score pill──▶ Daily Score ──"How Daily Score Works"──▶ Score info
Home ──entry card──▶ Entry detail
Home ──+ button──▶ AddMenu ──▶ Saved foods | Food Database | Scan barcode
Scan barcode ──found──▶ Nutrition (replaces it); not found / no server ──"Search food database"──▶ Food Database
Food Database / Saved foods ──add──▶ back to Home (selected day)
```
