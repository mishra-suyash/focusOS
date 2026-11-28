import { addDaysToKey } from "@/lib/dates";
import type { DailySchedule, Task } from "@/types";

/** How close a hard deadline gets before an unplanned one is flagged, in days. */
export const DEADLINE_ALERT_DAYS = 3;

export interface UnplannedDeadline {
  task: Task;
  /** 0 = due today. */
  daysLeft: number;
}

/**
 * Hard deadlines (`kind: "external"`) coming up within `withinDays` with no time blocked for them
 * between today and the due date. External tasks stay outside Workload on purpose (a visa form isn't
 * study time), which is exactly why nothing else in the plan pushes for them: this is what does. A
 * block counts if it's assigned the task on any date from today up to the due date; a block on a day
 * already behind you doesn't, since that time is gone.
 */
export function unplannedHardDeadlines(params: {
  tasks: Task[];
  schedules: Pick<DailySchedule, "dateKey" | "slots">[];
  todayKey: string;
  withinDays?: number;
}): UnplannedDeadline[] {
  const { tasks, schedules, todayKey, withinDays = DEADLINE_ALERT_DAYS } = params;
  const horizon = addDaysToKey(todayKey, withinDays);
  return tasks
    .filter((task) => task.kind === "external" && task.status !== "done" && task.dueDate && task.dueDate >= todayKey && task.dueDate <= horizon)
    .filter((task) => !schedules.some((schedule) => schedule.dateKey >= todayKey && schedule.dateKey <= task.dueDate! && schedule.slots.some((slot) => slot.assignedTaskIds?.includes(task.id))))
    .map((task) => ({ task, daysLeft: Math.round((Date.parse(`${task.dueDate}T00:00:00Z`) - Date.parse(`${todayKey}T00:00:00Z`)) / 86_400_000) }))
    .sort((a, b) => a.daysLeft - b.daysLeft);
}
