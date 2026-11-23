import { parseISO } from "date-fns";
import { courseSlotsForDate } from "@/lib/courses";
import { weekStartKey } from "@/lib/dates";
import { isFixedSlot, mergeMissingLockedSlots, minutesFromTime, sortedSlots } from "@/lib/schedule";
import { isBreakMode } from "@/lib/terms";
import { rangeOverlapsSlots } from "@/lib/timeline";
import { isPlannerMade, isUnstartedFutureSitting, type ReleaseClock } from "@/lib/weekplan";
import type { Course, RecurringTaskTemplate, ScheduleSlot, Term } from "@/types";

type Dates = Pick<Term, "startDate" | "endDate">;

export interface DatePatch<T> {
  item: T;
  before: Partial<Dates>;
  after: Partial<Dates>;
}

/**
 * A course created under a term copies the term's dates (`CourseForm`), so moving the term alone would
 * leave its courses ending on the old date: read as completed, with their classes stopping there. A course
 * date equal to the term's old one was copied and follows; one that differs was set by hand and stays.
 */
export function coursesFollowingTerm(courses: Course[], before: Term, after: Dates): DatePatch<Course>[] {
  const patches: DatePatch<Course>[] = [];
  for (const course of courses) {
    if (course.termId !== before.id) continue;
    const patch = datesFollowing(course, before, after);
    if (patch) patches.push({ item: course, ...patch });
  }
  return patches;
}

/**
 * The same rule one level down: a course's recurring tasks (its revision template, a TA meeting) copied
 * the course's dates when they were made, so they follow wherever the course's dates moved.
 */
export function templatesFollowingCourses(templates: RecurringTaskTemplate[], moved: DatePatch<Course>[]): DatePatch<RecurringTaskTemplate>[] {
  const patches: DatePatch<RecurringTaskTemplate>[] = [];
  for (const template of templates) {
    const course = moved.find((patch) => patch.item.id === template.courseId);
    if (!course) continue;
    const old = { startDate: course.item.startDate, endDate: course.item.endDate };
    const next = { startDate: course.after.startDate ?? old.startDate, endDate: course.after.endDate ?? old.endDate };
    const patch = datesFollowing(template, old, next);
    if (patch) patches.push({ item: template, ...patch });
  }
  return patches;
}

function datesFollowing(item: Partial<Dates>, from: Partial<Dates>, to: Partial<Dates>): { before: Partial<Dates>; after: Partial<Dates> } | null {
  const before: Partial<Dates> = {};
  const after: Partial<Dates> = {};
  for (const key of ["startDate", "endDate"] as const) {
    if (item[key] && item[key] === from[key] && to[key] && to[key] !== from[key]) {
      before[key] = item[key];
      after[key] = to[key];
    }
  }
  return Object.keys(after).length > 0 ? { before, after } : null;
}

/** The class blocks a date should carry: none outside a semester, the same gate `/plan/day` uses. */
export function classLayerForDate(terms: Term[], courses: Course[], dateKey: string): ScheduleSlot[] {
  return isBreakMode(terms, dateKey) ? [] : courseSlotsForDate(courses, dateKey);
}

const isRoutineLayer = (slot: ScheduleSlot) => slot.id.startsWith("routine-") || slot.id === "weekly-planning";

/**
 * A saved day after a term change, or `null` if the change doesn't reach it. `before` and `after` are the
 * class blocks the date wanted under the old and the new terms; only the difference is applied, so nothing
 * else about the day is touched.
 *
 * A class that leaves takes its block with it, and any routine block that had stepped aside for it comes
 * back if it fits. A class that arrives is a fixed fact, so it lands whatever is there: a routine block
 * under it steps aside, as routine does for every fixed item; an unstarted planner sitting is released back
 * to "to place"; a block placed by hand stays and is reported as a clash for the person to sort out, since
 * neither side can be moved from here.
 */
export function resyncClassesOnDay(params: {
  dateKey: string;
  slots: ScheduleSlot[];
  before: ScheduleSlot[];
  after: ScheduleSlot[];
  routine: ScheduleSlot[];
  clock: ReleaseClock;
}) {
  const { dateKey, slots, before, after, routine, clock } = params;
  const leaving = new Set(before.filter((slot) => !after.some((next) => next.id === slot.id)).map((slot) => slot.id));
  const arriving = after.filter((slot) => !before.some((old) => old.id === slot.id) && !slots.some((saved) => saved.id === slot.id));
  if (arriving.length === 0 && !slots.some((slot) => leaving.has(slot.id))) return null;

  const weekStart = weekStartKey(parseISO(dateKey));
  let kept = slots.filter((slot) => !leaving.has(slot.id));
  const released: ScheduleSlot[] = [];
  const clashes: { title: string; with: string }[] = [];
  for (const block of arriving) {
    const start = minutesFromTime(block.startTime);
    const end = minutesFromTime(block.endTime);
    const beneath = kept.filter((slot) => !isFixedSlot(slot) && rangeOverlapsSlots(start, end, [slot]));
    for (const slot of beneath) {
      if (isRoutineLayer(slot)) continue;
      if (isUnstartedFutureSitting(slot, dateKey, clock) && isPlannerMade(slot, weekStart)) released.push(slot);
      else clashes.push({ title: block.title, with: slot.title });
    }
    kept = kept.filter((slot) => !(isRoutineLayer(slot) && beneath.includes(slot)) && !released.includes(slot));
  }

  const withClasses = sortedSlots([...kept, ...arriving]);
  // Routine that had stepped aside for a class that's gone comes back where nothing else is now.
  const nextSlots = leaving.size > 0 ? mergeMissingLockedSlots(withClasses, routine.filter((slot) => !rangeOverlapsSlots(minutesFromTime(slot.startTime), minutesFromTime(slot.endTime), withClasses))) : withClasses;
  return { slots: nextSlots, released, clashes };
}
