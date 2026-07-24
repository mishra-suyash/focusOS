import type { DailySchedule, DayTemplate, ScheduleSlot, ScheduleSlotStatus, ScheduleSlotType, Task, Thought } from "@/types";

export const slotTypes: ScheduleSlotType[] = ["deep_work", "meal", "free", "admin", "break", "commute", "sleep", "gym", "custom"];

export const slotTypeLabels: Record<ScheduleSlotType, string> = {
  deep_work: "Deep work",
  meal: "Meal",
  free: "Free",
  admin: "Admin",
  break: "Break",
  commute: "Commute",
  sleep: "Sleep",
  gym: "Gym",
  custom: "Custom"
};

export const slotTypeStyles: Record<ScheduleSlotType, string> = {
  deep_work: "border-moss-600 bg-moss-600/10 text-moss-700 dark:text-moss-400",
  meal: "border-amberline bg-amberline/10 text-amber-700 dark:text-amber-300",
  free: "border-ink-300 bg-ink-100 text-ink-600 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-300",
  admin: "border-sky-500 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  break: "border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300",
  commute: "border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  sleep: "border-indigo-500 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
  gym: "border-rose-500 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  custom: "border-ink-400 bg-white text-ink-700 dark:bg-ink-900 dark:text-ink-200"
};

export function minutesFromTime(time: string) {
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

export function formatMinutes(total: number) {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

export function slotDuration(slot: ScheduleSlot) {
  return Math.max(0, minutesFromTime(slot.endTime) - minutesFromTime(slot.startTime));
}

export function sortedSlots(slots: ScheduleSlot[]) {
  return [...slots].sort((a, b) => minutesFromTime(a.startTime) - minutesFromTime(b.startTime));
}

export function validateSlots(slots: ScheduleSlot[]) {
  const errors: string[] = [];
  const ordered = sortedSlots(slots);
  ordered.forEach((slot, index) => {
    const start = minutesFromTime(slot.startTime);
    const end = minutesFromTime(slot.endTime);
    if (!slot.title.trim()) errors.push(`Slot ${index + 1} needs a title.`);
    if (end <= start) errors.push(`${slot.title || `Slot ${index + 1}`} must end after it starts.`);
    const previous = ordered[index - 1];
    if (previous && start < minutesFromTime(previous.endTime)) {
      errors.push(`${slot.title || `Slot ${index + 1}`} overlaps with ${previous.title}.`);
    }
  });
  return errors;
}

export function currentMinute(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

export function computeSlotStatus(slot: ScheduleSlot, minute = currentMinute()): ScheduleSlotStatus {
  if (slot.status === "skipped" || slot.status === "completed") return slot.status;
  const start = minutesFromTime(slot.startTime);
  const end = minutesFromTime(slot.endTime);
  if (minute >= start && minute < end) return "active";
  if (minute >= end) return "completed";
  return "upcoming";
}

export function getActiveSlot(slots: ScheduleSlot[], minute = currentMinute()) {
  return sortedSlots(slots).find((slot) => minute >= minutesFromTime(slot.startTime) && minute < minutesFromTime(slot.endTime));
}

export function getNextSlot(slots: ScheduleSlot[], minute = currentMinute()) {
  return sortedSlots(slots).find((slot) => minutesFromTime(slot.startTime) > minute);
}

export function dayProgressPercent(minute = currentMinute()) {
  return Math.min(100, Math.max(0, Math.round((minute / 1440) * 100)));
}

export function slotProgressPercent(slot?: ScheduleSlot, minute = currentMinute()) {
  if (!slot) return 0;
  const start = minutesFromTime(slot.startTime);
  const end = minutesFromTime(slot.endTime);
  return Math.min(100, Math.max(0, Math.round(((minute - start) / Math.max(1, end - start)) * 100)));
}

export function scheduleSummary(slots: ScheduleSlot[], minute = currentMinute()) {
  const plannedDeepWork = slots.filter((slot) => slot.type === "deep_work").reduce((sum, slot) => sum + slotDuration(slot), 0);
  const completedDeepWork = slots
    .filter((slot) => slot.type === "deep_work" && (slot.status === "completed" || minutesFromTime(slot.endTime) <= minute))
    .reduce((sum, slot) => sum + slotDuration(slot), 0);
  const completedSlots = slots.filter((slot) => slot.status === "completed" || minutesFromTime(slot.endTime) <= minute).length;
  return { plannedDeepWork, completedDeepWork, completedSlots, totalSlots: slots.length };
}

export function taskNamesForSlot(slot: ScheduleSlot, tasks: Task[]) {
  const ids = new Set(slot.assignedTaskIds ?? []);
  return tasks.filter((task) => ids.has(task.id)).map((task) => task.title);
}

export function stableThoughtForDate(thoughts: Thought[], dateKey: string) {
  if (thoughts.length === 0) return undefined;
  const seed = Array.from(dateKey).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return thoughts[seed % thoughts.length];
}

export function createSlot(partial: Partial<ScheduleSlot> = {}): ScheduleSlot {
  return {
    id: partial.id ?? crypto.randomUUID(),
    title: partial.title ?? "New slot",
    type: partial.type ?? "deep_work",
    startTime: partial.startTime ?? "09:00",
    endTime: partial.endTime ?? "10:30",
    assignedTaskIds: partial.assignedTaskIds ?? [],
    note: partial.note ?? "",
    status: partial.status ?? "upcoming",
    color: partial.color
  };
}

export function generateResearchWeekdayTemplate(): Omit<DayTemplate, "id" | "createdAt" | "updatedAt"> {
  return {
    name: "Research weekday",
    description: "A balanced doctoral workday with deep work, meals, admin, gym, and evening review.",
    slots: [
      createSlot({ title: "Sleep", type: "sleep", startTime: "00:00", endTime: "06:30" }),
      createSlot({ title: "Morning routine", type: "free", startTime: "06:30", endTime: "07:30" }),
      createSlot({ title: "Gym", type: "gym", startTime: "07:30", endTime: "08:30" }),
      createSlot({ title: "Breakfast", type: "meal", startTime: "08:30", endTime: "09:00" }),
      createSlot({ title: "Deep work: primary research", type: "deep_work", startTime: "09:00", endTime: "11:30" }),
      createSlot({ title: "Break", type: "break", startTime: "11:30", endTime: "12:00" }),
      createSlot({ title: "Reading and notes", type: "deep_work", startTime: "12:00", endTime: "13:30" }),
      createSlot({ title: "Lunch", type: "meal", startTime: "13:30", endTime: "14:15" }),
      createSlot({ title: "Admin and email", type: "admin", startTime: "14:15", endTime: "15:00" }),
      createSlot({ title: "Writing block", type: "deep_work", startTime: "15:00", endTime: "17:00" }),
      createSlot({ title: "Open buffer", type: "free", startTime: "17:00", endTime: "18:30" }),
      createSlot({ title: "Dinner", type: "meal", startTime: "18:30", endTime: "19:30" }),
      createSlot({ title: "Review and tomorrow setup", type: "admin", startTime: "19:30", endTime: "20:00" }),
      createSlot({ title: "Personal time", type: "free", startTime: "20:00", endTime: "22:30" }),
      createSlot({ title: "Sleep", type: "sleep", startTime: "22:30", endTime: "23:59" })
    ]
  };
}

export function scheduleFromTemplate(template: DayTemplate, dateKey: string): Omit<DailySchedule, "id" | "createdAt" | "updatedAt"> {
  return {
    dateKey,
    templateId: template.id,
    slots: template.slots.map((slot) => ({ ...slot, id: crypto.randomUUID(), status: "upcoming" }))
  };
}
