"use client";

import { getDay, parseISO } from "date-fns";
import { orderBy, where } from "firebase/firestore";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { InfoHint } from "@/components/info-hint";
import { ModuleGate } from "@/components/module-gate";
import { SectionHeader } from "@/components/section-header";
import { useAuth } from "@/components/auth-provider";
import { useCourseCheckpoints } from "@/hooks/use-course-checkpoints";
import { useUserCollection } from "@/hooks/use-user-collection";
import { useUserSettings } from "@/hooks/use-user-settings";
import { averageFocusRating } from "@/lib/analytics";
import { bucketWeeklyTarget, completedMinutesThisWeek, courseSlotsForDate, effectiveCourseStatus, scheduledMinutesThisWeek, syncRevisionTemplate } from "@/lib/courses";
import { addDaysToKey, todayKey, weekDates, weekStartKey } from "@/lib/dates";
import { clearDayOff, fetchCourseClassLogs, saveDailySchedule, saveWeeklyReviewFields, setDayOff, updateCourse, updateGoal, updatePaper, updateTask } from "@/lib/firestore";
import { isGoalActiveForDate } from "@/lib/goals";
import { computeDebtHours, computeLoadIndexStreak, loadIndexBand, loadIndexBandLabels, loadIndexBandStyles } from "@/lib/loadindex";
import { taskBucketLabels } from "@/lib/options";
import { DEFAULT_MAX_REVISIONS_PER_DAY, DEFAULT_MAX_REVISION_MINUTES_PER_DAY, estimatedReviewMinutes } from "@/lib/revision";
import { isTemplateDueOn } from "@/lib/recurring-tasks";
import { DEFAULT_ROUTINE_BLOCKS, routineSlotsForDate } from "@/lib/routine";
import { sortedSlots, validateSlots } from "@/lib/schedule";
import { isBreakMode } from "@/lib/terms";
import { taskBlockMinutes } from "@/lib/timeline";
import {
  DEFAULT_WORKING_WINDOW,
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
  Task,
  TaskBucket,
  Term,
  WeeklyReview,
  WeekPlan
} from "@/types";

const COURSE_BUCKETS: TaskBucket[] = ["revision", "assignment", "backlog"];
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
      result.push({ title, type, durationMinutes: minutes, dateKey: d, ...extra });
      remaining -= minutes;
    }
    return result;
  }

  const candidates: WeekProposalCandidate[] = [];
  for (const cp of prepCheckpoints) {
    const windowDays = weekDateKeys.filter((d) => d >= addDaysToKey(cp.dueAt, -cp.prepLeadDays) && d < cp.dueAt && !offDateKeys.has(d));
    const perDay = Math.max(15, Math.ceil(cp.prepEstimateMin / Math.max(1, cp.prepLeadDays)));
    let remaining = cp.prepEstimateMin;
    for (const d of windowDays) {
      if (remaining <= 0) break;
      const minutes = Math.min(perDay, remaining);
      candidates.push({ title: `Prep: ${cp.title}`, type: "deep_work", durationMinutes: minutes, dateKey: d, refType: "checkpoint", refId: cp.id });
      remaining -= minutes;
    }
  }
  // plan/15 §5.2 #4 — assignment first: it has no day preference of its own, so it should fill in
  // around the days revision/backlog have already claimed via their preferences below, not the
  // reverse (today's order let assignment's floating chunks take first pick of every day).
  for (const course of activeCourses) {
    const target = hoursFor(course, "assignment");
    const alreadyScheduled = scheduledMinutesThisWeek(tasks, course.id, "assignment", workMinutes, weekDateKeys);
    const chunks = Math.round(Math.max(0, target - alreadyScheduled) / workMinutes);
    for (let i = 0; i < chunks; i += 1) {
      candidates.push({
        title: `${course.name} — ${taskBucketLabels.assignment}`,
        type: "deep_work",
        durationMinutes: workMinutes,
        courseId: course.id,
        bucket: "assignment",
        capGroup: `assignment:${course.id}`
      });
    }
  }
  // plan/15 §5.2 #3 — revision prefers the course's own lecture days this week (reviewing material
  // near the class it came from), falling back to the general search when the course has none
  // materializing this week (mid-break, or an async course with no `CourseSession` at all) — see
  // plan/15 §8's open question on whether that should differ from a course with literally no
  // sessions; for now both cases fall through identically.
  for (const course of activeCourses) {
    const target = hoursFor(course, "revision");
    const alreadyScheduled = scheduledMinutesThisWeek(tasks, course.id, "revision", workMinutes, weekDateKeys);
    const chunks = Math.round(Math.max(0, target - alreadyScheduled) / workMinutes);
    const lectureDays = weekDateKeys.filter((d) => !isBreakMode(terms, d) && courseSlotsForDate([course], d).length > 0);
    for (let i = 0; i < chunks; i += 1) {
      candidates.push({
        title: `${course.name} — ${taskBucketLabels.revision}`,
        type: "deep_work",
        durationMinutes: workMinutes,
        courseId: course.id,
        bucket: "revision",
        preferredDateKeys: lectureDays.length > 0 ? lectureDays : undefined,
        capGroup: `revision:${course.id}`
      });
    }
  }
  if (revisionQueueMinutesPerDay > 0) {
    for (const d of weekDateKeys.slice(0, 5).filter((d) => !offDateKeys.has(d))) {
      candidates.push({ title: "Review revisions", type: "deep_work", durationMinutes: revisionQueueMinutesPerDay, dateKey: d, refType: "revision" });
    }
  }
  // plan/15 §5.2 #3 — backlog (both the bucket and undated tasks) prefers the weekend, the same
  // "leftover work last" instinct a person planning by hand already has.
  const weekend = [weekDateKeys[5], weekDateKeys[6]];
  for (const course of activeCourses) {
    const target = hoursFor(course, "backlog");
    const alreadyScheduled = scheduledMinutesThisWeek(tasks, course.id, "backlog", workMinutes, weekDateKeys);
    const chunks = Math.round(Math.max(0, target - alreadyScheduled) / workMinutes);
    for (let i = 0; i < chunks; i += 1) {
      candidates.push({
        title: `${course.name} — ${taskBucketLabels.backlog}`,
        type: "deep_work",
        durationMinutes: workMinutes,
        courseId: course.id,
        bucket: "backlog",
        preferredDateKeys: weekend,
        capGroup: `backlog:${course.id}`
      });
    }
  }
  const backlogTasks = tasks.filter((task) => task.status !== "done" && (!task.dueDate || task.dueDate < weekStart));
  for (const task of backlogTasks) {
    const duration = taskBlockMinutes(task, workMinutes);
    if (task.weeklyTargetDay != null) {
      candidates.push(...leadTimeCandidates(task.title, "deep_work", duration, task.weeklyTargetDay, { taskId: task.id }));
    } else {
      // plan/15 — every undated backlog task shares one cap pool: many small individual tasks
      // piling onto the same emptiest day is the exact §2.2 failure mode, just with tasks instead
      // of a single heavy bucket, so they still need to compete for one shared per-day allowance.
      candidates.push({ title: task.title, type: "deep_work", durationMinutes: duration, taskId: task.id, preferredDateKeys: weekend, capGroup: "backlog-tasks" });
    }
  }
  const stalePapers = papers
    .filter((paper) => paper.status === "reading")
    .map((paper) => ({ ...paper, daysSinceUpdate: Math.round((new Date(todayK).getTime() - new Date(paper.updatedAt).getTime()) / 86_400_000) }))
    .filter((paper) => paper.daysSinceUpdate > 14)
    .sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate)
    .slice(0, 3);
  for (const paper of stalePapers) {
    if (paper.weeklyTargetDay != null) {
      candidates.push(...leadTimeCandidates(`Read: ${paper.title}`, "reading", 45, paper.weeklyTargetDay, { refId: paper.id }));
    } else {
      candidates.push({ title: `Read: ${paper.title}`, type: "reading", durationMinutes: 45, refId: paper.id, capGroup: "papers" });
    }
  }

  const freshProposals = placeProposals(candidates, weekDateKeys, claimedSlotsByDate, workingWindow, offDateKeys);
  const proposals: WeekProposal[] = committed
    ? (existingReview!.plan!.proposedBlocks.map((p, index) => ({ ...p, key: `${index}`, fits: true })) as WeekProposal[])
    : freshProposals;

  const [decisions, setDecisions] = useState<Record<string, ProposalDecision>>({});
  useEffect(() => {
    setDecisions(existingReview?.plan?.blockDecisions ?? {});
     
  }, [weekStart, existingReview?.plan?.blockDecisions]);

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
        const newSlots: ScheduleSlot[] = props.map((p) => ({
          id: crypto.randomUUID(),
          title: p.title,
          type: p.type,
          startTime: p.startTime,
          endTime: p.endTime,
          status: "upcoming",
          ...(p.courseId ? { courseId: p.courseId } : {}),
          ...(p.bucket ? { bucket: p.bucket } : {}),
          ...(p.taskId ? { assignedTaskIds: [p.taskId] } : {})
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
        proposedBlocks: proposals.map(({ key, fits, ...rest }) => rest),
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

  const workingByDate = new Map(candidatesGroupedByDate(proposals));

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

      <section className="card mb-6 max-w-5xl p-5">
        <h2 className="mb-3 text-base font-semibold">4. Assign the week</h2>
        {acceptError ? <p className="mb-2 text-sm text-red-600">{acceptError}</p> : null}
        <div className="mb-3">
          <button className="btn-primary" onClick={() => acceptProposals(proposals)} disabled={accepting || committed}>
            {accepting ? "Accepting..." : "Accept all"}
          </button>
        </div>
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
        <div className="space-y-4">
          {weekDateKeys.map((d, i) => {
            const dayProposals = (workingByDate.get(d) ?? []).filter((p) => p.fits);
            if (dayProposals.length === 0) return null;
            return (
              <div key={d}>
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-sm font-medium">{DAY_LABELS[i]} {d.slice(5)}</p>
                  <button className="btn-secondary px-2 py-1 text-xs" onClick={() => acceptProposals(dayProposals)} disabled={accepting || committed}>
                    Accept day
                  </button>
                </div>
                <div className="space-y-1">
                  {dayProposals.map((p) => (
                    <div key={p.key} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-ink-50 px-3 py-2 text-xs dark:bg-ink-800">
                      <span>
                        {p.startTime}–{p.endTime} · {p.title}
                      </span>
                      <div className="flex items-center gap-2">
                        {decisions[p.key] ? (
                          <span className="text-ink-500">{decisions[p.key]}</span>
                        ) : (
                          <>
                            <button className="btn-secondary px-2 py-1" onClick={() => acceptProposals([p])} disabled={accepting || committed}>
                              Accept
                            </button>
                            <button className="btn-secondary px-2 py-1" onClick={() => dismissProposal(p)} disabled={accepting || committed}>
                              Dismiss
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {proposals.some((p) => !p.fits) ? (
          <div className="mt-4">
            <p className="label mb-1">Didn&apos;t fit</p>
            <div className="space-y-1">
              {proposals
                .filter((p) => !p.fits)
                .map((p) => (
                  <p key={p.key} className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                    {p.title} — no free gap of {p.durationMinutes}m inside the working window.
                  </p>
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

function candidatesGroupedByDate(proposals: WeekProposal[]): [string, WeekProposal[]][] {
  const map = new Map<string, WeekProposal[]>();
  for (const p of proposals) {
    if (!map.has(p.dateKey)) map.set(p.dateKey, []);
    map.get(p.dateKey)!.push(p);
  }
  return Array.from(map.entries());
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
