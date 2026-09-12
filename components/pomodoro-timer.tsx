"use client";

import { clsx } from "clsx";
import { Pause, Play, RotateCcw, SkipForward } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { MoreOptions } from "@/components/more-options";
import { PomodoroSurveyModal } from "@/components/pomodoro-survey-modal";
import { useUserSettings } from "@/hooks/use-user-settings";
import { savePomodoro } from "@/lib/firestore";
import { categories } from "@/lib/options";
import { BUILTIN_TIMER_PRESETS } from "@/lib/templates/builtin/timer-presets";
import type { Category, PomodoroSession, Task, TimerMode } from "@/types";

const modeLabel: Record<TimerMode, string> = {
  work: "Focus",
  short_break: "Short break",
  long_break: "Long break"
};

interface PendingSession {
  label: string;
  category: Category;
  mode: TimerMode;
  minutes: number;
  completedAt: string;
  cycle: number;
  taskId?: string;
  slotId?: string;
}

export function PomodoroTimer({
  sessions,
  tasks = [],
  compact = false,
  initialFocus,
  onInitialFocusConsumed
}: {
  sessions: PomodoroSession[];
  tasks?: Task[];
  compact?: boolean;
  /** DP5 S4 "Start focus session from a block" — pre-fills label/category/slotId and starts the timer running immediately, closing the plan-to-do loop in one click from `BlockInspector`. Consumed once (via `onInitialFocusConsumed`) so a re-render doesn't keep restarting the timer. */
  initialFocus?: { label: string; category: Category; slotId?: string } | null;
  onInitialFocusConsumed?: () => void;
}) {
  const { user } = useAuth();
  const { settings, loaded: settingsLoaded, update: updateSettings } = useUserSettings();
  const [work, setWork] = useState(25);
  const [shortBreak, setShortBreak] = useState(5);
  const [longBreak, setLongBreak] = useState(15);
  const [mode, setMode] = useState<TimerMode>("work");
  const [secondsLeft, setSecondsLeft] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const [cycle, setCycle] = useState(1);
  const [label, setLabel] = useState("writing");
  const [category, setCategory] = useState<Category>("research");
  const [taskId, setTaskId] = useState("");
  const [slotId, setSlotId] = useState<string | undefined>(undefined);
  const [pendingSession, setPendingSession] = useState<PendingSession | null>(null);
  const openTasks = tasks.filter((task) => task.status !== "done");

  useEffect(() => {
    if (!initialFocus) return;
    setLabel(initialFocus.label);
    setCategory(initialFocus.category);
    setSlotId(initialFocus.slotId);
    setTaskId("");
    setMode("work");
    // Explicit, not left to the `[duration, mode]` effect below: that effect only fires on a real
    // *change* to `mode`/`duration`, and `mode` is already "work" in the common case (it's the
    // default and where a session normally ends up) — leaving this implicit would start the timer
    // running with whatever seconds happened to be left over from the previous session, which
    // `completeSession` then reports as a full `duration`-minute session, inflating focus metrics.
    setSecondsLeft(work * 60);
    setRunning(true);
    onInitialFocusConsumed?.();
  }, [initialFocus]);

  const duration = useMemo(() => (mode === "work" ? work : mode === "short_break" ? shortBreak : longBreak), [longBreak, mode, shortBreak, work]);
  const progress = 100 - (secondsLeft / (duration * 60)) * 100;

  useEffect(() => {
    setSecondsLeft(duration * 60);
  }, [duration, mode]);

  // Pulls saved lengths (and built-in preset choices — lib/templates/builtin/timer-presets.ts) in once
  // settings load, so a preset applied elsewhere (Settings) takes effect here without a refresh.
  useEffect(() => {
    if (!settingsLoaded) return;
    if (typeof settings.workMinutes === "number") setWork(settings.workMinutes);
    if (typeof settings.shortBreakMinutes === "number") setShortBreak(settings.shortBreakMinutes);
    if (typeof settings.longBreakMinutes === "number") setLongBreak(settings.longBreakMinutes);
  }, [settingsLoaded, settings.workMinutes, settings.shortBreakMinutes, settings.longBreakMinutes]);

  function setLength(field: "work" | "shortBreak" | "longBreak", minutes: number) {
    if (field === "work") setWork(minutes);
    if (field === "shortBreak") setShortBreak(minutes);
    if (field === "longBreak") setLongBreak(minutes);
    updateSettings({
      workMinutes: field === "work" ? minutes : work,
      shortBreakMinutes: field === "shortBreak" ? minutes : shortBreak,
      longBreakMinutes: field === "longBreak" ? minutes : longBreak,
      timerPresetId: "custom"
    });
  }

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      setSecondsLeft((current) => Math.max(current - 1, 0));
    }, 1000);
    return () => window.clearInterval(id);
  }, [running]);

  useEffect(() => {
    if (secondsLeft !== 0 || !running || !user) return;
    completeSession();
  }, [secondsLeft, running, user]);

  function completeSession() {
    setRunning(false);
    const data: PendingSession = {
      label,
      category,
      mode,
      minutes: duration,
      completedAt: new Date().toISOString(),
      cycle,
      taskId: taskId || undefined,
      slotId
    };
    if (mode === "work") {
      setPendingSession(data);
    } else {
      finalizeSession(data);
    }
  }

  async function finalizeSession(data: PendingSession, survey?: { productivityRating: number; comment: string }) {
    await savePomodoro(user!.uid, {
      ...data,
      productivityRating: survey?.productivityRating,
      comment: survey?.comment || undefined
    });
    const nextMode: TimerMode = data.mode === "work" ? (data.cycle % 4 === 0 ? "long_break" : "short_break") : "work";
    if (data.mode === "work") setCycle((current) => current + 1);
    setMode(nextMode);
  }

  const minutes = Math.floor(secondsLeft / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (secondsLeft % 60).toString().padStart(2, "0");

  return (
    <section className={`card ${compact ? "p-4" : "p-5"}`}>
      <div>
        <p className="label">Focus timer</p>
        <h2 className={`${compact ? "mt-0.5 text-lg" : "mt-1 text-xl"} font-semibold`}>{modeLabel[mode]} session</h2>
      </div>
      <div className={compact ? "my-4" : "my-6"}>
        <div className="mb-3 h-2 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
          <div className="h-full bg-moss-600 transition-all" style={{ width: `${progress}%` }} />
        </div>
        <div className={`${compact ? "text-5xl" : "text-6xl"} text-center font-semibold tabular-nums tracking-tight`}>{minutes}:{seconds}</div>
        <p className="mt-2 text-center text-sm text-ink-500">Cycle {cycle} · {duration} minutes</p>
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
        <button className="btn-primary" onClick={() => setRunning((current) => !current)}>
          {running ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {running ? "Pause" : secondsLeft === duration * 60 ? "Start" : "Resume"}
        </button>
        <button className="btn-secondary" onClick={() => { setRunning(false); setSecondsLeft(duration * 60); }}>
          <RotateCcw className="h-4 w-4" />
          Reset
        </button>
        <button className="btn-secondary" onClick={completeSession}>
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
              onClick={() => {
                setWork(preset.workMinutes);
                setShortBreak(preset.shortBreakMinutes);
                setLongBreak(preset.longBreakMinutes);
                updateSettings({
                  workMinutes: preset.workMinutes,
                  shortBreakMinutes: preset.shortBreakMinutes,
                  longBreakMinutes: preset.longBreakMinutes,
                  timerPresetId: id as "classic" | "extended" | "short"
                });
              }}
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
      {pendingSession ? (
        <PomodoroSurveyModal
          label={pendingSession.label}
          onSave={(productivityRating, comment) => {
            finalizeSession(pendingSession, { productivityRating, comment });
            setPendingSession(null);
          }}
          onSkip={() => {
            finalizeSession(pendingSession);
            setPendingSession(null);
          }}
        />
      ) : null}
    </section>
  );
}
