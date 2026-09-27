#!/usr/bin/env tsx
/**
 * Unit-test stand-in for plan/16's pure functions — `splitIntoChunks`/`taskChunkMinutes`
 * (lib/timeline.ts), `remainingMinutes`/`sittingOutcome`/`sittingRemainingMinutes`
 * (lib/tracking.ts), `plannedMinutesThisWeek` (lib/courses.ts), `describeObjective`
 * (lib/objectives.ts), and `computeDayScore` (lib/gamify.ts). Same pattern as
 * scripts/verify-weekplan.ts, since this repo has no test runner.
 *
 * These cover plan/16 §7.1 only. Every criterion in §7.2 — drag, timer arming, PiP rendering,
 * notification delivery — is deliberately NOT here and cannot be: this script touches no Firestore,
 * renders no component, and drives no user flow. A green run says the arithmetic is right and
 * nothing more.
 */
import { DEFAULT_MAX_CHUNK_MINUTES, splitIntoChunks, taskChunkMinutes, taskBlockMinutes, sittingTitle } from "../lib/timeline";
import { loggedMinutesForTask, remainingMinutes, sittingOutcome, sittingRemainingMinutes } from "../lib/tracking";
import { plannedMinutesForTask, plannedMinutesThisWeek } from "../lib/courses";
import { describeObjective } from "../lib/objectives";
import { computeDayReadout, computeDayScore } from "../lib/gamify";
import { placeProposals, DEFAULT_WORKING_WINDOW, type WeekProposalCandidate } from "../lib/weekplan";
import type { DailySchedule, PomodoroSession, ScheduleSlot, Task } from "../types";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures.push(detail ? `${label}: ${detail}` : label);
}

const WEEK = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];
const MON = WEEK[0];

// --- AC #1-#5: splitIntoChunks (plan/16 §5.1) ---

{
  // AC #1 — the headline case: the 14-pomodoro task that used to become one unplaceable 350m block.
  const chunks = splitIntoChunks(350, { maxChunkMinutes: 50 });
  check("350m at a 50m cap splits into 7 sittings", chunks.length === 7, `got ${chunks.length}: ${chunks.join(",")}`);
  check("no sitting exceeds the cap", chunks.every((m) => m <= 50), chunks.join(","));
  check("no sitting is below the floor", chunks.every((m) => m >= 15), chunks.join(","));
  check("350m split sums back to 350", chunks.reduce((a, b) => a + b, 0) === 350, `got ${chunks.reduce((a, b) => a + b, 0)}`);
}

{
  // AC #2 — even sittings, not "max, max, remainder". A trailing stub is harder to place and less
  // useful than three even sittings.
  const chunks = splitIntoChunks(120, { maxChunkMinutes: 50 });
  check("120m at a 50m cap is 3x40, not 50/50/20", chunks.length === 3 && chunks.every((m) => m === 40), chunks.join(","));
}

{
  // AC #3 — the floor is never violated by a remainder.
  const chunks = splitIntoChunks(55, { maxChunkMinutes: 50, minChunkMinutes: 15 });
  check("55m at a 50m cap never yields a 5m stub", chunks.every((m) => m >= 15), chunks.join(","));
  check("55m split sums back to 55", chunks.reduce((a, b) => a + b, 0) === 55, chunks.join(","));
}

{
  // AC #4 — work that already fits, and work the user said must not be split.
  check("30m under the cap stays one sitting", JSON.stringify(splitIntoChunks(30, { maxChunkMinutes: 50 })) === "[30]");
  check("unsplittable work stays one sitting however long", JSON.stringify(splitIntoChunks(350, { maxChunkMinutes: 50, splittable: false })) === "[350]");
  check("zero minutes yields no sittings", splitIntoChunks(0).length === 0);
}

{
  // AC #5 — the invariant that matters most: planning never creates or destroys minutes.
  let bad = "";
  for (let total = 1; total <= 600 && !bad; total += 1) {
    for (const max of [20, 25, 30, 45, 50, 90]) {
      const chunks = splitIntoChunks(total, { maxChunkMinutes: max, minChunkMinutes: 15 });
      const sum = chunks.reduce((a, b) => a + b, 0);
      if (sum !== total) bad = `total=${total} max=${max} -> ${chunks.join(",")} (sum ${sum})`;
      if (chunks.length > 1 && chunks.some((m) => m > max)) bad = `total=${total} max=${max} exceeded cap: ${chunks.join(",")}`;
    }
  }
  check("every split sums to its input and respects the cap, swept", bad === "", bad);
}

{
  // A fixed-time task is one sitting at its own clock length, whatever its estimate says.
  const task: Pick<Task, "estimatedPomodoros" | "maxChunkMinutes" | "splittable" | "fixedTime"> = {
    estimatedPomodoros: 14,
    fixedTime: { startTime: "14:00", endTime: "15:00" }
  };
  check("a fixed-time task is one 60m sitting", JSON.stringify(taskChunkMinutes(task, 25)) === "[60]", JSON.stringify(taskChunkMinutes(task, 25)));
  // A per-task cap overrides the account-wide one.
  const capped = taskChunkMinutes({ estimatedPomodoros: 4, maxChunkMinutes: 25 }, 25, { maxChunkMinutes: 90 });
  check("a per-task cap beats the account-wide cap", capped.length === 4 && capped.every((m) => m <= 25), capped.join(","));
  check("default cap is 50", DEFAULT_MAX_CHUNK_MINUTES === 50);
  check("taskBlockMinutes is still the uncapped total", taskBlockMinutes({ estimatedPomodoros: 14 }, 25) === 350);
  check("sittingTitle omits the suffix for unsplit work", sittingTitle("Read", 1, 1) === "Read");
  check("sittingTitle labels a sitting 1-based", sittingTitle("Read", 3, 7) === "Read (3 of 7)");
}

// --- AC #6: remainingMinutes is minutes, not session counts (plan/16 §5.1) ---

function session(partial: Partial<PomodoroSession>): PomodoroSession {
  return {
    id: "s", label: "l", category: "research", mode: "work", minutes: 25,
    completedAt: "2026-09-21T10:00:00.000Z", cycle: 1, ...partial
  };
}

{
  const sessions = [
    session({ taskId: "t1", minutes: 22 }),
    session({ taskId: "t1", minutes: 40 }),
    session({ taskId: "t2", minutes: 100 }),
    session({ taskId: "t1", minutes: 30, mode: "short_break" })
  ];
  check("logged minutes sum only this task's work sessions", loggedMinutesForTask(sessions, "t1") === 62, `got ${loggedMinutesForTask(sessions, "t1")}`);
  check("remaining = total - logged, in minutes", remainingMinutes(150, sessions, "t1") === 88, `got ${remainingMinutes(150, sessions, "t1")}`);
  // The defect this replaces: a 6-minute session used to advance a task exactly as far as a 50m one.
  check("a 6m session moves remaining by 6", remainingMinutes(100, [session({ taskId: "t1", minutes: 6 })], "t1") === 94);
  check("break sessions never count", remainingMinutes(100, [session({ taskId: "t1", minutes: 50, mode: "long_break" })], "t1") === 100);
  check("remaining clamps at 0 when overworked", remainingMinutes(30, sessions, "t1") === 0);
}

// --- AC #7: plannedMinutesThisWeek counts accepted slots (plan/16 §2.2/§5.8) ---

function slot(partial: Partial<ScheduleSlot>): ScheduleSlot {
  return { id: "x", title: "b", type: "deep_work", startTime: "09:00", endTime: "09:50", status: "upcoming", ...partial };
}

{
  const schedules: Pick<DailySchedule, "dateKey" | "slots">[] = [
    { dateKey: MON, slots: [slot({ courseId: "c1", bucket: "revision" }), slot({ courseId: "c1", bucket: "assignment" })] },
    { dateKey: WEEK[2], slots: [slot({ courseId: "c1", bucket: "revision", plannedMinutes: 45, endTime: "10:30" })] },
    { dateKey: "2026-09-14", slots: [slot({ courseId: "c1", bucket: "revision" })] }
  ];
  check("accepted slots count toward the bucket's planned minutes", plannedMinutesThisWeek(schedules, "c1", "revision", WEEK) === 95,
    `got ${plannedMinutesThisWeek(schedules, "c1", "revision", WEEK)}`);
  check("plannedMinutes wins over a resized duration", plannedMinutesThisWeek([schedules[1]], "c1", "revision", WEEK) === 45);
  check("a slot outside the week is excluded", plannedMinutesThisWeek([schedules[2]], "c1", "revision", WEEK) === 0);
  check("another bucket is not counted", plannedMinutesThisWeek(schedules, "c1", "assignment", WEEK) === 50);
}

{
  // The two planned pools must stay disjoint, or a course task that has been dropped onto a day is
  // subtracted twice (once as a task by `scheduledMinutesThisWeek`, once as a slot here) and the
  // bucket reads satisfied when it isn't.
  const withTaskBlock: Pick<DailySchedule, "dateKey" | "slots">[] = [
    {
      dateKey: MON,
      slots: [
        slot({ courseId: "c1", bucket: "revision" }),
        slot({ courseId: "c1", bucket: "revision", assignedTaskIds: ["t1"], plannedMinutes: 90 })
      ]
    }
  ];
  check("a task-derived block is not counted as bucket-planned minutes",
    plannedMinutesThisWeek(withTaskBlock, "c1", "revision", WEEK) === 50,
    `got ${plannedMinutesThisWeek(withTaskBlock, "c1", "revision", WEEK)}`);
  check("the same block IS counted as that task's planned minutes",
    plannedMinutesForTask(withTaskBlock, "t1", WEEK) === 90,
    `got ${plannedMinutesForTask(withTaskBlock, "t1", WEEK)}`);
  check("a task with nothing placed has no planned minutes", plannedMinutesForTask(withTaskBlock, "t2", WEEK) === 0);
  check("a task block outside the week is excluded",
    plannedMinutesForTask([{ dateKey: "2026-09-14", slots: [slot({ assignedTaskIds: ["t1"] })] }], "t1", WEEK) === 0);
}

{
  // Accounting a task's work: `max(logged, planned)`, never the sum. The two signals overlap — a
  // 50-minute sitting with 22 logged is 50 planned and 22 logged — so summing double-subtracts.
  const accounted = (logged: number, planned: number) => Math.max(logged, planned);
  check("nothing worked yet: the placed sitting is what's accounted", accounted(0, 50) === 50);
  check("partly worked: the sitting still accounts for its full planned length", accounted(22, 50) === 50);
  check("worked past the plan: the real minutes win", accounted(80, 50) === 80);
  check("summing would double-count the worked part", 22 + 50 !== accounted(22, 50));
}

// --- AC #8: one task's sittings spread, and never onto a day off (plan/15 regression) ---

{
  const sittings: WeekProposalCandidate[] = Array.from({ length: 7 }, (_, i) => ({
    title: `Write related-work (${i + 1} of 7)`,
    type: "deep_work",
    durationMinutes: 50,
    capGroup: "task:t1"
  }));
  const off = new Set([WEEK[3]]);
  const placed = placeProposals(sittings, WEEK, {}, DEFAULT_WORKING_WINDOW, off);
  const days = new Set(placed.filter((p) => p.fits).map((p) => p.dateKey));
  check("one task's 7 sittings spread across 3+ days", days.size >= 3, `landed on ${days.size} day(s): ${[...days].join(",")}`);
  check("no sitting lands on a day off", placed.filter((p) => p.fits).every((p) => !off.has(p.dateKey)), [...days].join(","));
  check("every sitting is placed somewhere", placed.every((p) => p.fits), `${placed.filter((p) => !p.fits).length} did not fit`);
}

{
  // A fixed-time pin takes its exact clock time, and is refused rather than moved when occupied.
  const pinned: WeekProposalCandidate[] = [
    { title: "TA meeting", type: "deep_work", durationMinutes: 60, dateKey: MON, fixedStartTime: "14:00" },
    { title: "Clashing meeting", type: "deep_work", durationMinutes: 60, dateKey: MON, fixedStartTime: "14:30" }
  ];
  const placed = placeProposals(pinned, WEEK, {}, DEFAULT_WORKING_WINDOW);
  check("a fixed-time candidate lands at its own clock time", placed[0].fits && placed[0].startTime === "14:00", `${placed[0].startTime} fits=${placed[0].fits}`);
  check("a clashing fixed-time candidate is refused, not moved", !placed[1].fits, `moved to ${placed[1].startTime}`);
}

// --- plan/16 §5.3 / §8 Q2: a candidate's own key survives placement, and shifting the list
//     no longer re-targets it. This is what makes the week grid's drag state and `blockDecisions`
//     safe to key on: they must follow the piece of work, not its array position.

{
  const a: WeekProposalCandidate = { title: "Revise CS201", type: "deep_work", durationMinutes: 45, key: "revision:c1:0" };
  const b: WeekProposalCandidate = { title: "Read: Attention", type: "reading", durationMinutes: 45, key: "paper:p1:0" };
  const unkeyed: WeekProposalCandidate = { title: "Something old", type: "admin", durationMinutes: 30 };

  const before = placeProposals([a, b], WEEK, {}, DEFAULT_WORKING_WINDOW);
  // A new candidate appended at the front is exactly what accepting a "What's coming" row does.
  const after = placeProposals([unkeyed, a, b], WEEK, {}, DEFAULT_WORKING_WINDOW);
  const keyOf = (list: typeof before, title: string) => list.find((p) => p.title === title)?.key;
  check("a keyed candidate keeps its key through placement", keyOf(before, "Revise CS201") === "revision:c1:0", `got ${keyOf(before, "Revise CS201")}`);
  check("prepending a candidate does not re-target an existing key",
    keyOf(after, "Revise CS201") === keyOf(before, "Revise CS201") && keyOf(after, "Read: Attention") === keyOf(before, "Read: Attention"),
    `${keyOf(after, "Revise CS201")} / ${keyOf(after, "Read: Attention")}`);
  check("an unkeyed candidate still falls back to its array index", keyOf(after, "Something old") === "0", `got ${keyOf(after, "Something old")}`);
  check("keys are unique across a placed set", new Set(after.map((p) => p.key)).size === after.length);
}

// --- AC #9: describeObjective (plan/16 §5.2) ---

const objectiveCtx = {
  courses: [{ id: "c1", name: "CS201" }],
  papers: [{ id: "p1", title: "Attention Is All You Need" }],
  checkpoints: [{ id: "k1", title: "Midterm 1" }],
  tasks: [{ id: "t1", title: "Essay", courseId: "c1", bucket: "assignment" as const }],
  goals: [{ id: "g1", title: "Survey", milestones: [{ id: "m1", title: "Outline", done: false }] }]
};

{
  const prep = describeObjective(slot({ objectiveRef: { kind: "checkpoint", id: "k1" } }), objectiveCtx);
  check("checkpoint objective labels Prep", prep?.label === "Prep" && prep?.detail === "Midterm 1", JSON.stringify(prep));

  const paper = describeObjective(slot({ type: "reading", objectiveRef: { kind: "paper", id: "p1", passNo: 2 } }), objectiveCtx);
  check("paper objective carries the paper into attribution", paper?.attribution.paperId === "p1" && paper?.attribution.passNo === 2, JSON.stringify(paper));

  const queue = describeObjective(slot({ objectiveRef: { kind: "revisionQueue" } }), objectiveCtx);
  check("revision-queue objective has a label and no ref", queue?.label === "Spaced repetition", JSON.stringify(queue));

  const course = describeObjective(slot({ courseId: "c1", bucket: "revision" }), objectiveCtx);
  check("course objective reads bucket + course", course?.detail === "CS201" && course?.attribution.courseId === "c1", JSON.stringify(course));

  const viaTask = describeObjective(slot({ assignedTaskIds: ["t1"] }), objectiveCtx);
  check("a task's course/bucket resolves when the slot carries neither", viaTask?.attribution.courseId === "c1" && viaTask?.attribution.taskId === "t1", JSON.stringify(viaTask));

  const cls = describeObjective(slot({ type: "class", courseId: "c1" }), objectiveCtx);
  check("a class block is labeled Class, never a bucket", cls?.label === "Class", JSON.stringify(cls));

  check("an ordinary block has no objective", describeObjective(slot({ type: "meal", title: "Lunch" }), objectiveCtx) === null);

  // Every objective must hand `startFocus` a usable argument object (plan/16 §5.5).
  const all = [prep, paper, queue, course, viaTask, cls];
  check("every objective returns an attribution object", all.every((o) => o !== null && typeof o.attribution === "object"));
}

// --- AC #10: computeDayScore (plan/16 §5.6) ---

{
  const nothingPlanned = computeDayScore({ slots: [], sessions: [] });
  check("a day with nothing planned scores null, not 0", nothingPlanned.score === null, JSON.stringify(nothingPlanned));

  const dayOff = computeDayScore({ slots: [slot({ id: "a" })], sessions: [], isDayOff: true });
  check("a day off scores null", dayOff.score === null, JSON.stringify(dayOff));

  // Two closed 50m sittings, fully covered, on track.
  const closed = computeDayScore({
    slots: [slot({ id: "a", plannedMinutes: 50 }), slot({ id: "b", startTime: "11:00", endTime: "11:50", plannedMinutes: 50 })],
    sessions: [session({ slotId: "a", minutes: 50 }), session({ slotId: "b", minutes: 50 })],
    loadIndex: { value: 1 }
  });
  check("a fully covered, on-track day scores 100", closed.score === 100, JSON.stringify(closed));
  check("closed sittings are counted", closed.sittingsClosed === 2 && closed.sittingsPlanned === 2, JSON.stringify(closed));

  // Same logged minutes, but spread so neither sitting reaches the 60% closure threshold.
  const halves = computeDayScore({
    slots: [slot({ id: "a", plannedMinutes: 50 }), slot({ id: "b", startTime: "11:00", endTime: "11:50", plannedMinutes: 50 })],
    sessions: [session({ slotId: "a", minutes: 25 }), session({ slotId: "b", minutes: 25 })],
    loadIndex: { value: 0.5 }
  });
  const oneClosed = computeDayScore({
    slots: [slot({ id: "a", plannedMinutes: 50 }), slot({ id: "b", startTime: "11:00", endTime: "11:50", plannedMinutes: 50 })],
    sessions: [session({ slotId: "a", minutes: 50 })],
    loadIndex: { value: 0.5 }
  });
  check("finishing sittings beats half-finishing them at equal minutes",
    (oneClosed.score ?? 0) > (halves.score ?? 0), `oneClosed=${oneClosed.score} halves=${halves.score}`);
  check("half-covered sittings close none", halves.sittingsClosed === 0, JSON.stringify(halves));
}

// --- sittingOutcome / sittingRemainingMinutes (plan/16 §5.5) ---

{
  const s = slot({ id: "a", plannedMinutes: 50 });
  check("an untouched sitting reads untouched", sittingOutcome(s, []) === "untouched");
  check("a 22/50 sitting reads partial", sittingOutcome(s, [session({ slotId: "a", minutes: 22 })]) === "partial");
  check("a 40/50 sitting reads closed (60% rule)", sittingOutcome(s, [session({ slotId: "a", minutes: 40 })]) === "closed");
  check("resuming a 22/50 sitting arms 28 minutes", sittingRemainingMinutes(s, [session({ slotId: "a", minutes: 22 })]) === 28,
    `got ${sittingRemainingMinutes(s, [session({ slotId: "a", minutes: 22 })])}`);
  check("a fully covered sitting arms nothing", sittingRemainingMinutes(s, [session({ slotId: "a", minutes: 50 })]) === 0);
  check("a class block closes on attendance, not coverage", sittingOutcome(slot({ id: "c", type: "class" }), [], true) === "closed");
}

// --- plan/16 §5.6 / §8 Q6: pace while the day runs, the absolute score once it's done ---

{
  const morning = [
    slot({ id: "a", type: "deep_work", startTime: "09:00", endTime: "09:50", plannedMinutes: 50 }),
    slot({ id: "b", type: "deep_work", startTime: "14:00", endTime: "14:50", plannedMinutes: 50 })
  ];

  // 08:00: nothing was planned to have finished yet, so pace is null — never 0, which would read as
  // a failure for not having done work that wasn't due.
  const early = computeDayReadout({ slots: morning, sessions: [], nowMinute: 8 * 60 });
  check("before the first sitting ends, pace is null not zero", early.mode === "pace" && early.pace === null, `${early.mode}/${early.pace}`);

  // 10:00: one 50-minute sitting has ended and 40 minutes were logged — 80% of pace, even though
  // the absolute score would be a discouraging fraction of the whole day.
  const midday = computeDayReadout({
    slots: morning,
    sessions: [session({ slotId: "a", minutes: 40 })],
    nowMinute: 10 * 60
  });
  check("mid-day reads pace against what has elapsed", midday.mode === "pace" && midday.pace === 0.8, `${midday.mode}/${midday.pace}`);

  // 18:00: everything planned has elapsed, so pace has stopped being a different question.
  const evening = computeDayReadout({ slots: morning, sessions: [session({ slotId: "a", minutes: 40 })], nowMinute: 18 * 60 });
  check("once every sitting has elapsed, the absolute score takes over", evening.mode === "final", evening.mode);

  // A written snapshot always wins, and always reads as final — a closed day's record must not
  // change under a later edit.
  const snapshotted = computeDayReadout({
    slots: morning,
    sessions: [],
    nowMinute: 10 * 60,
    snapshot: { score: 71, sittingsClosed: 1, sittingsPlanned: 2, minutesLogged: 40, minutesPlanned: 100 }
  });
  check("a stored snapshot wins over a recomputation", snapshotted.mode === "final" && snapshotted.score === 71, `${snapshotted.mode}/${snapshotted.score}`);

  const dayOff = computeDayReadout({ slots: morning, sessions: [], nowMinute: 10 * 60, isDayOff: true });
  check("a day off is never paced", dayOff.mode === "final" && dayOff.score === null, `${dayOff.mode}/${dayOff.score}`);
}

if (failures.length > 0) {
  console.error(`verify-chunking: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("verify-chunking: all plan/16 pure-function checks passed.");
