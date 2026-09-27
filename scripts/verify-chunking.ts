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
import { isFromDroppedCourse, plannableTasks } from "../lib/courses";
import { nextPassEstimateMinutes, nextReadingPass, pastPassMinutes, readingCandidates, PASS_SEED_MINUTES } from "../lib/papers";
import { placeProposals, resolvePlacement, DEFAULT_WORKING_WINDOW, type WeekProposalCandidate } from "../lib/weekplan";
import type { DailySchedule, Paper, PomodoroSession, ScheduleSlot, Task } from "../types";

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

// --- plan/16 §5.4 / AC #20: a user-confirmed time must be placed before the search guesses ---
//
// `placeProposals` walks its array once, committing each candidate as it goes, and refuses (never
// moves) a `fixedStartTime` candidate whose exact range is taken. "What's coming" prefills its time
// from `placeInWindow`, which returns the earliest fitting gap — exactly where the search puts its
// own first candidate for that day. So the ordering isn't a detail: last means the default prefill
// collides by construction and the confirmed time comes back "Didn't fit".

{
  const confirmed: WeekProposalCandidate = {
    title: "Prep: Midterm (confirmed 09:00)",
    type: "deep_work",
    durationMinutes: 50,
    dateKey: MON,
    fixedStartTime: "09:00",
    key: "upcoming:checkpoint:k1:0"
  };
  const floating: WeekProposalCandidate = { title: "Revise CS201", type: "deep_work", durationMinutes: 50, preferredDateKeys: [MON], key: "revision:c1:0" };

  const confirmedFirst = placeProposals([confirmed, floating], WEEK, {}, DEFAULT_WORKING_WINDOW);
  check(
    "a confirmed time placed first keeps its own slot",
    confirmedFirst[0].fits && confirmedFirst[0].startTime === "09:00",
    `${confirmedFirst[0].startTime} fits=${confirmedFirst[0].fits}`
  );
  check("and the floating candidate moves around it", confirmedFirst[1].fits && confirmedFirst[1].startTime !== "09:00", confirmedFirst[1].startTime);

  // The regression itself: ordered last, the same confirmed time is refused outright.
  const confirmedLast = placeProposals([floating, confirmed], WEEK, {}, DEFAULT_WORKING_WINDOW);
  check(
    "ordered last, a confirmed time is refused — which is why the caller orders it first",
    !confirmedLast[1].fits,
    `fits=${confirmedLast[1].fits} at ${confirmedLast[1].startTime}`
  );
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

// --- plan/16: a dropped course's tasks are never proposed ---

{
  const courses = [{ id: "c1", status: "active" as const }, { id: "c2", status: "dropped" as const }, { id: "c3", status: "completed" as const }];
  const list = [
    { id: "t1", courseId: "c1" },
    { id: "t2", courseId: "c2" },
    { id: "t3", courseId: "c3" },
    { id: "t4" }
  ];
  const kept = plannableTasks(list, courses).map((task) => task.id);
  check("a dropped course's task is not plannable", !kept.includes("t2"), kept.join(","));
  check("an active course's task, a completed course's task, and an uncoursed task all are",
    kept.includes("t1") && kept.includes("t3") && kept.includes("t4"), kept.join(","));
  check("isFromDroppedCourse ignores a task with no course", !isFromDroppedCourse({}, courses));
  check("an unknown courseId is not treated as dropped", !isFromDroppedCourse({ courseId: "gone" }, courses));
}

// --- plan/16 §5.2: reading is planned as the pass the paper is actually owed ---

const paper = (partial: Partial<Paper>): Paper => ({
  id: "p1",
  title: "A paper",
  authors: [],
  status: "to_read",
  priority: "medium",
  tags: [],
  progress: 0,
  groupIds: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...partial
});
const donePass = (minutes: number, output?: unknown) => ({ status: "done" as const, minutes, output: output as never });

{
  check("a fresh paper is owed pass 1", nextReadingPass(paper({})) === 1);
  check("an in-progress pass 1 is still pass 1", nextReadingPass(paper({ pass1: { status: "in_progress" } })) === 1);
  check("a finished pass 1 moves to pass 2", nextReadingPass(paper({ pass1: donePass(8, { verdict: "continue" }) })) === 2);
  check("a skipped pass counts as passed through", nextReadingPass(paper({ pass1: { status: "skipped" } })) === 2);
  check(
    "a dropped paper is owed nothing",
    nextReadingPass(paper({ pass1: donePass(6, { verdict: "drop" }) })) === null
  );
  check(
    "a parked paper is owed nothing",
    nextReadingPass(paper({ pass1: donePass(6, { verdict: "park" }) })) === null
  );
  // Pass 3 is opt-in, exactly as derivePaperStatus treats it: "grasped" finishes the paper.
  check(
    "pass 2 grasped finishes the paper",
    nextReadingPass(paper({ pass1: donePass(7, { verdict: "continue" }), pass2: donePass(55, { outcome: "grasped" }) })) === null
  );
  check(
    "pass 2 persevere earns a pass 3",
    nextReadingPass(paper({ pass1: donePass(7, { verdict: "continue" }), pass2: donePass(55, { outcome: "persevere" }) })) === 3
  );
  check(
    "a deliberate set-aside is not argued with",
    nextReadingPass(paper({ pass1: donePass(7, { verdict: "continue" }), pass2: donePass(55, { outcome: "set-aside" }) })) === null
  );
  check("a finished pass 3 is owed nothing", nextReadingPass(paper({ pass3: donePass(95) })) === null);
}

{
  // Sizing: the seed until there are 5 samples, then the reader's own median.
  const noHistory = nextPassEstimateMinutes(paper({}), [paper({})]);
  check("with no history, pass 1 is the seed estimate", noHistory === PASS_SEED_MINUTES[1], `got ${noHistory}`);

  const library = [10, 12, 14, 16, 18].map((minutes, i) => paper({ id: `h${i}`, pass1: donePass(minutes, { verdict: "continue" }) }));
  check("five samples switch pass 1 to the reader's own median", pastPassMinutes(library, 1).length === 5, `${pastPassMinutes(library, 1)}`);
  const calibrated = nextPassEstimateMinutes(paper({}), [...library, paper({})]);
  check("the calibrated estimate replaces the seed", calibrated === 14, `got ${calibrated}`);
  check("an unfinished pass contributes no sample", pastPassMinutes([paper({ pass1: { status: "in_progress", minutes: 9 } })], 1).length === 0);
}

{
  // Candidate selection: staleness ranks, it no longer gates. A paper added today with a next pass
  // is plannable — under the old rule only `reading`-status papers untouched 14+ days ever were.
  // Note the goal: a paper without one is *correctly* held back at pass 1, so a fixture testing
  // "added today is plannable" has to give it one — which is the gate doing its job.
  const fresh = paper({
    id: "fresh",
    title: "Added today",
    priority: "high",
    goal: "check whether the baseline is comparable",
    goalKind: "baseline",
    updatedAt: "2026-09-26T00:00:00.000Z"
  });
  const blocked = paper({ id: "blocked", title: "No goal yet" });
  const withGoal = paper({ id: "goal", title: "Has a goal", goal: "decide if the method applies", goalKind: "method" });
  const finished = paper({ id: "done", pass1: donePass(7, { verdict: "continue" }), pass2: donePass(50, { outcome: "grasped" }) });

  const { plannable, needsGoal } = readingCandidates([fresh, blocked, withGoal, finished], "2026-09-26");
  const ids = plannable.map((item) => item.paper.id);
  check("a paper added today is plannable", ids.includes("fresh"), ids.join(","));
  check("a finished paper is not offered", !ids.includes("done"), ids.join(","));
  check("pass 1 without a reading goal is held back, not proposed", !ids.includes("blocked") && needsGoal.some((p) => p.id === "blocked"), ids.join(","));
  check("a paper with a goal is proposed", ids.includes("goal"), ids.join(","));
  check("every candidate carries a pass and a length", plannable.every((item) => item.passNo >= 1 && item.minutes > 0));
  check("high priority is offered first", plannable[0]?.paper.id === "fresh", ids.join(","));
}

// --- plan/16 §5.3: a typed duration is resolved against every constraint it touches ---
//
// This is the regression guard for the "increase a block's size and it doesn't adjust" report. The
// clamps aren't cosmetic: a block longer than `maxChunkMinutes` arms a timer clamped to that cap
// (`startFocus`), so it can never reach `slotAutoStatus`'s 60% coverage, so it never closes, and
// `computeDayScore` counts it unfinished while dividing coverage by the inflated plan. An over-long
// block is unfinishable by construction.

{
  const bounds = { maxChunkMinutes: 50, minChunkMinutes: 15, workingWindow: DEFAULT_WORKING_WINDOW };
  const empty = { occupied: [], ...bounds };

  const overCap = resolvePlacement({ dateKey: MON, startMinutes: 9 * 60, durationMinutes: 120 }, empty);
  check("a duration over the sitting cap is clamped to it", overCap.placement.durationMinutes === 50, `${overCap.placement.durationMinutes}`);
  check("and says so", overCap.notes.some((note) => note.includes("longest sitting")), overCap.notes.join(" "));

  const underFloor = resolvePlacement({ dateKey: MON, startMinutes: 9 * 60, durationMinutes: 5 }, empty);
  check("a duration under the floor is raised to it", underFloor.placement.durationMinutes === 15, `${underFloor.placement.durationMinutes}`);

  // Growth stops at the locked layer rather than overlapping a lecture that cannot move.
  const beforeLecture = resolvePlacement(
    { dateKey: MON, startMinutes: 9 * 60, durationMinutes: 50 },
    { ...bounds, occupied: [{ startTime: "09:35", endTime: "11:00", title: "CS201 lecture" }] }
  );
  check("growth stops where the next block starts", beforeLecture.placement.durationMinutes === 35, `${beforeLecture.placement.durationMinutes}`);
  check("and names what stopped it", beforeLecture.notes.some((note) => note.includes("CS201 lecture")), beforeLecture.notes.join(" "));

  // The working window is a ceiling too.
  const atWindowEnd = resolvePlacement({ dateKey: MON, startMinutes: 17 * 60 + 40, durationMinutes: 50 }, empty);
  check("growth stops at the end of the working window", atWindowEnd.placement.durationMinutes === 20, `${atWindowEnd.placement.durationMinutes}`);

  // Squeezed into a gap smaller than the floor, the length is left alone: the caller's own overlap
  // check then reports it, which beats silently shrinking it to a stub that happens to fit.
  const noRoom = resolvePlacement(
    { dateKey: MON, startMinutes: 9 * 60, durationMinutes: 50 },
    { ...bounds, occupied: [{ startTime: "09:05", endTime: "11:00", title: "Standup" }] }
  );
  check("a gap below the floor is not silently filled with a stub", noRoom.placement.durationMinutes === 50, `${noRoom.placement.durationMinutes}`);
  check("and the user is told to move it", noRoom.notes.some((note) => note.includes("move it")), noRoom.notes.join(" "));

  // A start outside the window is pulled back in, and a placement that needs nothing changed says
  // nothing — a notice on every edit would be noise.
  const early = resolvePlacement({ dateKey: MON, startMinutes: 6 * 60, durationMinutes: 45 }, empty);
  check("a start before the window is pulled into it", early.placement.startMinutes === 9 * 60, `${early.placement.startMinutes}`);
  const fine = resolvePlacement({ dateKey: MON, startMinutes: 10 * 60, durationMinutes: 45 }, empty);
  check("a placement needing no change reports nothing", fine.notes.length === 0, fine.notes.join(" "));
  check("and is returned unchanged", fine.placement.durationMinutes === 45 && fine.placement.startMinutes === 10 * 60);
}

if (failures.length > 0) {
  console.error(`verify-chunking: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("verify-chunking: all plan/16 pure-function checks passed.");
