# QA decisions: status

Branch `qa/decisions-2026-11-05`, on top of `qa/overnight-2026-11-01`. Nothing is pushed or merged.

"App" means the flow was run in Chrome on the test account. "Scripts" means only typecheck, lint, build and `verify:*`,
which never touch Firestore or render a page. The last full gate passed on 2026-11-05 at `320e0dc`: `tsc`, eslint,
`next build` and all 13 `verify:*`. The one commit after it passed `tsc`, eslint on its file, `verify:timeline` and `verify:chunking`.

| Item | Commit | Checked |
|---|---|---|
| F2 day pills | 37fdc1b | App |
| F3 estimate label | c2e5379 | App |
| F4 overdue marker | 61329d8 | App |
| F5 README | 41ac464 | Docs only |
| F15 dialogs | aa18a65 | App (survey) |
| F31 paper status | d63ce73 | Scripts |
| F39 reviewed today | 62d923d | App |
| F14 24:00, F27 Add block | 0e7c5c7 | App |
| F20 Start day banner, F41 default template | 0e7c5c7 | Scripts |
| F6 deadlines, F13 sitting cap | 8622722 | App |
| F7 milestones | 8622722 | Scripts |
| F21 template split | 8622722, plus the drag fix on this branch | App (tray Apply and a real drag) |
| F19, F22 Workload | dcb9b15 | Scripts for the non-working-day rule |
| F32 modules | dcb9b15 | App (Goals off) |
| F11 fixed clash | fa5bb75 | App |
| F16, F29, F37, F42 release | 4851c06 | App, including Undo |
| F25, F26 routine | bc7fdb2 | App, including Undo |
| F18 streak, F28 day end | 92a5cd3, f458ade | App, with a temporary 23:00 day end |
| F33 server rollup, close-day cron | 92a5cd3, 320e0dc | Scripts. **Never executed** |

## Found while checking F28 and F21

- The Now card read the logical day's schedule against the clock, so it showed yesterday's blocks until the day ended. Fixed in f458ade.
- Reminder and cue keys used the logical day. Fixed in f458ade, not exercised live.
- `close-day` at 23:40 UTC could fire before a 05:00 day end, because Hobby crons fire anywhere in their hour. Moved to 01:00 UTC in 320e0dc.
- Dragging a template and accepting an AI one skipped the split, and "Add & save as template" saved the split copy.

## Still open

- **F33:** `close-day` and the rollup have never run. Locally they would write for every active user of the shared Firebase project, so they weren't run. Check the first runs after deploy.
- **Close-day outside IST:** the cron is an hour clear of the latest day end in IST. Elsewhere it can land inside a day that ends late, which closes the day before it. A run landing either side of the boundary on successive nights could skip a day.
- **F20:** the banner only shows on a day with no saved schedule, which the test account didn't offer.
- **Test account, 11-01:** still has three stacked Sleep blocks. Locked blocks can't be deleted and Clear all keeps them, so it needs a direct data fix. Past day, no effect on anything current.

## Test account changes on 2026-11-05

- Day end set to 23:00 for testing, then back to Midnight.
- One 1-minute test session against Thursday's "Prep: Midsem exam", stored with `dayKey` 11-04 and `slotDateKey` 11-05.
- Research Day applied to 11-22 and 11-29.
- The duplicate "Prep: Problem set 3" on 11-02 removed.
