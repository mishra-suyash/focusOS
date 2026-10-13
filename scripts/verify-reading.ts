#!/usr/bin/env tsx
/**
 * Unit-test stand-in for plan/17's reading model (lib/papers.ts, the past-day cut-off in
 * lib/courses.ts) — same pattern as scripts/verify-tracking.ts, since this repo has no test runner.
 */
import { accountedSlotMinutes, plannedMinutesForObjective, plannedMinutesThisWeek, type PlanningCutoff } from "../lib/courses";
import {
  calibratedPassEstimate,
  cancelPassPatch,
  derivePaperStatus,
  dropPatch,
  isBackFromShelf,
  nextReadingPass,
  paperShelfDate,
  PASS_SEED_MINUTES,
  passSessionMinutes,
  queuePatch,
  restorePatch,
  shelvePatch,
  startPassPatch,
  totalReadingMinutes
} from "../lib/papers";
import { harvestedSuggestions } from "../lib/papergroups";
import { readingHabitProgress, readingPickerSections, readingWeeksStreak } from "../lib/papers";
import { DEFAULT_WORKING_WINDOW, placeProposals, readingHabitPlan, TIME_OF_DAY_WINDOWS, type WeekProposalCandidate } from "../lib/weekplan";
import type { DailySchedule, Paper, PassState, PomodoroSession, ScheduleSlot } from "../types";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures.push(detail ? `${label}: ${detail}` : label);
}

function paper(overrides: Partial<Paper>): Paper {
  return {
    id: "p",
    title: "A paper",
    authors: [],
    status: "to_read",
    priority: "medium",
    tags: [],
    progress: 0,
    groupIds: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides
  };
}

const done = (output: unknown, completedAt = "2026-10-05T10:00:00.000Z"): PassState => ({ status: "done", startedAt: "2026-10-05T09:00:00.000Z", completedAt, output: output as never });
const skim = (verdict: string) => done({ verdict });
const read = (outcome: string, extra: Record<string, unknown> = {}) => done({ outcome, ...extra });

// --- §5.2: every pass outcome maps to exactly one status ---
{
  const rows: [string, Partial<Paper>, string, 1 | 2 | 3 | null][] = [
    ["fresh", {}, "to_read", 1],
    ["inbox", { inbox: true }, "inbox", null],
    ["skim in progress", { pass1: { status: "in_progress", startedAt: "2026-10-05T09:00:00.000Z" } }, "reading", 1],
    ["Skim → Keep reading", { pass1: skim("continue") }, "reading", 2],
    ["Skim → Save for later (new: dated)", { pass1: skim("park"), shelvedUntil: "2026-11-04" }, "shelved", null],
    ["Skim → Not relevant", { pass1: skim("drop") }, "dropped", null],
    ["Skim → Skim was enough", { pass1: skim("done") }, "read", null],
    ["Read → Grasped it", { pass1: skim("continue"), pass2: read("grasped") }, "read", null],
    ["Read → Set aside", { pass1: skim("continue"), pass2: read("set-aside"), shelvedUntil: "2026-11-04" }, "shelved", null],
    ["Read → Return later", { pass1: skim("continue"), pass2: read("return-later"), shelvedUntil: "2026-11-04" }, "shelved", null],
    ["Read → Persevere", { pass1: skim("continue"), pass2: read("persevere") }, "reading", 3],
    ["Deep dive in progress", { pass1: skim("continue"), pass2: read("persevere"), pass3: { status: "in_progress" } }, "reading", 3],
    ["Deep dive finished", { pass1: skim("continue"), pass2: read("persevere"), pass3: done({}) }, "read", null],
    ["Drop from any screen", { pass1: skim("continue"), droppedAt: "2026-10-06T00:00:00.000Z" }, "dropped", null],
    ["Shelve by hand before reading", { shelvedUntil: "2026-11-01" }, "shelved", null]
  ];
  for (const [label, fields, status, next] of rows) {
    const p = paper(fields);
    check(`${label} → ${status}`, derivePaperStatus(p) === status, `got ${derivePaperStatus(p)}`);
    check(`${label} → next pass ${next}`, nextReadingPass(p) === next, `got ${nextReadingPass(p)}`);
  }
}

// --- §10: legacy data reads correctly with no backfill ---
{
  const parked = paper({ status: "archived", pass1: done({ verdict: "park" }, "2026-04-01T10:00:00.000Z") });
  check("legacy archived park reads as shelved", derivePaperStatus(parked) === "shelved", derivePaperStatus(parked));
  check("legacy park comes back 180 days after the Skim", paperShelfDate(parked) === "2026-09-28", `${paperShelfDate(parked)}`);
  check("…which is today or earlier, so it's back from the shelf", isBackFromShelf(parked, "2026-10-12"));
  const archivedDrop = paper({ status: "archived", pass1: skim("drop") });
  check("legacy archived drop reads as dropped", derivePaperStatus(archivedDrop) === "dropped");
  const setAside = paper({ status: "reading", pass1: skim("continue"), pass2: read("set-aside", {}) });
  check("legacy set-aside (stored 'reading') reads as shelved", derivePaperStatus(setAside) === "shelved", derivePaperStatus(setAside));
  check("…for 30 days after the Read", paperShelfDate(setAside) === "2026-11-04", `${paperShelfDate(setAside)}`);
  const returnLater = paper({ pass1: skim("continue"), pass2: read("return-later", { returnAfter: { backgroundToRead: [], revisitOn: "2026-10-20" } }) });
  check("legacy return-later comes back on its revisitOn", paperShelfDate(returnLater) === "2026-10-20", `${paperShelfDate(returnLater)}`);
  check("…and isn't back before then", !isBackFromShelf(returnLater, "2026-10-12"));
}

// --- Leaving the shelf: "Read now" must not be re-derived back onto it ---
{
  const setAside = paper({ pass1: skim("continue"), pass2: read("set-aside") });
  const back = { ...setAside, ...queuePatch(setAside, "2026-10-12T08:00:00.000Z") } as Paper;
  check("Read now takes a legacy set-aside paper off the shelf", derivePaperStatus(back) === "reading", derivePaperStatus(back));
  check("…queues it in Up next", back.queuedAt === "2026-10-12T08:00:00.000Z");
  check("…and owes Read again", nextReadingPass(back) === 2, `${nextReadingPass(back)}`);
  const redo = startPassPatch(back, 2, "2026-10-12T09:00:00.000Z")!;
  const redoing = { ...back, ...redo } as Paper;
  check("redoing Read keeps the earlier attempt", redoing.previousPasses?.length === 1 && redoing.previousPasses[0].passNo === 2);
  check("…and the redo is in progress", redoing.pass2?.status === "in_progress" && redoing.pass2.startedAt === "2026-10-12T09:00:00.000Z");
  const cancelled = { ...redoing, ...cancelPassPatch(redoing, 2)! } as Paper;
  check("cancelling the redo restores the earlier attempt", cancelled.pass2?.status === "done" && (cancelled.previousPasses ?? []).length === 0);

  const parked = paper({ pass1: skim("park") });
  const unparked = { ...parked, ...queuePatch(parked, "2026-10-12T08:00:00.000Z") } as Paper;
  check("Read now on a parked Skim owes Read", nextReadingPass(unparked) === 2 && derivePaperStatus(unparked) === "reading");

  const shelvedAgain = { ...back, ...shelvePatch(back, "2026-12-01") } as Paper;
  check("shelving again wins over an earlier 'Read now'", derivePaperStatus(shelvedAgain) === "shelved" && paperShelfDate(shelvedAgain) === "2026-12-01");
  check("shelving leaves Up next", shelvedAgain.queuedAt === undefined && "queuedAt" in shelvePatch(back, "2026-12-01"));
}

// --- Drop and restore; inbox triage ---
{
  const p = paper({ pass1: skim("continue") });
  const dropped = { ...p, ...dropPatch(p, "2026-10-12T00:00:00.000Z") } as Paper;
  check("Drop from any screen", derivePaperStatus(dropped) === "dropped" && dropped.status === "dropped");
  const restored = { ...dropped, ...restorePatch(dropped) } as Paper;
  check("Restore undoes a manual drop", derivePaperStatus(restored) === "reading" && restored.status === "reading");
  const inbox = paper({ inbox: true });
  const queued = { ...inbox, ...queuePatch(inbox, "2026-10-12T00:00:00.000Z") } as Paper;
  check("Queue moves an inbox paper to To read", derivePaperStatus(queued) === "to_read" && nextReadingPass(queued) === 1);
  check("starting a pass is never 'inbox'", derivePaperStatus(paper({ inbox: true, pass1: { status: "in_progress" } })) === "reading");
}

// --- §5.5: one clock — pass minutes are its focus sessions, never wall-clock ---
{
  const session = (minutes: number, completedAt: string, extra: Partial<PomodoroSession> = {}) =>
    ({ id: completedAt, label: "", category: "reading", mode: "work", minutes, completedAt, cycle: 1, paperId: "p", passNo: 2, ...extra }) as PomodoroSession;
  const sessions = [
    session(25, "2026-10-05T09:30:00.000Z"),
    session(30, "2026-10-07T18:00:00.000Z"),
    session(20, "2026-10-01T09:00:00.000Z"), // before this attempt started
    session(10, "2026-10-06T09:00:00.000Z", { passNo: 1 }),
    session(5, "2026-10-06T10:00:00.000Z", { mode: "short_break" })
  ];
  check("a Read over two sittings two days apart is 55 minutes, not ~2 days", passSessionMinutes(sessions, "p", 2, "2026-10-05T09:00:00.000Z") === 55, `${passSessionMinutes(sessions, "p", 2, "2026-10-05T09:00:00.000Z")}`);
  check("total reading still sums every work session on the paper", totalReadingMinutes(sessions, "p") === 85, `${totalReadingMinutes(sessions, "p")}`);
  check("wall-clock artifacts over 6h are ignored by calibration", calibratedPassEstimate([2880, 50, 55, 60, 65], 2) === PASS_SEED_MINUTES[2]);
  check("honest samples still calibrate", calibratedPassEstimate([2880, 50, 55, 60, 65, 70], 2) === 60);
}

// --- §7.2: past days count what was worked, not what was planned ---
{
  const WEEK = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];
  const slot = (id: string, startTime: string, endTime: string, extra: Partial<ScheduleSlot> = {}): ScheduleSlot => ({ id, title: id, type: "deep_work", startTime, endTime, status: "upcoming", courseId: "c", bucket: "revision", ...extra });
  const schedules: DailySchedule[] = [
    { id: "a", dateKey: WEEK[0], slots: [slot("missed", "09:00", "09:50"), slot("partial", "10:00", "10:50"), slot("full", "11:00", "11:50")], createdAt: "", updatedAt: "" },
    { id: "b", dateKey: WEEK[1], slots: [slot("past-today", "09:00", "09:50"), slot("running", "10:00", "10:50"), slot("later", "14:00", "14:50")], createdAt: "", updatedAt: "" },
    { id: "c", dateKey: WEEK[2], slots: [slot("future", "09:00", "09:50"), slot("read", "10:00", "10:30", { type: "reading", courseId: undefined, bucket: undefined, objectiveRef: { kind: "readingHabit" } })], createdAt: "", updatedAt: "" }
  ];
  const work = (slotId: string, minutes: number, completedAt: string) => ({ slotId, mode: "work" as const, minutes, completedAt });
  const cutoff: PlanningCutoff = {
    todayKey: WEEK[1],
    nowMinutes: 10 * 60 + 20,
    sessions: [
      work("partial", 20, `${WEEK[0]}T10:30:00.000Z`),
      work("full", 50, `${WEEK[0]}T11:50:00.000Z`),
      work("full", 30, `${WEEK[0]}T12:20:00.000Z`), // over-covered: clamped to the block's length
      work("missed", 50, `${WEEK[3]}T09:00:00.000Z`) // a later date reusing the id never covers it
    ]
  };
  check("a missed past sitting counts 0", accountedSlotMinutes(schedules[0].slots[0], WEEK[0], cutoff) === 0);
  check("a partly worked one counts what it got", accountedSlotMinutes(schedules[0].slots[1], WEEK[0], cutoff) === 20);
  check("a fully worked one counts its length, never more", accountedSlotMinutes(schedules[0].slots[2], WEEK[0], cutoff) === 50);
  check("today, a sitting whose end has passed is behind you", accountedSlotMinutes(schedules[1].slots[0], WEEK[1], cutoff) === 0);
  check("today, the sitting under way still counts as planned", accountedSlotMinutes(schedules[1].slots[1], WEEK[1], cutoff) === 50);
  check("later today and future days count as planned", accountedSlotMinutes(schedules[1].slots[2], WEEK[1], cutoff) === 50 && accountedSlotMinutes(schedules[2].slots[0], WEEK[2], cutoff) === 50);
  const placed = plannedMinutesThisWeek(schedules, "c", "revision", WEEK, cutoff);
  check("the bucket's placed total uses the cut-off", placed === 0 + 20 + 50 + 0 + 50 + 50 + 50, `${placed}`);
  check("without a cut-off it is the old total", plannedMinutesThisWeek(schedules, "c", "revision", WEEK) === 50 * 7, `${plannedMinutesThisWeek(schedules, "c", "revision", WEEK)}`);
  check("an open reading sitting is accounted under readingHabit", plannedMinutesForObjective(schedules, { kind: "readingHabit" }, WEEK, cutoff) === 30);
}


// --- §6.2: the reading habit row ---
{
  const base = { target: { sittings: 4, minutes: 30 }, maxChunkMinutes: 50, minChunkMinutes: 15, dismissedMinutes: {}, placedByPaper: {}, placedOpen: 0 };
  const empty = readingHabitPlan({ ...base, owed: [] });
  check("an empty library still asks for 4 × 30", empty.ask === 120 && empty.open.length === 4 && empty.pinned.length === 0, JSON.stringify(empty));
  const owed = readingHabitPlan({ ...base, owed: [{ paperId: "a", title: "A", passNo: 2, minutes: 60 }, { paperId: "b", title: "B", passNo: 1, minutes: 7 }] });
  check("owed passes pin the sittings they need, in order", owed.pinned.map((p) => `${p.paper.paperId}:${p.minutes.length}`).join() === "a:2,b:1", JSON.stringify(owed.pinned));
  check("the rest stay open", owed.open.length === 1);
  const over = readingHabitPlan({ ...base, target: { sittings: 2, minutes: 30 }, owed: [{ paperId: "a", title: "A", passNo: 2, minutes: 60 }, { paperId: "b", title: "B", passNo: 1, minutes: 7 }] });
  check("owed beyond the target don't inflate the ask", over.ask === 60 && over.alsoOwed.map((o) => o.paperId).join() === "b", JSON.stringify(over));
  const placed = readingHabitPlan({ ...base, placedOpen: 30, placedByPaper: { a: 30 }, owed: [{ paperId: "a", title: "A", passNo: 2, minutes: 60 }] });
  check("placed open and pinned sittings both count toward the habit", placed.placed === 60 && placed.pinned[0]?.minutes.length === 1 && placed.open.length === 1, JSON.stringify(placed));
  const dismissed = readingHabitPlan({ ...base, dismissedMinutes: { readingHabit: 30, "paper:a": 30 }, owed: [{ paperId: "a", title: "A", passNo: 2, minutes: 60 }] });
  check("dismissals per family come off the ask and the pin", dismissed.dismissed === 60 && dismissed.pinned[0]?.minutes.length === 1 && dismissed.open.length === 1, JSON.stringify(dismissed));
  const capped = readingHabitPlan({ ...base, target: { sittings: 2, minutes: 90 }, owed: [] });
  check("a sitting is held under the sitting cap", capped.sittingMinutes === 50 && capped.ask === 100);
  const partial = readingHabitPlan({ ...base, placedOpen: 20 + 90, owed: [] });
  check("a remainder too short to sit with is reported, not proposed", partial.open.length === 0 && partial.shortfall === 10, JSON.stringify(partial));
  const zero = readingHabitPlan({ ...base, target: { sittings: 0, minutes: 30 }, owed: [] });
  check("0 sittings is a valid, empty week", zero.ask === 0 && zero.open.length === 0);
}

// --- §6.3: one reading sitting a day until every working day has one; time of day ---
{
  const WEEK = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];
  const sitting = (i: number): WeekProposalCandidate => ({ title: `R${i}`, type: "reading", durationMinutes: 30, spreadGroup: "reading", capGroup: "reading", key: `readingHabit:${i}` });
  const placedOut = placeProposals([0, 1, 2, 3].map(sitting), WEEK, { [WEEK[0]]: [], [WEEK[1]]: [{ startTime: "09:00", endTime: "09:30", type: "reading" }] }, DEFAULT_WORKING_WINDOW);
  const days = placedOut.map((p) => p.dateKey);
  check("four sittings land on four different days", new Set(days).size === 4, days.join());
  check("a day that already has a reading sitting isn't picked first", !days.includes(WEEK[1]), days.join());
  const seven = placeProposals([0, 1, 2, 3, 4, 5, 6].map(sitting), WEEK, {}, DEFAULT_WORKING_WINDOW);
  const counts = seven.reduce<Record<string, number>>((acc, p) => ({ ...acc, [p.dateKey]: (acc[p.dateKey] ?? 0) + 1 }), {});
  check("a seventh sitting doubles up only after every working day has one", Object.keys(counts).length === 6 && Math.max(...Object.values(counts)) === 2, JSON.stringify(counts));
  const evening = placeProposals([{ ...sitting(0), preferredWindow: TIME_OF_DAY_WINDOWS.afternoon }], WEEK, {}, DEFAULT_WORKING_WINDOW);
  check("a time-of-day preference is honoured when there's room", evening[0].startTime === "12:00", evening[0].startTime);
}

// --- §5.3: the picker's order; §5.7: habit progress and streak; F2: harvest ---
{
  const sessions = [
    { id: "s1", label: "", category: "reading", mode: "work", minutes: 20, completedAt: "2026-10-12T09:20:00.000Z", cycle: 1, paperId: "r2", passNo: 2 },
    { id: "s2", label: "", category: "reading", mode: "work", minutes: 25, completedAt: "2026-10-10T09:20:00.000Z", cycle: 1, paperId: "r1", passNo: 2 }
  ] as PomodoroSession[];
  const library = [
    paper({ id: "q2", title: "Queued second", queuedAt: "2026-10-02T00:00:00.000Z" }),
    paper({ id: "q1", title: "Queued first", queuedAt: "2026-10-01T00:00:00.000Z" }),
    paper({ id: "hi", title: "Unqueued high", priority: "high" }),
    paper({ id: "r1", pass1: skim("continue"), pass2: { status: "in_progress", startedAt: "2026-10-09T00:00:00.000Z" } }),
    paper({ id: "r2", pass1: skim("continue") }),
    paper({ id: "back", shelvedUntil: "2026-10-11" }),
    paper({ id: "later", shelvedUntil: "2026-10-30" }),
    paper({ id: "in", inbox: true }),
    paper({ id: "x", droppedAt: "2026-10-01T00:00:00.000Z" })
  ];
  const sections = readingPickerSections(library, sessions, "2026-10-12");
  check("Continue: most recently read first", sections.continueReading.map((p) => p.id).join() === "r2,r1", sections.continueReading.map((p) => p.id).join());
  check("Up next: queue order, then the rest", sections.upNext.map((p) => p.id).join() === "q1,q2,hi", sections.upNext.map((p) => p.id).join());
  check("Back from the shelf: only dates that have come", sections.backFromShelf.map((p) => p.id).join() === "back");
  check("Inbox listed; dropped nowhere", sections.inbox.map((p) => p.id).join() === "in");
  const empty = readingPickerSections([paper({ id: "done", pass1: skim("done") })], [], "2026-10-12");
  check("a library with nothing to read yields empty sections (→ Find a paper)", Object.values(empty).every((list) => list.length === 0));

  const WEEK = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];
  const s = (id: string, minutes: number, day: string, extra: Partial<PomodoroSession> = {}) =>
    ({ id, label: "", category: "reading", mode: "work", minutes, completedAt: `${day}T09:00:00.000Z`, cycle: 1, paperId: "p", ...extra }) as PomodoroSession;
  const week = [
    s("a", 30, WEEK[0]),
    s("b", 10, WEEK[1], { slotId: "slot1" }),
    s("c", 12, WEEK[1], { slotId: "slot1" }), // same block: one sitting of 22
    s("d", 5, WEEK[2]), // too short to be a sitting
    s("e", 25, WEEK[3], { paperId: undefined, findPaper: true }),
    s("f", 25, WEEK[4], { paperId: undefined, findPaper: true }), // a second find-a-paper doesn't count
    s("g", 40, WEEK[5], { category: "coding", paperId: undefined }) // not reading
  ];
  const progress = readingHabitProgress(week, WEEK, { minutes: 30 });
  check("sittings: block sessions grouped, short ones and non-reading skipped, find-a-paper capped at one", progress.sittings === 3 && progress.findPaperSittings === 2, JSON.stringify(progress));
  check("minutes count all reading time", progress.minutes === 30 + 22 + 5 + 50, `${progress.minutes}`);
  const target = () => ({ sittings: 1, minutes: 30 });
  const history = [s("w0", 30, "2026-10-12"), s("w1", 30, "2026-10-06"), s("w2", 30, "2026-09-29"), s("w4", 30, "2026-09-15")];
  check("streak counts back from this week until a missed week", readingWeeksStreak(history, "2026-10-12", target) === 3, `${readingWeeksStreak(history, "2026-10-12", target)}`);
  const zeroWeek = (start: string) => (start === "2026-09-21" ? { sittings: 0, minutes: 30 } : { sittings: 1, minutes: 30 });
  check("a deliberate 0 week neither counts nor breaks it", readingWeeksStreak(history, "2026-10-12", zeroWeek) === 4, `${readingWeeksStreak(history, "2026-10-12", zeroWeek)}`);

  const harvested = harvestedSuggestions([
    paper({ id: "a", title: "Attention Is All You Need", pass2: read("grasped", { unreadReferencesMarked: ["Neural Machine Translation by Jointly Learning to Align", "Layer Normalization"], summary: "", keyPoints: [], figures: [], unclear: [] }) }),
    paper({ id: "b", title: "BERT", pass2: read("grasped", { unreadReferencesMarked: ["Layer normalization"], summary: "", keyPoints: [], figures: [], unclear: [] }), layeredNotes: { citationsToRead: ["Attention is all you need"] } as never })
  ]);
  check("references already in the library are not suggested", !harvested.some((h) => /attention is all/i.test(h.ref)), harvested.map((h) => h.ref).join("|"));
  check("duplicates merge and rank by how many papers point at them", harvested[0]?.ref === "Layer Normalization" && harvested[0].citedByPaperIds.length === 2, JSON.stringify(harvested));
}

if (failures.length > 0) {
  console.error(`verify-reading: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("verify-reading: all plan/17 reading-model checks passed.");
