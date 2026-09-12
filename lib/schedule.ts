import { Book, Briefcase, Brain, Car, Coffee, Dumbbell, GraduationCap, Moon, Sparkles, Utensils, type LucideIcon } from "lucide-react";
import type { DailySchedule, DayTemplate, ScheduleSlot, ScheduleSlotStatus, ScheduleSlotType, Task } from "@/types";

export const slotTypes: ScheduleSlotType[] = ["deep_work", "reading", "meal", "free", "admin", "break", "commute", "sleep", "gym", "class", "custom"];

export const slotTypeLabels: Record<ScheduleSlotType, string> = {
  deep_work: "Deep work",
  reading: "Reading",
  meal: "Meal",
  free: "Free",
  admin: "Admin",
  break: "Break",
  commute: "Commute",
  sleep: "Sleep",
  gym: "Gym",
  class: "Class",
  custom: "Custom"
};

export const slotTypeStyles: Record<ScheduleSlotType, string> = {
  deep_work: "border-moss-600 bg-moss-600/10 text-moss-700 dark:text-moss-400",
  reading: "border-cyan-500 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  meal: "border-amberline bg-amberline/10 text-amber-700 dark:text-amber-300",
  free: "border-ink-300 bg-ink-100 text-ink-600 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-300",
  admin: "border-sky-500 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  break: "border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300",
  commute: "border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  sleep: "border-indigo-500 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
  gym: "border-rose-500 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  class: "border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300",
  custom: "border-ink-400 bg-white text-ink-700 dark:bg-ink-900 dark:text-ink-200"
};

/** §9 "colour not the only signal" — a type icon on every block/strip segment, DP4. */
export const slotTypeIcons: Record<ScheduleSlotType, LucideIcon> = {
  deep_work: Brain,
  reading: Book,
  meal: Utensils,
  free: Coffee,
  admin: Briefcase,
  break: Coffee,
  commute: Car,
  sleep: Moon,
  gym: Dumbbell,
  class: GraduationCap,
  custom: Sparkles
};

export function minutesFromTime(time: string) {
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

export function minutesToTime(total: number) {
  const hours = Math.floor(total / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (total % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
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

export function createSlot(partial: Partial<ScheduleSlot> = {}): ScheduleSlot {
  return {
    id: partial.id ?? crypto.randomUUID(),
    title: partial.title ?? "New block",
    type: partial.type ?? "deep_work",
    startTime: partial.startTime ?? "09:00",
    endTime: partial.endTime ?? "10:30",
    assignedTaskIds: partial.assignedTaskIds ?? [],
    note: partial.note ?? "",
    status: partial.status ?? "upcoming",
    color: partial.color
  };
}

/** Turns a bare slot shape (title/type/startTime/endTime/note — a template catalog entry's shape, no id/status) into real `ScheduleSlot`s with fresh ids. Shared by both the built-in and admin-published (org) template materialization paths. */
export function materializeSlots(slots: Array<Pick<ScheduleSlot, "title" | "type" | "startTime" | "endTime"> & { note?: string }>): ScheduleSlot[] {
  return slots.map((slot) => createSlot(slot));
}

/**
 * Shifts every slot by a fixed offset so the earliest slot starts at `newStart`
 * (plan §6.2's "My day starts at" personalization). Pure — returns a new array,
 * or `null` if the shift would push any slot before 00:00 or past 24:00 ("crosses
 * midnight"), since block lengths are never scaled, only translated.
 */
export function shiftTemplateSlots(slots: ScheduleSlot[], newStart: string): ScheduleSlot[] | null {
  if (slots.length === 0) return slots;
  const ordered = sortedSlots(slots);
  const offset = minutesFromTime(newStart) - minutesFromTime(ordered[0].startTime);
  if (offset === 0) return slots;
  for (const slot of ordered) {
    const start = minutesFromTime(slot.startTime) + offset;
    const end = minutesFromTime(slot.endTime) + offset;
    if (start < 0 || end >= 24 * 60) return null;
  }
  return slots.map((slot) => ({
    ...slot,
    startTime: minutesToTime(minutesFromTime(slot.startTime) + offset),
    endTime: minutesToTime(minutesFromTime(slot.endTime) + offset)
  }));
}

export function scheduleFromTemplate(template: DayTemplate, dateKey: string): Omit<DailySchedule, "id" | "createdAt" | "updatedAt"> {
  return {
    dateKey,
    templateId: template.id,
    slots: template.slots.map((slot) => ({ ...slot, id: crypto.randomUUID(), status: "upcoming" }))
  };
}
