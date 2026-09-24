"use client";

import { clsx } from "clsx";
import { Pause, Play, RotateCcw, SkipForward } from "lucide-react";
import Link from "next/link";
import { useFocusSession } from "@/components/focus-session-provider";
import { InfoHint } from "@/components/info-hint";
import { MoreOptions } from "@/components/more-options";
import { useUserSettings } from "@/hooks/use-user-settings";
import { categories } from "@/lib/options";
import { BUILTIN_TIMER_PRESETS } from "@/lib/templates/builtin/timer-presets";
import type { Category, PomodoroSession, Task } from "@/types";

/** A view over `FocusSessionProvider` — the timer's state lives there now (so it survives
 * navigating away from whichever page mounts this), not in local state. */
export function PomodoroTimer({
  sessions,
  tasks = [],
  compact = false
}: {
  sessions: PomodoroSession[];
  tasks?: Task[];
  compact?: boolean;
}) {
  const { settings } = useUserSettings();
  const {
    mode,
    modeLabel,
    secondsLeft,
    running,
    duration,
    progress,
    cycle,
    label,
    category,
    taskId,
    work,
    shortBreak,
    longBreak,
    setLabel,
    setCategory,
    setTaskId,
    setSlotId,
    setCourseId,
    setBucket,
    setLength,
    applyPreset,
    toggleRunning,
    reset,
    finishNow
  } = useFocusSession();
  const openTasks = tasks.filter((task) => task.status !== "done");

  const minutes = Math.floor(secondsLeft / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (secondsLeft % 60).toString().padStart(2, "0");

  return (
    <section className={`card ${compact ? "p-4" : "p-5"}`}>
      <div>
        <p className="label">Focus timer</p>
        <h2 className={`${compact ? "mt-0.5 text-lg" : "mt-1 text-xl"} font-semibold`}>{modeLabel} session</h2>
      </div>
      <div className={compact ? "my-4" : "my-6"}>
        <div className="mb-3 h-2 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
          <div className="h-full bg-moss-600 transition-all" style={{ width: `${progress}%` }} />
        </div>
        <div className={`${compact ? "text-5xl" : "text-6xl"} text-center font-semibold tabular-nums tracking-tight`}>{minutes}:{seconds}</div>
        <p className="mt-2 flex items-center justify-center gap-1 text-center text-sm text-ink-500">
          {mode === "work" ? (
            <>
              Cycle {cycle}
              <InfoHint term="focusCycle" />· {duration} minutes
            </>
          ) : (
            `${duration} minutes`
          )}
        </p>
      </div>
      {openTasks.length > 0 ? (
        <select
          className="input"
          value={taskId}
          onChange={(e) => {
            const nextTaskId = e.target.value;
            setTaskId(nextTaskId);
            setSlotId(undefined); // picking a task by hand means this session is no longer "from" whichever block started it
            // Plan §9.5: label/category default to the linked task's when one is picked — label
            // is now collapsed behind "More options", so this is the only way most sessions get
            // a label at all (it drives what "Today history" and the end-of-session survey show).
            const linkedTask = openTasks.find((task) => task.id === nextTaskId);
            if (linkedTask) {
              setCategory(linkedTask.category);
              setLabel(linkedTask.title);
              // plan/14 §6.2/§6.4 — a manually-picked task still carries its own course/bucket
              // attribution; a picked task with neither clears the slot's (courseId/bucket are
              // otherwise sticky from whichever block was active before the dropdown was touched).
              setCourseId(linkedTask.courseId);
              setBucket(linkedTask.bucket);
            } else {
              setCourseId(undefined);
              setBucket(undefined);
            }
          }}
          aria-label="Working on"
        >
          <option value="">Not tied to a task</option>
          {openTasks.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </select>
      ) : (
        // F10 (plan §11.2) — keep the field's slot instead of letting it disappear (a layout
        // jump), with an explicit way to fix the actual problem (no open tasks).
        <div className="input flex items-center justify-between text-ink-500">
          <span>No open tasks</span>
          <Link href="/tasks" className="text-xs font-medium text-moss-700 dark:text-moss-400">
            Add one
          </Link>
        </div>
      )}
      <div className="mt-4 grid grid-cols-3 gap-2">
        <button className="btn-primary" onClick={toggleRunning}>
          {running ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {running ? "Pause" : secondsLeft === duration * 60 ? "Start" : "Resume"}
        </button>
        <button className="btn-secondary" onClick={reset}>
          <RotateCcw className="h-4 w-4" />
          Reset
        </button>
        <button className="btn-secondary" onClick={finishNow}>
          <SkipForward className="h-4 w-4" />
          Finish
        </button>
      </div>
      <div className="mt-3">
        <MoreOptions label="Label & category">
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Session label" />
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
            {categories.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </MoreOptions>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-ink-500 outline-none focus:ring-2 focus:ring-moss-500">Timer settings</summary>
        <div className="mt-3 flex flex-wrap gap-2">
          {Object.entries(BUILTIN_TIMER_PRESETS).map(([id, preset]) => (
            <button
              key={id}
              type="button"
              className={clsx("btn-secondary py-1 text-xs", settings.timerPresetId === id && "ring-2 ring-moss-500")}
              title={preset.description}
              onClick={() => applyPreset(preset.workMinutes, preset.shortBreakMinutes, preset.longBreakMinutes, id as "classic" | "extended" | "short")}
            >
              {preset.name}
            </button>
          ))}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <label className="text-xs text-ink-500">Work<input className="input mt-1" type="number" min={5} value={work} onChange={(e) => setLength("work", Number(e.target.value))} /></label>
          <label className="text-xs text-ink-500">Short<input className="input mt-1" type="number" min={1} value={shortBreak} onChange={(e) => setLength("shortBreak", Number(e.target.value))} /></label>
          <label className="text-xs text-ink-500">Long<input className="input mt-1" type="number" min={5} value={longBreak} onChange={(e) => setLength("longBreak", Number(e.target.value))} /></label>
        </div>
      </details>
      <div className={compact ? "mt-3" : "mt-5"}>
        <p className="label mb-2">Today history</p>
        <div className="space-y-2">
          {sessions.slice(0, compact ? 2 : 4).map((session) => (
            <div key={session.id} className="rounded-md bg-ink-50 px-3 py-2 text-sm dark:bg-ink-800">
              <div className="flex justify-between">
                <span>{session.label}</span>
                <span className="text-ink-500">
                  {session.minutes}m{session.productivityRating ? ` · ${session.productivityRating}/5` : ""}
                </span>
              </div>
              {session.comment ? <p className="mt-1 text-xs text-ink-500">{session.comment}</p> : null}
            </div>
          ))}
          {sessions.length === 0 ? <p className="text-sm text-ink-500">Completed sessions will appear here.</p> : null}
        </div>
      </div>
    </section>
  );
}
