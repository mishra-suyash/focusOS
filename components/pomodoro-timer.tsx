"use client";

import { Pause, Play, RotateCcw, SkipForward } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { PomodoroSurveyModal } from "@/components/pomodoro-survey-modal";
import { savePomodoro } from "@/lib/firestore";
import { categories } from "@/lib/options";
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
}

export function PomodoroTimer({ sessions, tasks = [], compact = false }: { sessions: PomodoroSession[]; tasks?: Task[]; compact?: boolean }) {
  const { user } = useAuth();
  const [work, setWork] = useState(25);
  const [shortBreak, setShortBreak] = useState(5);
  const [longBreak, setLongBreak] = useState(15);
  const [mode, setMode] = useState<TimerMode>("work");
  const [secondsLeft, setSecondsLeft] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const [cycle, setCycle] = useState(1);
  const [label, setLabel] = useState("writing");
  const [category, setCategory] = useState<Category>("writing");
  const [taskId, setTaskId] = useState("");
  const [pendingSession, setPendingSession] = useState<PendingSession | null>(null);
  const openTasks = tasks.filter((task) => task.status !== "done");

  const duration = useMemo(() => (mode === "work" ? work : mode === "short_break" ? shortBreak : longBreak), [longBreak, mode, shortBreak, work]);
  const progress = 100 - (secondsLeft / (duration * 60)) * 100;

  useEffect(() => {
    setSecondsLeft(duration * 60);
  }, [duration, mode]);

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
      taskId: taskId || undefined
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
        <p className="label">Pomodoro</p>
        <h2 className={`${compact ? "mt-0.5 text-lg" : "mt-1 text-xl"} font-semibold`}>{modeLabel[mode]} session</h2>
      </div>
      <div className={compact ? "my-4" : "my-6"}>
        <div className="mb-3 h-2 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
          <div className="h-full bg-moss-600 transition-all" style={{ width: `${progress}%` }} />
        </div>
        <div className={`${compact ? "text-5xl" : "text-6xl"} text-center font-semibold tabular-nums tracking-tight`}>{minutes}:{seconds}</div>
        <p className="mt-2 text-center text-sm text-ink-500">Cycle {cycle} · {duration} minutes</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Session label" />
        <select className="input" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
          {categories.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </div>
      {openTasks.length > 0 ? (
        <select className="input mt-3" value={taskId} onChange={(e) => setTaskId(e.target.value)} aria-label="Scheduled for task">
          <option value="">Not tied to a task</option>
          {openTasks.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </select>
      ) : null}
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
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-ink-500 outline-none focus:ring-2 focus:ring-moss-500">Timer settings</summary>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <label className="text-xs text-ink-500">Work<input className="input mt-1" type="number" min={5} value={work} onChange={(e) => setWork(Number(e.target.value))} /></label>
          <label className="text-xs text-ink-500">Short<input className="input mt-1" type="number" min={1} value={shortBreak} onChange={(e) => setShortBreak(Number(e.target.value))} /></label>
          <label className="text-xs text-ink-500">Long<input className="input mt-1" type="number" min={5} value={longBreak} onChange={(e) => setLongBreak(Number(e.target.value))} /></label>
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
