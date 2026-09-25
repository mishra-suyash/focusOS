import type { ModuleId } from "@/lib/features";
import { minutesFromTime } from "@/lib/schedule";
import type { Checkpoint, ScheduleSlot, Task } from "@/types";

export type NextActionKind = "checkpoint-prep" | "revision" | "task" | "rest" | "block";

export interface NextAction {
  kind: NextActionKind;
  title: string;
  why: string;
  href: string;
  /** DP5 S5 "Schedule it" — set only for `kind: "task"`, the one case with a concrete Task to size a block from (`lib/timeline.ts`'s `createTaskBlock`). The other kinds still get a plain default-duration block from just their `title`. */
  taskId?: string;
  /** plan/14 §7.1 — set only for `kind: "block"`: the active or imminent `ScheduleSlot` itself, so
   *  the card can pre-arm the focus timer (§6.2) or offer "Log this class" without the caller
   *  having to re-look it up. */
  slot?: ScheduleSlot;
  /** True when `slot` is the day's *next* block (starts within 15 minutes) rather than the one
   *  active right now — changes the card's wording from "Now" to "Next: X at HH:MM". */
  upcoming?: boolean;
}

function daysBetween(laterKey: string, earlierKey: string): number {
  return Math.round((new Date(laterKey).getTime() - new Date(earlierKey).getTime()) / 86_400_000);
}

/**
 * A deterministic priority cascade — no model call, no decision left for the
 * user to make at the moment their willpower is lowest. plan/14 §7.1 gave this cascade a new
 * first branch: if a block is active right now (or starts within 15 minutes), that block IS the
 * next action — the plan for right now beats any of the four content-priority branches below it,
 * which fall through unchanged when there's no schedule or a gap in it.
 */
export function pickNextAction({
  checkpoints,
  dueRevisionCount,
  tasks,
  loadIndexValue,
  todayKey,
  weekEndKey,
  enabledModules,
  activeSlot,
  nextSlot,
  minute
}: {
  checkpoints: Checkpoint[];
  dueRevisionCount: number;
  tasks: Task[];
  loadIndexValue: number;
  todayKey: string;
  weekEndKey: string;
  /** Plan §9.2: "Up next" must never recommend an action in a disabled module. Omitted = every module counts as enabled (existing callers, tests). */
  enabledModules?: Set<ModuleId>;
  /** plan/14 §7.1 — today's active block (`getActiveSlot`), if any. Omitted = the cascade behaves
   *  exactly as it did before this branch existed (existing callers, tests). */
  activeSlot?: ScheduleSlot;
  /** Today's next block (`getNextSlot`), checked against `minute` for the "starts within 15
   *  minutes" branch. */
  nextSlot?: ScheduleSlot;
  /** Minutes since midnight — required whenever `nextSlot` is given, to know how soon it starts. */
  minute?: number;
}): NextAction | null {
  const enabled = (id: ModuleId) => !enabledModules || enabledModules.has(id);

  if (activeSlot) {
    return {
      kind: "block",
      title: activeSlot.title,
      why: activeSlot.type === "class" ? "In progress" : "Active now",
      href: "/dashboard",
      slot: activeSlot
    };
  }
  if (nextSlot && minute != null) {
    const minutesUntil = minutesFromTime(nextSlot.startTime) - minute;
    if (minutesUntil >= 0 && minutesUntil <= 15) {
      return {
        kind: "block",
        title: nextSlot.title,
        why: `Starts in ${minutesUntil} minute${minutesUntil === 1 ? "" : "s"}`,
        href: "/dashboard",
        slot: nextSlot,
        upcoming: true
      };
    }
  }

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
  const priorityTask = openTasks
    .filter((task) => task.priority === "high" && task.dueDate && task.dueDate <= weekEndKey)
    .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1))[0];
  const fallbackTask = priorityTask ? undefined : openTasks.find((task) => task.dueDate === todayKey);
  const topTask = priorityTask ?? fallbackTask;

  if (topTask) {
    // The fallback branch is a plain first-match on "due today", not priority-sorted — it needs its
    // own honest `why` rather than reusing the priority branch's claim (plan/13 A10).
    const why = priorityTask ? "Highest-priority open task due this week" : "Due today";
    return { kind: "task", title: topTask.title, why, href: "/tasks", taskId: topTask.id };
  }

  if (enabled("analytics") && loadIndexValue > 1.3) {
    return { kind: "rest", title: "Take it easy", why: "You're already well ahead of today's target", href: "/analytics" };
  }

  return null;
}
