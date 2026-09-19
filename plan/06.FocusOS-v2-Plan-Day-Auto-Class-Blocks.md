# FocusOS v2 — Plan › Day: Automatic Class Blocks

**Status:** Draft for review · **Route:** `/plan/day` · **Companion to:** `FocusOS-v2-Plan-Day-Timeline.md`
**Principle carried over:** additive and non-destructive. No migration, no schema break, old saved days open unchanged.

---

## 0. TL;DR

Class blocks (`type: "class"`) only ever get inserted into a day's schedule from one place: `WorkdaySessionProvider.start()`, fired by clicking "Start day," and only for *today*, and only the first time (no existing `dailySchedules` doc). Every other case — planning a future date, or opening today's timeline before clicking "Start day" — shows an empty grid with no class blocks, nothing locked, nothing to plan around.

This spec closes that gap: whenever the Day Timeline editor opens a date with no saved schedule yet, it locally seeds the grid with that date's class blocks (computed the same way "Start day" already does), before the user ever types or drags anything. Already-saved days are never touched.

---

## 1. Problem

| # | Issue | Evidence |
|---|---|---|
| B1 | Class blocks are generated in exactly one code path: `components/workday-session-provider.tsx`'s `start()`, gated on `!todaySchedule`. | `courseSlotsForDate(courses, today)` called nowhere else in the app. |
| B2 | That path only runs for `today` (`todayKey()`), never for any other date. | `start()` closes over `today` from `todayKey()`; there is no date parameter. |
| B3 | It only runs on the explicit "Start day" click, not on page load. | `start` is a `useCallback` returned from the provider and invoked by whatever UI button calls it — nothing calls it on mount. |
| B4 | The Day Timeline editor (`DayTimelineEditor`/`TimeGrid`) only *locks* an existing `type: "class"` slot from being dragged/resized (D2 in the companion plan) — it never generates one. | No `courseSlotsForDate` import in `day-timeline-editor.tsx`, `time-grid.tsx`, or `app/(app)/plan/day/page.tsx`. |
| B5 | Net effect: plan a day ahead (e.g. next Tuesday) and the grid is just empty — no visual or structural indication that three lectures already occupy part of it, so a block can be dragged/typed directly on top of class time with nothing to refuse it. | Reported directly by user while reviewing the new editor. |

---

## 2. Goals and non-goals

**Goals**

- Opening `/plan/day?date=X` for any date with no saved schedule shows that date's class blocks already in place and locked, matching what "Start day" would have produced for today.
- Works for past, today, and future dates identically — no special-casing "today."
- Zero behavior change for a date that already has a saved schedule, including one saved before this change shipped.
- Zero Firestore writes just from opening the page — matches the existing "Preview writes nothing" principle. The class blocks only get persisted once the user makes their first real edit (which already autosaves the full `slots` array, class blocks included).
- Term breaks stay class-free, exactly as `start()` already handles via `isBreakMode`.

**Non-goals**

- Re-running or reconciling class blocks for a date that already has a saved schedule (e.g. after the user edits their course timetable). Per the "old saved days open unchanged" principle, a saved day's `type: "class"` slots stay exactly what they were saved as; correcting them is a manual edit, not automatic.
- Changing what "Start day" itself does — it keeps merging the chosen day template with class blocks exactly as today, for `today` only.
- Any new UI (no new button, no new setting). This is a default-behavior fix, not a feature toggle.

---

## 3. Design

### 3.1 Where the logic moves

`courseSlotsForDate(courses, dateKey)` (already in `lib/courses.ts`) and `isBreakMode(terms, dateKey)` (already in `lib/terms.ts`) are the same two calls `start()` already makes. Reuse them from the page that hosts the editor rather than duplicating the merge logic:

- `app/(app)/plan/day/page.tsx` already loads `schedule` for the selected `dateKey` via `useUserCollection<DailySchedule>`. It does not currently load `courses` or `terms`.
- Add `useUserCollection<Course>("courses")` and `useUserCollection<Term>("terms")` there (both already used elsewhere in the app the same way, e.g. in `WorkdaySessionProvider`).
- Compute `effectiveInitialSlots`: if a saved `schedule` exists for `dateKey`, use `schedule.slots` unchanged (today's behavior). If it doesn't, and the date isn't a break day, use `courseSlotsForDate(courses, dateKey)` as the starting slots; if it is a break day, use `[]`.
- Pass `effectiveInitialSlots` into `DayTimelineEditor` instead of always assuming "no schedule ⇒ empty day."

### 3.2 Why local-only, not a write

`DayTimelineEditor` already treats its `schedule` prop as the one-time seed for `useUndoStack`'s initial value (`useUndoStack<ScheduleSlot[]>(sortedSlots(schedule?.slots ?? []))`) and only calls `scheduleSave` after a real local edit (commit/undo/redo), never on mount. Seeding it with computed class blocks instead of `[]` needs no change to that contract: the very first drag, keyboard action, or accept-a-suggestion the user makes will autosave the *whole* `slots` array — class blocks included — through the exact same path that already persists everything else. No new Firestore write is introduced by opening the page.

This also means a date the user never visits, or visits but never edits, never gets a `dailySchedules` doc written for it just because it has classes — matching the existing "gaps-as-free-time (no forced scheduling)" and "Preview writes nothing" principles the companion plan calls out as things to keep.

### 3.3 Locking

No change needed here — `TimeGrid` and `BlockInspector` already refuse to start a move/resize gesture on `slot.type === "class"` (D2, companion plan §4.3/§5), and that check is purely on the slot's `type` field, not on how the slot got there. A locally-seeded class block is indistinguishable from one "Start day" wrote to Firestore, so it's locked immediately, before any save happens.

### 3.4 Old editor

The old stacked-forms editor (still reachable behind `planDayTimeline` being off — see `lib/features.ts`) is out of scope. It has never generated class blocks itself either; leaving it as-is is consistent with not touching it further per the companion plan's D7 (old editor is legacy, being phased out, not actively developed).

---

## 4. Edge cases

| Case | Behavior |
|---|---|
| Date has a saved schedule already (even an empty `slots: []`) | Unchanged — `schedule.slots` wins, exactly as today. Never overwritten with recomputed class blocks. |
| Date falls in a term break (`isBreakMode`) | No class blocks seeded, matching `start()`'s own `onBreak ? [] : courseSlotsForDate(...)` branch. |
| Two courses overlap in time | Both render, laid out in lanes — the existing legacy-overlap handling (`laneLayout`, companion plan A13/§4.2/§11) already covers overlapping slots regardless of source. |
| User deletes an auto-seeded class block before making any other edit | Allowed like any other edit once one exists locally (delete isn't blocked, only move/resize on a still-present class block is) — the resulting `slots` array (without it) is what gets saved on the next autosave, same as deleting a class block from an already-saved day today. |
| Course schedule changes after a date's schedule was already saved | No retroactive change — matches "old saved days open unchanged." The user would need to delete and re-add manually, same as any other stale block today. |
| No courses at all / `courses` module disabled | `courseSlotsForDate` returns `[]` either way; day opens empty exactly as it does today. |
| Courses exist but no term is configured (or none active for the date) | `isBreakMode` treats "no active term" as a break (`!active` → true), so no class blocks seed even though courses exist — matches `WorkdaySessionProvider.start()`'s identical gate today, so this is consistent behavior, not a regression. A user who wants class blocks on a date needs an active semester term covering it, same as "Start day" already requires. |

---

## 5. Phased rollout

Single phase — this is a bug-fix-sized change to one data flow, not a new surface.

| Phase | Scope | Done when |
|---|---|---|
| **Only phase** (S) | Load `courses`/`terms` in `app/(app)/plan/day/page.tsx`; compute `effectiveInitialSlots` for the no-saved-schedule case; pass it into `DayTimelineEditor` in place of the current empty-day assumption. | Opening a future date with a course meeting on it shows that class block, locked, with zero Firestore writes until a real edit is made; opening an already-saved day is pixel-identical to before this change. |

---

## 6. Open decisions

| # | Question | Options | Leaning |
|---|---|---|---|
| D1 | Should the day strip / block count summary distinguish "auto-seeded, unsaved" class blocks from ones that are actually saved? | (a) No visual difference — they're locked and correct either way · (b) A subtle "unsaved" indicator until the first edit | (a) — the save-status pill already communicates unsaved state for the whole day; a per-block indicator adds complexity for a state that resolves itself the moment the user touches anything. |
| D2 | Should this also run for the old (flag-off) editor? | (a) No, leave it as-is (empty day, no locking) · (b) Backport the same seeding | (a) — old editor is legacy per companion plan D7; not worth touching. |
