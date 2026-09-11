import { materializeSlots } from "@/lib/schedule";
import { BUILTIN_DAY_TEMPLATES, type BuiltinDayTemplate } from "@/lib/templates/builtin/day-templates";
import { BUILTIN_GOAL_TEMPLATES } from "@/lib/templates/builtin/goal-templates";
import { BUILTIN_READING_GOAL_PRESETS } from "@/lib/templates/builtin/reading-goal-presets";
import { BUILTIN_TASK_PACKS } from "@/lib/templates/builtin/task-packs";
import { BUILTIN_TIMER_PRESETS } from "@/lib/templates/builtin/timer-presets";
import type { DayTemplate, PackId, TimerPresetId } from "@/types";

export { BUILTIN_DAY_TEMPLATES, findBuiltinDayTemplate } from "@/lib/templates/builtin/day-templates";
export { BUILTIN_GOAL_TEMPLATES, findBuiltinGoalTemplate } from "@/lib/templates/builtin/goal-templates";
export { BUILTIN_READING_GOAL_PRESETS } from "@/lib/templates/builtin/reading-goal-presets";
export { BUILTIN_TASK_PACKS, findBuiltinTaskPack } from "@/lib/templates/builtin/task-packs";
export { BUILTIN_TIMER_PRESETS } from "@/lib/templates/builtin/timer-presets";
export type { BuiltinDayTemplate } from "@/lib/templates/builtin/day-templates";

/** Turns a code-defined catalog entry into a real DayTemplate (§6.1's "materialize on commit") — generates fresh slot ids/status, exactly like `scheduleFromTemplate` does for a user template. */
export function materializeBuiltinDayTemplate(builtin: BuiltinDayTemplate): Omit<DayTemplate, "id" | "createdAt" | "updatedAt"> {
  return {
    name: builtin.name,
    description: builtin.description,
    isDefault: false,
    slots: materializeSlots(builtin.slots),
    sourceTemplateId: `builtin:${builtin.id}`,
    sourceVersion: builtin.version
  };
}

/** Resolution order for a pack's default workday template (plan §7.4): admin override (U2, not yet wired) -> built-in default -> Research Day as the global fallback (§8.1: skipping onboarding uses Research Day). */
export function resolvePackWorkdayTemplate(packId?: PackId): BuiltinDayTemplate {
  const pack = packId ?? "research";
  return (
    BUILTIN_DAY_TEMPLATES.find((template) => template.defaultForPack?.includes(pack)) ??
    BUILTIN_DAY_TEMPLATES.find((template) => template.id === "research-day")!
  );
}

/** Resolution for a pack's break-day default (plan §8.1); undefined = no built-in break default for this pack. */
export function resolvePackBreakDayTemplate(packId?: PackId): BuiltinDayTemplate | undefined {
  if (!packId) return undefined;
  return BUILTIN_DAY_TEMPLATES.find((template) => template.breakDefaultForPack?.includes(packId));
}

const PACK_TIMER_PRESET: Record<PackId, TimerPresetId> = {
  coursework: "classic",
  research: "classic",
  writing: "extended",
  everything: "classic",
  core: "classic"
};

export function resolvePackTimerPreset(packId?: PackId): TimerPresetId {
  return PACK_TIMER_PRESET[packId ?? "research"];
}
