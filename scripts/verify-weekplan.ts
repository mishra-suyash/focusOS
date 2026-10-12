#!/usr/bin/env tsx
/**
 * Unit-test stand-in for lib/weekplan.ts (plan/14 §5.3/§5.4/§5.6, §12) — same pattern as
 * scripts/verify-tracking.ts, since this repo has no test runner.
 */
import { DEFAULT_WORKING_WINDOW, freeMinutesOnDay, keyedAfterRemoval, placeInWindow, placeProposals, resolvePlacement, usableWindow, weekCapacity, weeklyPlanningSlotForDate, type WeekProposalCandidate } from "../lib/weekplan";
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

{
  // Reproduces the exact bug found live: a heavy, unrelated backlog-tasks pool (1200 min, no
  // preference) would inflate a single global cap so far — ceil((1200+300)/6*1.5) = 375min = 15
  // chunks — that one course's entire 300-min revision bucket (12 chunks of 25, all preferring its
  // one lecture day, Mon) fit under it undisturbed: 06:00-to-17:10, one course, one day. Scoping
  // the cap to each candidate's own `capGroup` means revision's cap is ceil((300/6)*1.5) = 75min =
  // 3 chunks, regardless of how much unrelated backlog work also exists that week.
  const revision: WeekProposalCandidate[] = Array.from({ length: 12 }, (_, i) => ({
    title: `Revise ${i}`,
    type: "deep_work",
    durationMinutes: 25,
    preferredDateKeys: [MON],
    capGroup: "revision:course1"
  }));
  const backlog: WeekProposalCandidate[] = Array.from({ length: 20 }, (_, i) => ({
    title: `Backlog ${i}`,
    type: "deep_work",
    durationMinutes: 60,
    capGroup: "backlog-tasks"
  }));
  const placed = placeProposals([...revision, ...backlog], WEEK, {}, DEFAULT_WORKING_WINDOW);
  const revisionOnMonday = placed.filter((p) => p.fits && p.capGroup === "revision:course1" && p.dateKey === MON).length;
  const revisionElsewhere = placed.filter((p) => p.fits && p.capGroup === "revision:course1" && p.dateKey !== MON).length;
  check("a course's own revision cap isn't inflated by an unrelated bucket's volume", revisionOnMonday <= 3, `Monday got ${revisionOnMonday} revision chunks`);
  check("capped revision overflow spills onto other days instead of vanishing", revisionElsewhere > 0, `got ${revisionElsewhere} elsewhere`);
}

// --- The now floor: planning a week from inside it (Mon 07:21 of the week being planned) ---

{
  const now = { dateKey: TUE, minutes: 7 * 60 + 21 };
  check("a past day has no usable window", usableWindow(DEFAULT_WORKING_WINDOW, MON, now) === null);
  check("today's window starts at the next 15-minute mark after now, not before it", usableWindow({ ...DEFAULT_WORKING_WINDOW, startTime: "05:30" }, TUE, now)?.start === 7 * 60 + 30);
  check("a future day keeps its whole window", usableWindow(DEFAULT_WORKING_WINDOW, WEEK[2], now)?.start === 9 * 60);

  // 09:00–18:00 Mon–Sat: Mon is past (0), Tue–Sat untouched at 07:21 (5 x 540), Sun isn't a working day.
  const { freeMinutes } = weekCapacity({ workingWindow: DEFAULT_WORKING_WINDOW, weekDateKeys: WEEK, claimedSlotsByDate: {}, committedMinutes: 0, now });
  check("capacity excludes days already behind you", freeMinutes === 5 * 540, `got ${freeMinutes}`);
  const late = weekCapacity({ workingWindow: DEFAULT_WORKING_WINDOW, weekDateKeys: WEEK, claimedSlotsByDate: {}, committedMinutes: 0, now: { dateKey: TUE, minutes: 15 * 60 } });
  check("capacity excludes the elapsed part of today", late.freeMinutes === 180 + 4 * 540, `got ${late.freeMinutes}`);

  const placed = placeProposals(
    Array.from({ length: 4 }, (_, i): WeekProposalCandidate => ({ title: `S${i}`, type: "deep_work", durationMinutes: 50, preferredDateKeys: [MON] })),
    WEEK,
    {},
    DEFAULT_WORKING_WINDOW,
    new Set(),
    now
  );
  check("nothing is proposed onto a past day, even a preferred one", placed.every((p) => p.fits && p.dateKey !== MON), placed.map((p) => `${p.dateKey} ${p.startTime}`).join(", "));

  const pinnedPast = placeProposals([{ title: "Pinned", type: "deep_work", durationMinutes: 30, dateKey: TUE, fixedStartTime: "06:00" }], WEEK, {}, { ...DEFAULT_WORKING_WINDOW, startTime: "05:30" }, new Set(), now);
  check("a pinned time that has already passed is refused, not placed into the past", pinnedPast[0].fits === false);

  const dragged = resolvePlacement(
    { dateKey: TUE, startMinutes: 6 * 60, durationMinutes: 45 },
    { occupied: [], workingWindow: { ...DEFAULT_WORKING_WINDOW, startTime: "05:30" }, maxChunkMinutes: 50, minChunkMinutes: 15, now }
  );
  check("a typed start before now is moved up to now", dragged.placement.startMinutes === 7 * 60 + 30, `got ${dragged.placement.startMinutes}`);
}

{
  // One definition of free: overlapping locked slots are counted once, and a non-working day is 0
  // (the grid header used to say Sunday had "10.8h free" while placement refused to use it).
  const overlapping = [
    { startTime: "12:00", endTime: "13:00" },
    { startTime: "12:30", endTime: "13:30" }
  ];
  check("overlapping slots are merged, not double-subtracted", freeMinutesOnDay(DEFAULT_WORKING_WINDOW, MON, overlapping) === 540 - 90);
  check("a non-working day has no free time", freeMinutesOnDay(DEFAULT_WORKING_WINDOW, SUN, []) === 0);
  check("a day off has no free time", freeMinutesOnDay(DEFAULT_WORKING_WINDOW, MON, [], { offDateKeys: new Set([MON]) }) === 0);
}

// --- keyedAfterRemoval: drag positions follow their sittings when an Accept or Dismiss regenerates the family ---

{
  const placed = { "revision:c1:0": "Mon", "revision:c1:1": "Tue", "revision:c1:2": "Thu", "task:t1:0": "Sat", "task:t2:fixed": "Wed", "task:t3:1:2026-10-14": "Wed" };
  const one = keyedAfterRemoval(placed, ["revision:c1:0"]);
  check("the accepted sitting's position is dropped, not inherited by the next", one["revision:c1:0"] === "Tue" && one["revision:c1:1"] === "Thu" && !("revision:c1:2" in one), JSON.stringify(one));
  check("other families are untouched", one["task:t1:0"] === "Sat" && one["task:t2:fixed"] === "Wed" && one["task:t3:1:2026-10-14"] === "Wed");
  const middle = keyedAfterRemoval(placed, ["revision:c1:1"]);
  check("sittings before the accepted one keep their key", middle["revision:c1:0"] === "Mon" && middle["revision:c1:1"] === "Thu", JSON.stringify(middle));
  const two = keyedAfterRemoval(placed, ["revision:c1:0", "revision:c1:2"]);
  check("several accepted at once close up together", two["revision:c1:0"] === "Tue" && Object.keys(two).filter((k) => k.startsWith("revision")).length === 1, JSON.stringify(two));
  const dated = keyedAfterRemoval(placed, ["task:t3:1:2026-10-14"]);
  check("a dated lead-time key is only dropped, never parsed as an index", !("task:t3:1:2026-10-14" in dated) && dated["revision:c1:0"] === "Mon" && Object.keys(dated).length === 5);
}

if (failures.length > 0) {
  console.error(`verify-weekplan: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("verify-weekplan: all lib/weekplan.ts checks passed.");
