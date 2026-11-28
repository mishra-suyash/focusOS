/**
 * A day's blocks as the app opens it — shared by the schedule writes and get_day/get_week, so what
 * Claude reads is what it edits.
 */
import type { ToolContext } from "@/lib/mcp/context";
import { courseSlotsForDate } from "@/lib/courses";
import { commitmentSlotsForDate, withCommitments } from "@/lib/recurring-tasks";
import { DEFAULT_ROUTINE_BLOCKS, routineSlotsForDate } from "@/lib/routine";
import { mergeMissingLockedSlots, minutesFromTime, sortedSlots } from "@/lib/schedule";
import { isBreakMode } from "@/lib/terms";
import { rangeOverlapsSlots } from "@/lib/timeline";
import { weeklyPlanningSlotForDate } from "@/lib/weekplan";
import type { Course, RecurringTaskTemplate, ScheduleSlot, Term } from "@/types";

/** `/plan/week`'s `daySlotsWithFixed`, with `/plan/day`'s course-module gate and routine yield: the day as the app would open it. */
/** Terms, courses and commitments, read once per request. Commitment tools write templates, but each tool call is its own request (and context), so a write is seen by the next call. */
const fixedSources = new WeakMap<ToolContext, Promise<[Term[], Course[], RecurringTaskTemplate[]]>>();

export async function dayAsOpened(ctx: ToolContext, date: string, saved: ScheduleSlot[]): Promise<ScheduleSlot[]> {
  if (!fixedSources.has(ctx)) fixedSources.set(ctx, Promise.all([ctx.list<Term>("terms"), ctx.list<Course>("courses"), ctx.list<RecurringTaskTemplate>("recurringTaskTemplates")]));
  const [settings, modules, [terms, courses, templates]] = await Promise.all([ctx.settings(), ctx.modules(), fixedSources.get(ctx)!]);
  const classSlots = isBreakMode(terms, date) || !modules.has("courses") ? [] : courseSlotsForDate(courses, date);
  const commitments = commitmentSlotsForDate(templates, date, saved);
  // Routine yields to every commitment on this date, including one already saved onto it.
  const yieldTo = [...classSlots, ...commitmentSlotsForDate(templates, date)];
  const routine = routineSlotsForDate(settings.routineBlocks ?? DEFAULT_ROUTINE_BLOCKS, date).filter(
    (slot) => !rangeOverlapsSlots(minutesFromTime(slot.startTime), minutesFromTime(slot.endTime), yieldTo)
  );
  const base = saved.length > 0 ? mergeMissingLockedSlots(withCommitments(saved, commitments), [...classSlots, ...routine]) : [...classSlots, ...commitments, ...routine];
  const anchor = weeklyPlanningSlotForDate(settings.weeklyPlanning, date);
  return sortedSlots(anchor && !base.some((slot) => slot.id === anchor.id) ? [...base, anchor] : base);
}
