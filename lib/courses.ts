import { getDay, parseISO } from "date-fns";
import { sessionDayKey, sessionSlotDayKey, weekDates, weekStartKey } from "@/lib/dates";
import { minutesFromTime, sortedSlots } from "@/lib/schedule";
import { isBreakMode } from "@/lib/terms";
import { slotCoverageMinutes } from "@/lib/tracking";
import type {
  Course,
  CourseStatus,
  DailySchedule,
  Goal,
  PomodoroSession,
  RecurringTaskTemplate,
  ScheduleSlot,
  SlotObjectiveRef,
  Task,
  TaskBucket,
  Term
} from "@/types";

/** `status` as stored can go stale (nobody flips it when a course's end date passes) — derive the real one. */
export function effectiveCourseStatus(course: Course, dateKey: string): CourseStatus {
  if (course.status === "dropped") return "dropped";
  if (course.endDate && dateKey > course.endDate) return "completed";
  return course.status;
}

/**
 * plan/16 — whether this task belongs to a course that has been dropped.
 *
 * `effectiveCourseStatus` was only ever consulted where *courses* are iterated, so a task was never
 * checked against its own course's status. A dropped course's tasks therefore kept flowing into
 * every surface that proposes work — the weekly planner's candidates, "What's coming", Up next, the
 * day's task tray — which is the "dropped course's tasks still showing" reported in use.
 *
 * Deliberately only `dropped`, not `completed`. Dropping a course is a statement that its work is
 * not going to happen; a course simply having ended can still leave a real task with a real deadline
 * (a final report handed in after the last lecture), and refusing to plan that would be wrong.
 *
 * Also deliberately a *filter for suggestions*, never a reason to hide a task on `/tasks`: the task
 * still exists and is still the user's, so it stays visible and labelled there. Silently vanishing
 * work is how you end up not trusting the list.
 */
export function isFromDroppedCourse(task: Pick<Task, "courseId">, courses: Pick<Course, "id" | "status">[]): boolean {
  if (!task.courseId) return false;
  return courses.find((course) => course.id === task.courseId)?.status === "dropped";
}

/** The tasks a planning surface should consider — everything except a dropped course's. */
export function plannableTasks<T extends Pick<Task, "courseId">>(tasks: T[], courses: Pick<Course, "id" | "status">[]): T[] {
  return tasks.filter((task) => !isFromDroppedCourse(task, courses));
}

/**
 * Courses grouped by the term they belong to, latest term first, for showing a course list semester by
 * semester. Courses without a term, or whose term was deleted, come last in one group.
 */
export function coursesByTerm<T extends Pick<Course, "termId">>(courses: T[], terms: Term[]): { term?: Term; courses: T[] }[] {
  const ordered = [...terms].sort((a, b) => b.startDate.localeCompare(a.startDate));
  const groups = ordered.map((term) => ({ term, courses: courses.filter((course) => course.termId === term.id) })).filter((group) => group.courses.length > 0);
  const loose = courses.filter((course) => !ordered.some((term) => term.id === course.termId));
  return loose.length > 0 ? [...groups, { courses: loose }] : groups;
}

export function courseSlotsForDate(courses: Course[], dateKey: string): ScheduleSlot[] {
  const dayOfWeek = getDay(parseISO(dateKey));
  const slots: ScheduleSlot[] = [];
  for (const course of courses) {
    if (effectiveCourseStatus(course, dateKey) !== "active") continue;
    if (course.startDate && dateKey < course.startDate) continue;
    if (course.endDate && dateKey > course.endDate) continue;
    for (const session of course.sessions) {
      if (session.dayOfWeek !== dayOfWeek) continue;
      slots.push({
        id: `course-${course.id}-${session.id}`,
        title: course.code ? `${course.code} · ${course.name}` : course.name,
        type: "class",
        startTime: session.startTime,
        endTime: session.endTime,
        note: session.location,
        status: "upcoming",
        color: course.color,
        // plan/14 §6.1 — lets a class block credit its course (Class time, §6.3) without matching
        // on the title string. Not paired with a `bucket`: class time isn't a planned bucket.
        courseId: course.id
      });
    }
  }
  return slots;
}

export const dayOfWeekLabels = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** This week's Mon-Sun date keys — the same window `lib/dates.ts`'s `currentWeekDays`/`lib/analytics.ts`'s `weeklyPomodoros` already use — the default "this week" for every bucket total below. */
export function currentWeekDateKeys(date = new Date()): string[] {
  return weekDates(weekStartKey(date));
}

/**
 * A course's weekly target for one of its four planning buckets (goal/assignment/backlog/revision
 * — TaskBucket, distinct from Task.category). "Revision" keeps reading the pre-existing
 * `targetMinutesPerWeek` unchanged (still what `planRevisionTemplateSync`/`courseTargetMinutesForDay`
 * read), so nothing about the existing revision-template sync above changes. "Goal" has no stored
 * target on the course at all — it's derived from whichever Goals are linked to this course, so a
 * goal's own weekly-hours target (set once, on the Goal) never drifts out of sync with a second
 * number kept here.
 */
export function bucketWeeklyTarget(
  course: Pick<Course, "targetMinutesPerWeek" | "weeklyTargets">,
  bucket: TaskBucket,
  linkedGoals: Pick<Goal, "targetHoursPerWeek" | "linked">[]
): number {
  if (bucket === "revision") return course.targetMinutesPerWeek ?? 0;
  // plan/13 B5 — a goal's hours are shown once per linked course (not divided), so a 10h/week goal
  // linked to 3 courses read as "10h/week" on each, easily mistaken for 30h total. Split evenly
  // across however many courses that goal is linked to (`lib/goals.ts`'s `goalTargetMinutesForDay`
  // already sums each goal only once, globally, for Workload — this only changes the per-course
  // display, not the actual workload total).
  if (bucket === "goal") {
    return linkedGoals.reduce((sum, goal) => sum + ((goal.targetHoursPerWeek ?? 0) * 60) / Math.max(1, goal.linked.courseIds.length), 0);
  }
  return course.weeklyTargets?.[bucket] ?? 0;
}

type BucketedTask = Pick<Task, "id" | "courseId" | "bucket" | "dueDate" | "estimatedPomodoros" | "completedPomodoros">;

function tasksDueThisWeek(tasks: BucketedTask[], courseId: string, bucket: TaskBucket, weekDateKeys: string[]): BucketedTask[] {
  return tasks.filter((task) => task.courseId === courseId && task.bucket === bucket && task.dueDate && weekDateKeys.includes(task.dueDate));
}

/**
 * Minutes "scheduled" this week for one course/bucket: every task due this week in that bucket,
 * sized the same way `lib/timeline.ts`'s `taskBlockMinutes` sizes a dropped-in task
 * (estimatedPomodoros × workMinutes, defaulting to one pomodoro). Includes done tasks — "scheduled"
 * is what was planned for the week, not what's still open.
 */
export function scheduledMinutesThisWeek(
  tasks: BucketedTask[],
  courseId: string,
  bucket: TaskBucket,
  workMinutes: number,
  weekDateKeys: string[] = currentWeekDateKeys()
): number {
  return tasksDueThisWeek(tasks, courseId, bucket, weekDateKeys).reduce((sum, task) => sum + (task.estimatedPomodoros ?? 1) * workMinutes, 0);
}

/**
 * plan/16 §5.8 — minutes *already placed on a day* this week for one course/bucket, summed from the
 * real `ScheduleSlot`s on that week's schedules.
 *
 * This is the missing half of `scheduledMinutesThisWeek` above, and the fix for plan/16 §2.2's bug:
 * accepting a weekly-planner proposal writes a `ScheduleSlot` carrying `courseId`/`bucket`, never a
 * `Task`, so the task-based count above could not see accepted work at all. Step 4 therefore
 * subtracted nothing after an accept and re-proposed the identical set of chunks, with only
 * `blockDecisions` (keyed by a candidate's *array index*, so it re-targets the moment the candidate
 * list shifts) standing between the user and a duplicate.
 *
 * Measures the block's **real duration**, not its recorded `plannedMinutes`. That precedence was the
 * other way round and it made the number wrong in use: shortening an accepted block from 50 minutes
 * to 25 left the week still counting 50, so the freed 25 never came back as something to plan. The
 * two fields answer different questions — `plannedMinutes` is what the sitting was *intended* to
 * contribute, kept for display and for `WeekPlan.proposedBlocks`' record of what was committed;
 * this function asks what is *on the calendar now*, and for that the calendar is the only honest
 * source. Superseded note, kept for the history:
 * A slot's `plannedMinutes` wins over its own duration where present, so resizing a block on the
 * timeline after planning doesn't rewrite what the week was understood to have committed.
 */
/** A slot's real length on the day. See `plannedMinutesThisWeek` for why this, not `plannedMinutes`. */
function slotMinutes(slot: Pick<ScheduleSlot, "startTime" | "endTime">): number {
  return Math.max(0, minutesFromTime(slot.endTime) - minutesFromTime(slot.startTime));
}

/**
 * plan/17 §7.2 — the line between "behind you" and "still ahead", for the three `planned*` helpers
 * below. Without it they counted every slot on a week's days as placed — including a Monday sitting
 * you never worked — so missed work never came back as something to plan, and replanning a week had
 * nothing to replan.
 */
export interface PlanningCutoff {
  todayKey: string;
  /** Minutes since midnight now. A sitting today whose end has passed counts as behind you; one
   *  under way or later today still counts as planned. */
  nowMinutes: number;
  /** Every session that could cover a slot. Filtered to each slot's own date before use, because
   *  a recurring class/routine slot reuses one id on every date it materializes on. */
  sessions: Pick<PomodoroSession, "slotId" | "mode" | "minutes" | "completedAt">[];
}

/**
 * What one slot contributes to "placed": its real length while it's still ahead, or — once it's
 * behind you — only what was actually worked against it (`slotCoverageMinutes`, the same coverage the
 * 60% completion rule reads), never more than its length. No cutoff = the pre-plan/17 behaviour, the
 * slot's length wherever it is.
 */
export function accountedSlotMinutes(slot: Pick<ScheduleSlot, "id" | "startTime" | "endTime" | "rescheduledTo">, dateKey: string, cutoff?: PlanningCutoff): number {
  const length = slotMinutes(slot);
  // plan/20 §3 — a rescheduled original's work is its copy's; it counts only through what was logged in it.
  if (slot.rescheduledTo && !cutoff) return 0;
  if (!cutoff) return length;
  const behind = slot.rescheduledTo || dateKey < cutoff.todayKey || (dateKey === cutoff.todayKey && minutesFromTime(slot.endTime) <= cutoff.nowMinutes);
  if (!behind) return length;
  const sameDay = cutoff.sessions.filter((session) => sessionSlotDayKey(session) === dateKey);
  return Math.min(slotCoverageMinutes(slot, sameDay), length);
}

/** Every slot of the week's schedules, with the date it sits on. */
function slotsInWeek(schedules: Pick<DailySchedule, "dateKey" | "slots">[], weekDateKeys: string[]): { slot: ScheduleSlot; dateKey: string }[] {
  const inWeek = new Set(weekDateKeys);
  return schedules.filter((schedule) => inWeek.has(schedule.dateKey)).flatMap((schedule) => schedule.slots.map((slot) => ({ slot, dateKey: schedule.dateKey })));
}

export function plannedMinutesThisWeek(
  schedules: Pick<DailySchedule, "dateKey" | "slots">[],
  courseId: string,
  bucket: TaskBucket,
  weekDateKeys: string[] = currentWeekDateKeys(),
  cutoff?: PlanningCutoff
): number {
  return slotsInWeek(schedules, weekDateKeys)
    // Task-derived blocks are deliberately excluded. `scheduledMinutesThisWeek` above already counts
    // task-shaped work (via the task's own estimate), and `createTaskBlock` copies the task's
    // `courseId`/`bucket` onto the block it creates — so without this filter a course task that has
    // been dropped onto a day is counted by both functions and the bucket reads satisfied when it
    // isn't. The two pools have to stay disjoint or their sum lies, and they are separable by
    // construction: a planner-accepted *bucket* proposal carries no `assignedTaskIds` (bucket
    // candidates have no `taskId`), while every task-derived block does.
    .filter(({ slot }) => slot.courseId === courseId && slot.bucket === bucket && !slot.assignedTaskIds?.length)
    .reduce((sum, { slot, dateKey }) => sum + accountedSlotMinutes(slot, dateKey, cutoff), 0);
}

/**
 * plan/16 §5.1 — minutes already placed on a day this week for one *task*, the task-shaped sibling
 * of `plannedMinutesThisWeek` above.
 *
 * Without it, a task's sittings are re-proposed after being accepted: `remainingMinutes` subtracts
 * only *logged* session minutes, an undated backlog task doesn't change when its blocks are created,
 * and nothing else looks at the slots now carrying `assignedTaskIds: [task.id]` — so re-opening the
 * weekly planner offers all seven sittings again, and accepting twice duplicates them. That is
 * exactly the §2.2 bug this doc set out to fix, in its task form rather than its bucket form.
 */
export function plannedMinutesForTask(
  schedules: Pick<DailySchedule, "dateKey" | "slots">[],
  taskId: string,
  weekDateKeys: string[] = currentWeekDateKeys(),
  cutoff?: PlanningCutoff
): number {
  return slotsInWeek(schedules, weekDateKeys)
    .filter(({ slot }) => slot.assignedTaskIds?.includes(taskId))
    .reduce((sum, { slot, dateKey }) => sum + accountedSlotMinutes(slot, dateKey, cutoff), 0);
}

/**
 * How much of one task is already taken care of: every minute worked on it, plus the sittings still
 * ahead this week. A sitting behind you counts only through its sessions, which the first term
 * already holds, and one under way counts only its unworked rest, so no minute is counted twice.
 *
 * This replaced `max(logged, planned)`, which forgot the logged minutes as soon as anything was placed:
 * a 100-minute task with 25 worked offered 75, and once those 75 were accepted it offered 25 more, so
 * "Accept all" never emptied the list.
 */
export function taskMinutesAccounted(
  sessions: Pick<PomodoroSession, "mode" | "minutes" | "taskId" | "slotId" | "slotDateKey" | "completedAt">[],
  schedules: Pick<DailySchedule, "dateKey" | "slots">[],
  taskId: string,
  weekDateKeys: string[],
  cutoff: Pick<PlanningCutoff, "todayKey" | "nowMinutes">
): number {
  const logged = sessions.filter((session) => session.mode === "work" && session.taskId === taskId).reduce((sum, session) => sum + Math.max(0, session.minutes), 0);
  const counted = slotsInWeek(schedules, weekDateKeys)
    .filter(({ slot }) => slot.assignedTaskIds?.includes(taskId))
    .reduce((sum, { slot, dateKey }) => {
      const length = slotMinutes(slot);
      if (dateKey > cutoff.todayKey || (dateKey === cutoff.todayKey && minutesFromTime(slot.startTime) >= cutoff.nowMinutes)) return sum + length;
      // Worked against this sitting without naming the task (a block shared by two tasks): not in
      // `logged`, so counted here, through the block.
      const sameDay = sessions.filter((session) => sessionSlotDayKey(session) === dateKey);
      const unnamed = slotCoverageMinutes(slot, sameDay.filter((session) => session.taskId !== taskId));
      if (dateKey < cutoff.todayKey || minutesFromTime(slot.endTime) <= cutoff.nowMinutes) return sum + unnamed;
      // Under way: the rest of it is still ahead.
      return sum + Math.max(unnamed, length - slotCoverageMinutes(slot, sameDay));
    }, 0);
  return logged + counted;
}

type BucketedSession = Pick<PomodoroSession, "mode" | "minutes" | "completedAt" | "courseId" | "bucket" | "taskId">;

/**
 * Minutes actually done this week for one course/bucket — real `PomodoroSession.minutes` (plan/14
 * §6.4), not `Task.completedPomodoros × workMinutes` (a 6-minute session and a 25-minute session
 * used to add exactly the same amount; this is the fix for that). A session counts if it carries
 * `courseId`/`bucket` directly (set at finalize time by `FocusSessionProvider`, §6.2 — a block or a
 * course-tagged task started it) or, for a session that predates that field or was started with no
 * block context, if its `taskId` resolves to a task carrying them.
 */
export function completedMinutesThisWeek(
  sessions: BucketedSession[],
  tasks: BucketedTask[],
  courseId: string,
  bucket: TaskBucket,
  weekDateKeys: string[] = currentWeekDateKeys()
): number {
  const taskById = new Map(tasks.map((task) => [task.id, task] as const));
  return sessions.reduce((sum, session) => {
    if (session.mode !== "work") return sum;
    const dateKey = sessionDayKey(session);
    if (!weekDateKeys.includes(dateKey)) return sum;
    const linkedTask = session.taskId ? taskById.get(session.taskId) : undefined;
    const sessionCourseId = session.courseId ?? linkedTask?.courseId;
    const sessionBucket = session.bucket ?? linkedTask?.bucket;
    if (sessionCourseId !== courseId || sessionBucket !== bucket) return sum;
    return sum + session.minutes;
  }, 0);
}

/**
 * plan/16 — minutes already placed on a day this week for one *objective*: a checkpoint's prep, a
 * paper's pass, a goal milestone, the revision queue.
 *
 * The sibling of `plannedMinutesThisWeek`, for the candidate families that carry an `objectiveRef`
 * instead of a course/bucket pair. Without it those families were not accounted at all: accepting a
 * "Prep: Midterm" sitting reduced the next generation by nothing, and the only thing standing
 * between the user and the identical proposal returning was a stored accept decision. That made the
 * accept decision load-bearing, which in turn made its key load-bearing — the exact fragility
 * plan/16 §8 Q2 is about. With every family accounted, what is offered follows from what is on the
 * calendar, and a decision only ever has to mean "not this week".
 *
 * A paper's `passNo` is deliberately *not* compared: a pass-2 sitting accepted for a paper is time
 * spent on that paper this week either way, and re-offering pass 2 because the accepted block was
 * labelled pass 3 would be the same double-count in a different coat.
 */
export function plannedMinutesForObjective(
  schedules: Pick<DailySchedule, "dateKey" | "slots">[],
  ref: { kind: SlotObjectiveRef["kind"]; id?: string; milestoneId?: string },
  weekDateKeys: string[] = currentWeekDateKeys(),
  cutoff?: PlanningCutoff
): number {
  return slotsInWeek(schedules, weekDateKeys)
    .filter(({ slot }) => {
      const slotRef = slot.objectiveRef;
      if (!slotRef || slotRef.kind !== ref.kind) return false;
      if (ref.id === undefined) return true;
      if (!("id" in slotRef) || slotRef.id !== ref.id) return false;
      // A milestone is narrower than its goal: two milestones of one goal are separate pieces of
      // work, so a sitting for one must not read as progress on the other.
      return ref.milestoneId === undefined || ("milestoneId" in slotRef && slotRef.milestoneId === ref.milestoneId);
    })
    .reduce((sum, { slot, dateKey }) => sum + accountedSlotMinutes(slot, dateKey, cutoff), 0);
}
