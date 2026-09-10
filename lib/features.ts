import type { PackId } from "@/types";

/**
 * The feature module registry (plan §9.1) — one entry per module, the same
 * pattern as `lib/ai/tasks.ts`'s AI task registry. U0 only defines the data;
 * nothing gates on it yet (that's U4). Building it now means every module id
 * referenced by starter packs (U3) and the built-in catalog (U1) already has
 * a single source of truth for its label and core-ness.
 */
export type ModuleId =
  | "today"
  | "tasks"
  | "plan"
  | "focus"
  | "wrapup"
  | "readingList"
  | "stagedReading"
  | "paperTools"
  | "courses"
  | "revise"
  | "goals"
  | "weeklyCheckin"
  | "workload"
  | "analytics"
  | "insights";

export interface FeatureModule {
  id: ModuleId;
  label: string;
  description: string;
  /** Cannot be disabled — always present regardless of pack or custom selection. */
  core?: boolean;
  /** Another module this one depends on being enabled (e.g. paperTools needs stagedReading). */
  requires?: ModuleId[];
}

export const FEATURE_MODULES: Record<ModuleId, FeatureModule> = {
  today: { id: "today", label: "Today", description: "Your day at a glance.", core: true },
  tasks: { id: "tasks", label: "Tasks", description: "Everything you need to get done.", core: true },
  plan: { id: "plan", label: "Plan", description: "Your day, block by block.", core: true },
  focus: { id: "focus", label: "Focus timer", description: "Timed focus sessions.", core: true },
  wrapup: { id: "wrapup", label: "Daily wrap-up", description: "Close out the day and carry things to tomorrow.", core: true },
  readingList: { id: "readingList", label: "Papers", description: "Papers you want to read, are reading, or have read.", core: true },
  stagedReading: {
    id: "stagedReading",
    label: "Staged reading",
    description: "Skim / Read / Deep dive — read a paper in stages.",
    requires: ["readingList"]
  },
  paperTools: {
    id: "paperTools",
    label: "Paper tools",
    description: "Paper sets, PDF highlights, layered summaries.",
    requires: ["stagedReading"]
  },
  courses: { id: "courses", label: "Courses", description: "Your classes, assessments, and what each lecture covered." },
  revise: { id: "revise", label: "Revise", description: "Topics and papers come back at growing intervals." },
  goals: { id: "goals", label: "Goals", description: "Long-term aims like a chapter, an exam, or a submission." },
  weeklyCheckin: { id: "weeklyCheckin", label: "Weekly check-in", description: "A short weekly review of long-running goals." },
  workload: { id: "workload", label: "Workload", description: "How much you've done today compared with what today asked for." },
  analytics: { id: "analytics", label: "Analytics", description: "Trends across tasks, focus sessions, and load." },
  insights: { id: "insights", label: "Insights", description: "AI-generated daily insight summaries." }
};

export const CORE_MODULES: ModuleId[] = Object.values(FEATURE_MODULES)
  .filter((module) => module.core)
  .map((module) => module.id);

/** Additive modules each starter pack turns on beyond the core set (plan §8.1). */
export const PACK_MODULES: Record<PackId, ModuleId[]> = {
  coursework: ["courses", "revise"],
  research: ["stagedReading", "revise", "goals"],
  writing: ["goals", "weeklyCheckin"],
  everything: Object.keys(FEATURE_MODULES) as ModuleId[],
  core: []
};

/** Resolves the effective module set for a settings doc: an explicit `enabledModules` list wins; otherwise it's derived from `packId` (default "everything" so pre-U3/pre-pack accounts see every module, matching the migration default). */
export function resolveEnabledModules(settings: { packId?: PackId; enabledModules?: string[] }): Set<ModuleId> {
  if (settings.enabledModules) {
    return new Set([...CORE_MODULES, ...(settings.enabledModules as ModuleId[])]);
  }
  const pack = settings.packId ?? "everything";
  return new Set([...CORE_MODULES, ...PACK_MODULES[pack]]);
}

export function isModuleEnabled(settings: { packId?: PackId; enabledModules?: string[] }, moduleId: ModuleId): boolean {
  return resolveEnabledModules(settings).has(moduleId);
}
