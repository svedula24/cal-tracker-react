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
| Scan food | `/scan-food` | coming soon (camera/AI = backend) |
| Entry detail | `/entry/[id]` | designed (edit name/servings, delete) |

## Navigation
- **Stack** with Home as the root. No tab bar.
- Black round **+ button** (bottom right) opens the AddMenu overlay: Saved foods, Food Database, Scan food; the button turns into X.

```
Home ──score pill──▶ Daily Score ──"How Daily Score Works"──▶ Score info
Home ──entry card──▶ Entry detail
Home ──+ button──▶ AddMenu ──▶ Saved foods | Food Database | Scan food
Scan food ──"Search food database"──▶ Food Database
Food Database / Saved foods ──add──▶ back to Home (selected day)
```
