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
import { useFeatures } from "@/hooks/use-features";
import { useUserCollection } from "@/hooks/use-user-collection";
import { useUserSettings } from "@/hooks/use-user-settings";
import { averageFocusRating } from "@/lib/analytics";
import {
  bucketWeeklyTarget,
  completedMinutesThisWeek,
  courseSlotsForDate,
  effectiveCourseStatus,
  plannableTasks,
  plannedMinutesForObjective,
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
import { paperStatusLabels, readingCandidates } from "@/lib/papers";
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
  resolvePlacement,
  usableWindow,
  weekCapacity,
  weeklyPlanningSlotForDate,
  type NowFloor,
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
  /** The dismissal/accounting family its sittings belong to — the same one Step 4 would use. */
  family: string;
  title: string;
  detail: string;
  /** Still owed: the estimate minus what's on a day (or logged) minus what was dismissed. */
  minutes: number;
  /** Minutes already on a day this week for it. */
  planned: number;
  type: WeekProposalCandidate["type"];
  preferredDateKeys: string[];
  courseId?: string;
  bucket?: TaskBucket;
  taskId?: string;
  objectiveRef?: SlotObjectiveRef;
};
/** A dated thing that is planned somewhere else (or needs something other than time) — shown so the
 *  horizon reads complete, never addable, so it can't become a second copy of the same work. */
type UpcomingNote = { id: string; title: string; detail: string; status: string; href?: string };
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "7 × 50–55m" — how a total will actually be split, so a number of hours never appears on its own
 *  next to a sitting count that doesn't obviously follow from it. */
function sittingShape(sittings: number[]): string {
  if (sittings.length === 0) return "";
  const lo = Math.min(...sittings);
  const hi = Math.max(...sittings);
  return `${sittings.length} × ${lo === hi ? lo : `${lo}–${hi}`}m`;
}

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
  // plan/16 §5.6 / AC #24 — every score surface is gated on the one module, including the two on
  // this page. A module toggle that leaves a score still showing somewhere is the coherence bug
  // plan/13 C1 already had to fix once for Workload.
  const { isEnabled } = useFeatures();
  const dayScoreOn = isEnabled("dayScore");
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
  // Planning is measured from now: the elapsed part of today and every earlier day of the week are
  // neither free time nor somewhere a sitting can be proposed. Re-read each render, so a page left
  // open stays honest; placement only moves when the clock crosses a 15-minute mark.
  const nowClock = new Date();
  const now: NowFloor = { dateKey: todayK, minutes: nowClock.getHours() * 60 + nowClock.getMinutes() };
  /** This week's days that can still take a sitting: not off, not past, with window left today. */
  const liveDateKeys = weekDateKeys.filter((d) => !offDateKeys.has(d) && usableWindow(workingWindow, d, now) !== null);

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
  const hoursDirty = activeCourses.some((course) => {
    const draft = hoursDraft[course.id];
    return Boolean(
      draft &&
        ((draft.revision ?? 0) !== (course.targetMinutesPerWeek ?? 0) ||
          (draft.assignment ?? 0) !== (course.weeklyTargets?.assignment ?? 0) ||
          (draft.backlog ?? 0) !== (course.weeklyTargets?.backlog ?? 0))
    );
  });

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

  // ---- What the week's ask is built from, besides the Step 3 hours: prep owed, the review queue, goal hours ----
  const prepCheckpoints = allCheckpoints.filter(
    (cp) => cp.requiresPrep && cp.status !== "done" && cp.status !== "missed" && weekDateKeys.some((d) => d >= addDaysToKey(cp.dueAt, -cp.prepLeadDays) && d < cp.dueAt)
  );

  const dueRevisionCount = revisionItems.filter((item) => !item.suspended && item.dueDate <= todayK).length;
  const revisionLimits = { maxItems: settings.maxRevisionsPerDay ?? DEFAULT_MAX_REVISIONS_PER_DAY, maxMinutes: settings.maxRevisionMinutesPerDay ?? DEFAULT_MAX_REVISION_MINUTES_PER_DAY };
  const revisionQueueMinutesPerDay = estimatedReviewMinutes(dueRevisionCount, revisionLimits);
  /**
   * The review queue's block on each working day. The estimate is often a handful of minutes (two
   * due items is 6), and a 6-minute block is under the shortest sitting: it drew as an unreadable
   * sliver on the grid, and `resolvePlacement` raised it to the floor the moment it was touched. It
   * is held at the floor from the start instead, and the Step 3 row says so.
   */
  const reviewBlockMinutes = revisionQueueMinutesPerDay > 0 ? Math.max(chunkOpts.minChunkMinutes, revisionQueueMinutesPerDay) : 0;

  const activeGoals = goals.filter((goal) => isGoalActiveForDate(goal, terms, todayK));
  /** Goal hours, each active goal counted once whatever it is linked to. Nothing on this page
   *  proposes them — there is no generator for goal hours — so they sit beside the ledger rather than
   *  inside it, and the meter names them instead of folding them into a number the plan can't move. */
  const goalMinutes = activeGoals.reduce((sum, goal) => sum + (goal.targetHoursPerWeek ?? 0) * 60, 0);

  // ---- Step 4: proposals ----
  // plan/15 §5.3 — the same lead-time spread checkpoint prep uses (evenly across the days from the
  // week's start through a target weekday, landing by it), shared so reading/task targets get it too.
  // Hard-pins each chunk's `dateKey` — exempt from Step 4's per-day cap, since a chunk here was placed
  // deliberately. Days off and days already behind you are filtered out before splitting: a share
  // pinned to yesterday is a sitting that can only be missed.
  function leadTimeCandidates(
    title: string,
    type: WeekProposalCandidate["type"],
    totalMinutes: number,
    targetDow: number,
    extra: Partial<WeekProposalCandidate>
  ): WeekProposalCandidate[] {
    const targetIndex = weekDateKeys.findIndex((d) => getDay(parseISO(d)) === targetDow);
    if (targetIndex === -1) return [{ title, type, durationMinutes: totalMinutes, ...extra }];
    const windowDays = weekDateKeys.slice(0, targetIndex + 1).filter((d) => liveDateKeys.includes(d));
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
   * plan/16 — the one accounting rule every candidate family follows:
   *
   *     offered = what the week asks for  -  what is already on a day  -  what has been dismissed
   *
   * Nothing else may suppress a candidate. An accepted proposal is a real `ScheduleSlot`, the slot is
   * counted, and the count is the truth. A dismissal is minutes, not a flag, so it survives the list
   * being rebuilt at any length — and because everything is measured in minutes against the
   * calendar, editing a target, resizing a block, or deleting one all flow through correctly.
   */
  const dismissedMinutes = existingReview?.plan?.dismissedMinutes ?? {};
  function outstandingFor(family: string, asks: number, alreadyPlanned: number): number {
    return Math.max(0, asks - alreadyPlanned - (dismissedMinutes[family] ?? 0));
  }

  async function dismissFamily(family: string, minutes: number) {
    if (!user) return;
    await patchPlan({ dismissedMinutes: { ...dismissedMinutes, [family]: (dismissedMinutes[family] ?? 0) + minutes } });
  }

  /** Undoes "not this week" for every family behind one ledger row. */
  async function restoreFamilies(families: string[]) {
    if (!user) return;
    const next = { ...dismissedMinutes };
    for (const family of families) delete next[family];
    await patchPlan({ dismissedMinutes: next });
  }

  /**
   * The week's arithmetic, kept in one place. Every generator below records, per row, what the week
   * asks of it, what is already on a day, what was dismissed, and the sittings it is still offering —
   * so the meter, Step 3 and Step 4 are three views of the same numbers instead of three
   * computations. Before this the page had three: the meter's "committed" (targets, plus the review
   * queue counted for 7 days while it was proposed on 5, minus nothing already placed), Step 4's
   * candidates, and "What's coming", which offered a second copy of every course bucket, paper and
   * checkpoint and added it on top — a 6h revision target became 12h of sittings on the grid.
   *
   * Per row, `ask = placed + dismissed + toPlace`, except where more is on the calendar than was
   * asked, which is reported as `over` rather than hidden.
   */
  type LedgerRow = { id: string; label: string; detail?: string; ask: number; placed: number; dismissed: number; sittings: number[]; families: string[] };
  const ledger: LedgerRow[] = [];
  const bucketLedger = new Map<string, LedgerRow>();
  const toPlaceOf = (row: Pick<LedgerRow, "sittings">) => row.sittings.reduce((sum, minutes) => sum + minutes, 0);

  const candidates: WeekProposalCandidate[] = [];
  /** The durations of every candidate pushed since `index` — how a generator learns what it just offered. */
  const offeredSince = (index: number) => candidates.slice(index).map((candidate) => candidate.durationMinutes);

  /** The tasks one course bucket owns this week: due this week, carrying that course and bucket. */
  function bucketTasksDue(courseId: string, bucket: TaskBucket): Task[] {
    return plannableTasks(tasks, courses).filter(
      (task) => task.courseId === courseId && task.bucket === bucket && Boolean(task.dueDate) && weekDateKeys.includes(task.dueDate!)
    );
  }

  /**
   * One task's still-owed minutes as candidates — shared by the backlog tasks and the tasks a course
   * bucket owns, so a task is proposed the same way whichever family it belongs to.
   *
   * plan/16 §5.1/§2.1 — a fixed-time task is pinned to its own clock time on its own weekday and
   * never split. Without a day to pin to (no target weekday or due date, or its day is off) it floats
   * at its own fixed length instead — dropping it would delete the work from the planner with not
   * even a "Didn't fit" row to notice. A task with a target weekday keeps the lead-time spread, so "by
   * Wednesday" lands across the days leading up to it; anything else prefers `preferredDateKeys`.
   */
  function pushTaskCandidates(task: Task, total: number, preferredDateKeys: string[]) {
    const family = `task:${task.id}`;
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
        ...(task.courseId ? { courseId: task.courseId } : {}),
        ...(task.bucket ? { bucket: task.bucket } : {}),
        key: `${family}:fixed`,
        family,
        ...(pinnable ? { dateKey, fixedStartTime: task.fixedTime.startTime } : { preferredDateKeys, capGroup: "fixed-time-unpinned" })
      });
      return;
    }

    const sittings = taskChunkMinutes({ ...task, estimatedPomodoros: Math.max(1, Math.ceil(total / workMinutes)) }, workMinutes, chunkOpts);
    const groupId = `${family}:${weekStart}`;
    const shared = (minutes: number, index: number) => ({
      taskId: task.id,
      ...(task.courseId ? { courseId: task.courseId } : {}),
      ...(task.bucket ? { bucket: task.bucket } : {}),
      plannedMinutes: minutes,
      key: `${family}:${index}`,
      family,
      ...(sittings.length > 1 ? { chunk: { groupId, index: index + 1, total: sittings.length } } : {})
    });
    sittings.forEach((minutes, index) => {
      if (task.weeklyTargetDay != null) {
        candidates.push(...leadTimeCandidates(sittingTitle(task.title, index + 1, sittings.length), "deep_work", minutes, task.weeklyTargetDay, shared(minutes, index)));
      } else {
        // Each task its own cap pool, so one big task can't sidestep the per-day cap by arriving as
        // one indivisible block, and many small ones can't all pile onto the emptiest day.
        candidates.push({
          title: sittingTitle(task.title, index + 1, sittings.length),
          type: "deep_work",
          durationMinutes: minutes,
          preferredDateKeys,
          capGroup: family,
          ...shared(minutes, index)
        });
      }
    });
  }

  /**
   * plan/16 §5.1 — one course bucket's week: its own tasks due this week first, then whatever of the
   * target they don't cover, as generic sittings under the sitting cap.
   *
   * The bucket owns its tasks. They used to be subtracted from the target here as "scheduled" (their
   * estimate, placed or not) while being scheduled from somewhere else entirely — "What's coming" —
   * so the same 100 minutes was counted once as covered and again when it was added, and the ledger
   * read 200 placed for 100 on the calendar. Now this is the only place they're proposed, and every
   * minute of the bucket is in exactly one column: on a day (or already worked), dismissed, or to
   * place.
   *
   * Bucket blocks and task blocks are disjoint by construction (`plannedMinutesThisWeek` excludes any
   * slot carrying `assignedTaskIds`), so the two are summed, not maxed.
   */
  function bucketCandidates(course: Course, bucket: TaskBucket, preferredDateKeys: string[] | undefined) {
    const target = hoursFor(course, bucket);
    const family = `${bucket}:${course.id}`;
    const row: LedgerRow = {
      id: family,
      label: `${course.name} — ${taskBucketLabels[bucket]}`,
      ask: target,
      placed: 0,
      dismissed: dismissedMinutes[family] ?? 0,
      sittings: [],
      families: [family]
    };
    const bucketBlocks = plannedMinutesThisWeek(schedules, course.id, bucket, weekDateKeys);
    row.placed += bucketBlocks;
    const start = candidates.length;

    let taskEstimates = 0;
    for (const task of bucketTasksDue(course.id, bucket)) {
      const estimate = taskBlockMinutes(task, workMinutes);
      taskEstimates += estimate;
      if (task.status === "done") {
        row.placed += estimate;
        continue;
      }
      const taskFamily = `task:${task.id}`;
      const remaining = outstandingFor(taskFamily, estimate, Math.max(loggedMinutesForTask(sessions, task.id), plannedMinutesForTask(schedules, task.id, weekDateKeys)));
      const taskDismissed = dismissedMinutes[taskFamily] ?? 0;
      // Whatever of the estimate isn't still owed or dismissed is on a day or already worked.
      row.placed += Math.max(0, estimate - remaining - taskDismissed);
      row.dismissed += taskDismissed;
      row.families.push(taskFamily);
      if (remaining > 0) pushTaskCandidates(task, remaining, weekDateKeys.filter((d) => d <= task.dueDate!));
    }

    // The generic remainder: the target less bucket blocks already on a day and every task estimate
    // (owed, placed, worked or dismissed — all of it is this bucket's work, accounted above).
    const outstanding = outstandingFor(family, target, bucketBlocks + taskEstimates);
    const sittings = splitIntoChunks(outstanding, chunkOpts);
    const groupId = `${course.id}:${bucket}:${weekStart}`;
    candidates.push(
      ...sittings.map((minutes, index) => ({
        title: `${course.name} — ${taskBucketLabels[bucket]}`,
        type: "deep_work" as const,
        durationMinutes: minutes,
        plannedMinutes: minutes,
        courseId: course.id,
        bucket,
        preferredDateKeys,
        capGroup: family,
        key: `${family}:${index}`,
        family,
        ...(sittings.length > 1 ? { chunk: { groupId, index: index + 1, total: sittings.length } } : {})
      }))
    );
    row.sittings = offeredSince(start);
    bucketLedger.set(family, row);
    if (row.ask > 0 || row.placed > 0 || row.sittings.length > 0) ledger.push(row);
  }

  const prepRow: LedgerRow = { id: "prep", label: "Checkpoint prep", ask: 0, placed: 0, dismissed: 0, sittings: [], families: [] };
  for (const cp of prepCheckpoints) {
    const family = `checkpoint:${cp.id}`;
    const placed = plannedMinutesForObjective(schedules, { kind: "checkpoint", id: cp.id }, weekDateKeys);
    const prepOutstanding = outstandingFor(family, cp.prepEstimateMin, placed);
    prepRow.placed += placed;
    prepRow.dismissed += dismissedMinutes[family] ?? 0;
    prepRow.families.push(family);
    // Spread over the lead days still ahead — including any beyond this week, so this week takes its
    // share rather than all of it, and excluding days already behind you, so a share that fell on
    // one isn't silently lost.
    let leadDaysLeft = 0;
    for (let back = 1; back <= cp.prepLeadDays; back += 1) {
      const d = addDaysToKey(cp.dueAt, -back);
      if (d >= todayK && !offDateKeys.has(d)) leadDaysLeft += 1;
    }
    const windowDays = weekDateKeys.filter((d) => d >= addDaysToKey(cp.dueAt, -cp.prepLeadDays) && d < cp.dueAt && liveDateKeys.includes(d));
    if (prepOutstanding <= 0 || windowDays.length === 0) continue;
    const perDay = Math.max(15, Math.ceil(prepOutstanding / Math.max(1, leadDaysLeft)));
    const start = candidates.length;
    let remaining = prepOutstanding;
    for (const d of windowDays) {
      if (remaining <= 0) break;
      const minutes = Math.min(perDay, remaining);
      candidates.push({
        title: `Prep: ${cp.title}`,
        type: "deep_work",
        durationMinutes: minutes,
        plannedMinutes: minutes,
        dateKey: d,
        key: `${family}:${d}`,
        family,
        refType: "checkpoint",
        refId: cp.id,
        objectiveRef: { kind: "checkpoint", id: cp.id }
      });
      remaining -= minutes;
    }
    prepRow.sittings.push(...offeredSince(start));
  }
  prepRow.ask = prepRow.placed + prepRow.dismissed + toPlaceOf(prepRow);
  if (prepRow.ask > 0) ledger.push(prepRow);

  // plan/15 §5.2 #4 — assignment first: it has no day preference of its own, so it fills in around
  // the days revision/backlog claim via their preferences below, not the reverse.
  for (const course of activeCourses) bucketCandidates(course, "assignment", undefined);
  // plan/15 §5.2 #3 — revision prefers the course's own lecture days this week, falling back to the
  // general search when the course has none materializing this week.
  for (const course of activeCourses) {
    const lectureDays = weekDateKeys.filter((d) => !isBreakMode(terms, d) && courseSlotsForDate([course], d).length > 0);
    bucketCandidates(course, "revision", lectureDays.length > 0 ? lectureDays : undefined);
  }

  // The review queue is a per-day commitment, accounted per day, on the days you work: a day that
  // already carries a review block isn't offered a second, and a past day with none is simply gone.
  const reviewRow: LedgerRow = {
    id: "reviews",
    label: "Spaced-repetition reviews",
    detail:
      reviewBlockMinutes > 0
        ? `${dueRevisionCount} item${dueRevisionCount === 1 ? "" : "s"} due today · about ${revisionQueueMinutesPerDay}m a day${
            reviewBlockMinutes > revisionQueueMinutesPerDay ? `, held as a ${reviewBlockMinutes}m sitting (your shortest)` : ""
          }`
        : undefined,
    ask: 0,
    placed: 0,
    dismissed: 0,
    sittings: [],
    families: []
  };
  if (reviewBlockMinutes > 0) {
    for (const d of weekDateKeys.filter((d) => workingWindow.daysOfWeek.includes(getDay(parseISO(d))) && !offDateKeys.has(d))) {
      const family = `revisionQueue:${d}`;
      reviewRow.families.push(family);
      const placed = plannedMinutesForObjective(schedules, { kind: "revisionQueue" }, [d]);
      if (placed > 0) {
        reviewRow.placed += placed;
        continue;
      }
      if ((dismissedMinutes[family] ?? 0) > 0) {
        reviewRow.dismissed += dismissedMinutes[family];
        continue;
      }
      if (!liveDateKeys.includes(d)) continue;
      candidates.push({
        title: "Review revisions",
        type: "deep_work",
        durationMinutes: reviewBlockMinutes,
        plannedMinutes: reviewBlockMinutes,
        dateKey: d,
        key: `revisionQueue:${d}`,
        family,
        refType: "revision",
        objectiveRef: { kind: "revisionQueue" }
      });
      reviewRow.sittings.push(reviewBlockMinutes);
    }
  }
  reviewRow.ask = reviewRow.placed + reviewRow.dismissed + toPlaceOf(reviewRow);
  if (reviewRow.ask > 0) ledger.push(reviewRow);

  // plan/15 §5.2 #3 — backlog (both the bucket and undated tasks) prefers the weekend, the same
  // "leftover work last" instinct a person planning by hand already has.
  const weekend = [weekDateKeys[5], weekDateKeys[6]];
  for (const course of activeCourses) bucketCandidates(course, "backlog", weekend);

  // plan/16 — a dropped course's tasks are not work this week is going to contain, so they never
  // become candidates. They stay visible and labelled on /tasks; they just stop being proposed.
  const backlogTasks = plannableTasks(
    tasks.filter((task) => task.status !== "done" && (!task.dueDate || task.dueDate < weekStart)),
    courses
  );
  const taskRow: LedgerRow = { id: "tasks", label: "Backlog tasks", ask: 0, placed: 0, dismissed: 0, sittings: [], families: [] };
  for (const task of backlogTasks) {
    // plan/16 §5.1 — propose only what's actually left. `logged` (real session minutes) and `planned`
    // (minutes already on a day) overlap in time, so the larger is taken rather than the sum: a
    // 50-minute sitting with 22 logged counts 50, not 72. Errs toward proposing slightly too much in
    // the middle, the safe direction — an over-proposal is visible and dismissable.
    const family = `task:${task.id}`;
    const logged = loggedMinutesForTask(sessions, task.id);
    const planned = plannedMinutesForTask(schedules, task.id, weekDateKeys);
    taskRow.placed += planned;
    taskRow.dismissed += dismissedMinutes[family] ?? 0;
    taskRow.families.push(family);
    const total = outstandingFor(family, taskBlockMinutes(task, workMinutes), Math.max(logged, planned));
    if (total <= 0) continue;
    const start = candidates.length;
    pushTaskCandidates(task, total, weekend);
    taskRow.sittings.push(...offeredSince(start));
  }
  taskRow.ask = taskRow.placed + taskRow.dismissed + toPlaceOf(taskRow);
  if (taskRow.ask > 0) ledger.push(taskRow);

  /**
   * plan/16 §5.2 — reading is planned as the *pass the paper is actually owed*, at the length that
   * pass takes for this reader (`readingCandidates`), carrying `passNo` so the block can say "Pass 2",
   * arm that pass's length on the timer, and attribute the session to the right pass.
   */
  const { plannable: readingPlan, needsGoal: papersNeedingGoal } = readingCandidates(papers, todayK);
  const readingRow: LedgerRow = { id: "reading", label: "Reading", ask: 0, placed: 0, dismissed: 0, sittings: [], families: [] };
  for (const { paper, passNo, minutes: passMinutes } of readingPlan) {
    const family = `paper:${paper.id}`;
    const placed = plannedMinutesForObjective(schedules, { kind: "paper", id: paper.id }, weekDateKeys);
    readingRow.placed += placed;
    readingRow.dismissed += dismissedMinutes[family] ?? 0;
    readingRow.families.push(family);
    const readingOutstanding = outstandingFor(family, passMinutes, placed);
    if (readingOutstanding <= 0) continue;
    const start = candidates.length;
    const readingMinutes = splitIntoChunks(readingOutstanding, chunkOpts);
    const paperObjective = { objectiveRef: { kind: "paper" as const, id: paper.id, passNo }, refId: paper.id };
    const title = `Read: ${paper.title} (pass ${passNo})`;
    if (paper.weeklyTargetDay != null) {
      readingMinutes.forEach((minutes, index) => {
        candidates.push(
          ...leadTimeCandidates(title, "reading", minutes, paper.weeklyTargetDay!, {
            ...paperObjective,
            plannedMinutes: minutes,
            key: `paper:${paper.id}:${index}`,
            family
          })
        );
      });
    } else {
      readingMinutes.forEach((minutes, index) => {
        candidates.push({
          title,
          type: "reading",
          durationMinutes: minutes,
          plannedMinutes: minutes,
          ...paperObjective,
          capGroup: "papers",
          key: `paper:${paper.id}:${index}`,
          family
        });
      });
    }
    readingRow.sittings.push(...offeredSince(start));
  }
  readingRow.ask = readingRow.placed + readingRow.dismissed + toPlaceOf(readingRow);
  if (readingRow.ask > 0) ledger.push(readingRow);

  /**
   * plan/16 §5.4 — "What's coming": dated things in the next `horizonDays` that nothing in Step 4
   * proposes on its own — tasks due from this week on, and goal milestones — each with an estimate
   * and a suggested day and time the user confirms or edits.
   *
   * It used to list every course bucket, paper pass, checkpoint and the review queue as well, all of
   * which Step 4 already generates. "Add to week" then appended a *second* set of candidates for the
   * same work, under its own cap group and its own dismissal family, and never subtracted what was
   * accepted from it — so the grid showed both copies, and accepting from the added copy left it
   * standing to be accepted again. Those families now appear here only as notes pointing at where
   * they're planned.
   *
   * An added row stores the user's decision (how much, which day, what time), never candidates:
   * its sittings are re-derived every render from what is still owed, so accepting or dismissing one
   * shrinks what's left exactly the way it does for every other family.
   */
  const horizonDays = settings.upcomingHorizonDays ?? DEFAULT_UPCOMING_HORIZON_DAYS;
  const horizonEnd = addDaysToKey(todayK, horizonDays);
  type UpcomingDraft = { minutes?: number; dateKey?: string; startTime?: string };
  type UpcomingAdd = { ask: number; dateKey: string; startTime: string; plannedAtAdd: number; dismissedAtAdd: number };
  const [upcomingDrafts, setUpcomingDrafts] = useState<Record<string, UpcomingDraft>>({});
  const [upcomingAdds, setUpcomingAdds] = useState<Record<string, UpcomingAdd>>({});
  useEffect(() => {
    setUpcomingDrafts({});
    setUpcomingAdds({});
  }, [weekStart]);

  const upcomingRows: UpcomingRow[] = [];
  const upcomingNotes: UpcomingNote[] = [];
  // From the later of today and this week's Monday: a task due before the week starts is already
  // overdue relative to it, and Step 4 proposes it as backlog — listing it here too would be the
  // same double-offer this section was rebuilt to remove.
  const upcomingFrom = todayK > weekStart ? todayK : weekStart;
  for (const task of plannableTasks(tasks, courses)) {
    if (task.status === "done" || !task.dueDate || task.dueDate < upcomingFrom || task.dueDate > horizonEnd) continue;
    // Due this week in an active course's bucket: that bucket proposes it in step 4 (see
    // `bucketCandidates`), so offering it here too would be a second copy of the same minutes.
    const owningCourse = activeCourses.find((course) => course.id === task.courseId);
    if (owningCourse && task.bucket && COURSE_BUCKETS.includes(task.bucket) && weekDateKeys.includes(task.dueDate)) {
      upcomingNotes.push({
        id: `task:${task.id}`,
        title: task.title,
        detail: `Task · due ${task.dueDate}`,
        status: `Proposed in step 4 with ${owningCourse.name} — ${taskBucketLabels[task.bucket].toLowerCase()}`
      });
      continue;
    }
    const family = `task:${task.id}`;
    const planned = plannedMinutesForTask(schedules, task.id, weekDateKeys);
    upcomingRows.push({
      id: family,
      family,
      title: task.title,
      detail: `${task.kind === "external" ? "External · " : ""}Task · due ${task.dueDate}`,
      minutes: outstandingFor(family, taskBlockMinutes(task, workMinutes), Math.max(loggedMinutesForTask(sessions, task.id), planned)),
      planned,
      type: "deep_work",
      taskId: task.id,
      courseId: task.courseId,
      bucket: task.bucket,
      preferredDateKeys: weekDateKeys.filter((d) => d <= task.dueDate!)
    });
  }
  for (const goal of activeGoals) {
    for (const milestone of goal.milestones) {
      if (milestone.done || !milestone.dueAt || milestone.dueAt < upcomingFrom || milestone.dueAt > horizonEnd) continue;
      const family = `milestone:${goal.id}:${milestone.id}`;
      const objectiveRef = { kind: "goal" as const, id: goal.id, milestoneId: milestone.id };
      const planned = plannedMinutesForObjective(schedules, objectiveRef, weekDateKeys);
      upcomingRows.push({
        id: family,
        family,
        title: `${goal.title} — ${milestone.title}`,
        detail: `Milestone · due ${milestone.dueAt}`,
        minutes: outstandingFor(family, Math.max(30, Math.round((goal.targetHoursPerWeek ?? 1) * 60)), planned),
        planned,
        type: "deep_work",
        preferredDateKeys: weekDateKeys.filter((d) => d <= milestone.dueAt!),
        objectiveRef
      });
    }
  }
  for (const cp of allCheckpoints) {
    if (!cp.dueAt || cp.dueAt < todayK || cp.dueAt > horizonEnd || !cp.requiresPrep || cp.prepEstimateMin <= 0) continue;
    if (cp.status === "done" || cp.status === "missed") continue;
    upcomingNotes.push({
      id: `checkpoint:${cp.id}`,
      title: `Prep: ${cp.title}`,
      detail: `Checkpoint · due ${cp.dueAt} · ${formatHours(cp.prepEstimateMin)} prep`,
      status: prepCheckpoints.includes(cp) ? "Proposed in step 4" : `Proposed from ${addDaysToKey(cp.dueAt, -cp.prepLeadDays)}`
    });
  }
  // A paper whose pass 1 is blocked on a missing reading goal is *not* schedulable — starting it is
  // gated — so it is surfaced as the small thing it actually is: go and set the goal.
  for (const paper of papersNeedingGoal) {
    upcomingNotes.push({
      id: `paperGoal:${paper.id}`,
      title: `Set a reading goal: ${paper.title}`,
      detail: "Pass 1 can't start without one",
      status: "Open paper",
      href: `/papers/${paper.id}`
    });
  }

  /** The days still worth offering: working, not off, and not already behind you. */
  function firstUsableDay(preferred: string[]): string {
    const workable = liveDateKeys.filter((d) => workingWindow.daysOfWeek.includes(getDay(parseISO(d))));
    return preferred.find((d) => workable.includes(d)) ?? workable[0] ?? liveDateKeys[0] ?? weekDateKeys[6];
  }

  // Sittings derived from each added row's decision and what it still owes. The first sitting is
  // pinned to the confirmed day and time only until something of it is accepted — after that, a pin
  // would put the next sitting on top of the one just accepted.
  const datedRow: LedgerRow = { id: "dated", label: "Dated work (from What's coming)", ask: 0, placed: 0, dismissed: 0, sittings: [], families: [] };
  const extraCandidates: WeekProposalCandidate[] = [];
  for (const row of upcomingRows) {
    datedRow.placed += row.planned;
    datedRow.families.push(row.family);
    const add = upcomingAdds[row.id];
    if (!add) continue;
    const placedSince = Math.max(0, row.planned - add.plannedAtAdd);
    const dismissedSince = Math.max(0, (dismissedMinutes[row.family] ?? 0) - add.dismissedAtAdd);
    datedRow.dismissed += dismissedSince;
    const sittings = splitIntoChunks(Math.max(0, add.ask - placedSince - dismissedSince), chunkOpts);
    datedRow.sittings.push(...sittings);
    const groupId = `upcoming:${row.id}:${weekStart}`;
    const laterDays = weekDateKeys.filter((d) => d >= add.dateKey && liveDateKeys.includes(d));
    extraCandidates.push(
      ...sittings.map((minutes, index) => ({
        title: row.title,
        type: row.type,
        durationMinutes: minutes,
        plannedMinutes: minutes,
        key: `upcoming:${row.id}:${index}`,
        family: row.family,
        capGroup: `upcoming:${row.id}`,
        ...(row.courseId ? { courseId: row.courseId } : {}),
        ...(row.bucket ? { bucket: row.bucket } : {}),
        ...(row.taskId ? { taskId: row.taskId } : {}),
        ...(row.objectiveRef ? { objectiveRef: row.objectiveRef } : {}),
        ...(sittings.length > 1 ? { chunk: { groupId, index: index + 1, total: sittings.length } } : {}),
        ...(index === 0 && placedSince === 0 ? { dateKey: add.dateKey, fixedStartTime: add.startTime } : { preferredDateKeys: laterDays })
      }))
    );
  }
  datedRow.ask = datedRow.placed + datedRow.dismissed + toPlaceOf(datedRow);
  if (datedRow.ask > 0) ledger.push(datedRow);

  const totals = ledger.reduce(
    (sum, row) => ({
      ask: sum.ask + row.ask,
      placed: sum.placed + row.placed,
      dismissed: sum.dismissed + row.dismissed,
      toPlace: sum.toPlace + toPlaceOf(row),
      over: sum.over + Math.max(0, row.placed + row.dismissed - row.ask)
    }),
    { ask: 0, placed: 0, dismissed: 0, toPlace: 0, over: 0 }
  );
  // `free` is measured *after* the locked layer, which includes every block already accepted onto a
  // day — so it is compared with what is still to place, never with the whole ask. The old meter set
  // the whole ask against it, counting placed work once as committed and again as no longer free.
  const capacity = weekCapacity({ workingWindow, weekDateKeys, claimedSlotsByDate, committedMinutes: totals.ask + goalMinutes, offDateKeys, now });
  const toPlacePct = capacity.freeMinutes > 0 ? (totals.toPlace / capacity.freeMinutes) * 100 : totals.toPlace > 0 ? 100 : 0;
  if (process.env.NODE_ENV !== "production") {
    const offered = [...extraCandidates, ...candidates].reduce((sum, candidate) => sum + candidate.durationMinutes, 0);
    if (offered !== totals.toPlace) console.warn(`[weekplan] ledger says ${totals.toPlace}m to place, candidates offer ${offered}m`);
    // One owner per piece of work: a family accounted by two rows is the double count this ledger
    // exists to prevent.
    const owners = new Map<string, string>();
    for (const row of ledger) {
      for (const family of row.families) {
        if (owners.has(family)) console.warn(`[weekplan] ${family} is accounted by both "${owners.get(family)}" and "${row.label}"`);
        owners.set(family, row.label);
      }
    }
  }

  /**
   * The order here is load-bearing. `placeProposals` walks the array once, committing each candidate
   * as it goes, and a `fixedStartTime` candidate is *refused* rather than moved when its range is
   * taken. An added "What's coming" row carries exactly such a pin — the time the user confirmed —
   * so it goes first: a time the user chose claims its space before the search is allowed to guess.
   */
  const freshProposals = placeProposals([...extraCandidates, ...candidates], weekDateKeys, claimedSlotsByDate, workingWindow, offDateKeys, now);
  const proposals: WeekProposal[] = committed
    ? (existingReview!.plan!.proposedBlocks.map((p, index) => ({ ...p, key: p.key ?? `${index}`, fits: true })) as WeekProposal[])
    : freshProposals;

  /**
   * plan/16 — `blockDecisions` is no longer read. It was a per-candidate accepted/dismissed flag, and
   * a flag cannot identify one of a family's interchangeable sittings: the list is regenerated at
   * whatever length the remaining minutes call for, so a flag keyed to a position in it re-targets
   * the moment anything changes. What replaced it: accepted work is counted off the calendar, and
   * dismissals are minutes in `WeekPlan.dismissedMinutes`. The stored map is still written through
   * unchanged by `patchPlan` rather than deleted — it costs nothing to keep and throwing away a
   * user's data to tidy up a field would be the wrong trade.
   */
  const legacyBlockDecisions = existingReview?.plan?.blockDecisions ?? {};

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
  /** What `applyPlacement` changed about a requested placement, per proposal key — reported on the
   *  row so a clamp explains itself rather than looking like a control that ignored you. */
  const [placementNotes, setPlacementNotes] = useState<Record<string, string>>({});
  useEffect(() => {
    setPlacements({});
    setPlacementNotes({});
  }, [weekStart]);
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
  /**
   * Every proposal the accounting produced. There is deliberately no "minus the ones flagged
   * accepted or dismissed" step: an accepted proposal is already absent because the slot it became is
   * counted, and a dismissal is already absent because its minutes were subtracted. Filtering again
   * here is what made accepting two of four sittings leave the planner empty with half the target
   * unplanned — the count and the flags were suppressing the same work twice.
   */
  const undecidedProposals = effectiveProposals;

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
    const usable = usableWindow(workingWindow, p.dateKey, now);
    if (!usable) return p.dateKey < todayK ? "That day has already passed." : "Today's working window is over.";
    const start = minutesFromTime(p.startTime);
    const end = minutesFromTime(p.endTime);
    if (start < usable.start && start >= minutesFromTime(workingWindow.startTime)) return `${p.startTime} has already passed — pick a later time.`;
    if (start < usable.start || end > usable.end) {
      return `Outside your working window (${workingWindow.startTime}–${workingWindow.endTime}).`;
    }
    const others = [
      ...(claimedSlotsByDate[p.dateKey] ?? []),
      ...undecidedProposals.filter((other) => other.key !== p.key && other.dateKey === p.dateKey)
    ];
    const clash = others.find((other) => start < minutesFromTime(other.endTime) && minutesFromTime(other.startTime) < end);
    return clash ? `Overlaps "${clash.title}" (${clash.startTime}–${clash.endTime}).` : null;
  }

  /**
   * The single path every move and resize goes through — the grid's drag and the inspector's day,
   * time and duration fields alike — because a placement has to satisfy more constraints than any
   * one of those inputs knows about.
   *
   * A typed duration in particular reaches much further than its own block, which is why it is
   * clamped here rather than taken literally:
   *
   * - **The sitting cap is not advisory.** `startFocus` clamps the armed timer to
   *   `maxChunkMinutes`, so a 120-minute block arms a 50-minute timer. 50 of 120 is 42%, below
   *   `slotAutoStatus`'s 60% threshold, so the block can never auto-close however diligently it is
   *   worked — and `computeDayScore` then counts it as an unfinished sitting *and* uses the inflated
   *   120 as its coverage denominator. A block longer than the cap is unfinishable by construction,
   *   so allowing one is not flexibility, it is a trap.
   * - **`plannedMinutes` is read by the planner.** It feeds `plannedMinutesThisWeek` /
   *   `plannedMinutesForTask`, which is what next week's generation subtracts before deciding how
   *   much to propose. Inflating it silently tells the planner more is planned than the work needs,
   *   and the difference is lost rather than rolled forward.
   * - **The locked layer cannot move.** Lectures, routine and calendar events are fixed reality
   *   (§5.4/A1), so growth stops at whatever is next on the day rather than overlapping it. Other
   *   *proposals* could in principle be pushed, but silently reflowing a block the user placed
   *   deliberately is worse than stopping short and saying so.
   *
   * Every clamp is reported rather than applied silently — the note appears on the row, so a
   * duration that came back smaller than typed explains itself instead of looking broken.
   */
  function applyPlacement(key: string, requested: WeekGridPlacement) {
    const proposal = effectiveProposals.find((p) => p.key === key);
    const grew = proposal ? requested.durationMinutes > minutesFromTime(proposal.endTime) - minutesFromTime(proposal.startTime) : false;
    const { placement, notes } = resolvePlacement(requested, {
      occupied: [
        ...(claimedSlotsByDate[requested.dateKey] ?? []),
        ...undecidedProposals.filter((other) => other.key !== key && other.dateKey === requested.dateKey)
      ].map((item) => ({ startTime: item.startTime, endTime: item.endTime, title: item.title })),
      workingWindow,
      maxChunkMinutes: chunkOpts.maxChunkMinutes,
      minChunkMinutes: chunkOpts.minChunkMinutes,
      now
    });
    // Growing one sitting of a split doesn't shrink its siblings — so the week now plans more of this
    // work than the split budgeted. Said out loud rather than silently rebalancing blocks the user
    // may have already placed deliberately.
    if (grew && proposal?.chunk) notes.push(`This is sitting ${proposal.chunk.index} of ${proposal.chunk.total}; the others are unchanged.`);
    setPlacements((current) => ({ ...current, [key]: placement }));
    setPlacementNotes((current) => ({ ...current, [key]: notes.join(" ") }));
  }

  /** The first start on `dateKey` that would actually fit — what the inspector uses when a proposal
   *  with no position is given a day, so choosing a day is one step rather than "choose a day, then
   *  discover it's at midnight, then type a time". */
  function suggestStartOn(dateKey: string, durationMinutes: number): number {
    return firstGapOn(dateKey, durationMinutes, claimedSlotsByDate[dateKey] ?? []);
  }

  /** The earliest start on `dateKey` that fits `minutes` around `occupied`, from now on — the window's
   *  start when nothing fits, so a control always has a value to show. */
  function firstGapOn(dateKey: string, minutes: number, occupied: Pick<ScheduleSlot, "startTime" | "endTime">[]): number {
    const usable = usableWindow(workingWindow, dateKey, now);
    if (!usable) return minutesFromTime(workingWindow.startTime);
    return placeInWindow(occupied, usable.start, usable.end, minutes) ?? usable.start;
  }

  // ---- "What's coming": a row's values, and adding/removing it ----
  /** The tentative time: the first gap that fits the row's first sitting on that day, around the
   *  locked layer *and* every sitting already proposed there — so two rows prefilled for the same day
   *  no longer both suggest 05:30 and collide the moment both are added. */
  function tentativeTime(dateKey: string, minutes: number): string {
    const firstSitting = splitIntoChunks(minutes, chunkOpts)[0] ?? minutes;
    const occupied = [...(claimedSlotsByDate[dateKey] ?? []), ...effectiveProposals.filter((p) => p.fits && p.dateKey === dateKey)];
    return minutesToTime(firstGapOn(dateKey, firstSitting, occupied));
  }

  /** A row's current values: the derived prefill, overridden by whatever the user has typed. */
  function upcomingValues(row: UpcomingRow): { minutes: number; dateKey: string; startTime: string } {
    const draft = upcomingDrafts[row.id] ?? {};
    const minutes = draft.minutes ?? row.minutes;
    const dateKey = draft.dateKey ?? firstUsableDay(row.preferredDateKeys);
    return { minutes, dateKey, startTime: draft.startTime ?? tentativeTime(dateKey, minutes) };
  }

  function addUpcoming(row: UpcomingRow) {
    const values = upcomingValues(row);
    if (values.minutes <= 0) return;
    setUpcomingAdds((current) => ({
      ...current,
      [row.id]: { ask: values.minutes, dateKey: values.dateKey, startTime: values.startTime, plannedAtAdd: row.planned, dismissedAtAdd: dismissedMinutes[row.family] ?? 0 }
    }));
  }

  function removeUpcoming(rowId: string) {
    setUpcomingAdds((current) => {
      const next = { ...current };
      delete next[rowId];
      return next;
    });
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

  /** What "Accept all" takes: every proposal with a position that `placementProblem` has nothing to say about. */
  const acceptableProposals = undecidedProposals.filter((p) => p.fits && !placementProblem(p));

  const [acceptError, setAcceptError] = useState("");
  const [accepting, setAccepting] = useState(false);

  /**
   * Writes the whole `plan` field in one shot rather than dotted paths like `plan.blockDecisions.0`
   * — `setDoc(ref, {"a.b": x}, {merge: true})` does NOT nest in this SDK; it creates a literal
   * top-level field named `"a.b"` (verified live: a committed plan produced sibling fields
   * `"plan.completedAt"`, `"plan.targets"`, etc. instead of a `plan` object, so `existingReview
   * ?.plan` stayed `undefined` and Commit never flipped to Re-commit). `merge: true` at the *top*
   * level does work — it leaves `wins`/`missedGoals`/etc. untouched — so replacing the whole `plan`
   * value here is safe as long as callers always spread in what they don't mean to change (`dismissedMinutes`
   * is read straight off `existingReview`, so a dismissal made moments earlier is already in it by
   * the time the next patch is built).
   */
  async function patchPlan(patch: Partial<WeekPlan>) {
    if (!user) return;
    const nextPlan = {
      targets: existingReview?.plan?.targets ?? [],
      capacity: existingReview?.plan?.capacity ?? { freeMinutes: 0, committedMinutes: 0 },
      proposedBlocks: existingReview?.plan?.proposedBlocks ?? [],
      blockDecisions: legacyBlockDecisions,
      // `saveWeeklyReviewFields` replaces the whole `plan` field on an existing doc, so anything not
      // carried here is erased — committing the week used to wipe every dismissal made before it.
      dismissedMinutes,
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
      const fitting = toAccept.filter((p) => p.fits);
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

      // No accept flag is written. The `ScheduleSlot` just saved onto the day *is* the record that
      // this work is planned, and every generator now subtracts what is on the calendar — so a second
      // record would only be a chance for the two to disagree, which is exactly what went wrong.

    } finally {
      setAccepting(false);
    }
  }

  /**
   * Dismissing means "not this week", and it is recorded as *minutes against the family* rather than
   * a flag on this candidate. A family's candidates are interchangeable sittings of one quantity,
   * regenerated at whatever length the remaining minutes call for — so there is no individual
   * candidate for a flag to belong to, and a flag keyed to a position in that list re-targets the
   * moment the quantity changes.
   */
  async function dismissProposal(p: WeekProposal) {
    const minutes = Math.max(0, minutesFromTime(p.endTime) - minutesFromTime(p.startTime)) || p.durationMinutes;
    await dismissFamily(p.family ?? p.key, minutes);
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
        // plan/16 §5.3 — `effectiveProposals`, not `proposals`: the week is committed as the user
        // left it, drags and typed times included. Committing the search's own positions would
        // silently discard every move the moment the week was committed and re-opened.
        proposedBlocks: effectiveProposals.map(({ fits, ...rest }) => rest),
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
  // plan/16 §5.6 — Look back's one new number. Averaged over the days that actually have a score:
  // a day with nothing planned and a day off both score null rather than 0 (plan/15 §5.1's
  // distinction), so counting them would drag the average down for not having worked on a Sunday.
  const priorWeekScores = priorWeekDays.map((d) => d.game?.score).filter((score): score is number => typeof score === "number");
  const avgDayScore = priorWeekScores.length > 0 ? Math.round(priorWeekScores.reduce((sum, score) => sum + score, 0) / priorWeekScores.length) : null;
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
            <span className="font-semibold text-ink-950 dark:text-ink-50">{formatHours(totals.toPlace)}</span> to place, of{" "}
            {formatHours(capacity.freeMinutes)} free{weekStart <= todayK ? " from now" : ""}
            <span className="ml-2 text-xs">
              · {formatHours(totals.placed)} placed
              {totals.dismissed > 0 ? ` · ${formatHours(totals.dismissed)} dismissed` : ""} · {formatHours(totals.ask)} asked in all
              {goalMinutes > 0 ? ` · plus ${formatHours(goalMinutes)} of goal hours you plan yourself` : ""}
            </span>
          </p>
          <div className="mt-1 h-1.5 w-48 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
            <div
              className={`h-full ${toPlacePct > 100 ? "bg-red-500" : toPlacePct > 85 ? "bg-amber-500" : "bg-moss-600"}`}
              style={{ width: `${Math.min(100, toPlacePct)}%` }}
            />
          </div>
          {totals.toPlace > capacity.freeMinutes ? (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
              {formatHours(totals.toPlace - capacity.freeMinutes)} more than the free time left — lower a target in step 3 or dismiss something.
            </p>
          ) : null}
        </div>
        <button className="btn-primary" onClick={commitWeek} disabled={committing}>
          {committing ? "Committing..." : committed ? "Re-commit" : "Commit"}
        </button>
      </div>

      {!settings.seenSittingsNotice ? (
        <section className="card mb-6 max-w-5xl border-l-2 border-l-moss-600 p-4 text-sm">
          <p className="font-medium">Your week is shaped differently now.</p>
          <p className="mt-1 text-ink-500">
            Work is planned in <strong>sittings</strong> — blocks capped at {chunkOpts.maxChunkMinutes} minutes, split across the week and
            labelled &ldquo;2 of 7&rdquo;. A three-hour revision target used to become seven 25-minute blocks, because 25 is the focus
            timer&apos;s default, not a considered length for a block of revision; it now becomes a few longer ones. Big tasks that
            never fit anywhere are split instead of landing under &ldquo;Didn&apos;t fit&rdquo;. Change the cap in{" "}
            <Link href="/settings" className="underline">
              Settings
            </Link>
            .
          </p>
          <button className="btn-secondary mt-3 px-2 py-1 text-xs" onClick={() => updateSettings({ seenSittingsNotice: true })}>
            Got it
          </button>
        </section>
      ) : null}

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
            {dayScoreOn ? <Stat label="Average day score" value={avgDayScore != null ? `${avgDayScore}` : "-"} /> : null}
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
          Tasks and milestones due soon that nothing else plans. Adding one puts its sittings in step 4 — the first at the day and time
          you pick, the rest on the days after — and nothing reaches a day until you accept it there. Course hours, reading, checkpoint
          prep and reviews are planned automatically from step 3.
        </p>
        {upcomingRows.every((row) => row.minutes <= 0 && !upcomingAdds[row.id]) && upcomingNotes.length === 0 ? (
          <p className="text-sm text-ink-500">Nothing dated in the next {horizonDays} days.</p>
        ) : (
          <div className="space-y-1">
            {upcomingRows
              .filter((row) => row.minutes > 0 || upcomingAdds[row.id])
              .map((row) => {
                const add = upcomingAdds[row.id];
                if (add) {
                  const left = extraCandidates.filter((c) => c.key?.startsWith(`upcoming:${row.id}:`)).map((c) => c.durationMinutes);
                  return (
                    <div key={row.id} className="flex flex-wrap items-center gap-2 rounded-md bg-ink-50 px-3 py-2 text-xs dark:bg-ink-800">
                      <span className="min-w-48 flex-1">
                        <span className="block truncate font-medium">{row.title}</span>
                        <span className="block truncate text-ink-500">{row.detail}</span>
                      </span>
                      <span className="text-ink-500">
                        {left.length > 0
                          ? `Added · ${sittingShape(left)} in step 4, from ${DAY_LABELS[weekDateKeys.indexOf(add.dateKey)]} ${add.startTime}`
                          : "Added · all placed"}
                      </span>
                      <button className="btn-secondary px-2 py-1" onClick={() => removeUpcoming(row.id)} disabled={committed}>
                        Remove
                      </button>
                    </div>
                  );
                }
                const values = upcomingValues(row);
                const sittings = splitIntoChunks(values.minutes, chunkOpts);
                return (
                  <div key={row.id} className="flex flex-wrap items-center gap-2 rounded-md bg-ink-50 px-3 py-2 text-xs dark:bg-ink-800">
                    <span className="min-w-48 flex-1">
                      <span className="block truncate font-medium">{row.title}</span>
                      <span className="block truncate text-ink-500">
                        {row.detail}
                        {row.planned > 0 ? ` · ${formatHours(row.planned)} already placed` : ""}
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
                        disabled={committed}
                        onChange={(e) =>
                          setUpcomingDrafts((current) => ({ ...current, [row.id]: { ...current[row.id], minutes: Math.max(5, Number(e.target.value)) } }))
                        }
                      />
                      <span className="text-ink-500">min</span>
                    </label>
                    <select
                      className="input w-28 py-1 text-xs"
                      aria-label={`First day for ${row.title}`}
                      value={values.dateKey}
                      disabled={committed}
                      onChange={(e) =>
                        // A new day re-derives the time: the old one was a gap on the old day.
                        setUpcomingDrafts((current) => ({ ...current, [row.id]: { ...current[row.id], dateKey: e.target.value, startTime: undefined } }))
                      }
                    >
                      {weekDateKeys.map((d, i) => (
                        <option key={d} value={d} disabled={!liveDateKeys.includes(d)}>
                          {DAY_LABELS[i]} {d.slice(5)}
                          {offDateKeys.has(d) ? " (off)" : !liveDateKeys.includes(d) ? " (past)" : ""}
                        </option>
                      ))}
                    </select>
                    <TypedTimeInput
                      className="input w-20 py-1 text-xs"
                      value={values.startTime}
                      disabled={committed}
                      onChange={(time) => setUpcomingDrafts((current) => ({ ...current, [row.id]: { ...current[row.id], startTime: time } }))}
                    />
                    <button className="btn-secondary px-2 py-1" onClick={() => addUpcoming(row)} disabled={committed}>
                      Add to week
                    </button>
                    {sittings.length > 1 ? (
                      <span className="w-full text-[11px] text-ink-500">
                        {sittingShape(sittings)}: the first at {values.startTime} on {DAY_LABELS[weekDateKeys.indexOf(values.dateKey)]}, the rest on the
                        days after.
                      </span>
                    ) : null}
                  </div>
                );
              })}
            {upcomingNotes.map((note) => (
              <div key={note.id} className="flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-xs">
                <span className="min-w-48 flex-1">
                  <span className="block truncate">{note.title}</span>
                  <span className="block truncate text-ink-500">{note.detail}</span>
                </span>
                {note.href ? (
                  <Link href={note.href} className="text-ink-500 underline">
                    {note.status}
                  </Link>
                ) : (
                  <span className="text-ink-500">{note.status}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card mb-6 max-w-5xl p-5">
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
        <p className="mb-2 text-xs text-ink-500">
          Hours for the whole week, per course. Each is split into sittings of at most {chunkOpts.maxChunkMinutes} minutes, after taking off
          what&apos;s already on a day or dismissed.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-500">
                <th className="py-1">Course</th>
                {COURSE_BUCKETS.map((bucket) => (
                  <th key={bucket} className="py-1 pl-3">
                    <span className="inline-flex items-center gap-1">
                      {taskBucketLabels[bucket]} (h)
                      <InfoHint term={bucket === "revision" ? "revisionHoursPerWeek" : "bucketAssignmentBacklog"} />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activeCourses.map((course) => (
                <tr key={course.id} className="border-t border-ink-100 align-top dark:border-ink-800">
                  <td className="py-2 pr-2 font-medium">{course.name}</td>
                  {COURSE_BUCKETS.map((bucket) => {
                    const row = bucketLedger.get(`${bucket}:${course.id}`);
                    const toPlace = row ? toPlaceOf(row) : 0;
                    return (
                      <td key={bucket} className="py-2 pl-3">
                        <input
                          type="number"
                          min={0}
                          step={0.5}
                          className="input w-20 py-1"
                          aria-label={`${course.name} ${taskBucketLabels[bucket]} hours`}
                          value={hoursFor(course, bucket) / 60}
                          onChange={(e) =>
                            setHoursDraft((current) => ({
                              ...current,
                              [course.id]: { ...current[course.id], [bucket]: Math.round(Math.max(0, Number(e.target.value)) * 60) }
                            }))
                          }
                        />
                        <p className="mt-1 text-[11px] text-ink-500">
                          {!row || (row.ask === 0 && row.placed === 0)
                            ? "\u00a0"
                            : toPlace > 0
                              ? `${sittingShape(row.sittings)} to place`
                              : row.placed + row.dismissed > row.ask
                                ? `All placed, ${formatHours(row.placed + row.dismissed - row.ask)} over`
                                : "All placed"}
                        </p>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button className="btn-primary" onClick={saveHours} disabled={savingHours || !hoursDirty}>
            {savingHours ? "Saving..." : "Save hours"}
          </button>
          {hoursDirty ? <span className="text-xs text-ink-500">Unsaved — step 4 is already using these numbers.</span> : null}
        </div>

        <div className="mt-5 overflow-x-auto">
          <p className="label mb-1">The week, in minutes</p>
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left text-xs text-ink-500">
                <th className="py-1">Work</th>
                <th className="py-1 pl-3 text-right">Asked</th>
                <th className="py-1 pl-3 text-right">Placed</th>
                <th className="py-1 pl-3 text-right">Dismissed</th>
                <th className="py-1 pl-3 text-right">To place</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((row) => {
                const toPlace = toPlaceOf(row);
                return (
                  <tr key={row.id} className="border-t border-ink-100 dark:border-ink-800">
                    <td className="py-1.5 pr-2">
                      {row.label}
                      {row.detail ? <span className="block text-xs text-ink-500">{row.detail}</span> : null}
                    </td>
                    <td className="py-1.5 pl-3 text-right">{formatHours(row.ask)}</td>
                    <td className="py-1.5 pl-3 text-right">{formatHours(row.placed)}</td>
                    <td className="py-1.5 pl-3 text-right">
                      {row.dismissed > 0 ? (
                        <>
                          {formatHours(row.dismissed)}{" "}
                          <button
                            className="text-xs text-ink-500 underline decoration-dotted"
                            onClick={() => restoreFamilies(row.families)}
                            disabled={committed}
                          >
                            restore
                          </button>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-1.5 pl-3 text-right">
                      {formatHours(toPlace)}
                      {toPlace > 0 ? <span className="block text-xs text-ink-500">{sittingShape(row.sittings)}</span> : null}
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t-2 border-ink-200 font-medium dark:border-ink-700">
                <td className="py-1.5 pr-2">Total</td>
                <td className="py-1.5 pl-3 text-right">{formatHours(totals.ask)}</td>
                <td className="py-1.5 pl-3 text-right">{formatHours(totals.placed)}</td>
                <td className="py-1.5 pl-3 text-right">{totals.dismissed > 0 ? formatHours(totals.dismissed) : "—"}</td>
                <td className="py-1.5 pl-3 text-right">{formatHours(totals.toPlace)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-1 text-xs text-ink-500">
            Asked = placed + dismissed + to place
            {totals.over > 0 ? `, less ${formatHours(totals.over)} placed beyond what was asked` : ""}. Placed means on a day this week
            {weekStart <= todayK ? " (including days already behind you)" : ""} or already worked; a course&apos;s hours include its tasks due this week.
          </p>
          {activeGoals.some((goal) => goal.targetHoursPerWeek) ? (
            <div className="mt-3 text-xs text-ink-500">
              <p>Goal hours aren&apos;t proposed here — plan them yourself:</p>
              <ul className="mt-1 list-inside list-disc">
                {activeGoals
                  .filter((goal) => goal.targetHoursPerWeek)
                  .map((goal) => (
                    <li key={goal.id}>
                      {goal.title} · {goal.targetHoursPerWeek}h/week
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
        </div>
      </section>

      <section className="card mb-6 max-w-6xl p-5">
        <h2 className="mb-1 text-base font-semibold">4. Assign the week</h2>
        <p className="mb-3 text-xs text-ink-500">
          Drag a sitting to a different day or time, or use the list below — both do the same thing. Nothing is written to a day
          until you accept it.
        </p>
        {acceptError ? <p className="mb-2 text-sm text-red-600">{acceptError}</p> : null}
        {acceptableProposals.length > 0 ? (
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <button className="btn-primary" onClick={() => acceptProposals(acceptableProposals)} disabled={accepting || committed}>
              {accepting ? "Accepting..." : `Accept all ${acceptableProposals.length} (${formatHours(acceptableProposals.reduce((sum, p) => sum + p.durationMinutes, 0))})`}
            </button>
            <span className="text-xs text-ink-500">
              Every sitting shown on the grid, where it sits now.
              {undecidedProposals.length > acceptableProposals.length
                ? ` ${undecidedProposals.length - acceptableProposals.length} more need a day or time first (below).`
                : ""}
            </span>
          </div>
        ) : null}
        <p className="sr-only" role="status" aria-live="polite">
          {gridMessage}
        </p>
        {readingPlan.length > 0 || backlogTasks.length > 0 ? (
          <div className="mb-4 space-y-1">
            <p className="label mb-1 inline-flex items-center gap-1">
              Target a day (optional)
              <InfoHint term="weeklyTargetDay" />
            </p>
            {readingPlan.map(({ paper, passNo }) => (
              <TargetDayRow
                key={paper.id}
                title={`Read: ${paper.title} (pass ${passNo})`}
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
            onPlace={applyPlacement}
            disabled={accepting || committed}
            now={now}
            chipFor={chipForProposal}
            dayScoreFor={dayScoreOn ? (dateKey) => (dateKey < todayK ? weekDayDocs.get(dateKey)?.game?.score ?? null : null) : undefined}
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
                        onPlace={applyPlacement}
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
                        notice={placementNotes[p.key]}
                        maxMinutes={chunkOpts.maxChunkMinutes}
                        suggestStart={suggestStartOn}
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
                    onPlace={applyPlacement}
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
                    notice={placementNotes[p.key]}
                    maxMinutes={chunkOpts.maxChunkMinutes}
                    suggestStart={suggestStartOn}
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
