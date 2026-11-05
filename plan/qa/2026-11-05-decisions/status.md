# QA decisions: status

Branch `qa/decisions-2026-11-05`, on top of `qa/overnight-2026-11-01`. Nothing is pushed or merged.

"App" means the flow was run in Chrome on the test account. "Scripts" means only typecheck, lint, build and `verify:*`,
which never touch Firestore or render a page. The last full gate passed on 2026-11-05 at `b1a0548`: `tsc`, eslint,
`next build` and all 13 `verify:*`.

| Item | Commit | Checked |
|---|---|---|
| F2 day pills | 37fdc1b | App |
| F3 estimate label | c2e5379 | App |
| F4 overdue marker | 61329d8 | App |
| F5 README | 41ac464 | Docs only |
| F15 dialogs | aa18a65 | App (survey, reading check-in, wrap-up) |
| F31 paper status | d63ce73 | App |
| F39 reviewed today | 62d923d | App |
| F14 24:00, F27 Add block | 0e7c5c7 | App |
| F20 Start day banner | 0e7c5c7 | App, on a day with its schedule removed for the check |
| F41 default template | 0e7c5c7 | App, with the account's templates removed for the check. Saved from the timeline editor; the classic editor's form wasn't run |
| F6 deadlines, F13 sitting cap | 8622722 | App |
| F7 milestones | 8622722 | App (two milestones of an 8h goal offer 4 × 60m each) |
| F21 template split | 8622722, 9dda9cd | App (tray Apply and a real drag) |
| F19, F22 Workload | dcb9b15 | App (Thursday made non-working: Workload and the brief drop from 376 to the 187 planned) |
| F32 modules | dcb9b15, f633945, b1a0548 | App (Courses, Revise, Goals, Workload off, each with an on control). The rollup's proposals and the daily-insight gate weren't run |
| F11 fixed clash | fa5bb75 | App |
| F16, F29, F37, F42 release | 4851c06 | App, including Undo |
| F25, F26 routine | bc7fdb2 | App, including Undo |
| F18 streak, F28 day end | 92a5cd3, f458ade, 7d15ec8 | App, with a temporary 23:00 day end |
| F33 server day frame, `closeFinishedDay` | 92a5cd3 | Run once against the test account only. Picked 11-04 and honoured stored `dayKey` and `slotDateKey` |
| `closeFinishedDays` | 4fd2631 | Run twice against the test account only. Closed 11-03 then 11-04; the second run changed nothing |
| Evening rollup, cron routes, the 01:00 UTC schedule | 92a5cd3, 320e0dc, 4fd2631 | Not run. The rollup and daily insight call AI, and the routes act on every active user |

## Found while checking F28 and F21

- The Now card read the logical day's schedule against the clock, so it showed yesterday's blocks until the day ended. Fixed in f458ade.
- Reminder and cue keys used the logical day. Fixed in f458ade. Checked live with a temporary 23:00 day end: the page read Wednesday, and the lead and start cues each fired once, keyed to Thursday. A sitting's end cue wasn't waited for.
- `close-day` at 23:40 UTC could fire before a 05:00 day end, because Hobby crons fire anywhere in their hour. Moved to 01:00 UTC in 320e0dc.
- Dragging a template and accepting an AI one skipped the split, and "Add & save as template" saved the split copy. Fixed in 9dda9cd. The AI path was run with the AI call stubbed: the day got 09:00-10:00 and 10:00-11:00, and the template kept its 120 minutes.
- Past midnight, the Day score read a finished day as running, and the wrap-up's timed-out list hid blocks later than the clock. Fixed in 7d15ec8. Only a day end later than midnight could reach either. End day was already safe: it never reads the clock.
- Courses paired the logical day with the clock's minute. Fixed in 7d15ec8. Checked live: every course's done and scheduled line reads the same with the two days apart as at midnight.

## Found in the final pass

- The morning overview, the evening rollup's proposals and the calendar ignored a module that's off. Fixed in f633945.
- Insights off still spent AI on the daily cron, and Workload off still showed in the floating widget. Fixed in b1a0548. Alerts keep running.
- A submitted assessment still asked for prep in Next action, the morning overview, Revise's order and the AI prompts. Fixed in 2f68d44. `verify:next-action` covers Next action; the others share the same one-line filter and weren't run.
- Close-day could skip a day outside IST. Fixed in 4fd2631, below.

## Choices to review

- **Close-day catch-up (4fd2631):** taken as the recommended option while the owner was away. A day's final record now stores `closedAt`, and each run closes the last two days without one, oldest first. On the first production run the day before yesterday has no `closedAt`, so its stored record is recomputed once with the current rules.
- **Insights off skips the daily cron (b1a0548):** taken under "off means fully off". Turning Insights back on brings the next day's insight back.

## Observed, not changed

- Start day on a template saved from a real day lists its Sleep, meals and class as "skipped" because the same blocks are already there. It's accurate but reads like a problem.
- Saved templates keep planner sittings, so "Tuesday class day" brought "Prep: Problem set 3" back after that assessment was submitted.
- There is no control for working days. `workingWindow.daysOfWeek` stays at its Monday to Saturday default unless written directly.

## Hydration reminder

Checked live with a 1-minute interval: one notification and banner, no repeat on the next tick, and "Did it" counted it. The break reminder wasn't run; it shares the same path.

## Still open

- **After deploy:** check the first `close-day`, evening rollup and daily insight runs. None has run on this branch, and they act on every active user of the shared Firebase project.
- **Owner review:** nothing is pushed or merged.
- **Not covered:** the admin panel (its settings are global), notifications in a truly hidden tab (automated tabs always read visible) and Monday-morning behaviour of a committed week (no way to move the app's clock).

## Test account changes on 2026-11-05

- Day end set to 23:00 for testing, then back to Midnight.
- One 1-minute test session against Thursday's "Prep: Midsem exam", stored with `dayKey` 11-04 and `slotDateKey` 11-05.
- Research Day applied to 11-22 and 11-29.
- The duplicate "Prep: Problem set 3" on 11-02 removed.
- The stale Sleep 00:00–07:00 on 11-01 removed with a one-off Admin SDK script scoped to this account, because locked blocks can't be deleted in the app. The Sleeps there no longer overlap.
- `closeFinishedDay` wrote a stored record for 11-04.
- `closeFinishedDays` rewrote the records for 11-03 and 11-04 and set `closedAt` on both.
- One test Read sitting on the Offline RL paper, logged as 20 minutes on 11-05 by a fast completion, with its check-in answered "Not yet".
- Backed up and restored by a one-off Admin SDK script scoped to this account: settings, 11-05's schedule and day record, and the day templates. The temporary schedule, templates and milestones are gone. 11-04's day record had a temporary session, since removed.
