"use client";

import { Check, Circle, Clock, Repeat, Trash2 } from "lucide-react";
import { InfoHint } from "@/components/info-hint";
import { categoryLabels } from "@/lib/options";
import { DEFAULT_MAX_CHUNK_MINUTES, taskBlockMinutes } from "@/lib/timeline";
import { loggedMinutesForTask } from "@/lib/tracking";
import type { Course, PomodoroSession, Task, TaskStatus } from "@/types";
import { clsx } from "clsx";

export function TaskList({
  tasks,
  onStatus,
  onDelete,
  empty = "No tasks here yet.",
  courses = [],
  sessions,
  workMinutes = 25
}: {
  tasks: Task[];
  onStatus: (task: Task, status: TaskStatus) => Promise<void>;
  onDelete?: (task: Task) => Promise<void>;
  empty?: string;
  /** plan/10.FocusOS-v2-Connected-Flow-Plan.md §5.3 — resolves Task.courseId to a name/color chip. Absent tasks just show no chip, same as before this prop existed. */
  courses?: Course[];
  /** plan/16 §5.1 — real focus-session history, for the minutes line beside the session count.
   *  Absent = the session count alone, exactly as this list read before `16`. */
  sessions?: PomodoroSession[];
  workMinutes?: number;
}) {
  if (tasks.length === 0) {
    return <div className="rounded-md border border-dashed border-ink-300 p-5 text-sm text-ink-500 dark:border-ink-700">{empty}</div>;
  }

  return (
    <div className="space-y-2">
      {tasks.map((task) => {
        const course = task.courseId ? courses.find((item) => item.id === task.courseId) : undefined;
        return (
          <article key={task.id} className="rounded-md border border-ink-200 bg-white p-3 dark:border-ink-800 dark:bg-ink-900">
            <div className="flex items-start gap-3">
              <button
                className="mt-0.5 rounded-full text-ink-400 outline-none focus:ring-2 focus:ring-moss-500"
                onClick={() => onStatus(task, task.status === "done" ? "todo" : "done")}
                aria-label={task.status === "done" ? "Mark task todo" : "Mark task done"}
              >
                {task.status === "done" ? <Check className="h-5 w-5 text-moss-600" /> : <Circle className="h-5 w-5" />}
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className={clsx("text-sm font-medium", task.status === "done" && "text-ink-400 line-through")}>{task.title}</h3>
                  <span
                    className={clsx(
                      "rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase",
                      task.priority === "high" && "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200",
                      task.priority === "medium" && "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
                      task.priority === "low" && "bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300"
                    )}
                  >
                    {task.priority}
                  </span>
                  <span className="rounded bg-moss-600/10 px-1.5 py-0.5 text-[11px] font-medium text-moss-700 dark:text-moss-500">
                    {categoryLabels[task.category]}
                  </span>
                  {course ? (
                    <span
                      className={clsx(
                        "rounded px-1.5 py-0.5 text-[11px] font-medium",
                        course.status === "dropped"
                          ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                          : "bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300"
                      )}
                      // plan/16 — a dropped course's tasks stop being *proposed* anywhere, but they
                      // are still the user's tasks and still exist, so here they are labelled rather
                      // than hidden. Silently vanishing work is how you stop trusting the list; this
                      // way the reason they no longer turn up in planning is visible and the task can
                      // be finished or deleted deliberately.
                      title={course.status === "dropped" ? "This course is dropped — its tasks are no longer planned" : undefined}
                    >
                      {course.code || course.name}
                      {course.status === "dropped" ? " · dropped" : ""}
                    </span>
                  ) : null}
                  {task.seriesId ? (
                    <span className="inline-flex items-center gap-1 text-ink-400" title="Generated from a recurring commitment">
                      <Repeat className="h-3 w-3" />
                    </span>
                  ) : null}
                  {task.kind === "external" ? (
                    <span className="inline-flex items-center gap-1 rounded bg-sky-100 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-sky-700 dark:bg-sky-950 dark:text-sky-300">
                      Hard deadline
                      <InfoHint term="hardDeadline" />
                    </span>
                  ) : null}
                </div>
                {task.description ? <p className="mt-1 text-sm text-ink-600 dark:text-ink-300">{task.description}</p> : null}
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-500">
                  {task.dueDate ? <span>Due {task.dueDate}</span> : null}
                  {task.estimatedPomodoros ? (
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {task.completedPomodoros ?? 0} of {task.estimatedPomodoros} focus session{task.estimatedPomodoros === 1 ? "" : "s"}
                      {task.status !== "done" ? ` · ${Math.max(0, task.estimatedPomodoros - (task.completedPomodoros ?? 0))} left` : ""}
                    </span>
                  ) : null}
                  {/* plan/16 §5.1 — the minutes line, beside the session count rather than instead of
                      it. The count answers "how many times have I sat with this", which is genuinely
                      useful; it just can't answer "how much is left", because it advances once per
                      session over a 5-minute floor, so a 6-minute session and a 50-minute one move it
                      identically. The minutes are real logged `PomodoroSession.minutes`, and they are
                      the number the weekly planner subtracts when deciding what to propose. */}
                  {sessions && task.estimatedPomodoros ? <MinutesLine task={task} sessions={sessions} workMinutes={workMinutes} /> : null}
                  <button
                    className={clsx(
                      "rounded px-1.5 py-0.5 font-medium",
                      task.status === "in_progress"
                        ? "bg-moss-600/15 text-moss-700 dark:text-moss-400"
                        : "text-ink-500 hover:text-moss-700"
                    )}
                    onClick={() => onStatus(task, task.status === "in_progress" ? "todo" : "in_progress")}
                    aria-pressed={task.status === "in_progress"}
                  >
                    In progress
                  </button>
                </div>
              </div>
              {onDelete ? (
                <button className="rounded p-1 text-ink-400 hover:text-red-600 focus:outline-none focus:ring-2 focus:ring-red-500" onClick={() => onDelete(task)}>
                  <Trash2 className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

/**
 * plan/16 §5.1 — "logged of planned, n min left", in minutes, plus how many sittings that much work
 * splits into so the figure connects to the blocks the planner will actually propose. Every number
 * here is derived: nothing about a task's stored `completedPomodoros` changes.
 */
function MinutesLine({ task, sessions, workMinutes }: { task: Task; sessions: PomodoroSession[]; workMinutes: number }) {
  const total = taskBlockMinutes(task, workMinutes);
  const logged = loggedMinutesForTask(sessions, task.id);
  const left = Math.max(0, total - logged);
  const sittings = Math.ceil(left / (task.maxChunkMinutes ?? DEFAULT_MAX_CHUNK_MINUTES));
  return (
    <span className="inline-flex items-center gap-1">
      {logged} of {total} min
      {task.status !== "done" && left > 0 ? ` · ${left} min left${sittings > 1 ? ` (${sittings} sittings)` : ""}` : ""}
    </span>
  );
}
