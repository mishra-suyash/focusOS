import { z } from "zod";
import { slotTypes, validateSlots } from "@/lib/schedule";
import type { ScheduleSlot, ScheduleSlotType } from "@/types";

/**
 * Shared, pure schemas for every template payload shape (plan §6.1, §7.2).
 * Used by the built-in catalog (U1) and, later, the admin template editor
 * and API routes (U2) — kept dependency-free of Firestore/Admin SDK so it
 * can run on the client, in a server route, or in `scripts/verify-templates.mjs`.
 */

export type TemplateKind = "day" | "taskPack" | "goal" | "readingGoal" | "timer";

export const templateSlotSchema = z.object({
  title: z.string().min(1),
  type: z.enum(slotTypes as [ScheduleSlotType, ...ScheduleSlotType[]]),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  note: z.string().optional()
});

export const dayTemplatePayloadSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().optional(),
  slots: z.array(templateSlotSchema).min(1)
});
export type DayTemplatePayload = z.infer<typeof dayTemplatePayloadSchema>;

export const taskPackItemSchema = z.object({
  title: z.string().min(1),
  category: z.enum(["research", "coding", "reading", "writing", "admin", "personal"]),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  /** Days offset from the anchor date the user picks when applying the pack (may be negative — due before the anchor). */
  dueOffsetDays: z.number().int().optional(),
  kind: z.enum(["internal", "external"]).optional()
});

export const taskPackPayloadSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().optional(),
  anchorLabel: z.string().min(1),
  tasks: z.array(taskPackItemSchema).min(1)
});
export type TaskPackPayload = z.infer<typeof taskPackPayloadSchema>;

export const goalMilestoneTemplateSchema = z.object({
  title: z.string().min(1),
  dueOffsetDays: z.number().int().optional()
});

export const goalPayloadSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().optional(),
  title: z.string().min(1),
  horizon: z.enum(["week", "term", "break", "year", "phd"]),
  why: z.string().optional(),
  definitionOfDone: z.string().min(1),
  milestones: z.array(goalMilestoneTemplateSchema).default([]),
  targetHoursPerWeek: z.number().positive().optional()
});
export type GoalPayload = z.infer<typeof goalPayloadSchema>;

export const readingGoalPayloadSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  goalKind: z.enum(["survey", "method", "baseline", "related-work", "reproduce", "critique"]),
  text: z.string().min(1)
});
export type ReadingGoalPayload = z.infer<typeof readingGoalPayloadSchema>;

export const timerPayloadSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().optional(),
  workMinutes: z.number().int().positive(),
  shortBreakMinutes: z.number().int().positive(),
  longBreakMinutes: z.number().int().positive()
});
export type TimerPayload = z.infer<typeof timerPayloadSchema>;

/** Runs one day template through both the schema and the same overlap/ordering rules the Plan page's block editor enforces — a template that fails `validateSlots` would silently misbehave when applied to a date. */
export function validateDayTemplate(payload: unknown): { ok: true; value: DayTemplatePayload } | { ok: false; errors: string[] } {
  const parsed = dayTemplatePayloadSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((issue) => issue.message) };
  const slotErrors = validateSlots(parsed.data.slots.map((slot, index) => ({ ...slot, id: String(index), status: "upcoming" }) as ScheduleSlot));
  if (slotErrors.length > 0) return { ok: false, errors: slotErrors };
  return { ok: true, value: parsed.data };
}
