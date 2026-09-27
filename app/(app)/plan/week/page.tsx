"use client";

import { getDay, parseISO } from "date-fns";
import { orderBy, where } from "firebase/firestore";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { InfoHint } from "@/components/info-hint";
import { ModuleGate } from "@/components/module-gate";
import { SectionHeader } from "@/components/section-header";
import { ProposalInspector, WeekGrid, type WeekGridPlacement } from "@/components/plan/week-grid";
import { TypedTimeInput } from "@/components/plan/typed-time-input";
import { useAuth } from "@/components/auth-provider";
import { useCourseCheckpoints } from "@/hooks/use-course-checkpoints";
import { useUserCollection } from "@/hooks/use-user-collection";
import { useUserSettings } from "@/hooks/use-user-settings";
import { averageFocusRating } from "@/lib/analytics";
import {
  bucketWeeklyTarget,
  completedMinutesThisWeek,
  courseSlotsForDate,
  effectiveCourseStatus,
  plannedMinutesForTask,
  plannedMinutesThisWeek,
  scheduledMinutesThisWeek,
  syncRevisionTemplate
} from "@/lib/courses";
import { addDaysToKey, todayKey, weekDates, weekStartKey } from "@/lib/dates";
import { clearDayOff, fetchCourseClassLogs, saveDailySchedule, saveWeeklyReviewFields, setDayOff, updateCourse, updateGoal, updatePaper, updateTask } from "@/lib/firestore";
import { isGoalActiveForDate } from "@/lib/goals";
import { computeDebtHours, computeLoadIndexStreak, loadIndexBand, loadIndexBandLabels, loadIndexBandStyles } from "@/lib/loadindex";
import { taskBucketLabels } from "@/lib/options";
import { DEFAULT_MAX_REVISIONS_PER_DAY, DEFAULT_MAX_REVISION_MINUTES_PER_DAY, estimatedReviewMinutes } from "@/lib/revision";
import { isTemplateDueOn } from "@/lib/recurring-tasks";
import { DEFAULT_ROUTINE_BLOCKS, routineSlotsForDate } from "@/lib/routine";
import { describeObjective, objectiveChipText } from "@/lib/objectives";
import { minutesFromTime, minutesToTime, sortedSlots, validateSlots } from "@/lib/schedule";
import { isBreakMode } from "@/lib/terms";
import { loggedMinutesForTask } from "@/lib/tracking";
import { DEFAULT_MAX_CHUNK_MINUTES, DEFAULT_MIN_CHUNK_MINUTES, sittingTitle, splitIntoChunks, taskBlockMinutes, taskChunkMinutes } from "@/lib/timeline";
import {
  DEFAULT_WORKING_WINDOW,
  placeInWindow,
  placeProposals,
  weekCapacity,
  weeklyPlanningSlotForDate,
  type WeekProposal,
  type WeekProposalCandidate
} from "@/lib/weekplan";
import type {
  ClassLog,
  Checkpoint,
  Course,
  DailySchedule,
  Day,
  Goal,
  Paper,
  PomodoroSession,
  ProposalDecision,
  RecurringTaskTemplate,
  RevisionItem,
  ScheduleSlot,
  SlotObjectiveRef,
  Task,
  TaskBucket,
  Term,
  WeeklyReview,
  WeekPlan
} from "@/types";

const COURSE_BUCKETS: TaskBucket[] = ["revision", "assignment", "backlog"];
/** plan/16 §5.4 — how far ahead "What's coming" looks. Configurable per account; 14 days is the
 *  plan's default, and is roughly two planning cycles, so a thing appears there before the week it
 *  is due rather than in the week it is due. */
const DEFAULT_UPCOMING_HORIZON_DAYS = 14;

/** plan/16 §5.4 — one real, dated thing in the horizon, with an estimate and the days it would
 *  prefer. The tentative *time* isn't stored on the row: it depends on what the chosen day already
 *  contains, so it's derived in `tentativeTime` from whichever day the row currently points at. */
type UpcomingRow = {
  id: string;
  title: string;
  detail: string;
  minutes: number;
  type: WeekProposalCandidate["type"];
  preferredDateKeys: string[];
  courseId?: string;
  bucket?: TaskBucket;
  taskId?: string;
  objectiveRef?: SlotObjectiveRef;
};
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function formatHours(minutes: number): string {
  if (minutes <= 0) return "0h";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** plan/14 §5 — defaults to the coming week once the outgoing week is winding down (Fri/Sat/Sun),
 *  else the week already in progress. Deliberately simple: a query param always overrides this. */
function defaultWeekStart(todayK: string): string {
  const dow = getDay(parseISO(todayK));
  if (dow === 0 || dow === 5 || dow === 6) {
    return weekStartKey(parseISO(addDaysToKey(todayK, dow === 0 ? 1 : 8 - dow)));
  }
  return weekStartKey(parseISO(todayK));
}


export default function PlanWeekPage() {
  return (
    <Suspense fallback={null}>
      <PlanWeekContent />
    </Suspense>
  );
}

function PlanWeekContent() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const { settings, update: updateSettings } = useUserSettings();
  const todayK = todayKey();

  // Memoized end to end (weekStart -> priorWeekStart -> the where-clause constraints below) so
  // each link has a provably stable identity across renders — otherwise every keystroke in this
  // page's many text/number inputs would re-derive a "new" priorWeekStart and tear down and
  // rebuild the priorWeekDays Firestore subscription below on every render.
  const weekStart = useMemo(() => searchParams.get("week") ?? defaultWeekStart(todayK), [searchParams, todayK]);
  const weekDateKeys = useMemo(() => weekDates(weekStart), [weekStart]);
  const priorWeekStart = useMemo(() => addDaysToKey(weekStart, -7), [weekStart]);
  const priorWeekDateKeys = useMemo(() => weekDates(priorWeekStart), [priorWeekStart]);
  const workMinutes = settings.workMinutes ?? 25;
  // plan/16 §5.1 — the sitting bounds every candidate below is split under. `chunkOpts` is passed
  // verbatim into `taskChunkMinutes`/`splitIntoChunks`, so a change on /settings reshapes the whole
  // week's proposals with no other code path to keep in sync.
  const chunkOpts = {
    maxChunkMinutes: settings.maxChunkMinutes ?? DEFAULT_MAX_CHUNK_MINUTES,
    minChunkMinutes: settings.minChunkMinutes ?? DEFAULT_MIN_CHUNK_MINUTES
  };
  const workingWindow = settings.workingWindow ?? DEFAULT_WORKING_WINDOW;

  const { items: courses } = useUserCollection<Course>("courses", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: terms } = useUserCollection<Term>("terms", useMemo(() => [orderBy("startDate", "desc")], []));
  const { items: tasks } = useUserCollection<Task>("tasks", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: recurringTemplates } = useUserCollection<RecurringTaskTemplate>("recurringTaskTemplates", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: goals } = useUserCollection<Goal>("goals", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: papers } = useUserCollection<Paper>("papers", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: sessions } = useUserCollection<PomodoroSession>("pomodoroSessions", useMemo(() => [orderBy("completedAt", "desc")], []));
  const { items: schedules } = useUserCollection<DailySchedule>("dailySchedules", useMemo(() => [orderBy("updatedAt", "desc")], []));
  const { items: reviews } = useUserCollection<WeeklyReview>("weeklyReviews", useMemo(() => [orderBy("updatedAt", "desc")], []));
  const { items: revisionItems } = useUserCollection<RevisionItem>("revisionItems", useMemo(() => [orderBy("dueDate", "asc")], []));
  const { items: recentDays } = useUserCollection<Day>("days", useMemo(() => [orderBy("date", "desc")], []));
  const priorWeekEnd = priorWeekDateKeys[6];
  const { items: priorWeekDays } = useUserCollection<Day>(
    "days",
    useMemo(() => [where("date", ">=", priorWeekStart), where("date", "<=", priorWeekEnd), orderBy("date")], [priorWeekStart, priorWeekEnd])
  );
  const { allCheckpoints } = useCourseCheckpoints(courses);

  // plan/15 §5.1 — `recentDays` already fetches every `Day` doc (no date filter), so the current
  // week's day-off marks are already sitting in it; no new subscription needed.
  const weekDayDocs = new Map(recentDays.filter((d) => weekDateKeys.includes(d.date)).map((d) => [d.date, d] as const));
  const offDateKeys = new Set(weekDateKeys.filter((d) => weekDayDocs.get(d)?.dayOff));

  const activeCourses = courses.filter((course) => weekDateKeys.some((d) => effectiveCourseStatus(course, d) === "active"));
  const linkedGoalsFor = (courseId: string) => goals.filter((goal) => goal.linked.courseIds.includes(courseId));

  const [classLogsByCourse, setClassLogsByCourse] = useState<Record<string, ClassLog[]>>({});
  useEffect(() => {
    if (!user || activeCourses.length === 0) {
      setClassLogsByCourse({});
      return;
    }
    let cancelled = false;
    Promise.all(activeCourses.map((course) => fetchCourseClassLogs(user.uid, course.id).then((logs) => [course.id, logs] as const))).then((pairs) => {
      if (!cancelled) setClassLogsByCourse(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
     
  }, [user, activeCourses.map((c) => c.id).join(",")]);

  const existingReview = reviews.find((review) => review.weekStart === weekStart);
  const committed = Boolean(existingReview?.plan?.completedAt);

  // ---- Step 2: the week already contains (also the source of "claimed" minutes for Step 3's meter and Step 4's placement) ----
  function claimedSlotsForDate(dateKey: string): ScheduleSlot[] {
    const saved = schedules.find((s) => s.dateKey === dateKey)?.slots ?? [];
    const classSlots = isBreakMode(terms, dateKey) ? [] : courseSlotsForDate(courses, dateKey);
    const routineSlots = routineSlotsForDate(settings.routineBlocks ?? DEFAULT_ROUTINE_BLOCKS, dateKey);
    const base = saved.length > 0 ? saved : [...classSlots, ...routineSlots];
    const anchor = weeklyPlanningSlotForDate(settings.weeklyPlanning, dateKey);
    return anchor && !base.some((slot) => slot.id === anchor.id) ? [...base, anchor] : base;
  }
  const claimedSlotsByDate: Record<string, ScheduleSlot[]> = {};
  for (const d of weekDateKeys) claimedSlotsByDate[d] = claimedSlotsForDate(d);

  // ---- Step 3: hours table (local drafts, seeded from live course fields) ----
  const [hoursDraft, setHoursDraft] = useState<Record<string, Partial<Record<TaskBucket, number>>>>({});
  useEffect(() => {
    const seeded: Record<string, Partial<Record<TaskBucket, number>>> = {};
    for (const course of activeCourses) {
      seeded[course.id] = {
        revision: course.targetMinutesPerWeek ?? 0,
        assignment: course.weeklyTargets?.assignment ?? 0,
        backlog: course.weeklyTargets?.backlog ?? 0
      };
    }
    setHoursDraft(seeded);
     
  }, [activeCourses.map((c) => c.id).join(",")]);
  const [savingHours, setSavingHours] = useState(false);

  function hoursFor(course: Course, bucket: TaskBucket): number {
    if (bucket === "goal") return bucketWeeklyTarget(course, bucket, linkedGoalsFor(course.id));
    return hoursDraft[course.id]?.[bucket] ?? bucketWeeklyTarget(course, bucket, linkedGoalsFor(course.id));
  }

  async function saveHours() {
    if (!user) return;
    setSavingHours(true);
    try {
      for (const course of activeCourses) {
        const draft = hoursDraft[course.id];
        if (!draft) continue;
        const revisionMinutes = draft.revision ?? course.targetMinutesPerWeek ?? 0;
        if (revisionMinutes !== (course.targetMinutesPerWeek ?? 0)) {
          await updateCourse(user.uid, course.id, { targetMinutesPerWeek: revisionMinutes });
          await syncRevisionTemplate(
            user.uid,
            { id: course.id, name: course.name, targetMinutesPerWeek: revisionMinutes, startDate: course.startDate, endDate: course.endDate },
            recurringTemplates.filter((t) => t.courseId === course.id),
            workMinutes
          );
        }
        const assignment = draft.assignment ?? course.weeklyTargets?.assignment ?? 0;
        const backlog = draft.backlog ?? course.weeklyTargets?.backlog ?? 0;
        if (assignment !== (course.weeklyTargets?.assignment ?? 0) || backlog !== (course.weeklyTargets?.backlog ?? 0)) {
          await updateCourse(user.uid, course.id, { weeklyTargets: { assignment, backlog } });
        }
      }
    } finally {
      setSavingHours(false);
    }
  }

  // ---- Committed-minutes inputs: checkpoint prep owed, revision queue, unlinked-goal hours ----
  const prepCheckpoints = allCheckpoints.filter(
    (cp) => cp.requiresPrep && cp.status !== "done" && cp.status !== "missed" && weekDateKeys.some((d) => d >= addDaysToKey(cp.dueAt, -cp.prepLeadDays) && d < cp.dueAt)
  );
  const checkpointPrepMinutes = prepCheckpoints.reduce((sum, cp) => sum + cp.prepEstimateMin, 0);

  const dueRevisionCount = revisionItems.filter((item) => !item.suspended && item.dueDate <= todayK).length;
  const revisionLimits = { maxItems: settings.maxRevisionsPerDay ?? DEFAULT_MAX_REVISIONS_PER_DAY, maxMinutes: settings.maxRevisionMinutesPerDay ?? DEFAULT_MAX_REVISION_MINUTES_PER_DAY };
  const revisionQueueMinutesPerDay = estimatedReviewMinutes(dueRevisionCount, revisionLimits);
  const revisionQueueMinutesForWeek = revisionQueueMinutesPerDay * 7;

  const activeGoals = goals.filter((goal) => isGoalActiveForDate(goal, terms, todayK));
  const unlinkedGoalMinutes = activeGoals.filter((goal) => goal.linked.courseIds.length === 0).reduce((sum, goal) => sum + (goal.targetHoursPerWeek ?? 0) * 60, 0);

  const courseTargetMinutes = activeCourses.reduce((sum, course) => sum + COURSE_BUCKETS.reduce((s, bucket) => s + hoursFor(course, bucket), 0), 0);
  const committedMinutes = courseTargetMinutes + checkpointPrepMinutes + revisionQueueMinutesForWeek + unlinkedGoalMinutes;
  const capacity = weekCapacity({ workingWindow, weekDateKeys, claimedSlotsByDate, committedMinutes, offDateKeys });
  const committedPct = capacity.freeMinutes > 0 ? (capacity.committedMinutes / capacity.freeMinutes) * 100 : capacity.committedMinutes > 0 ? 100 : 0;

  // ---- Step 4: proposals ----
  // plan/15 §5.3 — the same lead-time spread checkpoint prep already uses (evenly across the days
  // from the week's start through a target weekday, landing by it), lifted into a small helper so
  // reading/task targets can reuse it instead of only ever getting one floating block. Hard-pins
  // each chunk's `dateKey` (like checkpoint prep) — exempt from Step 4's per-day cap, since a chunk
  // here was placed deliberately, not because that day happened to look emptiest. Day-off dates are
  // filtered out of the window before splitting, same as every other generator below. The window
  // always starts at the week's Monday, not at today — planning mid-week for a target earlier that
  // same week can hard-pin a chunk onto an already-past date. Deliberately left as-is: checkpoint
  // prep's own `windowDays` above has never filtered out past dates either, so diverging here would
  // make target-day reading/tasks behave differently from the pattern they were built to match.
  function leadTimeCandidates(
    title: string,
    type: WeekProposalCandidate["type"],
    totalMinutes: number,
    targetDow: number,
    extra: Partial<WeekProposalCandidate>
  ): WeekProposalCandidate[] {
    const targetIndex = weekDateKeys.findIndex((d) => getDay(parseISO(d)) === targetDow);
    if (targetIndex === -1) return [{ title, type, durationMinutes: totalMinutes, ...extra }];
    const windowDays = weekDateKeys.slice(0, targetIndex + 1).filter((d) => !offDateKeys.has(d));
    if (windowDays.length === 0) return [{ title, type, durationMinutes: totalMinutes, ...extra }];
    const perDay = Math.max(15, Math.ceil(totalMinutes / windowDays.length));
    const result: WeekProposalCandidate[] = [];
    let remaining = totalMinutes;
    for (const d of windowDays) {
      if (remaining <= 0) break;
      const minutes = Math.min(perDay, remaining);
      // plan/16 §5.3 — one call spreads one piece of work across several days, so the caller's own
      // stable key has to be made unique per day here or every sibling would share one key.
      result.push({ title, type, durationMinutes: minutes, dateKey: d, ...extra, ...(extra.key ? { key: `${extra.key}:${d}` } : {}) });
      remaining -= minutes;
    }
    return result;
  }

  /**
   * plan/16 §5.1 — one course bucket's outstanding minutes, as sittings.
   *
   * Two changes from the pre-`16` version this replaces. First, chunk size: it used to emit
   * `round(remaining / workMinutes)` candidates of exactly `workMinutes` each, so a 3h revision
   * target became seven 25-minute blocks — 25 being a *timer* default, never a considered statement
   * about how long a block of revision should be. It now splits under the sitting cap, giving four
   * 45-minute sittings instead. Second, and the actual bug fix (§2.2): `alreadyScheduled` now
   * subtracts `plannedMinutesThisWeek` as well, so minutes already accepted onto a day stop being
   * re-proposed. Before this, accepting a bucket's proposals reduced the next regeneration by
   * nothing at all, and only `blockDecisions` — keyed by array index, so it re-targets whenever the
   * candidate list shifts — kept the duplicates off the screen.
   */
  function bucketCandidates(course: Course, bucket: TaskBucket, preferredDateKeys: string[] | undefined): WeekProposalCandidate[] {
    const target = hoursFor(course, bucket);
    const alreadyScheduled =
      scheduledMinutesThisWeek(tasks, course.id, bucket, workMinutes, weekDateKeys) +
      plannedMinutesThisWeek(schedules, course.id, bucket, weekDateKeys);
    const outstanding = Math.max(0, target - alreadyScheduled);
    const sittings = splitIntoChunks(outstanding, chunkOpts);
    if (sittings.length === 0) return [];
    const groupId = `${course.id}:${bucket}:${weekStart}`;
    return sittings.map((minutes, index) => ({
      title: `${course.name} — ${taskBucketLabels[bucket]}`,
      type: "deep_work" as const,
      durationMinutes: minutes,
      plannedMinutes: minutes,
      courseId: course.id,
      bucket,
      preferredDateKeys,
      capGroup: `${bucket}:${course.id}`,
      key: `${bucket}:${course.id}:${index}`,
      ...(sittings.length > 1 ? { chunk: { groupId, index: index + 1, total: sittings.length } } : {})
    }));
  }

  const candidates: WeekProposalCandidate[] = [];
  for (const cp of prepCheckpoints) {
    const windowDays = weekDateKeys.filter((d) => d >= addDaysToKey(cp.dueAt, -cp.prepLeadDays) && d < cp.dueAt && !offDateKeys.has(d));
    const perDay = Math.max(15, Math.ceil(cp.prepEstimateMin / Math.max(1, cp.prepLeadDays)));
    let remaining = cp.prepEstimateMin;
    for (const d of windowDays) {
      if (remaining <= 0) break;
      const minutes = Math.min(perDay, remaining);
      candidates.push({
        title: `Prep: ${cp.title}`,
        type: "deep_work",
        durationMinutes: minutes,
        plannedMinutes: minutes,
        dateKey: d,
        key: `checkpoint:${cp.id}:${d}`,
        refType: "checkpoint",
        refId: cp.id,
        // plan/16 §5.2 — the reference that used to be dropped by `acceptProposals`, so an accepted
        // prep block was a string with no way back to the checkpoint it was prepping for.
        objectiveRef: { kind: "checkpoint", id: cp.id }
      });
      remaining -= minutes;
    }
  }
  // plan/15 §5.2 #4 — assignment first: it has no day preference of its own, so it should fill in
  // around the days revision/backlog have already claimed via their preferences below, not the
  // reverse (today's order let assignment's floating chunks take first pick of every day).
  for (const course of activeCourses) {
    candidates.push(...bucketCandidates(course, "assignment", undefined));
  }
  // plan/15 §5.2 #3 — revision prefers the course's own lecture days this week (reviewing material
  // near the class it came from), falling back to the general search when the course has none
  // materializing this week (mid-break, or an async course with no `CourseSession` at all) — see
  // plan/15 §8's open question on whether that should differ from a course with literally no
  // sessions; for now both cases fall through identically.
  for (const course of activeCourses) {
    const lectureDays = weekDateKeys.filter((d) => !isBreakMode(terms, d) && courseSlotsForDate([course], d).length > 0);
    candidates.push(...bucketCandidates(course, "revision", lectureDays.length > 0 ? lectureDays : undefined));
  }
  if (revisionQueueMinutesPerDay > 0) {
    for (const d of weekDateKeys.slice(0, 5).filter((d) => !offDateKeys.has(d))) {
      candidates.push({
        title: "Review revisions",
        type: "deep_work",
        durationMinutes: revisionQueueMinutesPerDay,
        plannedMinutes: revisionQueueMinutesPerDay,
        dateKey: d,
        key: `revisionQueue:${d}`,
        refType: "revision",
        objectiveRef: { kind: "revisionQueue" }
      });
    }
  }
  // plan/15 §5.2 #3 — backlog (both the bucket and undated tasks) prefers the weekend, the same
  // "leftover work last" instinct a person planning by hand already has.
  const weekend = [weekDateKeys[5], weekDateKeys[6]];
  for (const course of activeCourses) {
    candidates.push(...bucketCandidates(course, "backlog", weekend));
  }
  const backlogTasks = tasks.filter((task) => task.status !== "done" && (!task.dueDate || task.dueDate < weekStart));
  for (const task of backlogTasks) {
    // plan/16 §5.1 — propose only what's actually left, which is the "tracked across sittings" half
    // of the ask: the leftover rolls forward into the next week's plan with no bookkeeping of its own.
    //
    // Two signals say work is accounted for, and they overlap temporally, so this takes the larger
    // rather than the sum: `logged` is real session minutes against the task, `planned` is minutes
    // already placed on a day for it. A 50-minute sitting with 22 logged counts as 50 to `planned`
    // and 22 to `logged` — summing them would double-subtract the worked part and under-propose.
    // `max` is deliberately an approximation, and it is correct at both ends: nothing worked yet
    // (0 logged / 50 planned → 50 accounted), and worked well past what was planned (80 logged /
    // 50 planned → 80 accounted). It can under-subtract in the middle, which errs toward proposing
    // slightly too much — the safe direction, since an over-proposal is visible and dismissable
    // while an under-proposal silently loses work.
    const logged = loggedMinutesForTask(sessions, task.id);
    const planned = plannedMinutesForTask(schedules, task.id, weekDateKeys);
    const total = Math.max(0, taskBlockMinutes(task, workMinutes) - Math.max(logged, planned));
    if (total <= 0) continue;

    // plan/16 §5.1/§2.1 — a fixed-time task is pinned to its own clock time on its own weekday and
    // never split. This is the path that used to be lost entirely: `RecurringTaskTemplate.time`
    // never reached the Task, so a 14:00 meeting arrived here as a timeless backlog task.
    if (task.fixedTime) {
      const fixedMinutes = Math.max(15, minutesFromTime(task.fixedTime.endTime) - minutesFromTime(task.fixedTime.startTime));
      const targetDow = task.weeklyTargetDay ?? (task.dueDate ? getDay(parseISO(task.dueDate)) : null);
      const dateKey = targetDow != null ? weekDateKeys.find((d) => getDay(parseISO(d)) === targetDow) : task.dueDate;
      const pinnable = dateKey && !offDateKeys.has(dateKey);
      candidates.push({
        title: task.title,
        type: "deep_work",
        durationMinutes: fixedMinutes,
        plannedMinutes: fixedMinutes,
        taskId: task.id,
        key: `task:${task.id}:fixed`,
        // With a day to pin to, this is an exact-time candidate: 14:00 or it doesn't happen. Without
        // one — a fixed-time task with neither a target weekday nor a due date, or one whose day is
        // marked off — it still has to appear *somewhere*. It floats at its own fixed length instead,
        // never split (`splittable: false` is set on every task `taskFromTemplate` gives a time to).
        // Dropping it here instead would delete the work from the planner with not even a "Didn't
        // fit" row to notice, which is worse than placing it at an approximate time the user can move.
        ...(pinnable ? { dateKey, fixedStartTime: task.fixedTime.startTime } : { preferredDateKeys: weekend, capGroup: "fixed-time-unpinned" })
      });
      continue;
    }

    const sittings = taskChunkMinutes({ ...task, estimatedPomodoros: Math.max(1, Math.ceil(total / workMinutes)) }, workMinutes, chunkOpts);
    const groupId = `task:${task.id}:${weekStart}`;
    const chunkOf = (index: number) =>
      sittings.length > 1 ? { chunk: { groupId, index: index + 1, total: sittings.length } } : {};

    if (task.weeklyTargetDay != null) {
      // Each sitting keeps the lead-time spread, so "by Wednesday" still means the work lands across
      // the days leading up to Wednesday rather than all at once on it.
      sittings.forEach((minutes, index) => {
        candidates.push(
          ...leadTimeCandidates(sittingTitle(task.title, index + 1, sittings.length), "deep_work", minutes, task.weeklyTargetDay!, {
            taskId: task.id,
            plannedMinutes: minutes,
            key: `task:${task.id}:${index}`,
            ...chunkOf(index)
          })
        );
      });
    } else {
      // plan/15 — every undated backlog task shares one cap pool: many small individual tasks
      // piling onto the same emptiest day is the exact §2.2 failure mode, just with tasks instead
      // of a single heavy bucket, so they still need to compete for one shared per-day allowance.
      // plan/16: a single task's own sittings additionally share `task:<id>`, so one big task can no
      // longer sidestep the cap by arriving as one indivisible block.
      sittings.forEach((minutes, index) => {
        candidates.push({
          title: sittingTitle(task.title, index + 1, sittings.length),
          type: "deep_work",
          durationMinutes: minutes,
          plannedMinutes: minutes,
          taskId: task.id,
          preferredDateKeys: weekend,
          capGroup: `task:${task.id}`,
          key: `task:${task.id}:${index}`,
          ...chunkOf(index)
        });
      });
    }
  }
  const stalePapers = papers
    .filter((paper) => paper.status === "reading")
    .map((paper) => ({ ...paper, daysSinceUpdate: Math.round((new Date(todayK).getTime() - new Date(paper.updatedAt).getTime()) / 86_400_000) }))
    .filter((paper) => paper.daysSinceUpdate > 14)
    .sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate)
    .slice(0, 3);
  for (const paper of stalePapers) {
    const readingMinutes = splitIntoChunks(45, chunkOpts);
    const paperObjective = { objectiveRef: { kind: "paper" as const, id: paper.id }, refId: paper.id };
    if (paper.weeklyTargetDay != null) {
      readingMinutes.forEach((minutes, index) => {
        candidates.push(
          ...leadTimeCandidates(`Read: ${paper.title}`, "reading", minutes, paper.weeklyTargetDay!, {
            ...paperObjective,
            plannedMinutes: minutes,
            key: `paper:${paper.id}:${index}`
          })
        );
      });
    } else {
      readingMinutes.forEach((minutes, index) => {
        candidates.push({
          title: `Read: ${paper.title}`,
          type: "reading",
          durationMinutes: minutes,
          plannedMinutes: minutes,
          ...paperObjective,
          capGroup: "papers",
          key: `paper:${paper.id}:${index}`
        });
      });
    }
  }

  /**
   * plan/16 §5.4 — "What's coming": every real, dated thing in the next `horizonDays`, each with an
   * estimate and a **prefilled tentative day and time the user confirms or edits**.
   *
   * This is the other half of detaching derived course work from the timeline. Step 4 used to place
   * that work invisibly and write it to a day on one click; now the app still does the thinking —
   * the suggested day comes from exactly the preferences plan/15 §5.2 already places by (lead time
   * back from a deadline, a course's own lecture days for revision, the weekend for leftovers) and
   * the suggested time is the first gap that actually fits it — but the suggestion is visible and
   * editable instead of applied behind the user's back.
   *
   * Accepting a row generates *candidates*, never slots: the first sitting pinned to the confirmed
   * day and time, its siblings preferring the days after it, all of them flowing into the same
   * placement pass and the same grid as everything else. Nothing reaches a day's schedule without
   * passing through Accept in Step 4.
   */
  const horizonDays = settings.upcomingHorizonDays ?? DEFAULT_UPCOMING_HORIZON_DAYS;
  const horizonEnd = addDaysToKey(todayK, horizonDays);
  const [upcomingDrafts, setUpcomingDrafts] = useState<Record<string, { minutes: number; dateKey: string; startTime: string }>>({});
  const [acceptedUpcoming, setAcceptedUpcoming] = useState<string[]>([]);
  const [extraCandidates, setExtraCandidates] = useState<WeekProposalCandidate[]>([]);
  useEffect(() => {
    setUpcomingDrafts({});
    setAcceptedUpcoming([]);
    setExtraCandidates([]);
  }, [weekStart]);

  /** The first day in `preferred` that is a workable day this week, else the first workable day. */
  function firstUsableDay(preferred: string[]): string {
    const workable = weekDateKeys.filter((d) => !offDateKeys.has(d) && workingWindow.daysOfWeek.includes(getDay(parseISO(d))));
    return preferred.find((d) => workable.includes(d)) ?? workable[0] ?? weekDateKeys[0];
  }

  /** The tentative clock time: the first gap on that day that actually fits, so the prefill is a
   *  time the placement search itself could have chosen — not a guess the user has to fix. */
  function tentativeTime(dateKey: string, minutes: number): string {
    const start = placeInWindow(
      claimedSlotsByDate[dateKey] ?? [],
      minutesFromTime(workingWindow.startTime),
      minutesFromTime(workingWindow.endTime),
      minutes
    );
    return minutesToTime(start ?? minutesFromTime(workingWindow.startTime));
  }

  const upcomingRows: UpcomingRow[] = [];
  for (const cp of allCheckpoints) {
    if (!cp.dueAt || cp.dueAt < todayK || cp.dueAt > horizonEnd) continue;
    if (cp.status === "done" || cp.status === "missed") continue;
    const minutes = cp.requiresPrep ? cp.prepEstimateMin : 0;
    if (minutes <= 0) continue;
    upcomingRows.push({
      id: `checkpoint:${cp.id}`,
      title: `Prep: ${cp.title}`,
      detail: `Checkpoint · due ${cp.dueAt}`,
      minutes,
      type: "deep_work",
      // Lead time back from the deadline, the same spread plan/15 §5.2 already uses for prep.
      preferredDateKeys: weekDateKeys.filter((d) => d >= addDaysToKey(cp.dueAt, -cp.prepLeadDays) && d < cp.dueAt),
      objectiveRef: { kind: "checkpoint", id: cp.id }
    });
  }
  for (const course of activeCourses) {
    const lectureDays = weekDateKeys.filter((d) => !isBreakMode(terms, d) && courseSlotsForDate([course], d).length > 0);
    for (const bucket of COURSE_BUCKETS) {
      const target = hoursFor(course, bucket);
      const already =
        scheduledMinutesThisWeek(tasks, course.id, bucket, workMinutes, weekDateKeys) + plannedMinutesThisWeek(schedules, course.id, bucket, weekDateKeys);
      const outstanding = Math.max(0, target - already);
      if (outstanding <= 0) continue;
      upcomingRows.push({
        id: `bucket:${course.id}:${bucket}`,
        title: `${course.name} — ${taskBucketLabels[bucket]}`,
        detail: `${formatHours(already)} of ${formatHours(target)} planned this week`,
        minutes: outstanding,
        type: "deep_work",
        courseId: course.id,
        bucket,
        preferredDateKeys: bucket === "revision" ? lectureDays : bucket === "backlog" ? weekend : []
      });
    }
  }
  for (const task of tasks) {
    if (task.status === "done" || !task.dueDate || task.dueDate < todayK || task.dueDate > horizonEnd) continue;
    const outstanding = Math.max(
      0,
      taskBlockMinutes(task, workMinutes) - Math.max(loggedMinutesForTask(sessions, task.id), plannedMinutesForTask(schedules, task.id, weekDateKeys))
    );
    if (outstanding <= 0) continue;
    upcomingRows.push({
      id: `task:${task.id}`,
      title: task.title,
      detail: `${task.kind === "external" ? "External · " : ""}Task · due ${task.dueDate}`,
      minutes: outstanding,
      type: "deep_work",
      taskId: task.id,
      courseId: task.courseId,
      bucket: task.bucket,
      // A couple of days of runway before the deadline, clamped into this week.
      preferredDateKeys: weekDateKeys.filter((d) => d <= task.dueDate!)
    });
  }
  for (const goal of activeGoals) {
    for (const milestone of goal.milestones) {
      if (milestone.done || !milestone.dueAt || milestone.dueAt < todayK || milestone.dueAt > horizonEnd) continue;
      upcomingRows.push({
        id: `milestone:${goal.id}:${milestone.id}`,
        title: `${goal.title} — ${milestone.title}`,
        detail: `Milestone · due ${milestone.dueAt}`,
        minutes: Math.max(30, Math.round((goal.targetHoursPerWeek ?? 1) * 60)),
        type: "deep_work",
        preferredDateKeys: weekDateKeys.filter((d) => d <= milestone.dueAt!),
        objectiveRef: { kind: "goal", id: goal.id, milestoneId: milestone.id }
      });
    }
  }
  if (dueRevisionCount > 0 && revisionQueueMinutesPerDay > 0) {
    upcomingRows.push({
      id: "revisionQueue",
      title: `Review ${dueRevisionCount} due item${dueRevisionCount === 1 ? "" : "s"}`,
      detail: "Spaced repetition queue",
      minutes: revisionQueueMinutesPerDay,
      type: "deep_work",
      preferredDateKeys: [],
      objectiveRef: { kind: "revisionQueue" }
    });
  }
  for (const paper of stalePapers) {
    upcomingRows.push({
      id: `paper:${paper.id}`,
      title: `Read: ${paper.title}`,
      detail: `Untouched ${paper.daysSinceUpdate} days`,
      minutes: 45,
      type: "reading",
      preferredDateKeys: paper.weeklyTargetDay != null ? weekDateKeys.filter((d) => getDay(parseISO(d)) === paper.weeklyTargetDay) : [],
      objectiveRef: { kind: "paper", id: paper.id }
    });
  }

  /** A row's current values: the derived prefill, overridden by whatever the user has typed. */
  function upcomingValues(row: UpcomingRow): { minutes: number; dateKey: string; startTime: string } {
    const draft = upcomingDrafts[row.id];
    if (draft) return draft;
    const dateKey = firstUsableDay(row.preferredDateKeys);
    const minutes = row.minutes;
    return { minutes, dateKey, startTime: tentativeTime(dateKey, Math.min(minutes, chunkOpts.maxChunkMinutes)) };
  }

  function acceptUpcoming(row: UpcomingRow) {
    const { minutes, dateKey, startTime } = upcomingValues(row);
    const sittings = splitIntoChunks(minutes, chunkOpts);
    if (sittings.length === 0) return;
    const groupId = `upcoming:${row.id}:${weekStart}`;
    const laterDays = weekDateKeys.filter((d) => d >= dateKey && !offDateKeys.has(d));
    const added: WeekProposalCandidate[] = sittings.map((sittingMinutes, index) => ({
      title: sittings.length > 1 ? sittingTitle(row.title, index + 1, sittings.length) : row.title,
      type: row.type,
      durationMinutes: sittingMinutes,
      plannedMinutes: sittingMinutes,
      key: `upcoming:${row.id}:${index}`,
      capGroup: `upcoming:${row.id}`,
      ...(row.courseId ? { courseId: row.courseId } : {}),
      ...(row.bucket ? { bucket: row.bucket } : {}),
      ...(row.taskId ? { taskId: row.taskId } : {}),
      ...(row.objectiveRef ? { objectiveRef: row.objectiveRef } : {}),
      ...(sittings.length > 1 ? { chunk: { groupId, index: index + 1, total: sittings.length } } : {}),
      // The first sitting goes exactly where the user said. The rest prefer the days from there on,
      // so a confirmed time anchors the work without pinning every sibling to the same hour.
      ...(index === 0 ? { dateKey, fixedStartTime: startTime } : { preferredDateKeys: laterDays })
    }));
    setExtraCandidates((current) => [...current.filter((c) => !c.key?.startsWith(`upcoming:${row.id}:`)), ...added]);
    setAcceptedUpcoming((current) => [...current, row.id]);
  }

  const freshProposals = placeProposals([...candidates, ...extraCandidates], weekDateKeys, claimedSlotsByDate, workingWindow, offDateKeys);
  const proposals: WeekProposal[] = committed
    ? (existingReview!.plan!.proposedBlocks.map((p, index) => ({ ...p, key: p.key ?? `${index}`, fits: true })) as WeekProposal[])
    : freshProposals;

  /**
   * plan/16 §5.3 — keyed by each proposal's own stable `key` now (see `WeekProposalCandidate.key`),
   * not by its array index. One consequence, deliberately not migrated: a `blockDecisions` map
   * written before this change is keyed `"0"`/`"1"`/... and no longer resolves, so those proposals
   * read as undecided and can simply be accepted or dismissed again. That is a week-scoped map with
   * a one-week useful life, and re-deciding a handful of rows once is a smaller cost than a
   * migration that would have to guess which index meant which piece of work.
   */
  const [decisions, setDecisions] = useState<Record<string, ProposalDecision>>({});
  useEffect(() => {
    setDecisions(existingReview?.plan?.blockDecisions ?? {});
     
  }, [weekStart, existingReview?.plan?.blockDecisions]);

  /**
   * plan/16 §5.3 — where the user has dragged (or typed) a proposal, keyed by its stable `key`.
   * Local only: a move writes nothing until Accept, because `WeekPlan.proposedBlocks` is a Firestore
   * array field whose `merge: true` write replaces it wholesale, so persisting each drag would mean
   * rewriting the entire array on every pointer-up. Accept was already the commit point.
   *
   * Cleared when the week changes. Not cleared when the candidate list shifts, which is exactly why
   * the keys had to become stable first (see `WeekProposalCandidate.key`).
   */
  const [placements, setPlacements] = useState<Record<string, WeekGridPlacement>>({});
  useEffect(() => setPlacements({}), [weekStart]);
  const [gridMessage, setGridMessage] = useState("");

  /**
   * A proposal as the user has last left it: the placement search's answer, overridden by any move.
   * A proposal the search couldn't fit anywhere (`fits: false`) becomes acceptable the moment it is
   * given a position by hand — which is the point of the inspector, and the only route that existed
   * for such a proposal before this was Dismiss.
   */
  const effectiveProposals: WeekProposal[] = proposals.map((p) => {
    const placement = placements[p.key];
    if (!placement) return p;
    return {
      ...p,
      dateKey: placement.dateKey,
      startTime: minutesToTime(placement.startMinutes),
      endTime: minutesToTime(placement.startMinutes + placement.durationMinutes),
      durationMinutes: placement.durationMinutes,
      plannedMinutes: placement.durationMinutes,
      fits: true
    };
  });
  const undecidedProposals = effectiveProposals.filter((p) => !decisions[p.key]);

  /** Why a proposal can't be accepted where it currently sits — the sentence the inspector shows,
   *  and the reason its Accept button is disabled. Checked against the same two layers the grid
   *  refuses drops over: what the day already contains, and every other proposal still standing. */
  function placementProblem(p: WeekProposal): string | null {
    if (!p.fits && !placements[p.key]) {
      return p.fixedStartTime
        ? `Its fixed time (${p.fixedStartTime}) on ${p.dateKey.slice(5)} is already taken — pick another day or time.`
        : `No free gap of ${p.durationMinutes}m was found — pick a day and time.`;
    }
    if (offDateKeys.has(p.dateKey)) return "That day is marked off.";
    const start = minutesFromTime(p.startTime);
    const end = minutesFromTime(p.endTime);
    if (start < minutesFromTime(workingWindow.startTime) || end > minutesFromTime(workingWindow.endTime)) {
      return `Outside your working window (${workingWindow.startTime}–${workingWindow.endTime}).`;
    }
    const others = [
      ...(claimedSlotsByDate[p.dateKey] ?? []),
      ...undecidedProposals.filter((other) => other.key !== p.key && other.dateKey === p.dateKey)
    ];
    const clash = others.find((other) => start < minutesFromTime(other.endTime) && minutesFromTime(other.startTime) < end);
    return clash ? `Overlaps "${clash.title}" (${clash.startTime}–${clash.endTime}).` : null;
  }

  const objectiveCtx = { courses, papers, checkpoints: allCheckpoints, tasks, goals };
  /** plan/16 §5.2 — the objective chip a proposal shows, read off the slot it *would* become so the
   *  grid, the day timeline and the Now card can never word the same block differently. */
  function chipForProposal(p: WeekProposal): string | null {
    const asSlot: ScheduleSlot = {
      id: p.key,
      title: p.title,
      type: p.type,
      startTime: p.startTime,
      endTime: p.endTime,
      status: "upcoming",
      ...(p.courseId ? { courseId: p.courseId } : {}),
      ...(p.bucket ? { bucket: p.bucket } : {}),
      ...(p.taskId ? { assignedTaskIds: [p.taskId] } : {}),
      ...(p.objectiveRef ? { objectiveRef: p.objectiveRef } : {}),
      ...(p.chunk ? { chunk: p.chunk } : {})
    };
    return objectiveChipText(asSlot, describeObjective(asSlot, objectiveCtx));
  }

  const [acceptError, setAcceptError] = useState("");
  const [accepting, setAccepting] = useState(false);

  /**
   * Writes the whole `plan` field in one shot rather than dotted paths like `plan.blockDecisions.0`
   * — `setDoc(ref, {"a.b": x}, {merge: true})` does NOT nest in this SDK; it creates a literal
   * top-level field named `"a.b"` (verified live: a committed plan produced sibling fields
   * `"plan.completedAt"`, `"plan.targets"`, etc. instead of a `plan` object, so `existingReview
   * ?.plan` stayed `undefined` and Commit never flipped to Re-commit). `merge: true` at the *top*
   * level does work — it leaves `wins`/`missedGoals`/etc. untouched — so replacing the whole `plan`
   * value here is safe as long as callers always spread in what they don't mean to change (`decisions`
   * is the local session-accumulated map, more current than `existingReview` which lags one
   * subscription round-trip behind a just-made write).
   */
  async function patchPlan(patch: Partial<WeekPlan>) {
    if (!user) return;
    const nextPlan = {
      targets: existingReview?.plan?.targets ?? [],
      capacity: existingReview?.plan?.capacity ?? { freeMinutes: 0, committedMinutes: 0 },
      proposedBlocks: existingReview?.plan?.proposedBlocks ?? [],
      blockDecisions: decisions,
      ...(existingReview?.plan?.completedAt ? { completedAt: existingReview.plan.completedAt } : {}),
      ...patch
    };
    await saveWeeklyReviewFields(user.uid, weekStart, { plan: nextPlan });
  }

  async function acceptProposals(toAccept: WeekProposal[]) {
    if (!user) return;
    setAcceptError("");
    setAccepting(true);
    try {
      const fitting = toAccept.filter((p) => p.fits && !decisions[p.key]);
      const byDate = new Map<string, WeekProposal[]>();
      for (const p of fitting) {
        if (!byDate.has(p.dateKey)) byDate.set(p.dateKey, []);
        byDate.get(p.dateKey)!.push(p);
      }
      const writes: { dateKey: string; templateId?: string; slots: ScheduleSlot[] }[] = [];
      for (const [dateKey, props] of byDate) {
        const existingSlots = schedules.find((s) => s.dateKey === dateKey)?.slots ?? claimedSlotsForDate(dateKey);
        // plan/16 §5.2 — `objectiveRef`, `chunk`, and `plannedMinutes` are copied here. Before this
        // they were silently dropped (along with `refType`/`refId`, which `ScheduleSlot` had no field
        // for at all), so an accepted "Prep: Midterm" block was a bare string with no way back to its
        // checkpoint, an accepted reading block lost its paper, and seven sittings of one task became
        // seven unrelated slots with identical titles.
        const newSlots: ScheduleSlot[] = props.map((p) => ({
          id: crypto.randomUUID(),
          title: p.title,
          type: p.type,
          startTime: p.startTime,
          endTime: p.endTime,
          status: "upcoming",
          ...(p.courseId ? { courseId: p.courseId } : {}),
          ...(p.bucket ? { bucket: p.bucket } : {}),
          ...(p.taskId ? { assignedTaskIds: [p.taskId] } : {}),
          ...(p.objectiveRef ? { objectiveRef: p.objectiveRef } : {}),
          ...(p.chunk ? { chunk: p.chunk } : {}),
          ...(p.plannedMinutes != null ? { plannedMinutes: p.plannedMinutes } : {})
        }));
        const merged = sortedSlots([...existingSlots, ...newSlots]);
        const errors = validateSlots(merged);
        if (errors.length > 0) {
          setAcceptError(`${dateKey}: ${errors[0]}`);
          return;
        }
        writes.push({ dateKey, templateId: schedules.find((s) => s.dateKey === dateKey)?.templateId, slots: merged });
      }
      for (const w of writes) await saveDailySchedule(user.uid, w);

      if (fitting.length > 0) {
        const nextDecisions = { ...decisions };
        for (const p of fitting) nextDecisions[p.key] = "accepted";
        setDecisions(nextDecisions);
        await saveWeeklyReviewFields(user.uid, weekStart, {
          plan: {
            targets: existingReview?.plan?.targets ?? [],
            capacity: existingReview?.plan?.capacity ?? { freeMinutes: 0, committedMinutes: 0 },
            proposedBlocks: existingReview?.plan?.proposedBlocks ?? [],
            blockDecisions: nextDecisions,
            ...(existingReview?.plan?.completedAt ? { completedAt: existingReview.plan.completedAt } : {})
          }
        });
      }
    } finally {
      setAccepting(false);
    }
  }

  async function dismissProposal(p: WeekProposal) {
    if (!user) return;
    const nextDecisions = { ...decisions, [p.key]: "dismissed" as const };
    setDecisions(nextDecisions);
    await patchPlan({ blockDecisions: nextDecisions });
  }

  // ---- Step 5: commit ----
  const [committing, setCommitting] = useState(false);
  async function commitWeek() {
    if (!user) return;
    setCommitting(true);
    try {
      const targets = activeCourses.flatMap((course) => COURSE_BUCKETS.map((bucket) => ({ courseId: course.id, bucket, minutes: hoursFor(course, bucket) })));
      await patchPlan({
        targets,
        capacity,
        // plan/16 §5.3 — `key` is kept (it's part of `ProposedSlot` now) so a committed week's
        // `blockDecisions` still resolve when the plan is re-opened; only `fits`, which is a property
        // of this render's placement search rather than of the proposal, is dropped.
        proposedBlocks: proposals.map(({ fits, ...rest }) => rest),
        completedAt: new Date().toISOString()
      });
    } finally {
      setCommitting(false);
    }
  }

  // ---- Step 1: look back ----
  const priorActiveCourses = courses.filter((course) => priorWeekDateKeys.some((d) => effectiveCourseStatus(course, d) === "active"));
  let lookbackPlanned = 0;
  let lookbackDone = 0;
  for (const course of priorActiveCourses) {
    for (const bucket of ["revision", "assignment", "backlog", "goal"] as TaskBucket[]) {
      lookbackPlanned += scheduledMinutesThisWeek(tasks, course.id, bucket, workMinutes, priorWeekDateKeys);
      lookbackDone += completedMinutesThisWeek(sessions, tasks, course.id, bucket, priorWeekDateKeys);
    }
  }
  const priorWeekDaysOff = priorWeekDays.filter((d) => d.dayOff).length;
  const priorWeekLI = priorWeekDays.filter((d) => d.loadIndex);
  const behindDays = priorWeekLI.filter((d) => loadIndexBand(d.loadIndex!.value) === "behind").length;
  const onTrackDays = priorWeekLI.length - behindDays;
  const daysWithLI = [...recentDays].filter((d) => d.loadIndex).sort((a, b) => (a.date < b.date ? -1 : 1));
  const debtHours = computeDebtHours(daysWithLI.map((d) => d.loadIndex!));
  const streak = computeLoadIndexStreak(daysWithLI.map((d) => d.loadIndex!));
  const avgFocus = averageFocusRating(priorWeekDays);

  let classesHeld = 0;
  let classesLogged = 0;
  for (const course of priorActiveCourses) {
    for (const d of priorWeekDateKeys) {
      if (isBreakMode(terms, d) || courseSlotsForDate([course], d).length === 0) continue;
      classesHeld += 1;
      if (classLogsByCourse[course.id]?.some((log) => log.date === d)) classesLogged += 1;
    }
  }

  const priorStalePapers = papers
    .filter((paper) => paper.status === "reading")
    .map((paper) => ({ ...paper, daysSinceUpdate: Math.round((new Date(todayK).getTime() - new Date(paper.updatedAt).getTime()) / 86_400_000) }))
    .filter((paper) => paper.daysSinceUpdate > 14);

  const overdueOpenTasks = tasks.filter((task) => task.status !== "done" && task.dueDate && priorWeekDateKeys.includes(task.dueDate));

  const [wins, setWins] = useState(existingReview?.wins ?? "");
  const [missedGoals, setMissedGoals] = useState(existingReview?.missedGoals ?? "");
  const [blockers, setBlockers] = useState(existingReview?.blockers ?? "");
  const [nextWeekPriorities, setNextWeekPriorities] = useState(existingReview?.nextWeekPriorities ?? "");
  const [savingReview, setSavingReview] = useState(false);
  useEffect(() => {
    setWins(existingReview?.wins ?? "");
    setMissedGoals(existingReview?.missedGoals ?? "");
    setBlockers(existingReview?.blockers ?? "");
    setNextWeekPriorities(existingReview?.nextWeekPriorities ?? "");
     
  }, [weekStart, existingReview]);

  async function saveReview() {
    if (!user) return;
    setSavingReview(true);
    try {
      await saveWeeklyReviewFields(user.uid, weekStart, { wins, missedGoals, blockers, nextWeekPriorities, averageFocusRating: avgFocus });
    } finally {
      setSavingReview(false);
    }
  }

  return (
    <>
      <SectionHeader title="Weekly planning" eyebrow={`Week of ${weekStart}`} />

      <div className="card sticky top-16 z-10 mb-6 flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-sm text-ink-500">
            Committed <span className="font-semibold text-ink-950 dark:text-ink-50">{formatHours(capacity.committedMinutes)}</span> of{" "}
            {formatHours(capacity.freeMinutes)} free
          </p>
          <div className="mt-1 h-1.5 w-48 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
            <div
              className={`h-full ${committedPct > 100 ? "bg-red-500" : committedPct > 85 ? "bg-amber-500" : "bg-moss-600"}`}
              style={{ width: `${Math.min(100, committedPct)}%` }}
            />
          </div>
        </div>
        <button className="btn-primary" onClick={commitWeek} disabled={committing}>
          {committing ? "Committing..." : committed ? "Re-commit" : "Commit"}
        </button>
      </div>

      <ModuleGate moduleId="weeklyCheckin">
        <section className="card mb-6 max-w-4xl p-5">
          <h2 className="mb-3 text-base font-semibold">1. Look back — week of {priorWeekStart}</h2>
          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <Stat label="Done vs planned" value={`${formatHours(lookbackDone)} / ${formatHours(lookbackPlanned)}`} />
            <Stat label="On-track / behind days" value={`${onTrackDays} / ${behindDays}`} />
            <Stat label="Days off" value={`${priorWeekDaysOff}`} />
            <Stat label="Catch-up (14-day)" value={`${debtHours}h`} />
            <Stat label="On-track streak" value={`${streak}d`} />
            <Stat label="Classes logged" value={`${classesLogged} of ${classesHeld}`} />
            <Stat label="Stale papers (14d+)" value={`${priorStalePapers.length}`} />
            <Stat label="Tasks still open" value={`${overdueOpenTasks.length}`} />
            <Stat label="Focus average" value={avgFocus ? `${avgFocus}` : "-"} />
          </div>
          {overdueOpenTasks.length > 0 ? (
            <p className="mb-3 text-sm text-ink-500">
              Still open from last week: {overdueOpenTasks.slice(0, 5).map((t) => t.title).join(", ")}
              {overdueOpenTasks.length > 5 ? ` +${overdueOpenTasks.length - 5} more` : ""}
            </p>
          ) : null}
          <div className="mb-4">
            <p className="label mb-2">Goals</p>
            {activeGoals.length === 0 ? (
              <p className="text-sm text-ink-500">No active goals.</p>
            ) : (
              <div className="space-y-2">
                {activeGoals.map((goal) => {
                  const done = goal.milestones.filter((m) => m.done).length;
                  return (
                    <div key={goal.id} className="flex items-center justify-between gap-3 rounded-md border border-ink-200 p-2 text-sm dark:border-ink-800">
                      <span>
                        {goal.title} — {done}/{goal.milestones.length} milestones
                        {goal.targetHoursPerWeek ? ` · ${goal.targetHoursPerWeek}h/week` : ""}
                      </span>
                      {goal.reviewCadence === "weekly" ? (
                        <button className="btn-secondary px-2 py-1 text-xs" onClick={() => user && updateGoal(user.uid, goal.id, { lastReviewedAt: new Date().toISOString() })}>
                          Mark reviewed
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <Textarea label="Wins" value={wins} onChange={setWins} />
          <Textarea label="Missed goals" value={missedGoals} onChange={setMissedGoals} />
          <Textarea label="Blockers" value={blockers} onChange={setBlockers} />
          <Textarea label="Next week priorities" value={nextWeekPriorities} onChange={setNextWeekPriorities} />
          <div className="flex items-center gap-3">
            <button className="btn-secondary" onClick={saveReview} disabled={savingReview}>
              {savingReview ? "Saving..." : "Save review"}
            </button>
          </div>
        </section>
      </ModuleGate>

      <section className="card mb-6 max-w-5xl overflow-x-auto p-5">
        <h2 className="mb-3 text-base font-semibold">2. The week already contains</h2>
        <div className="grid grid-cols-7 gap-2 text-xs">
          {weekDateKeys.map((d, i) => {
            const anchor = weeklyPlanningSlotForDate(settings.weeklyPlanning, d);
            const classes = isBreakMode(terms, d) ? [] : courseSlotsForDate(courses, d);
            const routine = routineSlotsForDate(settings.routineBlocks ?? DEFAULT_ROUTINE_BLOCKS, d);
            const commitments = recurringTemplates.filter((t) => isTemplateDueOn(t, d));
            const checkpointsDue = allCheckpoints.filter((cp) => cp.dueAt === d);
            const external = (schedules.find((s) => s.dateKey === d)?.slots ?? []).filter((s) => s.type === "external");
            const dayOff = weekDayDocs.get(d)?.dayOff;
            return (
              <div key={d} className={`min-h-32 rounded-md border p-2 ${dayOff ? "border-ink-300 bg-ink-50 dark:border-ink-700 dark:bg-ink-900" : "border-ink-200 dark:border-ink-800"}`}>
                <div className="mb-1 flex items-center justify-between gap-1">
                  <p className="font-medium">{DAY_LABELS[i]} {d.slice(5)}</p>
                  <button
                    className="text-[10px] text-ink-500 underline decoration-dotted hover:text-ink-700 dark:hover:text-ink-300"
                    onClick={() => user && (dayOff ? clearDayOff(user.uid, d) : setDayOff(user.uid, d))}
                  >
                    {dayOff ? "Undo" : "Day off"}
                  </button>
                </div>
                {dayOff ? (
                  <DayOffReasonInput dateKey={d} reason={dayOff.reason} onSave={(reason) => user && setDayOff(user.uid, d, reason)} />
                ) : (
                  <>
                    {anchor ? <p className="truncate rounded bg-moss-500/10 px-1 py-0.5 text-moss-700 dark:text-moss-300">Weekly planning</p> : null}
                    {classes.map((slot) => (
                      <p key={slot.id} className="truncate rounded bg-fuchsia-500/10 px-1 py-0.5 text-fuchsia-700 dark:text-fuchsia-300">{slot.title}</p>
                    ))}
                    {routine.map((slot) => (
                      <p key={slot.id} className="truncate rounded bg-ink-100 px-1 py-0.5 text-ink-600 dark:bg-ink-800 dark:text-ink-300">{slot.title}</p>
                    ))}
                    {commitments.map((t) => (
                      <p key={t.id} className="truncate rounded bg-sky-500/10 px-1 py-0.5 text-sky-700 dark:text-sky-300">{t.title}</p>
                    ))}
                    {checkpointsDue.map((cp) => (
                      <p key={cp.id} className="truncate rounded bg-amberline/10 px-1 py-0.5 text-amber-700 dark:text-amber-300">Due: {cp.title}</p>
                    ))}
                    {external.map((slot) => (
                      <p key={slot.id} className="truncate rounded bg-ink-100 px-1 py-0.5 text-ink-600 dark:bg-ink-800 dark:text-ink-300">{slot.title} (calendar)</p>
                    ))}
                  </>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-ink-500">
          Fix a course → <Link href="/courses" className="underline">Courses</Link>. Fix routine → <Link href="/settings/routine" className="underline">Settings</Link>. Fix a commitment → <Link href="/tasks" className="underline">Tasks</Link>.
        </p>
      </section>

      <section className="card mb-6 max-w-5xl p-5">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">2.5 What&apos;s coming</h2>
          <label className="flex items-center gap-2 text-xs text-ink-500">
            Next
            <input
              className="input w-16 py-1 text-xs"
              type="number"
              min={1}
              max={60}
              value={horizonDays}
              onChange={(e) => updateSettings({ upcomingHorizonDays: Math.max(1, Math.min(60, Number(e.target.value))) })}
            />
            days
          </label>
        </div>
        <p className="mb-3 text-xs text-ink-500">
          Everything real and dated in the window, with a suggested day and time you can change. Accepting a row adds it to the
          week below as sittings — it still doesn&apos;t touch any day until you accept it there.
        </p>
        {upcomingRows.length === 0 ? (
          <p className="text-sm text-ink-500">Nothing dated in the next {horizonDays} days.</p>
        ) : (
          <div className="space-y-1">
            {upcomingRows.map((row) => {
              const values = upcomingValues(row);
              const accepted = acceptedUpcoming.includes(row.id);
              const sittings = splitIntoChunks(values.minutes, chunkOpts);
              return (
                <div key={row.id} className="flex flex-wrap items-center gap-2 rounded-md bg-ink-50 px-3 py-2 text-xs dark:bg-ink-800">
                  <span className="min-w-48 flex-1">
                    <span className="block truncate font-medium">{row.title}</span>
                    <span className="block truncate text-ink-500">
                      {row.detail}
                      {sittings.length > 1 ? ` · ${sittings.length} sittings` : ""}
                    </span>
                  </span>
                  <label className="flex items-center gap-1">
                    <input
                      className="input w-16 py-1 text-xs"
                      type="number"
                      min={5}
                      step={5}
                      aria-label={`Minutes for ${row.title}`}
                      value={values.minutes}
                      disabled={accepted || committed}
                      onChange={(e) => setUpcomingDrafts((current) => ({ ...current, [row.id]: { ...values, minutes: Math.max(5, Number(e.target.value)) } }))}
                    />
                    <span className="text-ink-500">min</span>
                  </label>
                  <select
                    className="input w-28 py-1 text-xs"
                    aria-label={`Day for ${row.title}`}
                    value={values.dateKey}
                    disabled={accepted || committed}
                    onChange={(e) =>
                      setUpcomingDrafts((current) => ({
                        ...current,
                        [row.id]: { ...values, dateKey: e.target.value, startTime: tentativeTime(e.target.value, Math.min(values.minutes, chunkOpts.maxChunkMinutes)) }
                      }))
                    }
                  >
                    {weekDateKeys.map((d, i) => (
                      <option key={d} value={d} disabled={offDateKeys.has(d)}>
                        {DAY_LABELS[i]} {d.slice(5)}
                        {offDateKeys.has(d) ? " (off)" : ""}
                      </option>
                    ))}
                  </select>
                  <TypedTimeInput
                    className="input w-20 py-1 text-xs"
                    value={values.startTime}
                    disabled={accepted || committed}
                    onChange={(time) => setUpcomingDrafts((current) => ({ ...current, [row.id]: { ...values, startTime: time } }))}
                  />
                  {accepted ? (
                    <span className="text-ink-500">added below</span>
                  ) : (
                    <button className="btn-secondary px-2 py-1" onClick={() => acceptUpcoming(row)} disabled={committed}>
                      Add to week
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="card mb-6 max-w-4xl p-5">
        <h2 className="mb-3 text-base font-semibold">3. Set this week&apos;s hours</h2>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-500">
          <span>Working window</span>
          <input
            type="time"
            className="input w-32 py-1"
            value={workingWindow.startTime}
            onChange={(e) => updateSettings({ workingWindow: { ...workingWindow, startTime: e.target.value } })}
          />
          <span>to</span>
          <input
            type="time"
            className="input w-32 py-1"
            value={workingWindow.endTime}
            onChange={(e) => updateSettings({ workingWindow: { ...workingWindow, endTime: e.target.value } })}
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-500">
                <th className="py-1">Course</th>
                {["revision", "assignment", "backlog", "goal"].map((bucket) => (
                  <th key={bucket} className="py-1 pl-3">
                    <span className="inline-flex items-center gap-1">
                      {taskBucketLabels[bucket as TaskBucket]}
                      <InfoHint term={bucket === "goal" ? "bucketGoal" : bucket === "revision" ? "revisionHoursPerWeek" : "bucketAssignmentBacklog"} />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activeCourses.map((course) => (
                <tr key={course.id} className="border-t border-ink-100 dark:border-ink-800">
                  <td className="py-2 pr-2 font-medium">{course.name}</td>
                  {(["revision", "assignment", "backlog"] as TaskBucket[]).map((bucket) => (
                    <td key={bucket} className="py-2 pl-3">
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        className="input w-20 py-1"
                        value={hoursFor(course, bucket) / 60}
                        onChange={(e) =>
                          setHoursDraft((current) => ({
                            ...current,
                            [course.id]: { ...current[course.id], [bucket]: Math.round(Number(e.target.value) * 60) }
                          }))
                        }
                      />
                    </td>
                  ))}
                  <td className="py-2 pl-3 text-ink-500">{formatHours(hoursFor(course, "goal"))}</td>
                </tr>
              ))}
              <tr className="border-t border-ink-100 dark:border-ink-800 text-ink-500">
                <td className="py-2 pr-2">Revision schedule (auto)</td>
                <td className="py-2 pl-3" colSpan={3}>{formatHours(revisionQueueMinutesForWeek)}/week</td>
                <td />
              </tr>
              {activeGoals
                .filter((g) => g.linked.courseIds.length === 0 && g.targetHoursPerWeek)
                .map((g) => (
                  <tr key={g.id} className="border-t border-ink-100 dark:border-ink-800 text-ink-500">
                    <td className="py-2 pr-2">{g.title} (goal, no course)</td>
                    <td className="py-2 pl-3" colSpan={3}>{g.targetHoursPerWeek}h/week</td>
                    <td />
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <button className="btn-primary mt-3" onClick={saveHours} disabled={savingHours}>
          {savingHours ? "Saving..." : "Save hours"}
        </button>
      </section>

      <section className="card mb-6 max-w-6xl p-5">
        <h2 className="mb-1 text-base font-semibold">4. Assign the week</h2>
        <p className="mb-3 text-xs text-ink-500">
          Drag a sitting to a different day or time, or use the list below — both do the same thing. Nothing is written to a day
          until you accept it.
        </p>
        {acceptError ? <p className="mb-2 text-sm text-red-600">{acceptError}</p> : null}
        <p className="sr-only" role="status" aria-live="polite">
          {gridMessage}
        </p>
        {stalePapers.length > 0 || backlogTasks.length > 0 ? (
          <div className="mb-4 space-y-1">
            <p className="label mb-1 inline-flex items-center gap-1">
              Target a day (optional)
              <InfoHint term="weeklyTargetDay" />
            </p>
            {stalePapers.map((paper) => (
              <TargetDayRow
                key={paper.id}
                title={`Read: ${paper.title}`}
                value={paper.weeklyTargetDay}
                onChange={(day) => user && updatePaper(user.uid, paper.id, { weeklyTargetDay: day })}
              />
            ))}
            {backlogTasks.map((task) => (
              <TargetDayRow
                key={task.id}
                title={task.title}
                value={task.weeklyTargetDay}
                onChange={(day) => user && updateTask(user.uid, task.id, { weeklyTargetDay: day })}
              />
            ))}
          </div>
        ) : null}

        {/* plan/16 §5.3 — the grid is the enhancement; the list below is the floor. The grid is
            hidden rather than squeezed on narrow screens, where seven columns can't be read. */}
        <div className="mb-4 hidden lg:block">
          <WeekGrid
            weekDateKeys={weekDateKeys}
            dayLabels={DAY_LABELS}
            workingWindow={workingWindow}
            offDateKeys={offDateKeys}
            fixedSlotsByDate={claimedSlotsByDate}
            proposals={undecidedProposals.filter((p) => p.fits)}
            decisions={decisions}
            onPlace={(key, placement) => setPlacements((current) => ({ ...current, [key]: placement }))}
            onAccept={(key) => {
              const proposal = effectiveProposals.find((p) => p.key === key);
              if (proposal) acceptProposals([proposal]);
            }}
            disabled={accepting || committed}
            chipFor={chipForProposal}
            dayScoreFor={(dateKey) => (dateKey < todayK ? weekDayDocs.get(dateKey)?.game?.score ?? null : null)}
            announce={setGridMessage}
          />
        </div>

        {undecidedProposals.length === 0 ? (
          <p className="text-sm text-ink-500">Nothing left to assign this week.</p>
        ) : (
          <div className="space-y-4">
            {weekDateKeys.map((d, i) => {
              const dayProposals = undecidedProposals.filter((p) => p.fits && p.dateKey === d);
              if (dayProposals.length === 0) return null;
              return (
                <div key={d}>
                  <p className="mb-1 text-sm font-medium">
                    {DAY_LABELS[i]} {d.slice(5)}
                  </p>
                  <div className="space-y-1">
                    {dayProposals.map((p) => (
                      <ProposalInspector
                        key={p.key}
                        proposal={p}
                        weekDateKeys={weekDateKeys}
                        dayLabels={DAY_LABELS}
                        offDateKeys={offDateKeys}
                        decision={decisions[p.key]}
                        onPlace={(key, placement) => setPlacements((current) => ({ ...current, [key]: placement }))}
                        onAccept={(key) => {
                          const proposal = effectiveProposals.find((item) => item.key === key);
                          if (proposal) acceptProposals([proposal]);
                        }}
                        onDismiss={(key) => {
                          const proposal = effectiveProposals.find((item) => item.key === key);
                          if (proposal) dismissProposal(proposal);
                        }}
                        disabled={accepting || committed}
                        chip={chipForProposal(p)}
                        invalidReason={placementProblem(p)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* plan/16 §5.3 — "Didn't fit" is no longer a dead end. A proposal the search couldn't place
            keeps its own row with a day and time to choose, so the only route out of it stopped
            being Dismiss. */}
        {undecidedProposals.some((p) => !p.fits) ? (
          <div className="mt-4">
            <p className="label mb-1">Didn&apos;t fit — pick a day and time</p>
            <div className="space-y-1">
              {undecidedProposals
                .filter((p) => !p.fits)
                .map((p) => (
                  <ProposalInspector
                    key={p.key}
                    proposal={p}
                    weekDateKeys={weekDateKeys}
                    dayLabels={DAY_LABELS}
                    offDateKeys={offDateKeys}
                    decision={decisions[p.key]}
                    onPlace={(key, placement) => setPlacements((current) => ({ ...current, [key]: placement }))}
                    onAccept={(key) => {
                      const proposal = effectiveProposals.find((item) => item.key === key);
                      if (proposal) acceptProposals([proposal]);
                    }}
                    onDismiss={(key) => {
                      const proposal = effectiveProposals.find((item) => item.key === key);
                      if (proposal) dismissProposal(proposal);
                    }}
                    disabled={accepting || committed}
                    chip={chipForProposal(p)}
                    invalidReason={placementProblem(p)}
                  />
                ))}
            </div>
          </div>
        ) : null}
      </section>

      <section className="card max-w-4xl p-5">
        <h2 className="mb-2 text-base font-semibold">5. Commit</h2>
        <p className="mb-3 text-sm text-ink-500">
          {committed
            ? `Committed ${existingReview!.plan!.completedAt!.slice(0, 10)}.`
            : "Writes the targets, capacity, and accepted blocks onto this week's plan."}
        </p>
        <button className="btn-primary" onClick={commitWeek} disabled={committing}>
          {committing ? "Committing..." : committed ? "Re-commit" : "Commit"}
        </button>
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-ink-50 p-3 dark:bg-ink-800">
      <p className="text-xs text-ink-500">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

/**
 * plan/15 §5.1's "report a holiday" half — `setDayOff` always accepts an optional `reason`, but the
 * one-click toggle button never passes one. This is the single place a reason gets typed in (mirrors
 * `dayOff.reason`'s only other read sites — NowCard, workday-session-provider's start notice —
 * which have always rendered it optionally, just never had a way to set it). Local `value` avoids
 * a Firestore round-trip per keystroke; only `onBlur` persists, and only when it actually changed.
 */
function DayOffReasonInput({ dateKey, reason, onSave }: { dateKey: string; reason: string | undefined; onSave: (reason: string | undefined) => void }) {
  const [value, setValue] = useState(reason ?? "");
  useEffect(() => setValue(reason ?? ""), [dateKey, reason]);
  return (
    <input
      className="input w-full px-1 py-0.5 text-[11px]"
      placeholder="Day off (reason, optional)"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        const trimmed = value.trim();
        if (trimmed !== (reason ?? "")) onSave(trimmed || undefined);
      }}
    />
  );
}

function TargetDayRow({ title, value, onChange }: { title: string; value: number | undefined; onChange: (day: number | undefined) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-ink-50 px-3 py-2 text-xs dark:bg-ink-800">
      <span className="truncate">{title}</span>
      <select
        className="input w-32 py-1 text-xs"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      >
        <option value="">No target</option>
        {DAY_LABELS.map((label, i) => (
          <option key={label} value={(i + 1) % 7}>{label}</option>
        ))}
      </select>
    </div>
  );
}

function Textarea({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="mb-4 block">
      <span className="label mb-2 block">{label}</span>
      <textarea className="input min-h-20" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
