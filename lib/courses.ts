import { getDay, parseISO } from "date-fns";
import { weekDates, weekStartKey } from "@/lib/dates";
import { fetchCollection, saveDailySchedule, setRecurringTaskTemplate, updateRecurringTaskTemplate } from "@/lib/firestore";
import { planRevisionTemplateSync } from "@/lib/recurring-tasks";
import { minutesFromTime, sortedSlots } from "@/lib/schedule";
import type { Course, CourseStatus, DailySchedule, Goal, PomodoroSession, RecurringTaskTemplate, ScheduleSlot, Task, TaskBucket } from "@/types";

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

/**
 * After a course's weekly sessions change, its already-generated future schedules
 * still show the old times. Regenerate just this course's class slots on every
 * future DailySchedule, leaving past days and every other slot untouched.
 */
export async function resyncFutureClassSlots(uid: string, course: Course, todayKey: string) {
  const schedules = await fetchCollection<DailySchedule>(uid, "dailySchedules");
  const futureSchedules = schedules.filter((schedule) => schedule.dateKey > todayKey);
  for (const schedule of futureSchedules) {
    const withoutThisCourse = schedule.slots.filter((slot) => !slot.id.startsWith(`course-${course.id}-`));
    const refreshedSlots = courseSlotsForDate([course], schedule.dateKey);
    if (refreshedSlots.length === 0 && withoutThisCourse.length === schedule.slots.length) continue;
    await saveDailySchedule(uid, {
      dateKey: schedule.dateKey,
      templateId: schedule.templateId,
      slots: sortedSlots([...withoutThisCourse, ...refreshedSlots])
    });
  }
}

export const dayOfWeekLabels = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The I/O half of `planRevisionTemplateSync` (lib/recurring-tasks.ts) — call after creating a
 * course or after its `targetMinutesPerWeek` changes, passing the templates already fetched for
 * that course (no extra query, same "fetch once, filter client-side" convention as everywhere
 * else) so it can find "the" auto revision template by `generatedFrom`, not by guessing from title.
 */
export async function syncRevisionTemplate(
  uid: string,
  course: Pick<Course, "id" | "name" | "targetMinutesPerWeek" | "startDate" | "endDate" | "autoRevisionTasks">,
  courseTemplates: RecurringTaskTemplate[],
  workMinutes: number
) {
  const existing = courseTemplates.find((template) => template.generatedFrom === "courseRevisionTarget");
  // plan/16 §5.4 — absent reads as "on" only for a course that already has an auto template, so
  // pre-`16` courses keep generating and new ones don't start.
  const autoEnabled = course.autoRevisionTasks ?? Boolean(existing);
  const plan = planRevisionTemplateSync(course, existing, workMinutes, autoEnabled);
  // "create" goes through setRecurringTaskTemplate's deterministic id, not createRecurringTaskTemplate's
  // addDoc — see revisionTemplateId's comment: two overlapping "Save" clicks must land on one document.
  if (plan.action === "create") await setRecurringTaskTemplate(uid, plan.templateId, plan.template);
  else if (plan.action === "update") await updateRecurringTaskTemplate(uid, plan.templateId, plan.patch);
  else if (plan.action === "pause") await updateRecurringTaskTemplate(uid, plan.templateId, { active: false });
}

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
 * A slot's `plannedMinutes` wins over its own duration where present, so resizing a block on the
 * timeline after planning doesn't rewrite what the week was understood to have committed.
 */
export function plannedMinutesThisWeek(
  schedules: Pick<DailySchedule, "dateKey" | "slots">[],
  courseId: string,
  bucket: TaskBucket,
  weekDateKeys: string[] = currentWeekDateKeys()
): number {
  const inWeek = new Set(weekDateKeys);
  return schedules
    .filter((schedule) => inWeek.has(schedule.dateKey))
    .flatMap((schedule) => schedule.slots)
    // Task-derived blocks are deliberately excluded. `scheduledMinutesThisWeek` above already counts
    // task-shaped work (via the task's own estimate), and `createTaskBlock` copies the task's
    // `courseId`/`bucket` onto the block it creates — so without this filter a course task that has
    // been dropped onto a day is counted by both functions and the bucket reads satisfied when it
    // isn't. The two pools have to stay disjoint or their sum lies, and they are separable by
    // construction: a planner-accepted *bucket* proposal carries no `assignedTaskIds` (bucket
    // candidates have no `taskId`), while every task-derived block does.
    .filter((slot) => slot.courseId === courseId && slot.bucket === bucket && !slot.assignedTaskIds?.length)
    .reduce((sum, slot) => sum + (slot.plannedMinutes ?? Math.max(0, minutesFromTime(slot.endTime) - minutesFromTime(slot.startTime))), 0);
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
  weekDateKeys: string[] = currentWeekDateKeys()
): number {
  const inWeek = new Set(weekDateKeys);
  return schedules
    .filter((schedule) => inWeek.has(schedule.dateKey))
    .flatMap((schedule) => schedule.slots)
    .filter((slot) => slot.assignedTaskIds?.includes(taskId))
    .reduce((sum, slot) => sum + (slot.plannedMinutes ?? Math.max(0, minutesFromTime(slot.endTime) - minutesFromTime(slot.startTime))), 0);
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
    const dateKey = session.completedAt.slice(0, 10);
    if (!weekDateKeys.includes(dateKey)) return sum;
    const linkedTask = session.taskId ? taskById.get(session.taskId) : undefined;
    const sessionCourseId = session.courseId ?? linkedTask?.courseId;
    const sessionBucket = session.bucket ?? linkedTask?.bucket;
    if (sessionCourseId !== courseId || sessionBucket !== bucket) return sum;
    return sum + session.minutes;
  }, 0);
}
