import { getDay, parseISO } from "date-fns";
import { fetchCollection, saveDailySchedule, setRecurringTaskTemplate, updateRecurringTaskTemplate } from "@/lib/firestore";
import { planRevisionTemplateSync } from "@/lib/recurring-tasks";
import { sortedSlots } from "@/lib/schedule";
import type { Course, CourseStatus, DailySchedule, RecurringTaskTemplate, ScheduleSlot } from "@/types";

/** `status` as stored can go stale (nobody flips it when a course's end date passes) — derive the real one. */
export function effectiveCourseStatus(course: Course, dateKey: string): CourseStatus {
  if (course.status === "dropped") return "dropped";
  if (course.endDate && dateKey > course.endDate) return "completed";
  return course.status;
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
        color: course.color
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
  course: Pick<Course, "id" | "name" | "targetMinutesPerWeek" | "startDate" | "endDate">,
  courseTemplates: RecurringTaskTemplate[],
  workMinutes: number
) {
  const existing = courseTemplates.find((template) => template.generatedFrom === "courseRevisionTarget");
  const plan = planRevisionTemplateSync(course, existing, workMinutes);
  // "create" goes through setRecurringTaskTemplate's deterministic id, not createRecurringTaskTemplate's
  // addDoc — see revisionTemplateId's comment: two overlapping "Save" clicks must land on one document.
  if (plan.action === "create") await setRecurringTaskTemplate(uid, plan.templateId, plan.template);
  else if (plan.action === "update") await updateRecurringTaskTemplate(uid, plan.templateId, plan.patch);
  else if (plan.action === "pause") await updateRecurringTaskTemplate(uid, plan.templateId, { active: false });
}
