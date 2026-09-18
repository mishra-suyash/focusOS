import { differenceInCalendarWeeks, getDay, parseISO } from "date-fns";
import { addDaysToKey } from "@/lib/dates";
import type { RecurringTaskTemplate } from "@/types";

/**
 * plan/FocusOS-v2-Connected-Flow-Plan.md §4.1 — mirrors lib/routine.ts's routineSlotsForDate and
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
