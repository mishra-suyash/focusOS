"use client";

import { clsx } from "clsx";
import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { useFocusSession } from "@/components/focus-session-provider";
import { useCurrentMinute } from "@/hooks/use-current-minute";
import { updateTask } from "@/lib/firestore";
import { categoryForSlotType } from "@/lib/timeline";
import { computeStatusPatch } from "@/lib/tasks";
import {
  computeSlotStatus,
  formatMinutes,
  getActiveSlot,
  getNextSlot,
  minutesFromTime,
  slotProgressPercent,
  slotTypeLabels,
  slotTypeStyles,
  sortedSlots
} from "@/lib/schedule";
import type { Course, DailySchedule, Task } from "@/types";

/**
 * plan/14 §7.2 — replaces `DailyScheduleWidget`'s compact three-metric grid and duplicate
 * current/next panels with one card: the current block, its assigned tasks as checkboxes, one
 * primary action, and a single "Next: X at HH:MM" line. `dayProgressPercent` in particular
 * ("Day complete 43%") measured wall-clock, not work, and never meant anything actionable — it's
 * deleted here, not carried over. The full-day list is still reachable, just collapsed behind
 * "Show the whole day".
 */
export function NowCard({ schedule, tasks, courses }: { schedule?: DailySchedule; tasks: Task[]; courses: Course[] }) {
  const { user } = useAuth();
  const { startFocus, running } = useFocusSession();
  const [showAll, setShowAll] = useState(false);
  const minute = useCurrentMinute();

  if (!schedule || schedule.slots.length === 0) {
    return (
      <section className="card p-4">
        <p className="label mb-1">Now</p>
        <p className="text-sm text-ink-600 dark:text-ink-300">No plan for today yet.</p>
        <Link href="/plan/week" className="btn-primary mt-3">
          Plan this week
        </Link>
      </section>
    );
  }

  const slots = sortedSlots(schedule.slots);
  const active = getActiveSlot(slots, minute);
  const next = getNextSlot(slots, minute);
  const assignedTasks = active ? (active.assignedTaskIds ?? []).map((id) => tasks.find((t) => t.id === id)).filter((t): t is Task => Boolean(t)) : [];
  const activeCourse = active?.courseId ? courses.find((c) => c.id === active.courseId) : undefined;

  function primaryAction() {
    if (!active) return null;
    if (active.type === "class") {
      return (
        <Link href="/courses" className="btn-primary py-1.5 text-xs">
          Log this class
        </Link>
      );
    }
    if (running) {
      return <span className="text-xs text-ink-500">A focus session is already running.</span>;
    }
    return (
      <button
        className="btn-primary py-1.5 text-xs"
        onClick={() =>
          startFocus({
            label: active.title,
            category: categoryForSlotType(active.type),
            slotId: active.id,
            taskId: assignedTasks.length === 1 ? assignedTasks[0].id : undefined,
            courseId: active.courseId,
            bucket: active.bucket
          })
        }
      >
        Start focus
      </button>
    );
  }

  return (
    <section className="card p-4">
      <p className="label mb-2">Now</p>
      {active ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className={clsx("rounded border px-2 py-1 text-xs font-medium", slotTypeStyles[active.type])}>{slotTypeLabels[active.type]}</span>
            <span className="text-sm text-ink-500">
              {active.startTime} – {active.endTime}
            </span>
            {activeCourse ? <span className="rounded bg-ink-100 px-1.5 py-0.5 text-xs text-ink-600 dark:bg-ink-800 dark:text-ink-300">{activeCourse.code || activeCourse.name}</span> : null}
          </div>
          <h2 className="mt-2 text-lg font-semibold leading-snug">{active.title}</h2>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
            <div className="h-full bg-amberline" style={{ width: `${slotProgressPercent(active, minute)}%` }} />
          </div>
          <p className="mt-2 text-sm text-ink-500">
            {formatMinutes(Math.max(0, minute - minutesFromTime(active.startTime)))} elapsed ·{" "}
            {formatMinutes(Math.max(0, minutesFromTime(active.endTime) - minute))} remaining
          </p>
          {assignedTasks.length > 0 ? (
            <div className="mt-3 space-y-1">
              {assignedTasks.map((task) => (
                <label key={task.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={task.status === "done"}
                    onChange={(e) => user && updateTask(user.uid, task.id, computeStatusPatch(task, e.target.checked ? "done" : "todo"))}
                  />
                  <span className={clsx(task.status === "done" && "text-ink-400 line-through")}>{task.title}</span>
                </label>
              ))}
            </div>
          ) : null}
          <div className="mt-3">{primaryAction()}</div>
        </>
      ) : (
        <p className="text-sm text-ink-500">No block is active right now.</p>
      )}
      <p className="mt-3 border-t border-ink-100 pt-2 text-sm text-ink-500 dark:border-ink-800">
        {next ? (
          <>
            Next: <span className="font-medium text-ink-700 dark:text-ink-300">{next.title}</span> at {next.startTime}
          </>
        ) : (
          "Nothing else planned today."
        )}
      </p>
      <button className="btn-secondary mt-3 w-full py-1.5 text-xs" onClick={() => setShowAll((v) => !v)}>
        {showAll ? "Hide the whole day" : "Show the whole day"}
      </button>
      {showAll ? (
        <div className="mt-3 space-y-1.5">
          {slots.map((slot) => {
            const status = computeSlotStatus(slot, minute);
            const displayStatus = status === "completed" && slot.status !== "completed" ? "past" : status;
            return (
              <div
                key={slot.id}
                className={clsx(
                  "grid grid-cols-[70px_1fr_auto] gap-2 rounded-md border p-2 text-xs",
                  status === "active" ? "border-moss-600 bg-moss-600/5" : "border-ink-200 dark:border-ink-800"
                )}
              >
                <span className="font-mono text-ink-500">
                  {slot.startTime}-{slot.endTime}
                </span>
                <span className="truncate font-medium">{slot.title}</span>
                <span className="capitalize text-ink-500">{displayStatus}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
