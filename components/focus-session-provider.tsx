"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { PomodoroSurveyModal } from "@/components/pomodoro-survey-modal";
import { useUserSettings } from "@/hooks/use-user-settings";
import { savePomodoro } from "@/lib/firestore";
import type { Category, TimerMode, TimerPresetId } from "@/types";

const MODE_LABELS: Record<TimerMode, string> = {
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

interface FocusSessionContextValue {
  mode: TimerMode;
  modeLabel: string;
  secondsLeft: number;
  running: boolean;
  duration: number;
  progress: number;
  cycle: number;
  label: string;
  category: Category;
  taskId: string;
  slotId?: string;
  work: number;
  shortBreak: number;
  longBreak: number;
  setLabel: (label: string) => void;
  setCategory: (category: Category) => void;
  setTaskId: (taskId: string) => void;
  setSlotId: (slotId: string | undefined) => void;
  setLength: (field: "work" | "shortBreak" | "longBreak", minutes: number) => void;
  /** Applies a built-in preset's three lengths together in one settings write (unlike `setLength`,
   * which is for a single field edited by hand) and tags `timerPresetId` accordingly. */
  applyPreset: (workMinutes: number, shortBreakMinutes: number, longBreakMinutes: number, presetId: TimerPresetId) => void;
  toggleRunning: () => void;
  reset: () => void;
  finishNow: () => void;
  /** DP5 S4 "Start focus session from a block" — pre-fills label/category/slotId and starts the
   * timer immediately. A plain method call rather than a prop it used to be: since the timer now
   * lives in this provider (not a component that mounts/unmounts with the dashboard page), there's
   * no "consume once" dance needed — the caller (the dashboard page, reacting to its own
   * `?startFocus=1` query param) just calls this and clears the param itself. */
  startFocus: (opts: { label: string; category: Category; slotId?: string }) => void;
}

const FocusSessionContext = createContext<FocusSessionContextValue | null>(null);

/**
 * Owns the Pomodoro timer's state at the app-shell level (mounted in `app/(app)/layout.tsx`,
 * alongside `WorkdaySessionProvider`) instead of inside `PomodoroTimer`, so a running session
 * survives navigating away from `/dashboard` — a prerequisite for the floating widget (it needs a
 * source of truth that outlives whichever page happens to be mounted) and a real fix in its own
 * right (previously, leaving `/dashboard` while a session was running silently killed it with no
 * completion logged). `PomodoroTimer` becomes a view over this context; the survey modal moves
 * here too, since it must be able to appear regardless of which page is open when a work session
 * ends — a modal that only `PomodoroTimer` could render would leave `pendingSession` stuck forever
 * on any other page.
 */
export function FocusSessionProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { settings, loaded: settingsLoaded, update: updateSettings } = useUserSettings();
  const [work, setWork] = useState(25);
  const [shortBreak, setShortBreak] = useState(5);
  const [longBreak, setLongBreak] = useState(15);
  const [mode, setMode] = useState<TimerMode>("work");
  const [secondsLeft, setSecondsLeft] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  // Epoch ms the running countdown is anchored to (null while paused) — see pomodoro-timer.tsx's
  // original comment (this logic moved from there unchanged): recomputed from this real timestamp
  // rather than decremented tick-by-tick so a throttled/backgrounded tab can't drift or stall.
  const [targetEndTime, setTargetEndTime] = useState<number | null>(null);
  const [cycle, setCycle] = useState(1);
  const [label, setLabel] = useState("writing");
  const [category, setCategory] = useState<Category>("research");
  const [taskId, setTaskId] = useState("");
  const [slotId, setSlotId] = useState<string | undefined>(undefined);
  const [pendingSession, setPendingSession] = useState<PendingSession | null>(null);

  const duration = useMemo(() => (mode === "work" ? work : mode === "short_break" ? shortBreak : longBreak), [longBreak, mode, shortBreak, work]);
  const progress = 100 - (secondsLeft / (duration * 60)) * 100;

  useEffect(() => {
    const totalSeconds = duration * 60;
    setSecondsLeft(totalSeconds);
    setTargetEndTime(running ? Date.now() + totalSeconds * 1000 : null);
  }, [duration, mode]);

  // Pulls saved lengths (and built-in preset choices) in once settings load, so a preset applied
  // in Settings takes effect here without a refresh.
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

  function applyPreset(nextWork: number, nextShortBreak: number, nextLongBreak: number, presetId: TimerPresetId) {
    setWork(nextWork);
    setShortBreak(nextShortBreak);
    setLongBreak(nextLongBreak);
    updateSettings({ workMinutes: nextWork, shortBreakMinutes: nextShortBreak, longBreakMinutes: nextLongBreak, timerPresetId: presetId });
  }

  useEffect(() => {
    if (!running || targetEndTime == null) return;
    function syncFromClock() {
      setSecondsLeft(Math.max(0, Math.ceil((targetEndTime! - Date.now()) / 1000)));
    }
    syncFromClock();
    const id = window.setInterval(syncFromClock, 1000);
    return () => window.clearInterval(id);
  }, [running, targetEndTime]);

  // A tab that was backgrounded can have its setInterval throttled or fully suspended — resync the
  // instant the tab is foregrounded again instead of waiting for the next (possibly late) tick.
  useEffect(() => {
    if (!running || targetEndTime == null) return;
    function syncOnForeground() {
      if (document.visibilityState !== "visible") return;
      setSecondsLeft(Math.max(0, Math.ceil((targetEndTime! - Date.now()) / 1000)));
    }
    document.addEventListener("visibilitychange", syncOnForeground);
    window.addEventListener("focus", syncOnForeground);
    return () => {
      document.removeEventListener("visibilitychange", syncOnForeground);
      window.removeEventListener("focus", syncOnForeground);
    };
  }, [running, targetEndTime]);

  useEffect(() => {
    if (secondsLeft !== 0 || !running || !user) return;
    // The tab may have been backgrounded well past the real end time before this effect got to run
    // — stamp completion at `targetEndTime`, not `Date.now()`, so a session doesn't get logged
    // hours late or land on the wrong day across a midnight boundary.
    completeSession(targetEndTime ?? undefined);
  }, [secondsLeft, running, user]);

  function toggleRunning() {
    if (running) {
      setSecondsLeft(targetEndTime == null ? secondsLeft : Math.max(0, Math.ceil((targetEndTime - Date.now()) / 1000)));
      setTargetEndTime(null);
      setRunning(false);
      return;
    }
    setTargetEndTime(Date.now() + secondsLeft * 1000);
    setRunning(true);
  }

  function reset() {
    setRunning(false);
    setTargetEndTime(null);
    setSecondsLeft(duration * 60);
  }

  function completeSession(endedAt?: number) {
    setRunning(false);
    setTargetEndTime(null);
    const data: PendingSession = {
      label,
      category,
      mode,
      minutes: duration,
      completedAt: new Date(endedAt ?? Date.now()).toISOString(),
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

  function startFocus(opts: { label: string; category: Category; slotId?: string }) {
    setLabel(opts.label);
    setCategory(opts.category);
    setSlotId(opts.slotId);
    setTaskId("");
    setMode("work");
    const totalSeconds = work * 60;
    setSecondsLeft(totalSeconds);
    setTargetEndTime(Date.now() + totalSeconds * 1000);
    setRunning(true);
  }

  const value: FocusSessionContextValue = {
    mode,
    modeLabel: MODE_LABELS[mode],
    secondsLeft,
    running,
    duration,
    progress,
    cycle,
    label,
    category,
    taskId,
    slotId,
    work,
    shortBreak,
    longBreak,
    setLabel,
    setCategory,
    setTaskId,
    setSlotId,
    setLength,
    applyPreset,
    toggleRunning,
    reset,
    finishNow: () => completeSession(),
    startFocus
  };

  return (
    <FocusSessionContext.Provider value={value}>
      {children}
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
    </FocusSessionContext.Provider>
  );
}

export function useFocusSession() {
  const ctx = useContext(FocusSessionContext);
  if (!ctx) throw new Error("useFocusSession must be used within FocusSessionProvider");
  return ctx;
}
