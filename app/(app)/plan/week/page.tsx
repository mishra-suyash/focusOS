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
  syncRevisionTemplate,
  type PlanningCutoff
} from "@/lib/courses";
import { addDaysToKey, todayKey, weekDates, weekStartKey } from "@/lib/dates";
import { clearDayOff, fetchCourseClassLogs, saveDailySchedule, saveWeeklyReviewFields, setDayOff, updateCourse, updateGoal, updatePaper, updateTask } from "@/lib/firestore";
import { isGoalActiveForDate } from "@/lib/goals";
import { computeDebtHours, computeLoadIndexStreak, loadIndexBand, loadIndexBandLabels, loadIndexBandStyles } from "@/lib/loadindex";
import { taskBucketLabels } from "@/lib/options";
import {
  DEFAULT_READING_HABIT,
  derivePaperStatus,
  isActivePaper,
  lastStatusChangeAt,
  nextReadingPass,
  PASS_LABELS,
  paperShelfDate,
  passSessionMinutes,
  readingCandidates,
  readingHabitProgress,
  readingOrder,
  readingWeeksStreak
} from "@/lib/papers";
import { DEFAULT_MAX_REVISIONS_PER_DAY, DEFAULT_MAX_REVISION_MINUTES_PER_DAY, estimatedReviewMinutes } from "@/lib/revision";
import { commitmentSlotsForDate, isFixedCommitment, isFixedCommitmentOccurrence, isTemplateDueOn, withCommitments } from "@/lib/recurring-tasks";
import { DEFAULT_ROUTINE_BLOCKS, routineSlotsForDate } from "@/lib/routine";
import { describeObjective, objectiveChipText } from "@/lib/objectives";
import { minutesFromTime, minutesToTime, sortedSlots, validateSlots } from "@/lib/schedule";
import { isBreakMode } from "@/lib/terms";
import { loggedMinutesForTask, sittingOutcome } from "@/lib/tracking";
import {
  DEFAULT_MAX_CHUNK_MINUTES,
  DEFAULT_MIN_CHUNK_MINUTES,
  rangeOverlapsSlots,
  renumberSittings,
  sittingTitle,
  splitIntoChunks,
  taskBlockMinutes,
  taskChunkMinutes,
  type SittingEntry
} from "@/lib/timeline";
import {
  DEFAULT_WORKING_WINDOW,
  keyedAfterRemoval,
  placeInWindow,
  placeProposals,
  isPlannerMade,
  readingHabitPlan,
  releasableSlots,
  replanDiff,
  resolvePlacement,
  TIME_OF_DAY_WINDOWS,
  usableWindow,
  weekCapacity,
  weeklyPlanningSlotForDate,
  type NowFloor,
  type OwedPass,
  type ReleasedSlot,
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
  ReadingHabit,
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

/** A saved slot under the number `renumberSittings` gave it — no `chunk` at all if it's no longer a split. */
function withSittingNumber(slot: ScheduleSlot, numbered: Pick<SittingEntry, "title" | "chunk">): ScheduleSlot {
  const { chunk: _chunk, ...rest } = slot;
  return { ...rest, title: numbered.title, ...(numbered.chunk ? { chunk: numbered.chunk } : {}) };
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
  /**
   * plan/17 §7.2 — what counts as "placed": slots still ahead count their length, slots behind you
   * count only what was worked against them. Read by every accounting call below, so a missed
   * sitting's minutes come back as To place instead of being counted as done.
   */
  const cutoff: PlanningCutoff = { todayKey: todayK, nowMinutes: now.minutes, sessions };
  // ---- plan/17 §7: Replan mode ----
  type ReplanState = { reason: "manual" | "missed" | "dayOff"; keepMoves: boolean; resetDismissals: boolean };
  const [replan, setReplan] = useState<ReplanState | null>(null);
  const [dayOffNudge, setDayOffNudge] = useState<string | null>(null);
  useEffect(() => {
    setReplan(null);
    setDayOffNudge(null);
  }, [weekStart]);
  const weekIsCurrent = weekDateKeys.includes(todayK);
  /**
   * The unstarted future of this week's plan, released for re-placing — in memory only. Nothing is
   * written until "Accept replan"; leaving the page writes nothing.
   */
  const released: ReleasedSlot[] = replan
    ? releasableSlots({ schedules, weekDateKeys, weekStart, todayKey: todayK, nowMinutes: now.minutes, sessions })
    : [];
  const releasedIds = new Set(released.map((item) => `${item.dateKey}|${item.slot.id}`));
  /** The schedules the week is planned against. Replan mode swaps in a copy without the released
   *  sittings — every accounting call and the claimed layer must read this, never `schedules`, or a
   *  released sitting would be counted as placed and never offered again. */
  const planningSchedules = replan
    ? schedules.map((schedule) => ({ ...schedule, slots: schedule.slots.filter((slot) => !releasedIds.has(`${schedule.dateKey}|${slot.id}`)) }))
    : schedules;
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

  // ---- plan/17 §6.1: this week's reading habit ----
  // The account's default (Settings), unless this week already committed its own, unless edited here.
  // An edit is this week only — Commit snapshots it into `WeekPlan.readingTarget`, the same rule as
  // course targets — until "Make this my default" writes it to settings.
  const habitDefault: ReadingHabit = settings.readingHabit
    ? { sittings: settings.readingHabit.sittings, minutes: settings.readingHabit.minutes, ...(settings.readingHabit.preferredDays ? { preferredDays: settings.readingHabit.preferredDays } : {}), ...(settings.readingHabit.timeOfDay ? { timeOfDay: settings.readingHabit.timeOfDay } : {}) }
    : DEFAULT_READING_HABIT;
  const [habitDraft, setHabitDraft] = useState<ReadingHabit | null>(null);
  useEffect(() => setHabitDraft(null), [weekStart]);
  const readingTarget: ReadingHabit = habitDraft ?? existingReview?.plan?.readingTarget ?? habitDefault;
  function editHabit(patch: Partial<ReadingHabit>) {
    setHabitDraft({ ...readingTarget, ...patch });
  }

  // ---- Step 2: the week already contains (also the source of "claimed" minutes for Step 3's meter and Step 4's placement) ----
  function claimedSlotsForDate(dateKey: string): ScheduleSlot[] {
    const saved = planningSchedules.find((s) => s.dateKey === dateKey)?.slots ?? [];
    const classSlots = isBreakMode(terms, dateKey) ? [] : courseSlotsForDate(courses, dateKey);
    // A TA meeting or office hour is fixed reality the same way a lecture is, so it claims its time
    // whether the day is saved or not — a saved day is exactly the one with accepted blocks on it.
    const commitments = commitmentSlotsForDate(recurringTemplates, dateKey, saved);
    const fixed = [...classSlots, ...commitments];
    // Routine yields to fixed commitments, as on /plan/day — two overlapping blocks would make the
    // day fail `validateSlots` the moment anything is accepted onto it.
    const routineSlots = routineSlotsForDate(settings.routineBlocks ?? DEFAULT_ROUTINE_BLOCKS, dateKey).filter(
      (slot) => !rangeOverlapsSlots(minutesFromTime(slot.startTime), minutesFromTime(slot.endTime), fixed)
    );
    const base = saved.length > 0 ? withCommitments(saved, commitments) : [...classSlots, ...commitments, ...routineSlots];
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
  /** What's on the plan document. A replan may set it aside ("Reset dismissals", §7.5) for its own
   *  arithmetic, but writes go against the stored map, so leaving the page loses nothing. */
  const storedDismissed = existingReview?.plan?.dismissedMinutes ?? {};
  const dismissedMinutes = replan?.resetDismissals ? {} : storedDismissed;
  function outstandingFor(family: string, asks: number, alreadyPlanned: number): number {
    return Math.max(0, asks - alreadyPlanned - (dismissedMinutes[family] ?? 0));
  }

  async function dismissFamily(family: string, minutes: number) {
    if (!user) return;
    await patchPlan({ dismissedMinutes: { ...storedDismissed, [family]: (storedDismissed[family] ?? 0) + minutes } });
  }

  /** Undoes "not this week" for every family behind one ledger row. */
  async function restoreFamilies(families: string[]) {
    if (!user) return;
    const next = { ...storedDismissed };
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
      // Always carried, even for a lone sitting: it's what joins this sitting to siblings already on
      // a day, and `renumberSittings` drops it again if the split turns out to be one block.
      chunk: { groupId, index: index + 1, total: sittings.length },
      sittingBase: task.title
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
    const bucketBlocks = plannedMinutesThisWeek(planningSchedules, course.id, bucket, weekDateKeys, cutoff);
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
      const remaining = outstandingFor(taskFamily, estimate, Math.max(loggedMinutesForTask(sessions, task.id), plannedMinutesForTask(planningSchedules, task.id, weekDateKeys, cutoff)));
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
        chunk: { groupId, index: index + 1, total: sittings.length }
      }))
    );
    row.sittings = offeredSince(start);
    bucketLedger.set(family, row);
    if (row.ask > 0 || row.placed > 0 || row.sittings.length > 0) ledger.push(row);
  }

  const prepRow: LedgerRow = { id: "prep", label: "Checkpoint prep", ask: 0, placed: 0, dismissed: 0, sittings: [], families: [] };
  for (const cp of prepCheckpoints) {
    const family = `checkpoint:${cp.id}`;
    const placed = plannedMinutesForObjective(planningSchedules, { kind: "checkpoint", id: cp.id }, weekDateKeys, cutoff);
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
      const placed = plannedMinutesForObjective(planningSchedules, { kind: "revisionQueue" }, [d], cutoff);
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
  // An occurrence of a fixed commitment (a past TA meeting nobody ticked done) is not backlog: its
  // time was on the calendar, and proposing it would pin a duplicate onto the meeting's own slot.
  const backlogTasks = plannableTasks(
    tasks.filter(
      (task) => task.status !== "done" && (!task.dueDate || task.dueDate < weekStart) && !isFixedCommitmentOccurrence(task, recurringTemplates)
    ),
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
    const planned = plannedMinutesForTask(planningSchedules, task.id, weekDateKeys, cutoff);
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
   * plan/17 §6.2/§6.3 — reading is a *habit* with a weekly target (sittings × minutes), not a backlog
   * of papers that happen to be ready. The row exists whenever the target does, so it can never
   * vanish the way plan/16's did when no paper was owed a pass with a goal set (F1).
   *
   * Owed passes still shape the row: each pins the sittings it needs, in the picker's order; the rest
   * are *open* — a time and a length, with the paper chosen when the sitting starts. Sittings are
   * spread one a day before any day gets a second, and lean to the habit's preferred days and time.
   */
  const readingOwed: OwedPass[] = readingCandidates(papers, todayK, 20).plannable.map(({ paper, passNo, minutes }) => {
    const pass = passNo === 1 ? paper.pass1 : passNo === 2 ? paper.pass2 : paper.pass3;
    const logged = pass?.status === "in_progress" ? passSessionMinutes(sessions, paper.id, passNo, pass.startedAt) : 0;
    return { paperId: paper.id, title: paper.title, passNo, minutes: Math.max(0, minutes - logged) };
  }).filter((item) => item.minutes > 0);
  const pinnedPaperIds = new Set(
    planningSchedules
      .filter((schedule) => weekDateKeys.includes(schedule.dateKey))
      .flatMap((schedule) => schedule.slots.flatMap((slot) => (slot.objectiveRef?.kind === "paper" ? [slot.objectiveRef.id] : [])))
  );
  const placedByPaper = Object.fromEntries(
    [...pinnedPaperIds].map((id) => [id, plannedMinutesForObjective(planningSchedules, { kind: "paper", id }, weekDateKeys, cutoff)] as const)
  );
  const habit = readingHabitPlan({
    target: readingTarget,
    owed: readingOwed,
    placedOpen: plannedMinutesForObjective(planningSchedules, { kind: "readingHabit" }, weekDateKeys, cutoff),
    placedByPaper,
    dismissedMinutes,
    maxChunkMinutes: chunkOpts.maxChunkMinutes,
    minChunkMinutes: chunkOpts.minChunkMinutes
  });
  const readingFamilies = [
    "readingHabit",
    ...new Set([...readingOwed.map((item) => `paper:${item.paperId}`), ...Object.keys(dismissedMinutes).filter((family) => family.startsWith("paper:"))])
  ];
  const readingPreferredDays = readingTarget.preferredDays?.length
    ? weekDateKeys.filter((d) => readingTarget.preferredDays!.includes(getDay(parseISO(d))))
    : undefined;
  const readingShared = {
    type: "reading" as const,
    capGroup: "reading",
    spreadGroup: "reading" as const,
    ...(readingPreferredDays ? { preferredDateKeys: readingPreferredDays } : {}),
    ...(readingTarget.timeOfDay ? { preferredWindow: TIME_OF_DAY_WINDOWS[readingTarget.timeOfDay] } : {})
  };
  const readingStart = candidates.length;
  for (const { paper, minutes } of habit.pinned) {
    const base = `${PASS_LABELS[paper.passNo]}: ${paper.title}`;
    minutes.forEach((sitting, index) => {
      candidates.push({
        ...readingShared,
        title: sittingTitle(base, index + 1, minutes.length),
        sittingBase: base,
        durationMinutes: sitting,
        plannedMinutes: sitting,
        objectiveRef: { kind: "paper", id: paper.paperId, passNo: paper.passNo },
        key: `paper:${paper.paperId}:${index}`,
        family: `paper:${paper.paperId}`,
        chunk: { groupId: `paper:${paper.paperId}:${weekStart}`, index: index + 1, total: minutes.length }
      });
    });
  }
  habit.open.forEach((sitting, index) => {
    candidates.push({
      ...readingShared,
      title: sittingTitle("Reading", index + 1, habit.open.length),
      sittingBase: "Reading",
      durationMinutes: sitting,
      plannedMinutes: sitting,
      objectiveRef: { kind: "readingHabit" },
      key: `readingHabit:${index}`,
      family: "readingHabit",
      chunk: { groupId: `readingHabit:${weekStart}`, index: index + 1, total: habit.open.length }
    });
  });
  const pinnedCount = habit.pinned.reduce((sum, item) => sum + item.minutes.length, 0);
  const readingRow: LedgerRow = {
    id: "reading",
    label: "Reading habit",
    detail:
      readingTarget.sittings === 0
        ? "0 this week — your choice"
        : `${readingTarget.sittings} × ${habit.sittingMinutes}m${
            pinnedCount + habit.open.length > 0
              ? ` · to place: ${pinnedCount} pinned${pinnedCount > 0 ? ` (${habit.pinned.map((item) => `${PASS_LABELS[item.paper.passNo]} · ${item.paper.title}`).join(", ")})` : ""}, ${habit.open.length} open`
              : ""
          }${habit.alsoOwed.length > 0 ? ` · also owed: ${habit.alsoOwed.map((item) => item.title).join(", ")}` : ""}`,
    ask: habit.ask - habit.shortfall,
    placed: habit.placed,
    dismissed: habit.dismissed,
    sittings: offeredSince(readingStart),
    families: readingFamilies
  };
  ledger.push(readingRow);

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
    // A fixed commitment's occurrence is already on its day at its time (step 2, and locked on the
    // grid) — offering it here would add a second, generic-length copy at whatever time is picked.
    if (isFixedCommitmentOccurrence(task, recurringTemplates)) {
      upcomingNotes.push({
        id: `task:${task.id}`,
        title: task.title,
        detail: `Commitment · ${task.dueDate}${task.fixedTime ? ` ${task.fixedTime.startTime}–${task.fixedTime.endTime}` : ""}`,
        status: "On your calendar at its own time",
        href: "/tasks"
      });
      continue;
    }
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
    const planned = plannedMinutesForTask(planningSchedules, task.id, weekDateKeys, cutoff);
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
      const planned = plannedMinutesForObjective(planningSchedules, objectiveRef, weekDateKeys, cutoff);
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
  // plan/17 §6.4 — the goal no longer gates planning (it's asked when a Skim starts), so the old
  // "Set a reading goal" notes are gone. What reading *does* have coming: shelf dates and the inbox.
  const weekEnd = weekDateKeys[6];
  for (const paper of papers) {
    const back = paperShelfDate(paper);
    if (!back || back > weekEnd || back < weekStart) continue;
    upcomingNotes.push({
      id: `shelf:${paper.id}`,
      title: `Back from the shelf: ${paper.title}`,
      detail: `Shelved until ${back}`,
      status: "Offered when a reading sitting starts",
      href: `/papers/${paper.id}`
    });
  }
  const inboxCount = papers.filter((paper) => derivePaperStatus(paper) === "inbox").length;
  if (inboxCount > 0) {
    upcomingNotes.push({ id: "inbox", title: `Inbox: ${inboxCount} paper${inboxCount === 1 ? "" : "s"} to triage`, detail: "Captured, not looked at yet", status: "Triage", href: "/papers" });
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
        chunk: { groupId, index: index + 1, total: sittings.length },
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
  /**
   * plan/17 §7.3 "Keep my moves", widened in implementation: a released sitting is offered back at its
   * own time whenever that time still works, by pinning the first candidate of its family there —
   * sittings you placed by hand first, then the search's. Without it a replan re-ran the search from
   * scratch and reshuffled sittings that were fine ("Fri 09:00 → Fri 09:45"), which made it feel
   * random; now only what has to move does — sittings on a new day off, and missed work coming back.
   * Unticking it gives the full re-layout. Pinned candidates go first, so they claim their space
   * before the search places what's left.
   */
  const keptMoveKeys = new Set<string>();
  if (replan?.keepMoves) {
    const byHandFirst = [...released].sort((a, b) => Number(Boolean(b.slot.placedByUser)) - Number(Boolean(a.slot.placedByUser)));
    for (const item of byHandFirst) {
      if (!item.family || !liveDateKeys.includes(item.dateKey)) continue;
      const candidate = candidates.find((c) => c.key && !keptMoveKeys.has(c.key) && (c.family ?? c.key) === item.family);
      if (!candidate?.key) continue;
      candidate.dateKey = item.dateKey;
      candidate.fixedStartTime = item.slot.startTime;
      delete candidate.preferredDateKeys;
      keptMoveKeys.add(candidate.key);
    }
  }
  const orderedCandidates = [...extraCandidates, ...candidates.filter((c) => c.key && keptMoveKeys.has(c.key)), ...candidates.filter((c) => !c.key || !keptMoveKeys.has(c.key))];
  const freshProposals = placeProposals(orderedCandidates, weekDateKeys, claimedSlotsByDate, workingWindow, offDateKeys, now);
  /** A committed week shows what was committed and can't be edited — except in Replan mode. */
  const frozen = committed && !replan;
  const proposals: WeekProposal[] = frozen
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
   * plan/17 §6.3 — a reading sitting pinned to a paper, or unpinned to an open one, by key. Local until
   * Accept, like a drag. Pinning moves the sitting between families (`readingHabit` ↔ `paper:<id>`)
   * and between numbering groups, so an accepted pinned sitting never reads "Reading (3 of 4)".
   */
  const [pinOverrides, setPinOverrides] = useState<Record<string, string | null>>({});
  useEffect(() => setPinOverrides({}), [weekStart]);
  const pinnablePapers = papers.filter((paper) => isActivePaper(paper)).sort(readingOrder);
  function pinProposal(p: WeekProposal, paperId: string | null): WeekProposal {
    const { chunk: _chunk, sittingBase: _base, ...rest } = p;
    const paper = paperId ? papers.find((item) => item.id === paperId) : undefined;
    if (paper) {
      const passNo = nextReadingPass(paper) ?? undefined;
      const base = passNo ? `${PASS_LABELS[passNo]}: ${paper.title}` : `Reading: ${paper.title}`;
      return {
        ...rest,
        title: base,
        sittingBase: base,
        objectiveRef: { kind: "paper", id: paper.id, ...(passNo ? { passNo } : {}) },
        family: `paper:${paper.id}`,
        chunk: { groupId: `paper:${paper.id}:${weekStart}`, index: 1, total: 1 }
      };
    }
    return {
      ...rest,
      title: "Reading",
      sittingBase: "Reading",
      objectiveRef: { kind: "readingHabit" },
      family: "readingHabit",
      chunk: { groupId: `readingHabit:${weekStart}`, index: 1, total: 1 }
    };
  }

  /**
   * A proposal as the user has last left it: the placement search's answer, overridden by any move.
   * A proposal the search couldn't fit anywhere (`fits: false`) becomes acceptable the moment it is
   * given a position by hand — which is the point of the inspector, and the only route that existed
   * for such a proposal before this was Dismiss.
   */
  const movedProposals: WeekProposal[] = proposals.map((original) => {
    const p = original.key in pinOverrides ? pinProposal(original, pinOverrides[original.key]) : original;
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
   * Sittings numbered by where they now sit — drag "1 of 3" after "3 of 3" and the three close up
   * around it. Saved sittings this week join the numbering alongside the proposals, since a split
   * is usually half on the calendar and half still proposed; only the proposals' numbers change
   * here, and Accept writes the saved siblings' new numbers back (`acceptProposals`).
   */
  // Only splits that still have a proposal: a split that is wholly on the calendar has nothing here
  // that could move, and renumbering it on the grid alone would disagree with what the day view
  // shows — a tray-dropped "1 of 7" with six sittings still unplanned would lose its number.
  const proposedGroups = new Set(movedProposals.flatMap((p) => (p.chunk ? [p.chunk.groupId] : [])));
  const savedSittings = weekDateKeys.flatMap((dateKey) =>
    (claimedSlotsByDate[dateKey] ?? []).filter((slot) => slot.chunk && proposedGroups.has(slot.chunk.groupId)).map((slot) => ({ ...slot, dateKey }))
  );
  const numberedSittings = renumberSittings<SittingEntry & { slot?: ScheduleSlot & { dateKey: string }; proposal?: WeekProposal }>([
    ...savedSittings.map((slot) => ({ dateKey: slot.dateKey, startTime: slot.startTime, title: slot.title, chunk: slot.chunk, slot })),
    ...movedProposals.map((p) => ({ dateKey: p.dateKey, startTime: p.startTime, title: p.title, chunk: p.chunk, placed: p.fits, sittingBase: p.sittingBase, proposal: p }))
  ]);
  const proposalNumbering = new Map(numberedSittings.filter((e) => e.proposal).map((e) => [e.proposal!.key, e]));
  /** Saved sittings whose number no longer matches where they sit, by slot id. */
  const renumberedSaved = new Map(
    numberedSittings
      .filter((e) => e.slot && (e.title !== e.slot.title || e.chunk?.index !== e.slot.chunk?.index || e.chunk?.total !== e.slot.chunk?.total))
      .map((e) => [e.slot!.id, e])
  );
  const effectiveProposals: WeekProposal[] = movedProposals.map((p) => {
    const numbered = proposalNumbering.get(p.key);
    if (!numbered || (numbered.title === p.title && numbered.chunk === p.chunk)) return p;
    const { chunk: _chunk, ...rest } = p;
    return { ...rest, title: numbered.title, ...(numbered.chunk ? { chunk: numbered.chunk } : {}) };
  });
  /** The grid's locked layer, with saved sittings shown under their current number. */
  const gridFixedSlotsByDate: Record<string, ScheduleSlot[]> = Object.fromEntries(
    weekDateKeys.map((dateKey) => [
      dateKey,
      (claimedSlotsByDate[dateKey] ?? []).map((slot) => {
        const numbered = renumberedSaved.get(slot.id);
        return numbered ? withSittingNumber(slot, numbered) : slot;
      })
    ])
  );
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

  /** plan/17 §6.3 — the pin control a reading sitting's row offers: Open, or any paper being read. */
  function pinPropsFor(p: WeekProposal) {
    const ref = p.objectiveRef;
    if (p.type !== "reading" || (ref?.kind !== "readingHabit" && ref?.kind !== "paper")) return {};
    return {
      pinOptions: pinnablePapers.map((paper) => {
        const passNo = nextReadingPass(paper);
        return { value: paper.id, label: `${passNo ? `${PASS_LABELS[passNo]}: ` : ""}${paper.title}` };
      }),
      pinValue: ref.kind === "paper" ? ref.id : "",
      onPin: (key: string, paperId: string | null) => setPinOverrides((current) => ({ ...current, [key]: paperId }))
    };
  }

  /** What "Accept all" takes: every proposal with a position that `placementProblem` has nothing to say about. */
  const acceptableProposals = undecidedProposals.filter((p) => p.fits && !placementProblem(p));

  /** plan/17 §7.4 — the replan as a diff, for the preview. */
  const diff = replan ? replanDiff(released, undecidedProposals) : null;

  /**
   * plan/17 §7.1 — sittings behind you this week that got under 60% of their length (the completion
   * rule, `sittingOutcome`), so the nudge can say what a replan would recover.
   */
  const missedSittings = committed && weekIsCurrent
    ? schedules
        .filter((schedule) => weekDateKeys.includes(schedule.dateKey) && schedule.dateKey <= todayK)
        .flatMap((schedule) =>
          schedule.slots.filter(
            (slot) =>
              isPlannerMade(slot, weekStart) &&
              (schedule.dateKey < todayK || minutesFromTime(slot.endTime) <= now.minutes) &&
              sittingOutcome(slot, sessions.filter((session) => session.completedAt.startsWith(schedule.dateKey))) !== "closed"
          )
        ).length
    : 0;

  function startReplan(reason: ReplanState["reason"]) {
    setPlacements({});
    setPlacementNotes({});
    setPinOverrides({});
    setDayOffNudge(null);
    setReplan({ reason, keepMoves: true, resetDismissals: false });
  }

  /** plan/17 §7.4/§7.6 — writes the replan day by day, then records it in the plan's history. */
  async function acceptReplan() {
    if (!replan) return;
    const ok = await acceptProposals(acceptableProposals, released);
    if (!ok) return;
    await patchPlan({
      proposedBlocks: effectiveProposals.map(({ fits, ...rest }) => rest),
      dismissedMinutes: replan.resetDismissals ? {} : storedDismissed,
      readingTarget,
      revisions: [
        ...(existingReview?.plan?.revisions ?? []),
        {
          at: new Date().toISOString(),
          reason: replan.reason,
          released: released.length,
          placed: acceptableProposals.length,
          keptMoves: acceptableProposals.filter((p) => keptMoveKeys.has(p.key)).length
        }
      ]
    });
    setReplan(null);
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
      dismissedMinutes: storedDismissed,
      ...(existingReview?.plan?.completedAt ? { completedAt: existingReview.plan.completedAt } : {}),
      // plan/17 — carried forward like every other plan field, or the next dismissal would erase them.
      ...(existingReview?.plan?.readingTarget ? { readingTarget: existingReview.plan.readingTarget } : {}),
      ...(existingReview?.plan?.revisions ? { revisions: existingReview.plan.revisions } : {}),
      ...patch
    };
    await saveWeeklyReviewFields(user.uid, weekStart, { plan: nextPlan });
  }

  async function acceptProposals(toAccept: WeekProposal[], release: ReleasedSlot[] = []): Promise<boolean> {
    if (!user) return false;
    setAcceptError("");
    setAccepting(true);
    try {
      const fitting = toAccept.filter((p) => p.fits);
      const byDate = new Map<string, WeekProposal[]>();
      for (const p of fitting) {
        if (!byDate.has(p.dateKey)) byDate.set(p.dateKey, []);
        byDate.get(p.dateKey)!.push(p);
      }
      // Accepting a sitting fixes its number onto a day, so its saved siblings take their current
      // numbers too — otherwise the day view would show the old "1 of 3" beside the new one. Only
      // the splits being accepted into; nothing else on the calendar is rewritten.
      const acceptedGroups = new Set(fitting.flatMap((p) => (p.chunk ? [p.chunk.groupId] : [])));
      const siblingUpdates = [...renumberedSaved.values()].filter((e) => e.slot!.chunk && acceptedGroups.has(e.slot!.chunk.groupId));
      for (const e of siblingUpdates) if (!byDate.has(e.dateKey)) byDate.set(e.dateKey, []);
      // plan/17 §7.4 — a replan also writes the days its released sittings leave, including a day
      // whose sittings were all released and nothing new lands on.
      const releasedOn = new Map<string, Set<string>>();
      for (const item of release) {
        if (!releasedOn.has(item.dateKey)) releasedOn.set(item.dateKey, new Set());
        releasedOn.get(item.dateKey)!.add(item.slot.id);
        if (!byDate.has(item.dateKey)) byDate.set(item.dateKey, []);
      }
      const writes: { dateKey: string; templateId?: string; slots: ScheduleSlot[] }[] = [];
      for (const [dateKey, props] of byDate) {
        const savedSlots = schedules.find((s) => s.dateKey === dateKey)?.slots;
        if (!savedSlots && props.length === 0) continue;
        // A saved day gets its fixed commitments here too, so what is written matches the grid the
        // proposals were placed against (and an overlapping routine block steps aside, as it does there).
        const baseSlots = savedSlots ? withCommitments(savedSlots, commitmentSlotsForDate(recurringTemplates, dateKey, savedSlots)) : claimedSlotsForDate(dateKey);
        const releasedHere = releasedOn.get(dateKey);
        const existingSlots = baseSlots.filter((slot) => !releasedHere?.has(slot.id)).map((slot) => {
          const numbered = siblingUpdates.find((e) => e.slot!.id === slot.id && e.dateKey === dateKey);
          return numbered ? withSittingNumber(slot, numbered) : slot;
        });
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
          ...(p.plannedMinutes != null ? { plannedMinutes: p.plannedMinutes } : {}),
          // plan/17 §7.3 — a time set by hand (drag or typed) is remembered, so a replan can keep it.
          ...(placements[p.key] || keptMoveKeys.has(p.key) ? { placedByUser: true } : {})
        }));
        const merged = sortedSlots([...existingSlots, ...newSlots]);
        const errors = validateSlots(merged);
        if (errors.length > 0) {
          setAcceptError(`${dateKey}: ${errors[0]}`);
          return false;
        }
        writes.push({ dateKey, templateId: schedules.find((s) => s.dateKey === dateKey)?.templateId, slots: merged });
      }
      for (const w of writes) await saveDailySchedule(user.uid, w);
      // The accepted sittings leave the regenerated list and the rest close up, so positions keyed
      // by the old indices are moved with them rather than left on whatever inherits each key.
      const acceptedKeys = fitting.map((p) => p.key);
      setPlacements((current) => keyedAfterRemoval(current, acceptedKeys));
      setPlacementNotes((current) => keyedAfterRemoval(current, acceptedKeys));
      setPinOverrides((current) => keyedAfterRemoval(current, acceptedKeys));

      // No accept flag is written. The `ScheduleSlot` just saved onto the day *is* the record that
      // this work is planned, and every generator now subtracts what is on the calendar — so a second
      // record would only be a chance for the two to disagree, which is exactly what went wrong.
      return true;
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
    // The family regenerates one sitting shorter, the same as after an Accept.
    setPlacements((current) => keyedAfterRemoval(current, [p.key]));
    setPlacementNotes((current) => keyedAfterRemoval(current, [p.key]));
    setPinOverrides((current) => keyedAfterRemoval(current, [p.key]));
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
        // plan/17 §6.6 — this week's reading habit, snapshotted like `targets`.
        readingTarget,
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

  // plan/17 §6.5 — reading in Look back: sittings done against the habit, minutes, the streak, and
  // what happened to papers. Replaces "Stale papers (14d+)", the one reading signal there used to be.
  const priorReview = reviews.find((review) => review.weekStart === priorWeekStart);
  const readingTargetFor = (start: string): ReadingHabit =>
    reviews.find((review) => review.weekStart === start)?.plan?.readingTarget ?? habitDefault;
  const priorReadingTarget = readingTargetFor(priorWeekStart);
  const priorReading = readingHabitProgress(sessions, priorWeekDateKeys, priorReadingTarget);
  const readingStreak = readingWeeksStreak(sessions, weekStart <= todayK ? weekStart : priorWeekStart, readingTargetFor);
  const priorMoved = { read: 0, shelved: 0, dropped: 0 };
  for (const paper of papers) {
    const status = derivePaperStatus(paper);
    if ((status === "read" || status === "shelved" || status === "dropped") && priorWeekDateKeys.includes(lastStatusChangeAt(paper).slice(0, 10))) priorMoved[status] += 1;
  }
  const priorReplans = priorReview?.plan?.revisions?.length ?? 0;

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
        <div className="flex flex-wrap items-center gap-2">
          {committed && weekIsCurrent && !replan ? (
            <button className="btn-secondary" onClick={() => startReplan("manual")} title="Lay out the rest of this week again from now">
              Replan from today
            </button>
          ) : null}
          {replan ? (
            <button className="btn-secondary" onClick={() => setReplan(null)}>
              Cancel replan
            </button>
          ) : (
            <button className="btn-primary" onClick={commitWeek} disabled={committing}>
              {committing ? "Committing..." : committed ? "Re-commit" : "Commit"}
            </button>
          )}
        </div>
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
            <Stat
              label="Reading sittings"
              value={priorReadingTarget.sittings === 0 ? "0 planned" : `${Math.min(priorReading.sittings, priorReadingTarget.sittings)} / ${priorReadingTarget.sittings} · ${priorReading.minutes}m`}
            />
            <Stat label="Reading streak" value={`${readingStreak} wk`} />
            <Stat label="Papers finished · shelved · dropped" value={`${priorMoved.read} · ${priorMoved.shelved} · ${priorMoved.dropped}`} />
            {priorReplans > 0 ? <Stat label="Replanned" value={`×${priorReplans}`} /> : null}
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
                    onClick={() => {
                      if (!user) return;
                      if (dayOff) {
                        void clearDayOff(user.uid, d);
                        return;
                      }
                      void setDayOff(user.uid, d);
                      // plan/17 §7.1 — a day off that held accepted sittings: offer to replan them.
                      const held = (schedules.find((schedule) => schedule.dateKey === d)?.slots ?? []).some((slot) => isPlannerMade(slot, weekStart) && slot.status === "upcoming");
                      if (committed && weekIsCurrent && d >= todayK && held) setDayOffNudge(d);
                    }}
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
                      <p key={t.id} className="truncate rounded bg-sky-500/10 px-1 py-0.5 text-sky-700 dark:text-sky-300">
                        {isFixedCommitment(t) ? `${t.time!.startTime} ${t.title}` : t.title}
                      </p>
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
                      <button className="btn-secondary px-2 py-1" onClick={() => removeUpcoming(row.id)} disabled={frozen}>
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
                        disabled={frozen}
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
                      disabled={frozen}
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
                      disabled={frozen}
                      onChange={(time) => setUpcomingDrafts((current) => ({ ...current, [row.id]: { ...current[row.id], startTime: time } }))}
                    />
                    <button className="btn-secondary px-2 py-1" onClick={() => addUpcoming(row)} disabled={frozen}>
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

        <div className="mt-5 rounded-md border border-ink-200 p-3 dark:border-ink-800">
          <p className="label mb-2 inline-flex items-center gap-1">Reading habit</p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <input
              type="number"
              min={0}
              max={14}
              className="input w-16 py-1"
              aria-label="Reading sittings this week"
              value={readingTarget.sittings}
              onChange={(e) => editHabit({ sittings: Math.max(0, Math.min(14, Math.round(Number(e.target.value)))) })}
            />
            <span>sittings ×</span>
            <input
              type="number"
              min={chunkOpts.minChunkMinutes}
              max={chunkOpts.maxChunkMinutes}
              step={5}
              className="input w-16 py-1"
              aria-label="Minutes per reading sitting"
              value={readingTarget.minutes}
              onChange={(e) => editHabit({ minutes: Math.max(chunkOpts.minChunkMinutes, Math.min(chunkOpts.maxChunkMinutes, Math.round(Number(e.target.value)))) })}
            />
            <span>min</span>
            <select
              className="input w-36 py-1 text-xs"
              aria-label="Preferred time of day for reading"
              value={readingTarget.timeOfDay ?? ""}
              onChange={(e) => editHabit({ timeOfDay: (e.target.value || undefined) as ReadingHabit["timeOfDay"] })}
            >
              <option value="">Any time</option>
              <option value="morning">Mornings</option>
              <option value="afternoon">Afternoons</option>
              <option value="evening">Evenings</option>
            </select>
            <span className="flex gap-0.5" role="group" aria-label="Preferred reading days">
              {DAY_LABELS.map((label, i) => {
                const dow = (i + 1) % 7;
                const on = readingTarget.preferredDays?.includes(dow) ?? false;
                return (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={on}
                    className={`rounded px-1.5 py-0.5 text-[11px] ${on ? "bg-moss-600 text-white" : "bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300"}`}
                    onClick={() => {
                      const days = new Set(readingTarget.preferredDays ?? []);
                      if (on) days.delete(dow);
                      else days.add(dow);
                      editHabit({ preferredDays: days.size > 0 ? [...days].sort() : undefined });
                    }}
                  >
                    {label.slice(0, 2)}
                  </button>
                );
              })}
            </span>
          </div>
          <p className="mt-2 text-xs text-ink-500">
            {readingTarget.sittings === 0
              ? "No reading this week — a deliberate 0, shown as such in next week's look back."
              : `Reading is planned as sittings, at most one a day until every working day has one. Papers owed a pass are pinned first; the rest stay open and you pick what to read when the sitting starts.`}
            {habitDraft ? " This week only until you commit." : ""}
          </p>
          {habit.alsoOwed.length > 0 ? (
            <div className="mt-2 text-xs text-ink-500">
              Also owed, beyond this week&apos;s sittings:
              {habit.alsoOwed.map((item) => (
                <span key={item.paperId} className="ml-2 inline-flex items-center gap-1">
                  {PASS_LABELS[item.passNo]} · {item.title} ({item.minutes}m)
                  <button className="underline" onClick={() => editHabit({ sittings: readingTarget.sittings + Math.ceil(item.minutes / habit.sittingMinutes) })} disabled={frozen}>
                    +{Math.ceil(item.minutes / habit.sittingMinutes)} sitting{Math.ceil(item.minutes / habit.sittingMinutes) === 1 ? "" : "s"}
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {(readingTarget.sittings !== habitDefault.sittings ||
            readingTarget.minutes !== habitDefault.minutes ||
            readingTarget.timeOfDay !== habitDefault.timeOfDay ||
            (readingTarget.preferredDays ?? []).join() !== (habitDefault.preferredDays ?? []).join()) ? (
            <button
              className="btn-secondary mt-2 px-2 py-1 text-xs"
              onClick={() =>
                updateSettings({
                  readingHabit: {
                    ...settings.readingHabit,
                    sittings: readingTarget.sittings,
                    minutes: readingTarget.minutes,
                    preferredDays: readingTarget.preferredDays,
                    timeOfDay: readingTarget.timeOfDay
                  }
                })
              }
            >
              Make this my default
            </button>
          ) : null}
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
                            disabled={frozen}
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
            {totals.over > 0 ? `, less ${formatHours(totals.over)} placed beyond what was asked` : ""}. Placed means worked, on days behind
            you, or planned, from today on — a sitting you missed comes back here to place again. A course&apos;s hours include its tasks due
            this week.
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
        {/* Only when there's something to recover: missed time already re-placed (an Accept after it
            was missed) makes the nudge noise. */}
        {!replan && committed && weekIsCurrent && ((missedSittings > 0 && totals.toPlace > 0) || dayOffNudge) ? (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <span className="flex-1">
              {dayOffNudge
                ? `${DAY_LABELS[weekDateKeys.indexOf(dayOffNudge)]} is now a day off, and it held sittings you'd accepted.`
                : `${missedSittings} sitting${missedSittings === 1 ? "" : "s"} behind you this week got less than 60% of its time.`}{" "}
              Replanning lays the rest of the week out again from now.
            </span>
            <button className="btn-primary py-1.5 text-xs" onClick={() => startReplan(dayOffNudge ? "dayOff" : "missed")}>
              Replan from today
            </button>
            {dayOffNudge ? (
              <button className="text-xs text-ink-500 underline" onClick={() => setDayOffNudge(null)}>
                Not now
              </button>
            ) : null}
          </div>
        ) : null}
        {replan ? (
          liveDateKeys.length === 0 ? (
            <div className="mb-3 rounded-md border border-ink-200 p-3 text-sm dark:border-ink-800">
              Nothing left to replan this week —{" "}
              <Link href={`/plan/week?week=${addDaysToKey(weekStart, 7)}`} className="underline">
                plan next week
              </Link>
              .
            </div>
          ) : (
            <div className="mb-3 space-y-2 rounded-md border border-moss-600/50 bg-moss-600/5 p-3 text-sm">
              <p className="font-medium">Replanning from now</p>
              <p className="text-xs text-ink-500">
                {(() => {
                  const stay = diff ? diff.moved.filter(({ from, to }) => from.dateKey === to.dateKey && from.slot.startTime === to.startTime).length : 0;
                  const move = diff ? diff.moved.length - stay : 0;
                  return `${released.length} unstarted sitting${released.length === 1 ? "" : "s"} from now on re-placed: ${stay} stay where they are, ${move} move${
                    diff && diff.added.length > 0 ? `, ${diff.added.length} new` : ""
                  }${diff && diff.dropped.length > 0 ? `, ${diff.dropped.length} no longer owed` : ""}. `;
                })()}
                Time missed earlier this week is counted back in. Blocks you added yourself, classes, routine, commitments and anything you&apos;ve
                worked are never touched. Nothing is written until you accept.
              </p>
              {diff ? (
                <ul className="space-y-0.5 text-xs">
                  {diff.moved.map(({ from, to }) => {
                    const same = from.dateKey === to.dateKey && from.slot.startTime === to.startTime;
                    return (
                      <li key={`m:${from.slot.id}`}>
                        {same ? "Kept" : "Moved"} · {from.slot.title} ·{" "}
                        {same
                          ? `${DAY_LABELS[weekDateKeys.indexOf(to.dateKey)]} ${to.startTime}`
                          : `${DAY_LABELS[weekDateKeys.indexOf(from.dateKey)]} ${from.slot.startTime} → ${DAY_LABELS[weekDateKeys.indexOf(to.dateKey)]} ${to.startTime}`}
                      </li>
                    );
                  })}
                  {diff.added.map((p) => (
                    <li key={`a:${p.key}`}>
                      New · {p.title} · {DAY_LABELS[weekDateKeys.indexOf(p.dateKey)]} {p.startTime}
                    </li>
                  ))}
                  {diff.dropped.map((item) => (
                    <li key={`d:${item.slot.id}`} className="text-ink-500">
                      Removed · {item.slot.title} · no longer owed this week
                    </li>
                  ))}
                  {diff.unplaced.map((p) => (
                    <li key={`u:${p.key}`} className="text-amber-700 dark:text-amber-400">
                      Didn&apos;t fit · {p.title} · {p.durationMinutes}m
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex flex-wrap items-center gap-4 text-xs">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={replan.keepMoves} onChange={(e) => setReplan({ ...replan, keepMoves: e.target.checked })} />
                  Keep sittings where they are when their time still works (off: lay everything out again)
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={replan.resetDismissals} onChange={(e) => setReplan({ ...replan, resetDismissals: e.target.checked })} />
                  Reset dismissals
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn-primary py-1.5 text-xs" onClick={acceptReplan} disabled={accepting}>
                  {accepting ? "Replanning..." : `Accept replan · ${acceptableProposals.length} sitting${acceptableProposals.length === 1 ? "" : "s"}`}
                </button>
                <button className="btn-secondary py-1.5 text-xs" onClick={() => setReplan(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )
        ) : null}
        {!replan && acceptableProposals.length > 0 ? (
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <button className="btn-primary" onClick={() => acceptProposals(acceptableProposals)} disabled={accepting || frozen}>
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
        {backlogTasks.length > 0 ? (
          <div className="mb-4 space-y-1">
            <p className="label mb-1 inline-flex items-center gap-1">
              Target a day (optional)
              <InfoHint term="weeklyTargetDay" />
            </p>
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
            fixedSlotsByDate={gridFixedSlotsByDate}
            proposals={undecidedProposals.filter((p) => p.fits)}
            onPlace={applyPlacement}
            disabled={accepting || frozen}
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
                        disabled={accepting || frozen}
                        chip={chipForProposal(p)}
                        invalidReason={placementProblem(p)}
                        notice={placementNotes[p.key]}
                        maxMinutes={chunkOpts.maxChunkMinutes}
                        suggestStart={suggestStartOn}
                        {...pinPropsFor(p)}
                        hideAccept={Boolean(replan)}
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
                    disabled={accepting || frozen}
                    chip={chipForProposal(p)}
                    invalidReason={placementProblem(p)}
                    notice={placementNotes[p.key]}
                    maxMinutes={chunkOpts.maxChunkMinutes}
                    suggestStart={suggestStartOn}
                    {...pinPropsFor(p)}
                    hideAccept={Boolean(replan)}
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
