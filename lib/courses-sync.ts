/**
 * The I/O half of lib/courses.ts, split out (plan/19 §5.1) so lib/courses.ts stays free of the client
 * SDK and its pure course logic can run on the server too (the MCP server builds days with
 * `courseSlotsForDate` and filters work with `effectiveCourseStatus`/`plannableTasks`).
 */
import { courseSlotsForDate } from "@/lib/courses";
import { fetchCollection, saveDailySchedule, setRecurringTaskTemplate, updateRecurringTaskTemplate } from "@/lib/firestore";
import { planRevisionTemplateSync } from "@/lib/recurring-tasks";
import { sortedSlots } from "@/lib/schedule";
import { isBreakMode } from "@/lib/terms";
import type { Course, DailySchedule, RecurringTaskTemplate, Term } from "@/types";

/**
 * After a course's weekly sessions change, its already-generated future schedules
 * still show the old times. Regenerate just this course's class slots on every
 * future DailySchedule, leaving past days and every other slot untouched. A date no
 * semester covers gets none, as `/plan/day` would give it.
 */
export async function resyncFutureClassSlots(uid: string, course: Course, todayKey: string, terms: Term[]) {
  const schedules = await fetchCollection<DailySchedule>(uid, "dailySchedules");
  const futureSchedules = schedules.filter((schedule) => schedule.dateKey > todayKey);
  for (const schedule of futureSchedules) {
    const withoutThisCourse = schedule.slots.filter((slot) => !slot.id.startsWith(`course-${course.id}-`));
    const refreshedSlots = isBreakMode(terms, schedule.dateKey) ? [] : courseSlotsForDate([course], schedule.dateKey);
    if (refreshedSlots.length === 0 && withoutThisCourse.length === schedule.slots.length) continue;
    await saveDailySchedule(uid, {
      dateKey: schedule.dateKey,
      templateId: schedule.templateId,
      slots: sortedSlots([...withoutThisCourse, ...refreshedSlots])
    });
  }
}

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
