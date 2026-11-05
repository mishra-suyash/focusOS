# QA decisions, 2026-11-05

Follow-up to `plan/qa/2026-11-01-overnight/final-report.md`. The owner answered its "Needs your decision" list on
2026-11-05. Work lands on `qa/decisions-2026-11-05` (branched from the unreviewed `qa/overnight-2026-11-01`), one commit
per fix, no push, no merge. Status of each item is tracked in `status.md` beside this file.

## The owner's decisions

| Item | Decision |
|---|---|
| F11 fixed-vs-fixed clash | Save everything, both fixed items stay, a banner names the clash. Saving must tolerate the overlap. |
| F26, F25 routine edits | Today and future saved days pick up the new routine. Past days stay. A sitting the new block overlaps is released to "to place", with a notice. Routine blocks stay undeletable (plan/07 D5). |
| F16, F29, F37, F42 finished or dropped work | Sittings from now on leave the plan automatically, with a notice and Undo, committed weeks included. Past ones stay. A day marked off offers Replan for next week too. |
| F28 day boundary | A "My day ends at" setting, default midnight, nothing changes until it's set. Store the day on new sessions so changing the setting never re-files history. |
| F19, F22 Workload | Weekly targets spread over working days. A non-working day requires 0 unless it has planned blocks, and then only those count. Stored snapshots don't change. |
| F32 modules | Off means fully off: Goals off stops goals feeding planner, What's coming and Workload. Data is kept. Applies to any other module with the same gap. |
| F7 milestones | A goal's weekly hours are shared across its milestones due that week. The total never exceeds the target. |
| F21 templates | Long template blocks split into back-to-back sittings when applied. The template itself isn't changed. A leftover below the minimum merges into the previous block. |
| Overnight hook | Removed on 2026-11-05. |

Fixed with the obvious default, no decision needed: F2, F3, F4, F5, F6, F13, F14, F15, F18, F20, F27, F31, F33 (timezone),
F39, F41, and repairing the test account's leftovers.

## Systems each decision touches

### F28 day boundary: two frames, not one
Shifting `todayKey()` alone would break things, because a schedule document is a calendar date and `currentMinute()` is
the clock. A block at 01:00 Thursday lives on Thursday's document even if the logical day is still Wednesday.

- **Logical day** (`todayKey()`, `dateKeyOfIso`, `sessionDayKey`): stats, history, streak, analytics, wrap-up, Start/End
  day, Workload, Revise due, reading log, rollover banner, focus cycle, tasks' due-today.
- **Calendar day** (`scheduleDayKey()`): anything that pairs a schedule document with the clock. Now card and next block,
  timer block follow, `/plan/day` and its now-line, `/plan/week`'s "from now" (`releasableSlots` pairs it with
  `nowMinutes`), `/plan/calendar`.
- **Block coverage** must match sessions to the block's document, not the logical day, or the 60% rule breaks whenever the
  setting is on. New sessions store `slotDateKey`, which also stops a session crossing midnight losing its block. Old
  sessions fall back to the calendar day of `completedAt`.
- **New sessions store `dayKey`.** Old sessions fall back to the calendar day, which is what they were under midnight, so
  setting a boundary re-files nothing.
- **`todayKey(date)` with an argument stays a plain calendar format.** All 12 such call sites convert a real date.
- **Server:** `lib/admin-dailyloop.ts` takes the user's `settings.timezone` and boundary. See F33.
- **Boundary value lives in `lib/dates.ts`,** set from settings and cached in localStorage so the first render after a
  reload is right.
- Default midnight must be a strict no-op: every `verify:*` script must pass unchanged.

### F33 server rollup
Reads `settings.timezone` (default `DEFAULT_TIMEZONE`) and the boundary. Sessions are matched by `sessionDayKey` in that
zone, not `startsWith(UTC date)`. The cron moves after the latest allowed boundary, and rolls up the day that just ended
rather than a day still running. End day still rolls up the current logical day on demand. Takes effect on deploy.

### F18 streak
Depends on F28: a streak holds until the logical day is over. Today not having a session yet doesn't break it. The Workload
card's streak is a different number, so it gets its own label.

### F11 clash
`validateSlots` is the single gate (day page, timeline editor, week accept, template apply). Tolerate overlap only when both
slots are fixed (class, external, `commitment-*`). Check against the furthest-ending earlier slot, not just the previous one,
or a sitting after a fixed overlap escapes detection. Rendering (time grid, week grid) must keep both blocks visible.
`getActiveSlot` returns the first match, which is fine. Banner on `/plan/week` and a note on `/plan/day`.

### F26 routine re-sync
- Lives next to `resyncFutureClassSlots`. Only today and later. On today, a routine block that has already ended stays as
  history; one still running is replaced, or the night-owl case doesn't get fixed.
- The routine page autosaves per keystroke, and an intermediate value must not release sittings. Debounced, flushed on leave.
- Routine yields to fixed items, as everywhere else. Saved days keep `routine-*` ids so `mergeMissingLockedSlots` stays safe.
- Overlapped sittings: released when `releasable` (planner-made, upcoming, unworked). A hand-added or worked block isn't
  destroyed; the routine block steps aside on that day, the same rule `mergeMissingLockedSlots` uses, and the notice says so.
- `plannedMinutes` falls with the removed slots, so the ledger shows them as "to place" with no second record.
- Committed weeks are included, and Replan must exist to re-place the work (shared with F42).
- Undo restores the days and the routine.

### F16, F29, F37 release of finished work
- One function on top of `releasableSlots`' rules, all future days rather than one week, filtered by what finished.
- Triggers: task done, task deleted, course dropped or completed, checkpoint submitted/done/missed, milestone done, goal
  dropped, paused or achieved, paper dropped/shelved/read for its paper sittings.
- Never touched: past days, today's blocks already started, worked or running blocks, hand-added blocks, the locked layer.
- Dropping a course also removes its future class blocks (`course-<id>-*`, via the existing resync path); today's stays.
- Undo restores the exact slots, and only on a day whose slots haven't changed since, so a later edit is never overwritten.
  Reopening the work later doesn't resurrect anything: the planner proposes it again.
- Accounting: minutes leave `plannedMinutes` with the slot, so nothing is re-offered for finished work, and `dismissed`
  isn't touched.

### F42 Replan for a future committed week
Lift the `weekIsCurrent` gate on the Replan entry and the day-off nudge. `releasableSlots` already takes any week.

### F19, F22 Workload
`lib/loadindex.ts` spreads weekly targets over working days. Day off stays 0. A non-working day requires 0 plus planned
blocks only. Floor of 30 only applies when something is required. Snapshots are stored and untouched, so debt history keeps
its old numbers. The goal half (`goalTargetMinutesForDay`) must follow the same rule.

### F32 modules
Goals off: excluded from the week planner's asks and What's coming, Workload, course "goal" bucket, next action. Find every
module read in `settings/features` and check for the same gap.

### F7, F6, F13, F21 sitting and hour bounds
- F7: `ask = goal hours / milestones due this week`.
- F6: dated work never falls back past its due date; it reads "Didn't fit".
- F13: pinned prep is chunked to `maxChunkMinutes`, and `minChunkMinutes` replaces the 15-minute floor where it applies.
- F21: split on apply in every path that applies a template (Start day, `/plan/day`, gallery). The timer's clamp then matches
  the block, so the 60% rule closes on one sitting.
