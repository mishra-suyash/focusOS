#!/usr/bin/env tsx
/**
 * Unit-test stand-in for lib/weekplan.ts (plan/14 §5.3/§5.4/§5.6, §12) — same pattern as
 * scripts/verify-tracking.ts, since this repo has no test runner.
 */
import { DEFAULT_WORKING_WINDOW, placeInWindow, placeProposals, weekCapacity, weeklyPlanningSlotForDate, type WeekProposalCandidate } from "../lib/weekplan";
import { minutesFromTime } from "../lib/schedule";
import type { ScheduleSlot } from "../types";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures.push(detail ? `${label}: ${detail}` : label);
}

// Mon 2026-09-21 .. Sun 2026-09-27
const WEEK = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];
const MON = WEEK[0];
const TUE = WEEK[1];
const SUN = WEEK[6];

// --- weekCapacity (§5.3, plan/14 AC #5) ---

{
  // Default window: Mon-Sat 09:00-18:00 = 9h x 6 = 3240 min free with nothing claimed. Sunday isn't
  // in daysOfWeek at all, so anything on Sunday (claimed or not) contributes zero either way.
  const { freeMinutes } = weekCapacity({
    workingWindow: DEFAULT_WORKING_WINDOW,
    weekDateKeys: WEEK,
    claimedSlotsByDate: {},
    committedMinutes: 0
  });
  check("empty week: free = 6 working days x 9h", freeMinutes === 6 * 9 * 60, `got ${freeMinutes}`);
}

{
  // AC #5's exact case: a block wholly outside the window (23:00 sleep, 08:00 commute) changes
  // free by nothing.
  const claimedSlotsByDate: Record<string, Pick<ScheduleSlot, "startTime" | "endTime">[]> = {
    [MON]: [
      { startTime: "23:00", endTime: "23:59" }, // wholly after the window
      { startTime: "07:30", endTime: "08:00" } // wholly before the window
    ]
  };
  const { freeMinutes } = weekCapacity({ workingWindow: DEFAULT_WORKING_WINDOW, weekDateKeys: WEEK, claimedSlotsByDate, committedMinutes: 0 });
  check("blocks wholly outside the window don't reduce free", freeMinutes === 6 * 9 * 60, `got ${freeMinutes}`);
}

{
  // A block straddling the window's edge only loses the part actually inside.
  const claimedSlotsByDate: Record<string, Pick<ScheduleSlot, "startTime" | "endTime">[]> = {
    [MON]: [{ startTime: "08:30", endTime: "09:30" }] // 30 min inside a 09:00-18:00 window
  };
  const { freeMinutes } = weekCapacity({ workingWindow: DEFAULT_WORKING_WINDOW, weekDateKeys: WEEK, claimedSlotsByDate, committedMinutes: 0 });
  check("a block straddling the window's edge only loses the overlapping part", freeMinutes === 6 * 9 * 60 - 30, `got ${freeMinutes}`);
}

{
  // Sunday is a non-working day under the default window: fully claiming it changes nothing.
  const claimedSlotsByDate: Record<string, Pick<ScheduleSlot, "startTime" | "endTime">[]> = {
    [SUN]: [{ startTime: "00:00", endTime: "23:59" }]
  };
  const { freeMinutes } = weekCapacity({ workingWindow: DEFAULT_WORKING_WINDOW, weekDateKeys: WEEK, claimedSlotsByDate, committedMinutes: 0 });
  check("a non-working day contributes nothing even fully claimed", freeMinutes === 6 * 9 * 60, `got ${freeMinutes}`);
}

{
  // Overlapping claimed slots inside the window don't double-subtract.
  const claimedSlotsByDate: Record<string, Pick<ScheduleSlot, "startTime" | "endTime">[]> = {
    [MON]: [
      { startTime: "10:00", endTime: "11:00" },
      { startTime: "10:30", endTime: "11:30" }
    ]
  };
  const { freeMinutes } = weekCapacity({ workingWindow: DEFAULT_WORKING_WINDOW, weekDateKeys: WEEK, claimedSlotsByDate, committedMinutes: 0 });
  check("overlapping claimed intervals merge instead of double-subtracting", freeMinutes === 6 * 9 * 60 - 90, `got ${freeMinutes}`);
}

{
  const { committedMinutes } = weekCapacity({ workingWindow: DEFAULT_WORKING_WINDOW, weekDateKeys: WEEK, claimedSlotsByDate: {}, committedMinutes: 425 });
  check("committedMinutes passes through unchanged", committedMinutes === 425);
}

// --- placeInWindow (§5.4) ---

{
  const start = placeInWindow([], minutesFromTime("09:00"), minutesFromTime("18:00"), 50);
  check("an empty day places at the window's start", start === minutesFromTime("09:00"), `got ${start}`);
}

{
  // Existing slot ends at a 15-min-aligned boundary so the stepped search lands on it exactly.
  const existing: ScheduleSlot[] = [{ id: "a", title: "A", type: "deep_work", startTime: "09:00", endTime: "09:45", status: "upcoming" }];
  const start = placeInWindow(existing, minutesFromTime("09:00"), minutesFromTime("18:00"), 50);
  check("skips a taken gap for the next one", start === minutesFromTime("09:45"), `got ${start}`);
}

{
  // A candidate that would only fit by spilling past the window end is refused, not clamped.
  const existing: ScheduleSlot[] = [{ id: "a", title: "A", type: "deep_work", startTime: "09:00", endTime: "17:40", status: "upcoming" }];
  const start = placeInWindow(existing, minutesFromTime("09:00"), minutesFromTime("18:00"), 50);
  check("refuses a placement that would spill past the window end", start === null, `got ${start}`);
}

{
  // A duration longer than the window itself never fits.
  const start = placeInWindow([], minutesFromTime("09:00"), minutesFromTime("18:00"), 999);
  check("a duration longer than the window is refused", start === null, `got ${start}`);
}

// --- weeklyPlanningSlotForDate (§5.6) ---

{
  const slot = weeklyPlanningSlotForDate({ enabled: true, dayOfWeek: 0, startTime: "18:00", endTime: "18:30" }, SUN); // Sunday
  check("matching day-of-week returns a locked admin slot", slot !== null && slot.locked === true && slot.type === "admin" && slot.id === "weekly-planning");
}

{
  const slot = weeklyPlanningSlotForDate({ enabled: true, dayOfWeek: 0, startTime: "18:00", endTime: "18:30" }, MON); // Monday, wrong day
  check("a non-matching day-of-week returns null", slot === null);
}

{
  const slot = weeklyPlanningSlotForDate({ enabled: false, dayOfWeek: 0, startTime: "18:00", endTime: "18:30" }, SUN);
  check("disabled returns null even on the matching day", slot === null);
}

{
  const slot = weeklyPlanningSlotForDate(undefined, SUN);
  check("an absent setting returns null (the feature is off by default)", slot === null);
}

// --- placeProposals (plan/15 §5.2) ---
const WED = WEEK[2];
const THU = WEEK[3];
const FRI = WEEK[4];
const SAT = WEEK[5];

{
  // plan/15 §2.2's exact bug: Mon-Fri are nearly full (480 of 540 min claimed, 60 min free each),
  // Sat is wide open. Eight floating 60-min candidates, naively assigned to whichever day is
  // "least loaded so far," would all land on Sat before Mon-Fri's higher starting load ever caught
  // up. The per-day cap (ceil((480/6)*1.5) = 120min = 2 chunks) must stop that pile-up.
  const claimedSlotsByDate: Record<string, Pick<ScheduleSlot, "startTime" | "endTime">[]> = {};
  for (const d of [MON, TUE, WED, THU, FRI]) claimedSlotsByDate[d] = [{ startTime: "09:00", endTime: "17:00" }];
  const candidates: WeekProposalCandidate[] = Array.from({ length: 8 }, (_, i) => ({
    title: `Task ${i}`,
    type: "deep_work",
    durationMinutes: 60
  }));
  const placed = placeProposals(candidates, WEEK, claimedSlotsByDate, DEFAULT_WORKING_WINDOW);
  const onSaturday = placed.filter((p) => p.fits && p.dateKey === SAT).length;
  const distinctDates = new Set(placed.filter((p) => p.fits).map((p) => p.dateKey)).size;
  check("the per-day cap keeps the emptiest day from absorbing every candidate", onSaturday <= 2, `Saturday got ${onSaturday}`);
  check("placement spreads across more than one day", distinctDates > 1, `only ${distinctDates} distinct date(s)`);
}

{
  // Revision prefers the course's lecture day (Tue here) even though Monday starts out emptier.
  const claimedSlotsByDate: Record<string, Pick<ScheduleSlot, "startTime" | "endTime">[]> = {
    [TUE]: [{ startTime: "09:00", endTime: "10:00" }] // Tue already has 60 min claimed; Mon has none
  };
  const candidates: WeekProposalCandidate[] = [{ title: "Revise", type: "deep_work", durationMinutes: 60, preferredDateKeys: [TUE] }];
  const placed = placeProposals(candidates, WEEK, claimedSlotsByDate, DEFAULT_WORKING_WINDOW);
  check("a preferred date is honored over a less-loaded fallback day", placed[0].fits && placed[0].dateKey === TUE, `got ${placed[0].dateKey}`);
}

{
  // Backlog prefers the weekend (Sat, the only weekend day in the default Mon-Sat window) even
  // though a weekday is emptier.
  const candidates: WeekProposalCandidate[] = [{ title: "Backlog task", type: "deep_work", durationMinutes: 60, preferredDateKeys: [SAT] }];
  const placed = placeProposals(candidates, WEEK, {}, DEFAULT_WORKING_WINDOW);
  check("backlog's weekend preference is honored", placed[0].fits && placed[0].dateKey === SAT, `got ${placed[0].dateKey}`);
}

{
  // A day marked off is excluded from both the preferred list and the general fallback search —
  // a candidate preferring it, or with no preference at all, must never land there.
  const offDateKeys = new Set([MON]);
  const preferring: WeekProposalCandidate = { title: "Prefers Monday", type: "deep_work", durationMinutes: 60, preferredDateKeys: [MON] };
  const floating: WeekProposalCandidate = { title: "Floating", type: "deep_work", durationMinutes: 60 };
  const placed = placeProposals([preferring, floating], WEEK, {}, DEFAULT_WORKING_WINDOW, offDateKeys);
  check("a day off is skipped even when explicitly preferred", placed[0].dateKey !== MON, `got ${placed[0].dateKey}`);
  check("a day off never absorbs a floating candidate either", placed[1].dateKey !== MON, `got ${placed[1].dateKey}`);
}

if (failures.length > 0) {
  console.error(`verify-weekplan: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("verify-weekplan: all lib/weekplan.ts checks passed.");
