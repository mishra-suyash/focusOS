#!/usr/bin/env tsx
/**
 * Pure-function checks for the planning-from-chat feedback fixes (2026-11-27): a resized sitting's
 * planned minutes, the derived missed/partial outcome of a past block, thin passes, and citation text
 * kept out of paper titles. Same pattern as scripts/verify-chunking.ts: no Firestore, no rendering,
 * no user flow. A green run says the arithmetic is right and nothing more.
 */
import { computeDayScore, computeDayReadout } from "../lib/gamify";
import { computeDebtHours, daysSinceCatchUpClear } from "../lib/loadindex";
import { fitPlannedMinutes } from "../lib/patches";
import { isThinPass, passOutputShortfall, splitCitation } from "../lib/papers";
import { pastBlockOutcome, sittingPlannedMinutes, sittingRemainingMinutes } from "../lib/tracking";
import { pickNextAction } from "../lib/next-action";
import { unplannedHardDeadlines } from "../lib/deadlines";
import { goalWeekPace } from "../lib/goals";
import { validateSlots } from "../lib/schedule";
import { placeInWindow, layOutBackwards } from "../lib/weekplan";
import type { Goal, Task } from "../types";
import { dayShapeConflict, dayShapeWindows, placeProposals, workWindowsOf, type WeekProposalCandidate } from "../lib/weekplan";
import type { Pass1Output, Pass2Output, PomodoroSession, ScheduleSlot } from "../types";

const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures.push(detail ? `${label}: ${detail}` : label);
}

const slot = (over: Partial<ScheduleSlot>): ScheduleSlot => ({ id: "s1", title: "Read pass", type: "reading", startTime: "06:45", endTime: "07:25", status: "upcoming", ...over });
const work = (slotId: string, minutes: number): Pick<PomodoroSession, "slotId" | "mode" | "minutes"> => ({ slotId, mode: "work", minutes });

// --- 1.1: a block moved from 09:00–09:55 to 06:45–07:25 kept plannedMinutes: 55 ---
{
  const stale = slot({ plannedMinutes: 55 });
  check("a shortened sitting is measured at its new length", sittingPlannedMinutes(stale) === 40, String(sittingPlannedMinutes(stale)));
  check("a planned figure under the length is kept", sittingPlannedMinutes(slot({ plannedMinutes: 30 })) === 30);
  check("no plannedMinutes falls back to the length", sittingPlannedMinutes(slot({})) === 40);
  const score = computeDayScore({ slots: [stale], sessions: [work("s1", 40)] });
  check("the day score plans 40, not 55", score.minutesPlanned === 40, String(score.minutesPlanned));
  check("40 logged minutes on a 40-minute sitting is full coverage", score.score !== null && score.score >= 80, String(score.score));
  const readout = computeDayReadout({ slots: [stale], sessions: [], nowMinute: 8 * 60 });
  check("the readout's elapsed minutes use the clamp too", readout.minutesElapsedPlanned === 40, String(readout.minutesElapsedPlanned));
  check("the resume timer arms what's left of 40", sittingRemainingMinutes(stale, [work("s1", 10)]) === 30);
  const [fitted, longer, none] = fitPlannedMinutes([stale, slot({ id: "s2", plannedMinutes: 30, endTime: "08:00" }), slot({ id: "s3" })]);
  check("a save clamps plannedMinutes to the block", fitted.plannedMinutes === 40, String(fitted.plannedMinutes));
  check("a save keeps a smaller plannedMinutes (lengthened block)", longer.plannedMinutes === 30);
  check("a save leaves a block without plannedMinutes alone", none.plannedMinutes === undefined && none === none);
}

// --- 1.2: past blocks are completed / partial / missed by their focus time ---
{
  check("no focus time is missed", pastBlockOutcome(slot({}), []) === "missed");
  check("some focus time is partial", pastBlockOutcome(slot({}), [work("s1", 10)]) === "partial");
  check("60% coverage is completed", pastBlockOutcome(slot({}), [work("s1", 24)]) === "completed");
  check("a hand-set Skipped wins", pastBlockOutcome(slot({ status: "skipped" }), [work("s1", 40)]) === "skipped");
  check("a hand-set Done wins", pastBlockOutcome(slot({ status: "completed" }), []) === "completed");
  check("another block's sessions don't count", pastBlockOutcome(slot({}), [work("other", 40)]) === "missed");
}

// --- 1.4: thin passes ---
{
  const skim = (contributions: string[], verdict: Pass1Output["verdict"] = "continue") =>
    ({ steps: { titleAbstractIntro: false, headings: false, conclusions: false, references: false }, contributions, referencesAlreadyRead: [], verdict, verdictReason: "proceeding" }) as Pass1Output;
  check("a Skim with no contribution is thin", isThinPass(1, { status: "done", output: skim([]) }));
  check("a blank contribution doesn't count", isThinPass(1, { status: "done", output: skim(["  "]) }));
  check("one contribution is enough", !isThinPass(1, { status: "done", output: skim(["A new NIC offload"]) }));
  check("a Skim that drops the paper is never thin", !isThinPass(1, { status: "done", output: skim([], "drop") }));
  check("a pass not done is never thin", !isThinPass(1, { status: "in_progress", output: skim([]) }));
  const read = (keyPoints: string[], outcome: Pass2Output["outcome"] = "grasped") => ({ keyPoints, figures: [], unreadReferencesMarked: [], summary: "Done already", unclear: [], outcome }) as Pass2Output;
  check("a Read with no key points is thin", isThinPass(2, { status: "done", output: read([]) }));
  check("two key points is thin", isThinPass(2, { status: "done", output: read(["a", "b"]) }));
  check("three key points is enough", !isThinPass(2, { status: "done", output: read(["a", "b", "c"]) }));
  check("a Read set aside isn't thin", !isThinPass(2, { status: "done", output: read([], "set-aside") }));
  check("the shortfall says what's missing", passOutputShortfall(2, read(["a"])) === "1 key point (3 expected)", String(passOutputShortfall(2, read(["a"]))));
  check("a Deep dive has no output minimum here", !isThinPass(3, { status: "done", output: undefined }));
  check("a done pass with no output at all is thin", isThinPass(1, { status: "done", output: undefined }));
}

// --- 4: citation text kept out of titles ---
{
  const snap = splitCitation("Marty et al. 2019, 'Snap: a microkernel approach to host networking' (ACM SOSP) — the network stack used");
  check("a quoted title is the title", snap.title === "Snap: a microkernel approach to host networking", snap.title);
  check("the full reference is kept as the citation", snap.citation?.startsWith("Marty et al. 2019") === true);
  const unquoted = splitCitation("Zhang and Li 2021, Janus: fast checkpointing for GPUs (OSDI)");
  check("an author-year prefix and venue are peeled off", unquoted.title === "Janus: fast checkpointing for GPUs", unquoted.title);
  const plain = splitCitation("LithOS: An Operating System for Efficient Machine Learning on GPUs");
  check("a plain title is unchanged", plain.title === "LithOS: An Operating System for Efficient Machine Learning on GPUs" && plain.citation === undefined);
  for (const real of ['"Why Should I Trust You?": Explaining the Predictions of Any Classifier', "Don't Stop Pretraining: Adapt Language Models to Domains and Tasks", "What's in a Name? Let's Find Out", "Smith's 'deep' prior for 2019 data"]) {
    const kept = splitCitation(real);
    check(`a real title with quotes or apostrophes is unchanged: ${real}`, kept.title === real && kept.citation === undefined, JSON.stringify(kept));
  }
  const apostrophe = splitCitation("Lee et al. 2021, 'Don't stop: a study' (ACL)");
  check("a quoted title with an apostrophe inside isn't cut short", apostrophe.title === "Don't stop: a study", apostrophe.title);
  const dash = splitCitation("Attention Is All You Need — transformer paper");
  check("a dash in a plain title isn't treated as a citation", dash.title === "Attention Is All You Need — transformer paper" && dash.citation === undefined);
}

// --- 3.1: the day shape ---
{
  const shape = dayShapeWindows({ deep: [{ startTime: "05:30", endTime: "13:00" }], light: [{ startTime: "13:45", endTime: "18:00" }] });
  const window = { startTime: "05:00", endTime: "22:00", daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };
  const day = "2026-12-02";
  const claimed = { [day]: [{ startTime: "05:30", endTime: "12:30", type: "deep_work" as const }] };
  const deep: WeekProposalCandidate = { title: "Write", type: "deep_work", durationMinutes: 50, dateKey: day };
  const admin: WeekProposalCandidate = { title: "Email", type: "admin", durationMinutes: 30, dateKey: day };
  const [deepPlaced, adminPlaced] = placeProposals([deep, admin], [day], claimed, window, new Set(), undefined, shape);
  check("deep work that doesn't fit the deep window doesn't spill into the light one", !deepPlaced.fits, JSON.stringify(deepPlaced));
  check("light work goes to the light window first", adminPlaced.fits && adminPlaced.startTime === "13:45", JSON.stringify(adminPlaced));
  const [deepEarly] = placeProposals([deep], [day], {}, window, new Set(), undefined, shape);
  check("deep work lands in the deep window", deepEarly.fits && deepEarly.startTime === "05:30", JSON.stringify(deepEarly));
  const [noShape] = placeProposals([deep], [day], claimed, window, new Set(), undefined, null);
  check("without a shape, placement is as before", noShape.fits && noShape.startTime === "12:30", JSON.stringify(noShape));
  check("deep work in a light window is named", dayShapeConflict(shape, { type: "reading", startTime: "14:00", endTime: "14:50" })?.includes("light window") === true);
  check("deep work in a deep window is fine", dayShapeConflict(shape, { type: "reading", startTime: "06:00", endTime: "06:50" }) === null);
  check("a meal has no energy and never conflicts", dayShapeConflict(shape, { type: "meal", startTime: "20:00", endTime: "20:30" }) === null);
  const base = { checkpoints: [], dueRevisionCount: 3, tasks: [], loadIndexValue: 0.5, todayKey: day, weekEndKey: "2026-12-06" };
  const evening = pickNextAction({ ...base, minute: 18 * 60 + 30, workWindows: shape! });
  check("after the last window Up next suggests no work", evening?.kind === "rest" && evening.title === "Done for the day", JSON.stringify(evening));
  const afternoon = pickNextAction({ ...base, minute: 17 * 60 + 35, workWindows: workWindowsOf({ workingWindow: { startTime: "09:00", endTime: "17:30", daysOfWeek: [1] } }) });
  check("past the given windows' end, no review is suggested", afternoon?.kind === "rest", JSON.stringify(afternoon));
  const inLight = pickNextAction({ ...base, minute: 17 * 60 + 35, workWindows: shape! });
  check("inside a light window a review is still light work", inLight?.kind === "revision", JSON.stringify(inLight));
  const morning = pickNextAction({ ...base, minute: 9 * 60, workWindows: shape! });
  check("inside a window the cascade runs as before", morning?.kind === "revision", JSON.stringify(morning));
  const unchanged = pickNextAction({ ...base, minute: 23 * 60 });
  check("without windows the cascade is unchanged", unchanged?.kind === "revision");
}

// --- 3.2: hard deadlines with nothing blocked ---
{
  const task = (over: Partial<Task>): Task => ({ id: "t1", title: "IndiaAI fellowship", status: "todo", priority: "high", category: "admin", kind: "external", dueDate: "2026-11-30", createdAt: "", updatedAt: "", ...over }) as Task;
  const today = "2026-11-27";
  check("an external task due in 3 days with no block is flagged", unplannedHardDeadlines({ tasks: [task({})], schedules: [], todayKey: today }).length === 1);
  check("its days left are counted", unplannedHardDeadlines({ tasks: [task({})], schedules: [], todayKey: today })[0]?.daysLeft === 3);
  check("a block assigned before the due date clears it", unplannedHardDeadlines({ tasks: [task({})], schedules: [{ dateKey: "2026-11-28", slots: [slot({ assignedTaskIds: ["t1"] })] }], todayKey: today }).length === 0);
  check("a block on a day already behind doesn't", unplannedHardDeadlines({ tasks: [task({})], schedules: [{ dateKey: "2026-11-26", slots: [slot({ assignedTaskIds: ["t1"] })] }], todayKey: today }).length === 1);
  check("a deadline further out isn't flagged yet", unplannedHardDeadlines({ tasks: [task({ dueDate: "2026-12-05" })], schedules: [], todayKey: today }).length === 0);
  check("an internal task isn't a hard deadline", unplannedHardDeadlines({ tasks: [task({ kind: undefined })], schedules: [], todayKey: today }).length === 0);
}

// --- 3.5 / 4: goal pace ---
{
  const week = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"];
  const goal = { id: "g1", title: "Implementation", status: "active", targetHoursPerWeek: 8, linked: { courseIds: [], paperIds: [], taskIds: [], goalIds: [] } } as unknown as Goal;
  const [none] = goalWeekPace({ goals: [goal], schedules: [], sessions: [], weekDateKeys: week, todayKey: "2026-11-25", nowMinutes: 600 });
  check("a goal with nothing planned mid-week warns", Boolean(none?.warning?.includes("Nothing planned")), JSON.stringify(none));
  const [monday] = goalWeekPace({ goals: [goal], schedules: [], sessions: [], weekDateKeys: week, todayKey: "2026-11-23", nowMinutes: 600 });
  check("on Monday it doesn't warn yet", !monday?.warning);
  const goalSlot = slot({ id: "gs", objectiveRef: { kind: "goal", id: "g1" }, type: "deep_work", startTime: "09:00", endTime: "10:00" });
  const schedules = ["2026-11-26", "2026-11-27", "2026-11-28"].map((dateKey) => ({ dateKey, slots: [goalSlot, { ...goalSlot, id: "gs2", startTime: "10:00", endTime: "11:00" }] }));
  const [planned] = goalWeekPace({ goals: [goal], schedules, sessions: [], weekDateKeys: week, todayKey: "2026-11-25", nowMinutes: 600 });
  check("planned goal blocks ahead count", planned?.plannedMinutes === 360 && !planned.warning, JSON.stringify(planned));
}

// --- 3.4: laying sittings out backwards from a deadline ---
{
  const days = [
    { dateKey: "2026-12-04", windows: [{ start: 540, end: 1080 }], busy: [], sittings: 0 },
    { dateKey: "2026-12-07", windows: [{ start: 540, end: 720 }], busy: [{ start: 600, end: 630 }], sittings: 0 }
  ];
  const { placed, unplaced } = layOutBackwards({ sittings: [{ key: "a", minutes: 50 }, { key: "b", minutes: 50 }, { key: "buffer", minutes: 45 }], days, gapMinutes: 10 });
  check("everything fits", unplaced.length === 0, JSON.stringify(unplaced));
  const buffer = placed.find((p) => p.key === "buffer")!;
  check("the buffer is last, ending by the deadline", buffer.dateKey === "2026-12-07" && buffer.end <= 720, JSON.stringify(buffer));
  const order = placed.map((p) => `${p.dateKey}T${p.start}`);
  check("sittings keep their order in time", [...order].sort().join() === order.join(), order.join());
  check("nothing lands on existing blocks", placed.every((p) => p.dateKey !== "2026-12-07" || p.end <= 600 - 10 || p.start >= 630 + 10), JSON.stringify(placed));
  const capped = layOutBackwards({ sittings: [{ key: "x", minutes: 30 }], days: [{ dateKey: "2026-12-07", windows: [{ start: 540, end: 720 }], busy: [], sittings: 7 }] });
  check("a day at the sitting cap takes no more", capped.unplaced.length === 1);
  const deep = layOutBackwards({ sittings: [{ key: "d", minutes: 30, energy: "deep" }], days: [{ dateKey: "2026-12-07", windows: [{ start: 840, end: 1080, energy: "light" as const }], busy: [], sittings: 0 }] });
  check("deep work never goes in a light window", deep.unplaced.length === 1);
}

// --- 2.4: tentative blocks are soft ---
{
  const held = slot({ id: "m", title: "Meeting (TBC)", type: "meeting", startTime: "12:00", endTime: "17:00", tentative: true });
  const work = slot({ id: "w", title: "Write", type: "deep_work", startTime: "13:30", endTime: "14:20" });
  check("a block may sit on a tentative one", validateSlots([held, work]).length === 0, validateSlots([held, work]).join(" "));
  check("a firm meeting there is a clash", validateSlots([{ ...held, tentative: undefined }, work]).length === 1);
  check("placement ignores tentative time", placeInWindow([held], 720, 1020, 50) === 720);
}

// --- Clearing catch-up hours ---
{
  const days = ["2026-11-20", "2026-11-27", "2026-11-28"].map((date) => ({ date, loadIndex: { requiredMinutes: 120, actualMinutes: 0 } }));
  check("uncleared, every day counts", computeDebtHours(daysSinceCatchUpClear(days).map((d) => d.loadIndex)) === 6);
  check("cleared on the 27th, only later days count", computeDebtHours(daysSinceCatchUpClear(days, "2026-11-27").map((d) => d.loadIndex)) === 2);
  check("the day of the clear itself doesn't come back", daysSinceCatchUpClear(days, "2026-11-28").length === 0);
}

if (failures.length > 0) {
  console.error(`verify-planning-feedback: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("verify-planning-feedback: all checks passed.");
