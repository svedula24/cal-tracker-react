# Screen graph: Kalo

## Screens & states
| Screen | Route | States (screenshot) |
| --- | --- | --- |
| Home | `/` (tab) | macros page (home-macros), micros page (home-micros), activity page (home-activity), add-menu open (home-add-menu) |
| Daily Score | `/daily-score` (transparent modal) | default (home-daily-score) |
| How Daily Score Works | `/score-info` | designed |
| Progress | `/progress` (tab) | designed |
| Groups | `/groups` (tab) | coming soon |
| Profile | `/profile` (tab) | designed (goals editor) |
| Food Database | `/food-database` | designed (search + add) |
| Saved foods | `/saved-foods` | designed |
| Log exercise | `/log-exercise` | designed |
| Scan food | `/scan-food` | coming soon (camera/AI = backend) |
| Entry detail | `/entry/[id]` | designed (edit name/servings, delete) |

## Navigation
- **Tabs** (persistent floating pill bar): Home · Progress · Groups · Profile.
- Black round **+ FAB** beside the bar opens the AddMenu overlay (tiles: Log exercise, Saved foods, Food Database, Scan food); FAB turns into X.
- Everything else is a push on the root Stack; Daily Score is a transparent modal.

```
Home ──score pill──▶ Daily Score ──"How Daily Score Works"──▶ Score info
Home ──entry card──▶ Entry detail
Any tab ──+ FAB──▶ AddMenu ──▶ Log exercise | Saved foods | Food Database | Scan food
Scan food ──"Search instead"──▶ Food Database
Food Database / Saved foods ──add──▶ back to Home (selected day)
```
