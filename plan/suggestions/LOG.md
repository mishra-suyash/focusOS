# Suggestions log

This log records what each "convert `plan/suggestions/` to a plan and implement" run found and did.
The plan for the work is `plan/20.FocusOS-v2-Suggestions-Followup.md`.

**How to rerun:**
1. Read this log.
2. Diff `plan/suggestions/*.md` against the **Processed up to** line below. Look for new files, new
   item numbers, new changelog lines and new status notes.
3. Plan and build only what is new or still `open`.
4. Add a run section and update the item table.
5. Never edit the suggestion files themselves; the owner writes those.

**States:**
- `pre-existing`: built before this log started.
- `done`: built in the run named.
- `open`: not built yet.
- `no change`: deliberately left as it is, with the reason.

**Processed up to:** `1.focusos-suggestions.md`, changelog line *"2026-11-28: Added 1.6 … and 1.7 … 3.2 ✅, 1.4 partly."* (status check 15:05).

---

## Items

| Item | Suggestion | State | Where | Verified |
|---|---|---|---|---|
| 1.1 | `move_block` leaves `plannedMinutes` stale | pre-existing (348065f) + done run 1 | Run 1: `blockView` returns `plannedMinutes` on every sitting, so the fix can be seen | MCP in-process: a 55-min block moved to 40 min reads `plannedMinutes: 40` |
| 1.2 | Past blocks show `upcoming` | pre-existing (348065f) | `pastBlockOutcome` in views | owner ✅ |
| 1.3 | Calendar side effects not named | pre-existing (create/remove) + done run 1 (updates) | `describePush` lists updates with `was` (renamed from, moved from). See note A. | pure only: test account has no Google Calendar |
| 1.4 | Pass "done" with nothing in it | done run 1 | Skim continue/done needs ≥1 contribution; Read grasped/persevere needs ≥3 key points. Stop endings exempt (drop, park, set aside, return later). `paper-pass-section.tsx` | browser (test account): button gated, releases at 3 points; Return later still finishes |
| 1.5 | Missed blocks can't be skipped or rescheduled | done run 1 | `skip_block`, `reschedule_block` (same day or later date); `ScheduleSlot.rescheduledTo` | MCP in-process + `/plan/day` in browser |
| 1.6 | Workload "overrun" on a planned reading day | done run 1 | `lib/planned-work.ts` + `computeRequiredMinutes`: every planned sitting counts, targets are netted (plan/20 §2) | verify script; app and MCP agree (267 min) |
| 1.7 | Goal pace ignores paper reading | done run 1 | `Paper.goalId`; `goalWeekPace`, Workload netting, `/plan/week` goal remainder; `update_paper goalId`, `list_goals.linkedPapers`, paper page "Counts toward goal" | MCP + browser (set and clear) |
| 2.1 | Paper objectives on blocks | pre-existing (348065f) | | owner ✅ |
| 2.2 | apply_plan / shift_blocks / add_session | pre-existing (348065f) | | owner ✅ |
| 2.3 | Commitments / routine from chat | pre-existing (348065f) | | |
| 2.4 | Tentative meetings | pre-existing (348065f) | | |
| 2.5 | defer_revision | pre-existing (348065f) | | |
| 2.6 | Compact `get_week` | pre-existing (348065f) | `get_week compact: true`, which the file still listed as open | MCP in-process |
| 2.7 | commit_week | pre-existing (348065f) | | |
| 3.1 | Day shape | pre-existing (348065f) | | |
| 3.2 | Hard-deadline alerts | pre-existing (348065f) | | owner ✅ |
| 3.3 | Habit sittings name a paper | done run 1 | Open reading sittings show "Reading · next up · Read: <paper>" in the app, and `nextUp` in MCP. Derived, not stored. | browser `/plan/day` + MCP |
| 3.4 | Lead-up planner | pre-existing (348065f) | `plan_lead_up` | |
| 3.5 | Sittings cap | pre-existing (348065f) | | owner ✅ |
| 3.6 | Meeting prep | pre-existing (348065f) | `get_meeting_prep` | |
| §4 Up next after the evening cutoff | | no change | Up next goes quiet outside the day-shape windows. The owner hasn't set a day shape; with one set (`set_day_shape` or Settings) it stops at 18:00. Without a shape, the working window is deliberately not a cutoff (`workWindowsOf`). | |
| §4 Implementation goal unflagged | | pre-existing (348065f) | goal-pace warning (dashboard + `get_overview`) | |
| §4 `builtDay` side effect | | pre-existing (348065f) | `builtDay` note; `calendar: "skip"` | |
| §4 Duplicate task + block events | | done run 1 | A task with a block in the push window isn't pushed as its own event. See note B. | pure path only: no Calendar on test account |
| §4 Citation text in titles | | pre-existing (348065f) | `cleanPaperTitle` / `citation` | |

**Note A, the "25 updated" on other dates:**
- **Cause:** `348065f` changed a block's event description from `slot.note` to `note || undefined`. For every block with an empty note, the stored hash stopped matching, so the first push after that deploy updated every FocusOS block event in the window once.
- **It doesn't recur.** Link docs now also record title and date, which is what lets updates say what changed.

**Note B, first push after deploy:**
- The first push removes the due-date events of tasks that have a block in the next 14 days.
- They were FocusOS-created, so removing them is allowed, and the push names them.
- A task's event comes back when its block is removed or rolls out of the window.

---

## Run 1 — 2026-11-28 (uncommitted, on main)

**Built:** 1.1 (view), 1.3 (update names), 1.4 (requirement), 1.5, 1.6, 1.7, 3.3, and the §4 duplicate events.

**Workload formula change (1.6):**
- **New formula:** required = planned sittings + targets less what those sittings already book.
- **What changes for the owner:**
  - A missed reading day now adds to catch-up hours, and the streak follows the new number.
  - Stored day snapshots are not rewritten.

**Files:**
- New: `lib/planned-work.ts`, `scripts/verify-suggestions-followup.ts`.
- Changed:
  - Workload: `lib/loadindex.ts`, `lib/goals.ts`, `lib/gamify.ts`, `lib/courses.ts`, `lib/patches.ts`, `lib/objectives.ts`.
  - MCP: `lib/mcp/{views,instructions,activity}.ts`, `lib/mcp/tools/{read,write,schedule}.ts`.
  - Calendar: `lib/google-calendar-admin.ts`.
  - App: `components/paper-pass-section.tsx`, `components/plan/block-inspector.tsx`, `components/workday-session-provider.tsx`, `hooks/use-live-load-index.ts`, `app/(app)/{dashboard,plan/week,papers/[id]}/page.tsx`.
  - Other: `lib/admin-dailyloop.ts`, `lib/templates/builtin/day-templates.ts`, `types/index.ts`, `scripts/verify-chunking.ts`, `package.json`.

**Checks:**
- Passed: `tsc`, `eslint` and the verify scripts (chunking, planning-feedback, tracking, weekplan, google-calendar, patches, reading, next-action, suggestions-followup).
- MCP tools run in-process on the test account, with snapshot and restore.
- In the browser on the test account:
  - Workload on the dashboard;
  - `/plan/day` labels;
  - paper page goal select and pass gating;
  - `/plan/week` renders.

**Not checked:**
- Google Calendar pushes. The test account isn't connected, so update names, the task dedupe and leaving out rescheduled originals are only covered as code paths.

**Left for the owner:**
- Link LithOS / Janus to "Literature / SOTA track" (`update_paper goalId`, or the paper page select). Until then 1.7 changes nothing for them.
- Set a day shape if Up next should go quiet after 18:00.
- Older thin passes (LithOS Skim, Agentix Read) stay "done (thin)". There's no backfill form yet.
