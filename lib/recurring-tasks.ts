import { differenceInCalendarWeeks, getDay, parseISO } from "date-fns";
import { addDaysToKey } from "@/lib/dates";
import type { Course, NewRecurringTaskTemplate, RecurringTaskTemplate } from "@/types";

/**
 * plan/10.FocusOS-v2-Connected-Flow-Plan.md §4.1 — mirrors lib/routine.ts's routineSlotsForDate and
 * lib/courses.ts's courseSlotsForDate in shape: a pure function of plain data, no Firestore
 * import, safe to reuse from a cron route, an API route, or a test.
 */
export function isTemplateDueOn(template: RecurringTaskTemplate, dateKey: string): boolean {
  if (!template.active) return false;
  if (template.startDate && dateKey < template.startDate) return false;
  if (template.endDate && dateKey > template.endDate) return false;
  const dayOfWeek = getDay(parseISO(dateKey));
  if (!template.daysOfWeek.includes(dayOfWeek)) return false;
  if (template.cadence === "weekly") return true;
  // biweekly: same-parity calendar week as the anchor. §3.2 requires anchorDate to be set at
  // creation time for every biweekly template, so there's no "unset anchor" case to fall back on.
  // weekStartsOn: 1 (Monday) matches lib/dates.ts's weekStartKey — every other "which week is
  // this" calculation in the app already uses a Monday week start, so this one does too.
  const weeksSinceAnchor = differenceInCalendarWeeks(parseISO(dateKey), parseISO(template.anchorDate!), { weekStartsOn: 1 });
  return weeksSinceAnchor % 2 === 0;
}

/**
 * §4.3 — the deterministic id a generated instance gets, so re-running generation over an
 * overlapping window is naturally idempotent (an admin-side `.create()` on this id just throws
 * `ALREADY_EXISTS` for a date that's already materialized) instead of needing an existence-check
 * read first.
 */
export function recurringTaskInstanceId(templateId: string, dateKey: string): string {
  return `rec-${templateId}-${dateKey}`;
}

/**
 * Every date from `fromDateKey` through `toDateKey`, inclusive, as yyyy-MM-dd keys. Built with
 * `addDaysToKey` (lib/dates.ts), the same local-time-consistent parse/format round-trip every
 * other date-key helper in this codebase already uses, rather than a UTC-based day-stepping loop
 * that could drift a day off in a server timezone behind UTC.
 */
export function dateKeysInRange(fromDateKey: string, toDateKey: string): string[] {
  const keys: string[] = [];
  let cursor = fromDateKey;
  while (cursor <= toDateKey) {
    keys.push(cursor);
    cursor = addDaysToKey(cursor, 1);
  }
  return keys;
}

export type RevisionTemplateSyncPlan =
  | { action: "none" }
  | { action: "create"; templateId: string; template: NewRecurringTaskTemplate }
  | { action: "update"; templateId: string; patch: Partial<RecurringTaskTemplate> }
  | { action: "pause"; templateId: string };

/**
 * A course's auto revision template always lives at this id rather than one `addDoc` would hand
 * out. Without it, two "Save" clicks close enough together that the second fires before the
 * template list has refreshed would each see no `existing` template and each create one —
 * two duplicate "Revise <course>" templates generating tasks every week, neither ever found again
 * by `find(t => t.generatedFrom === ...)` reliably. A deterministic id makes the create a `setDoc`
 * upsert instead of an `addDoc` insert — same idempotency rationale as `recurringTaskInstanceId`.
 */
export function revisionTemplateId(courseId: string): string {
  return `revision-${courseId}`;
}

/**
 * The user asked for revision time to be "scheduled as tasks automatically every week, hours set
 * on the course" — this decides what (if anything) needs to change about a course's one
 * auto-managed weekly "Revise <course>" template so that its size always matches
 * `course.targetMinutesPerWeek`, without the user ever touching the recurring-commitments UI
 * themselves. Pure, so the actual read-existing/write-the-change I/O (`lib/courses.ts`'s
 * `syncRevisionTemplate`) can stay a thin wrapper and this logic can be unit-tested directly.
 *
 * Deliberately asymmetric: clearing the hours to 0 always pauses the template (mirrors
 * `changeStatus`'s "course ended → pause its templates" rule on the course card), but raising the
 * hours again never force-reactivates a template the user paused by hand from the course card's
 * "Pause" button — only resizes it. Otherwise nudging the hours field would silently undo a
 * deliberate pause, which is worse than leaving the user to hit "Resume" themselves.
 */
export function planRevisionTemplateSync(
  course: Pick<Course, "id" | "name" | "targetMinutesPerWeek" | "startDate" | "endDate">,
  existing: RecurringTaskTemplate | undefined,
  workMinutes: number
): RevisionTemplateSyncPlan {
  const minutesPerWeek = course.targetMinutesPerWeek ?? 0;
  if (minutesPerWeek <= 0) {
    return existing?.active ? { action: "pause", templateId: existing.id } : { action: "none" };
  }

  // Matches lib/timeline.ts's taskBlockMinutes inverse: a task's real duration is
  // estimatedPomodoros * workMinutes, floored at one pomodoro so a small hours target never
  // rounds down to a task with nothing to actually do.
  const estimatedPomodoros = Math.max(1, Math.round(minutesPerWeek / workMinutes));

  if (!existing) {
    return {
      action: "create",
      templateId: revisionTemplateId(course.id),
      template: {
        title: `Revise ${course.name}`,
        courseId: course.id,
        category: "reading",
        priority: "medium",
        estimatedPomodoros,
        cadence: "weekly",
        // Sunday — a fixed, predictable catch-up slot the user never has to choose, since the
        // whole point is this needs no setup beyond the hours number.
        daysOfWeek: [0],
        active: true,
        startDate: course.startDate,
        endDate: course.endDate,
        generatedFrom: "courseRevisionTarget"
      }
    };
  }

  const patch: Partial<RecurringTaskTemplate> = {};
  if (existing.estimatedPomodoros !== estimatedPomodoros) patch.estimatedPomodoros = estimatedPomodoros;
  if (existing.startDate !== course.startDate) patch.startDate = course.startDate;
  if (existing.endDate !== course.endDate) patch.endDate = course.endDate;
  if (Object.keys(patch).length === 0) return { action: "none" };
  return { action: "update", templateId: existing.id, patch };
}
