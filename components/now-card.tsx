"use client";

import { clsx } from "clsx";
import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { useFocusSession } from "@/components/focus-session-provider";
import { useCurrentMinute } from "@/hooks/use-current-minute";
import { clearDayOff, updateTask } from "@/lib/firestore";
import { describeObjective, objectiveChipText } from "@/lib/objectives";
import { categoryForSlotType } from "@/lib/timeline";
import { sittingRemainingMinutes, slotCoverageMinutes } from "@/lib/tracking";
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
import type { Checkpoint, Course, DailySchedule, Day, Goal, Paper, PomodoroSession, Task } from "@/types";

/**
 * plan/14 §7.2 — replaces `DailyScheduleWidget`'s compact three-metric grid and duplicate
 * current/next panels with one card: the current block, its assigned tasks as checkboxes, one
 * primary action, and a single "Next: X at HH:MM" line. `dayProgressPercent` in particular
 * ("Day complete 43%") measured wall-clock, not work, and never meant anything actionable — it's
 * deleted here, not carried over. The full-day list is still reachable, just collapsed behind
 * "Show the whole day".
 */
export function NowCard({
  date,
  schedule,
  tasks,
  courses,
  dayOff,
  sessions = [],
  papers = [],
  checkpoints = [],
  goals = []
}: {
  date: string;
  schedule?: DailySchedule;
  tasks: Task[];
  courses: Course[];
  dayOff?: Day["dayOff"];
  /** plan/16 §5.5 — today's sessions, so "Start focus" can arm what's *left* of the active sitting
   *  rather than restarting it, and the card can say how much of it is already covered. Defaults to
   *  empty, which reproduces the pre-plan/16 behavior for any caller that doesn't pass them. */
  sessions?: PomodoroSession[];
  papers?: Paper[];
  checkpoints?: Checkpoint[];
  goals?: Goal[];
}) {
  const { user } = useAuth();
  const { startFocus, running } = useFocusSession();
  const [showAll, setShowAll] = useState(false);
  const minute = useCurrentMinute();

  // plan/15 §5.1 — a day marked off replaces the whole card, the same "an explicit decision wins
  // over whatever's still sitting on the schedule" precedent `pickNextAction`'s day-off branch
  // already established (lib/next-action.ts) — a day off isn't "no plan," it's a plan not to work.
  if (dayOff) {
    return (
      <section className="card p-4">
        <p className="label mb-1">Now</p>
        <h2 className="text-lg font-semibold leading-snug">Day off</h2>
        {dayOff.reason ? <p className="mt-1 text-sm text-ink-600 dark:text-ink-300">{dayOff.reason}</p> : null}
        <button className="btn-secondary mt-3 py-1.5 text-xs" onClick={() => user && clearDayOff(user.uid, date)}>
          Undo — this is a working day
        </button>
      </section>
    );
  }

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
  // plan/16 §5.2/§5.5 — what this block is for, and how much of it is left. `describeObjective`'s
  // `attribution` is exactly `startFocus`'s context arguments, so the button below passes it straight
  // through instead of rebuilding the mapping per objective kind.
  const objective = active ? describeObjective(active, { courses, papers, checkpoints, tasks, goals }) : null;
  const chip = active ? objectiveChipText(active, objective) : null;
  const sittingLeft = active ? sittingRemainingMinutes(active, sessions) : 0;
  const sittingCovered = active ? slotCoverageMinutes(active, sessions) : 0;

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
            bucket: active.bucket,
            // plan/16 §5.2 — paper/pass context the block carries, which `startFocus` could not
            // accept before, so a reading block logged a session with no idea which paper it was for.
            paperId: objective?.attribution.paperId,
            passNo: objective?.attribution.passNo,
            // plan/16 §5.5 — arm what's left of this sitting, not the settings default. A 50-minute
            // block used to arm a 25-minute timer; a block already 22 minutes covered now arms 28.
            minutes: sittingLeft > 0 ? sittingLeft : undefined
          })
        }
      >
        {sittingLeft > 0 ? `Start focus · ${formatMinutes(sittingLeft)}` : "Start focus"}
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
          {chip ? (
            <p className="mt-1 text-xs font-medium text-moss-700 dark:text-moss-400">
              {objective?.href ? (
                <Link href={objective.href} className="underline decoration-dotted">
                  {chip}
                </Link>
              ) : (
                chip
              )}
            </p>
          ) : null}
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
            <div className="h-full bg-amberline" style={{ width: `${slotProgressPercent(active, minute)}%` }} />
          </div>
          <p className="mt-2 text-sm text-ink-500">
            {formatMinutes(Math.max(0, minute - minutesFromTime(active.startTime)))} elapsed ·{" "}
            {formatMinutes(Math.max(0, minutesFromTime(active.endTime) - minute))} remaining
            {/* plan/16 §5.5 — real logged coverage, distinct from wall-clock elapsed above: sitting
                through a block is not the same as working it, and the 60% rule that completes a block
                counts only the latter. */}
            {sittingCovered > 0 ? ` · ${formatMinutes(sittingCovered)} logged` : ""}
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
