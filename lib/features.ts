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
  | "insights"
  | "planDayTimeline";

export interface FeatureModule {
  id: ModuleId;
  label: string;
  description: string;
  /** Cannot be disabled — always present regardless of pack or custom selection. */
  core?: boolean;
  /** Another module this one depends on being enabled (e.g. paperTools needs stagedReading). */
  requires?: ModuleId[];
  /** A rollout flag rather than a user-facing feature — excluded from `/settings/features`'s toggle list and from the "everything" pack's implicit membership, so it's only ever on for a settings doc that explicitly names it. */
  hidden?: boolean;
  /** Shown in `/settings/features` like any other module, but never auto-included by a pack (including "everything") — a deliberate, permanent choice the user makes for themselves rather than a default anyone gets by picking a pack. */
  optIn?: boolean;
}

export const FEATURE_MODULES: Record<ModuleId, FeatureModule> = {
  today: { id: "today", label: "Today", description: "Your day at a glance.", core: true },
  tasks: { id: "tasks", label: "Tasks", description: "Everything you need to get done.", core: true },
  plan: { id: "plan", label: "Plan", description: "Your day, block by block.", core: true },
  focus: { id: "focus", label: "Focus timer", description: "Timed focus sessions.", core: true },
  wrapup: { id: "wrapup", label: "Daily wrap-up", description: "Close out the day and carry things to tomorrow.", core: true },
  readingList: { id: "readingList", label: "Papers", description: "Papers you want to read, are reading, or have read.", core: true },
  /**
   * Deliberately `core: true` rather than pack-gated, deviating from plan §8.1's table (which
   * lists it as a Research-pack addition). §9.1 describes a condensed "Start reading" / "Mark as
   * read" fallback for when this is off, but flags its own [ASSUMPTION] that collapsing pass1/
   * pass2 output that way would distort drop-rate statistics. Rather than ship that unresolved
   * mapping, staged reading stays on for every pack — the alternative is a Coursework/Writing-up
   * reading list with no way to ever finish a paper, which is a worse first-week experience than
   * one extra always-on module.
   */
  stagedReading: {
    id: "stagedReading",
    label: "Staged reading",
    description: "Skim / Read / Deep dive — read a paper in stages.",
    core: true,
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
  insights: { id: "insights", label: "Insights", description: "AI-generated daily insight summaries." },
  /**
   * plan/FocusOS-v2-Plan-Day-Timeline.md §7.3 registered this as a `hidden` rollout flag through
   * DP0–DP5 while the new editor was being built. DP5 shipped it; the user has since chosen to
   * keep both editors permanently rather than sunset the old one, so this is now `optIn` instead
   * of `hidden` — a normal toggle in `/settings/features`, just never turned on for anyone by
   * default (including the "everything" pack) since switching a user's editor out from under them
   * without asking is worse than leaving it off until they opt in.
   */
  planDayTimeline: { id: "planDayTimeline", label: "Plan — Day timeline", description: "Drag-and-drop day editor with an editable time grid, instead of the simple block list.", optIn: true }
};

export const CORE_MODULES: ModuleId[] = Object.values(FEATURE_MODULES)
  .filter((module) => module.core)
  .map((module) => module.id);

/** Additive modules each starter pack turns on beyond the core set (plan §8.1) — stagedReading is core (see above), so it's not listed here even for Research. Hidden (rollout-flag) modules are excluded even from "everything": see `FeatureModule.hidden`. */
export const PACK_MODULES: Record<PackId, ModuleId[]> = {
  coursework: ["courses", "revise"],
  research: ["revise", "goals"],
  writing: ["goals", "weeklyCheckin"],
  everything: (Object.keys(FEATURE_MODULES) as ModuleId[]).filter((id) => !FEATURE_MODULES[id].hidden && !FEATURE_MODULES[id].optIn),
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

/**
 * Turns one module on/off — from a disabled-route prompt ("Revise is turned off. Turn it on?",
 * §9.2) or from the `/settings/features` toggle list (U5). Returns the `enabledModules` array to
 * write. Once a settings doc has an explicit list, every future resolution reads from it instead
 * of the pack, so this seeds the list with the pack's current additive set (not just the one
 * module) to avoid silently dropping every other module the pack had already turned on.
 * Enabling a module also enables whatever it `requires`; disabling one also disables whatever
 * currently-enabled module `requires` it, so the set never contains a dangling dependency.
 */
export function withModuleToggled(settings: { packId?: PackId; enabledModules?: string[] }, moduleId: ModuleId, enabled: boolean): ModuleId[] {
  const current = resolveEnabledModules(settings);
  if (enabled) {
    current.add(moduleId);
    for (const dep of FEATURE_MODULES[moduleId].requires ?? []) current.add(dep);
  } else {
    current.delete(moduleId);
    for (const other of Object.values(FEATURE_MODULES)) {
      if (other.requires?.includes(moduleId)) current.delete(other.id);
    }
  }
  return Array.from(current).filter((id) => !CORE_MODULES.includes(id));
}

/** Which module each alert's source concept belongs to (plan §9.2: the heads-up banner only shows alerts whose source module is enabled). */
export const ALERT_TYPE_MODULE: Record<string, ModuleId> = {
  "checkpoint.prep_overdue": "courses",
  "checkpoint.prep_not_started": "courses",
  "class.unlogged": "courses",
  "revision.backlog": "revise",
  "load_index.low_streak": "workload",
  "load_index.off_track": "workload",
  "paper.stale": "readingList",
  "goal.milestone_overdue": "goals",
  "task.external_due": "tasks"
};
