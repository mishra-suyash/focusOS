"use client";

import { Check, Circle, Clock, Trash2 } from "lucide-react";
import { InfoHint } from "@/components/info-hint";
import { categoryLabels } from "@/lib/options";
import type { Task, TaskStatus } from "@/types";
import { clsx } from "clsx";

export function TaskList({
  tasks,
  onStatus,
  onDelete,
  empty = "No tasks here yet."
}: {
  tasks: Task[];
  onStatus: (task: Task, status: TaskStatus) => Promise<void>;
  onDelete?: (task: Task) => Promise<void>;
  empty?: string;
}) {
  if (tasks.length === 0) {
    return <div className="rounded-md border border-dashed border-ink-300 p-5 text-sm text-ink-500 dark:border-ink-700">{empty}</div>;
  }

  return (
    <div className="space-y-2">
      {tasks.map((task) => (
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
                    {task.estimatedPomodoros} focus session{task.estimatedPomodoros === 1 ? "" : "s"}
                  </span>
                ) : null}
                <button className="hover:text-moss-700" onClick={() => onStatus(task, "in_progress")}>
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
      ))}
    </div>
  );
}
