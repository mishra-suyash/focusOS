import type { ModuleId } from "@/lib/features";
import type { Checkpoint, Task } from "@/types";

export type NextActionKind = "checkpoint-prep" | "revision" | "task" | "rest";

export interface NextAction {
  kind: NextActionKind;
  title: string;
  why: string;
  href: string;
  /** DP5 S5 "Schedule it" — set only for `kind: "task"`, the one case with a concrete Task to size a block from (`lib/timeline.ts`'s `createTaskBlock`). The other kinds still get a plain default-duration block from just their `title`. */
  taskId?: string;
}

function daysBetween(laterKey: string, earlierKey: string): number {
  return Math.round((new Date(laterKey).getTime() - new Date(earlierKey).getTime()) / 86_400_000);
}

/**
 * A deterministic priority cascade — no model call, no decision left for the
 * user to make at the moment their willpower is lowest. Order: an urgent
 * checkpoint's prep window, the revision queue, the top open task due this
 * week, or an explicit "you're already ahead" rest suggestion.
 */
export function pickNextAction({
  checkpoints,
  dueRevisionCount,
  tasks,
  loadIndexValue,
  todayKey,
  weekEndKey,
  enabledModules
}: {
  checkpoints: Checkpoint[];
  dueRevisionCount: number;
  tasks: Task[];
  loadIndexValue: number;
  todayKey: string;
  weekEndKey: string;
  /** Plan §9.2: "Up next" must never recommend an action in a disabled module. Omitted = every module counts as enabled (existing callers, tests). */
  enabledModules?: Set<ModuleId>;
}): NextAction | null {
  const enabled = (id: ModuleId) => !enabledModules || enabledModules.has(id);

  const urgent =
    enabled("courses") &&
    checkpoints
      .filter((checkpoint) => checkpoint.requiresPrep && checkpoint.status !== "done" && checkpoint.status !== "missed")
      .map((checkpoint) => ({ checkpoint, daysUntil: daysBetween(checkpoint.dueAt, todayKey) }))
      .filter(({ checkpoint, daysUntil }) => daysUntil >= 0 && daysUntil <= checkpoint.prepLeadDays)
      .sort((a, b) => a.daysUntil - b.daysUntil)[0];

  if (urgent) {
    return {
      kind: "checkpoint-prep",
      title: `Prep for ${urgent.checkpoint.title}`,
      why: `Due in ${urgent.daysUntil} day${urgent.daysUntil === 1 ? "" : "s"}`,
      href: "/courses"
    };
  }

  if (enabled("revise") && dueRevisionCount > 0) {
    return {
      kind: "revision",
      title: `Review ${dueRevisionCount} due item${dueRevisionCount === 1 ? "" : "s"}`,
      why: "Your spaced-repetition queue is ready",
      href: "/review"
    };
  }

  const openTasks = tasks.filter((task) => task.status !== "done");
  const topTask =
    openTasks
      .filter((task) => task.priority === "high" && task.dueDate && task.dueDate <= weekEndKey)
      .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1))[0] ?? openTasks.find((task) => task.dueDate === todayKey);

  if (topTask) {
    return { kind: "task", title: topTask.title, why: "Highest-priority open task due this week", href: "/tasks", taskId: topTask.id };
  }

  if (enabled("analytics") && loadIndexValue > 1.3) {
    return { kind: "rest", title: "Take it easy", why: "You're already well ahead of today's target", href: "/analytics" };
  }

  return null;
}
