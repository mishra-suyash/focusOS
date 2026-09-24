"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { PomodoroSurveyModal } from "@/components/pomodoro-survey-modal";
import { useFocusContext } from "@/hooks/use-focus-context";
import { useUserSettings } from "@/hooks/use-user-settings";
import { todayKey } from "@/lib/dates";
import { fetchCollection, incrementTaskCompletedPomodoros, savePomodoro, saveDailySchedule } from "@/lib/firestore";
import { slotAutoStatus } from "@/lib/tracking";
import type { Category, DailySchedule, PomodoroSession, TaskBucket, TimerMode, TimerPresetId } from "@/types";

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
  courseId?: string;
  bucket?: TaskBucket;
}

/**
 * L3 (plan/14 §2.4) — a running session lived only in React state, so any full page reload (as
 * opposed to client-side navigation, already fixed by hoisting the timer to this provider) threw
 * away real elapsed work with nothing written. Anchored to a persisted timestamp the same way the
 * paper-pass timer survives a refresh (`PassState.startedAt`), but per-device in `localStorage`
 * rather than Firestore — this is live countdown state, not a record worth syncing across devices.
 */
const SESSION_STORAGE_KEY = "focusos-active-session";

interface StoredSession {
  mode: TimerMode;
  running: boolean;
  targetEndTime: number | null;
  secondsLeft: number;
  /** The full configured length (seconds) this countdown was armed with — persisted separately
   *  from `duration` (derived live from `work`/`shortBreak`/`longBreak`) because those settings
   *  haven't necessarily loaded from Firestore yet at the moment of a restore. Without this, a
   *  restored session that completes (or is manually finished) before settings finish loading
   *  would log its minutes against the still-default 25, not the length it actually ran at. */
  totalSeconds: number;
  cycle: number;
  category: Category;
  label: string;
  contextTouched: boolean;
  taskId: string;
  slotId?: string;
  courseId?: string;
  bucket?: TaskBucket;
}

function readStoredSession(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

function writeStoredSession(session: StoredSession) {
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Not fatal — a reload just loses the running session the way it always used to.
  }
}

/**
 * §6.5 — the I/O half of `lib/tracking.ts`'s `slotAutoStatus`: re-checks the one block a just-
 * finished work session was tied to (not the whole day — `end()` in `workday-session-provider.tsx`
 * already re-checks every block at day's end) and, if sessions now cover it past the threshold,
 * writes the flip. A no-op class-attendance check (default `false`) — a focus session was never
 * started against a class block via the normal path, and even if it were, attendance is logged
 * separately, not inferred from a timer running.
 */
async function syncSlotAutoStatus(uid: string, slotId: string) {
  const dateKey = todayKey();
  const [schedules, sessions] = await Promise.all([
    fetchCollection<DailySchedule>(uid, "dailySchedules"),
    fetchCollection<PomodoroSession>(uid, "pomodoroSessions")
  ]);
  const schedule = schedules.find((item) => item.dateKey === dateKey);
  const slot = schedule?.slots.find((item) => item.id === slotId);
  if (!schedule || !slot || slot.status === "completed") return;
  // A recurring class/routine slot reuses the same id on every date it materializes on — restrict
  // coverage to today's own sessions so a session logged weeks ago against the same slot id never
  // counts toward today's block.
  const todaySessions = sessions.filter((session) => session.completedAt.startsWith(dateKey));
  if (slotAutoStatus(slot, todaySessions) !== "completed") return;
  await saveDailySchedule(uid, {
    dateKey,
    templateId: schedule.templateId,
    slots: schedule.slots.map((item) => (item.id === slotId ? { ...item, status: "completed" as const } : item))
  });
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
  /** plan/14 §6.2 — which course/bucket this session will attribute to, auto-filled from the
   *  active block while idle (or copied from a manually-picked task), and written onto the
   *  `PomodoroSession` at finalize time. */
  courseId?: string;
  bucket?: TaskBucket;
  work: number;
  shortBreak: number;
  longBreak: number;
  setLabel: (label: string) => void;
  setCategory: (category: Category) => void;
  setTaskId: (taskId: string) => void;
  setSlotId: (slotId: string | undefined) => void;
  setCourseId: (courseId: string | undefined) => void;
  setBucket: (bucket: TaskBucket | undefined) => void;
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
  startFocus: (opts: { label: string; category: Category; slotId?: string; taskId?: string; courseId?: string; bucket?: TaskBucket }) => void;
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
  // The full configured length (seconds) the *current* countdown was armed with — see
  // `StoredSession.totalSeconds`'s doc comment for why this can't just be `duration * 60` read
  // live at completion time.
  const [totalSeconds, setTotalSeconds] = useState(25 * 60);
  const [cycle, setCycle] = useState(1);
  const [category, setCategoryRaw] = useState<Category>("research");
  const [label, setLabelState] = useState<string>(category);
  // §6.2 — generalizes the old `labelTouched` flag: once the user (or a linked-task pick) has set
  // any part of the session's context by hand — label, category, task, or the block it's tied to —
  // the active-block auto-fill effect below stops overwriting it. Otherwise every keystroke-free
  // session would default to the literal string "writing" regardless of category (plan/13 A32).
  const [contextTouched, setContextTouched] = useState(false);

  function setLabel(next: string) {
    setContextTouched(true);
    setLabelState(next);
  }

  function setCategory(next: Category) {
    setContextTouched(true);
    setCategoryRaw(next);
  }

  useEffect(() => {
    if (!contextTouched) setLabelState(category);
  }, [category, contextTouched]);
  const [taskId, setTaskIdRaw] = useState("");
  const [slotId, setSlotIdRaw] = useState<string | undefined>(undefined);
  const [courseId, setCourseIdRaw] = useState<string | undefined>(undefined);
  const [bucket, setBucketRaw] = useState<TaskBucket | undefined>(undefined);

  function setTaskId(next: string) {
    setContextTouched(true);
    setTaskIdRaw(next);
  }
  function setSlotId(next: string | undefined) {
    setContextTouched(true);
    setSlotIdRaw(next);
  }
  function setCourseId(next: string | undefined) {
    setContextTouched(true);
    setCourseIdRaw(next);
  }
  function setBucket(next: TaskBucket | undefined) {
    setContextTouched(true);
    setBucketRaw(next);
  }

  const [pendingSession, setPendingSession] = useState<PendingSession | null>(null);
  // L3 — flips true once the storage restore effect below has run, so the persistence-write effect
  // never fires on the pre-restore render and stomps a saved session with the provider's defaults.
  const [hydrated, setHydrated] = useState(false);

  const duration = useMemo(() => (mode === "work" ? work : mode === "short_break" ? shortBreak : longBreak), [longBreak, mode, shortBreak, work]);
  const progress = 100 - (secondsLeft / (duration * 60)) * 100;

  useEffect(() => {
    // L3 — while a session is running (including one just restored from storage), settings loading
    // moments after mount must not snap the countdown back to a fresh duration. This effect's job
    // is resetting the *idle* display for a mode/length change, never an active countdown.
    if (running) return;
    const freshTotalSeconds = duration * 60;
    setSecondsLeft(freshTotalSeconds);
    setTargetEndTime(null);
    setTotalSeconds(freshTotalSeconds);
  }, [duration, mode, running]);

  // L3 — restore a running/paused session across a hard reload. Runs once; declared after the
  // duration/mode-reset effect above so its setState calls win over that effect's mount-time pass.
  // Uses the raw setters throughout — restoring a session must not itself count as a manual
  // override; `contextTouched` is restored verbatim instead, so an idle-and-auto-following session
  // resumes auto-following after reload exactly as it was.
  useEffect(() => {
    const stored = readStoredSession();
    if (stored) {
      setMode(stored.mode);
      setCycle(stored.cycle);
      setCategoryRaw(stored.category);
      setLabelState(stored.label);
      setContextTouched(stored.contextTouched);
      setTaskIdRaw(stored.taskId);
      setSlotIdRaw(stored.slotId);
      setCourseIdRaw(stored.courseId);
      setBucketRaw(stored.bucket);
      setRunning(stored.running);
      setTargetEndTime(stored.targetEndTime);
      setSecondsLeft(
        stored.running && stored.targetEndTime != null
          ? Math.max(0, Math.ceil((stored.targetEndTime - Date.now()) / 1000))
          : stored.secondsLeft
      );
      // A restored session's `work`/`shortBreak`/`longBreak` settings haven't necessarily loaded
      // from Firestore yet — `totalSeconds` must come from what the countdown actually started
      // with, not from `duration * 60` computed against still-default lengths (an older stored
      // session predating this field falls back to the current default; there's no better source).
      setTotalSeconds(stored.totalSeconds ?? 25 * 60);
    }
    setHydrated(true);
    // Intentionally empty deps — this restore must run exactly once, on mount, not on every
    // change to the state it's about to overwrite.
  }, []);

  // §6.2 — while idle and nothing has been touched by hand, keep the session's context in sync
  // with whichever block is active on today's schedule, so the first "Start" click needs no
  // dropdown. Raw setters throughout: this is the auto-follow itself, so it must never mark
  // `contextTouched` or it would immediately stop following its own next update.
  const focusContext = useFocusContext();
  useEffect(() => {
    if (running || contextTouched || !focusContext) return;
    setLabelState(focusContext.label);
    setCategoryRaw(focusContext.category);
    setSlotIdRaw(focusContext.slotId);
    setCourseIdRaw(focusContext.courseId);
    setBucketRaw(focusContext.bucket);
    setTaskIdRaw(focusContext.taskId ?? "");
  }, [focusContext, running, contextTouched]);

  // L3 — keeps the persisted snapshot current. `secondsLeft` is deliberately not a dependency: a
  // running session's remaining time is always recomputed from `targetEndTime` on restore, so
  // persisting it every tick would just be a once-a-second write for no benefit; the frozen value
  // still gets captured correctly here whenever `running` itself changes (e.g. on pause).
  useEffect(() => {
    if (!hydrated) return;
    writeStoredSession({ mode, running, targetEndTime, secondsLeft, totalSeconds, cycle, category, label, contextTouched, taskId, slotId, courseId, bucket });
  }, [hydrated, mode, running, targetEndTime, totalSeconds, cycle, category, label, contextTouched, taskId, slotId, courseId, bucket]);

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
    completeSession({ endedAt: targetEndTime ?? undefined });
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
    setTotalSeconds(duration * 60);
  }

  function completeSession(opts?: { endedAt?: number; elapsedMinutes?: number }) {
    setRunning(false);
    setTargetEndTime(null);
    const data: PendingSession = {
      label,
      category,
      mode,
      // A real timeout (the natural-completion effect below, which never passes elapsedMinutes)
      // logs the full configured length since the session genuinely ran that long; a manual
      // "Finish" click passes actual elapsed time instead, so stopping 30 seconds in doesn't award
      // full credit (plan/13 A6). Uses `totalSeconds`, not the live `duration` — after a reload
      // restore, `duration` can still be sitting on the pre-settings-load default for a moment,
      // which `totalSeconds` (persisted with the rest of the restored session) never is (L3).
      minutes: opts?.elapsedMinutes ?? Math.round(totalSeconds / 60),
      completedAt: new Date(opts?.endedAt ?? Date.now()).toISOString(),
      cycle,
      taskId: taskId || undefined,
      slotId,
      courseId,
      bucket
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
    // A6/A7 (plan/13) — `minutes` is now the real elapsed time, not always the full configured
    // length, so crediting a task's pomodoro count still needs its own floor: without one, clicking
    // Finish moments after Start (or after "start focus from a block", now that A7 can supply a
    // taskId immediately) would award a full completed-pomodoro for a near-zero-minute session.
    const MIN_MINUTES_FOR_TASK_CREDIT = 5;
    if (data.mode === "work" && data.taskId && data.minutes >= MIN_MINUTES_FOR_TASK_CREDIT) {
      await incrementTaskCompletedPomodoros(user!.uid, data.taskId);
    }
    // §6.5 — this session may have just pushed the block it was started inside past the
    // auto-complete threshold; check right away rather than waiting for End day, so "Up next"
    // and the day's block strip reflect it immediately.
    if (data.mode === "work" && data.slotId) {
      await syncSlotAutoStatus(user!.uid, data.slotId);
    }
    const nextMode: TimerMode = data.mode === "work" ? (data.cycle % 4 === 0 ? "long_break" : "short_break") : "work";
    if (data.mode === "work") setCycle((current) => current + 1);
    setMode(nextMode);
    // Reset per finished session rather than once per provider lifetime, so the category default
    // resumes for the next *unrelated* session — but only once nothing is linked any more. While a
    // task stays linked, its title should keep winning across repeat sessions against it; resetting
    // unconditionally here would otherwise overwrite that title with the bare category slug the
    // moment the first session against it ends, even though the same task is still selected
    // (plan/13 A32).
    if (!data.taskId) setContextTouched(false);
  }

  function startFocus(opts: { label: string; category: Category; slotId?: string; taskId?: string; courseId?: string; bucket?: TaskBucket }) {
    setLabel(opts.label);
    setCategory(opts.category);
    setSlotId(opts.slotId);
    setTaskId(opts.taskId ?? "");
    setCourseId(opts.courseId);
    setBucket(opts.bucket);
    setMode("work");
    const freshTotalSeconds = work * 60;
    setSecondsLeft(freshTotalSeconds);
    setTargetEndTime(Date.now() + freshTotalSeconds * 1000);
    setTotalSeconds(freshTotalSeconds);
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
    courseId,
    bucket,
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
    finishNow: () => {
      const remainingSeconds = targetEndTime == null ? secondsLeft : Math.max(0, Math.ceil((targetEndTime - Date.now()) / 1000));
      // `totalSeconds`, not `duration * 60` — see `completeSession`'s comment (L3).
      const elapsedMinutes = Math.max(0, Math.round((totalSeconds - remainingSeconds) / 60));
      completeSession({ elapsedMinutes });
    },
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
