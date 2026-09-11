import type { Task, TaskStatus } from "@/types";

/**
 * Plan §11.2 F5 — unchecking a task used to always write "todo", discarding "in_progress". Marking
 * a task done now stashes its current status in `previousStatus` so the checkbox's implicit
 * "todo" guess can be overridden by whatever the task actually was. Also normalizes `completedAt`
 * to match: set when landing on "done", cleared everywhere else.
 */
export function computeStatusPatch(task: Task, next: TaskStatus): Pick<Task, "status" | "completedAt"> & Partial<Pick<Task, "previousStatus">> {
  if (next === "done") {
    return { status: "done", previousStatus: task.status, completedAt: new Date().toISOString() };
  }
  if (task.status === "done" && next === "todo") {
    return { status: task.previousStatus ?? "todo", completedAt: undefined };
  }
  return { status: next, completedAt: undefined };
}
