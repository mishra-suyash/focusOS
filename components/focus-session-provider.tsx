"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { PomodoroSurveyModal } from "@/components/pomodoro-survey-modal";
import { ReadingCheckIn } from "@/components/reading-check-in";
import { useCurrentMinute } from "@/hooks/use-current-minute";
import { useFocusContext } from "@/hooks/use-focus-context";
import { useUserSettings } from "@/hooks/use-user-settings";
import { todayKey } from "@/lib/dates";
import { fetchCollection, incrementTaskCompletedPomodoros, savePomodoro, saveDailySchedule, updatePomodoro } from "@/lib/firestore";
import { DEFAULT_MAX_CHUNK_MINUTES } from "@/lib/timeline";
import { slotAutoStatus } from "@/lib/tracking";
import type { Category, DailySchedule, PomodoroSession, TaskBucket, TimerMode, TimerPresetId } from "@/types";

const MODE_LABELS: Record<TimerMode, string> = {
  work: "Focus",
  short_break: "Short break",
  long_break: "Long break"
};

/**
 * The countdown's whole lifecycle, as one value so every transition is atomic. It used to be five
 * independent `useState`s plus an effect that re-armed the idle display whenever `running` changed —
 * which also fired on *pause*, so pausing (from the dashboard, the reader or the floating widget)
 * snapped the countdown back to full and threw the elapsed time away. "Is anything in progress" was
 * then guessed from `secondsLeft < duration * 60`, which that same reset made false.
 *
 * `phase` makes it explicit: `idle` is a fresh countdown whose length is *derived* live from settings
 * (so a settings load or a preset change updates it, and nothing else can), `running` is anchored to
 * `targetEndTime`, `paused` holds `remainingSeconds` frozen. Only `idle` follows settings or the
 * active block; `running`/`paused` keep the length they were armed with (`totalSeconds`).
 */
type Phase = "idle" | "running" | "paused";

interface TimerCore {
  mode: TimerMode;
  phase: Phase;
  /** Epoch ms the running countdown ends at; null unless `running`. Recomputed against the real
   *  clock rather than decremented per tick, so a throttled or backgrounded tab can't drift. */
  targetEndTime: number | null;
  /** Frozen remaining seconds while `paused`; unused otherwise. */
  remainingSeconds: number;
  /** The length this countdown was armed with — persisted, never re-derived mid-session (L3: a
   *  restore can complete before settings load, and must not log the still-default 25). */
  totalSeconds: number;
  cycle: number;
  /** The date `cycle` counts within — a new day starts again at cycle 1, so "Cycle 7" can't greet a
   *  day with no sessions in it. */
  cycleDateKey: string;
  /** Identifies one armed countdown, so two tabs restoring the same session log it once. */
  runId: string;
  /** Epoch ms of the last phase/mode change — how old an untouched break is. */
  phaseChangedAt: number;
}

/** Who the session is for. Logged onto the `PomodoroSession` at completion — for work sessions only. */
interface SessionContext {
  label: string;
  category: Category;
  /** §6.2 — once the user (or a linked-task pick, or a block start) has set any of this by hand, the
   *  active-block auto-follow stops overwriting it. */
  contextTouched: boolean;
  taskId: string;
  slotId?: string;
  courseId?: string;
  bucket?: TaskBucket;
  paperId?: string;
  passNo?: 1 | 2 | 3;
  findPaper?: boolean;
  /** plan/16 §5.5 — this one sitting's armed length; overrides the settings work length while set. */
  armedMinutes?: number;
}

/** plan/17 §5.4 — a reading sitting abandoned inside this many minutes logs nothing: opening a
 *  paper by mistake isn't reading. (The 5-minute task-credit floor below is separate.) */
const MIN_READING_SESSION_MINUTES = 2;
/** A6/A7 (plan/13) — `minutes` is real elapsed time, so crediting a task's pomodoro count needs a
 *  floor of its own: Finish moments after Start must not award a completed pomodoro. */
const MIN_MINUTES_FOR_TASK_CREDIT = 5;

/**
 * L3 (plan/14 §2.4) — a running or paused session survives a hard reload, anchored to a persisted
 * timestamp, per-device in `localStorage` (live countdown state, not a record worth syncing). Also
 * the channel two open tabs keep each other in step through (the `storage` event below).
 */
const SESSION_STORAGE_KEY = "focusos-active-session";
/** The `runId` most recently logged on this device — the cross-tab double-log guard. */
const LOGGED_RUN_STORAGE_KEY = "focusos-last-logged-run";

interface StoredSessionV2 {
  v: 2;
  core: TimerCore;
  ctx: SessionContext;
}

/** The pre-`phase` shape, still sitting in browsers that last ran the old provider. */
interface LegacyStoredSession extends Omit<SessionContext, never> {
  mode: TimerMode;
  running: boolean;
  targetEndTime: number | null;
  secondsLeft: number;
  totalSeconds?: number;
  cycle: number;
}

function newRunId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function freshCore(): TimerCore {
  return {
    mode: "work",
    phase: "idle",
    targetEndTime: null,
    remainingSeconds: 0,
    totalSeconds: 25 * 60,
    cycle: 1,
    cycleDateKey: todayKey(),
    runId: newRunId(),
    phaseChangedAt: 0
  };
}

function parseStoredSession(raw: string | null): StoredSessionV2 | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSessionV2 | LegacyStoredSession;
    if ("v" in parsed && parsed.v === 2) return parsed;
    const legacy = parsed as LegacyStoredSession;
    const totalSeconds = legacy.totalSeconds ?? 25 * 60;
    // A paused legacy session was frozen below its full length; an untouched one is idle.
    const phase: Phase = legacy.running ? "running" : legacy.secondsLeft < totalSeconds ? "paused" : "idle";
    const { mode, running: _running, targetEndTime, secondsLeft, totalSeconds: _total, cycle, ...ctx } = legacy;
    return {
      v: 2,
      core: {
        mode,
        phase,
        targetEndTime: phase === "running" ? targetEndTime : null,
        remainingSeconds: secondsLeft,
        totalSeconds,
        cycle,
        // Unknown which day that cycle count belongs to — restart it rather than guess.
        cycleDateKey: "",
        runId: newRunId(),
        // No timestamp was ever stored: an untouched legacy break counts as long over.
        phaseChangedAt: phase === "idle" ? 0 : Date.now()
      },
      ctx: { ...ctx, taskId: ctx.taskId ?? "" }
    };
  } catch {
    return null;
  }
}

/**
 * One fixed key order, undefined fields dropped. Tabs adopt each other's writes (the `storage` sync
 * in the provider), and an adopting tab writes its state straight back; unless that write is
 * byte-identical to what it adopted, the browser fires another `storage` event at the first tab and
 * the two echo the session back and forth indefinitely. A canonical form makes the echo a no-op.
 */
function pick<T extends object>(value: T, keys: (keyof T)[]) {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

const CTX_KEYS: (keyof SessionContext)[] = ["label", "category", "contextTouched", "taskId", "slotId", "courseId", "bucket", "paperId", "passNo", "findPaper", "armedMinutes"];

/** What an idle, untouched session stores in place of its context: nothing about the active block. */
const FOLLOWING_CTX: SessionContext = { label: "research", category: "research", contextTouched: false, taskId: "" };

function sameContext(a: SessionContext, b: SessionContext) {
  return JSON.stringify(pick(a, CTX_KEYS)) === JSON.stringify(pick(b, CTX_KEYS));
}

function serializeSession({ core, ctx }: Pick<StoredSessionV2, "core" | "ctx">): string {
  // An idle session still following the active block derives that context per tab, from each tab's
  // own schedule snapshot and minute tick — which disagree for a moment whenever a tab is loading or
  // a block starts or ends. Stored and synced, each tab would adopt the other's answer, re-derive its
  // own and write it back: a write storm at every block boundary. Every tab re-derives it instead.
  const following = core.phase === "idle" && !ctx.contextTouched;
  return JSON.stringify({
    v: 2,
    core: pick(core, ["mode", "phase", "targetEndTime", "remainingSeconds", "totalSeconds", "cycle", "cycleDateKey", "runId", "phaseChangedAt"]),
    ctx: pick(following ? FOLLOWING_CTX : ctx, CTX_KEYS)
  });
}

function writeStoredSession(session: Pick<StoredSessionV2, "core" | "ctx">) {
  try {
    const next = serializeSession(session);
    if (window.localStorage.getItem(SESSION_STORAGE_KEY) !== next) window.localStorage.setItem(SESSION_STORAGE_KEY, next);
  } catch {
    // Not fatal — a reload just loses the running session the way it always used to.
  }
}

/** The end-of-session survey, shared by every open tab (see `PendingSurvey`). */
const PENDING_SURVEY_STORAGE_KEY = "focusos-pending-survey";
/** A survey nobody answered within this long is about a session too old to rate honestly. */
const PENDING_SURVEY_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function parsePendingSurvey(raw: string | null): PendingSurvey | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingSurvey;
    return Date.now() - parsed.at < PENDING_SURVEY_MAX_AGE_MS ? parsed : null;
  } catch {
    return null;
  }
}

function writePendingSurvey(survey: PendingSurvey | null) {
  try {
    if (survey) window.localStorage.setItem(PENDING_SURVEY_STORAGE_KEY, JSON.stringify(survey));
    else window.localStorage.removeItem(PENDING_SURVEY_STORAGE_KEY);
  } catch {
    // This tab still shows it; other tabs just won't.
  }
}

/**
 * True for exactly one tab per `runId`. Two open tabs adopt each other's countdown (the `storage`
 * sync below), so both reach zero together — a plain localStorage check-then-set is not atomic across
 * tab processes and let both log it. The Web Lock serializes the check; the session doc is also keyed
 * by `runId`, so even a lost race rewrites one doc instead of adding a second.
 */
async function claimRun(runId: string): Promise<boolean> {
  const check = () => {
    try {
      if (window.localStorage.getItem(LOGGED_RUN_STORAGE_KEY) === runId) return false;
      window.localStorage.setItem(LOGGED_RUN_STORAGE_KEY, runId);
    } catch {
      // Without storage there is no second tab to race with.
    }
    return true;
  };
  if (typeof navigator === "undefined" || !navigator.locks) return check();
  return navigator.locks.request("focusos-log-session", async () => check());
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
  phase: Phase;
  secondsLeft: number;
  /** The countdown is ticking — a break or a focus session. */
  running: boolean;
  /** A *focus* session is ticking. Breaks are not focus: everything that asks "is the user working
   *  right now?" (the Now card, the reading picker, the floating widget) asks this, never `running`. */
  focusRunning: boolean;
  /** A focus session has started and not ended — running or paused. Starting another sitting while
   *  this is true would replace it, so surfaces offering one check this first. */
  focusInProgress: boolean;
  /** Minutes the current countdown is armed with (live settings/sitting length while idle). */
  duration: number;
  totalSeconds: number;
  elapsedSeconds: number;
  progress: number;
  cycle: number;
  label: string;
  category: Category;
  taskId: string;
  slotId?: string;
  /** plan/14 §6.2 — which course/bucket this session will attribute to, auto-filled from the
   *  active block while idle (or copied from a manually-picked task). */
  courseId?: string;
  bucket?: TaskBucket;
  /** True while the session's context is still following the active block (nothing set by hand) —
   *  a Start from this state starts that block's sitting, exactly as the Now card's "Start focus". */
  autoFollowing: boolean;
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
  /** Start from idle, pause while running, resume while paused. Never resets anything. */
  toggleRunning: () => void;
  reset: () => void;
  finishNow: () => void;
  /** Ends a break (running or not) and returns to an idle focus countdown. Logs nothing. */
  skipBreak: () => void;
  /** Re-reads the clock now. The floating widget calls this from its own window's timer, because the
   *  opener tab's timers are throttled while it is hidden — which is exactly when the widget is used. */
  syncClock: () => void;
  /** DP5 S4 "Start focus session from a block" — sets the session's context and starts a focus
   * countdown immediately. A break in progress is simply replaced; a focus session in progress is
   * logged for the time it ran first, never silently discarded. */
  startFocus: (opts: {
    label: string;
    category: Category;
    slotId?: string;
    taskId?: string;
    courseId?: string;
    bucket?: TaskBucket;
    paperId?: string;
    passNo?: 1 | 2 | 3;
    findPaper?: boolean;
    /** plan/16 §5.5 — this sitting's length. Absent = `work`, the settings length. Clamped to
     *  [5, maxChunkMinutes] so a mis-sized or stale block can't arm a multi-hour "pomodoro". */
    minutes?: number;
  }) => void;
  /** plan/16 §5.5 — set only for a session armed from a sitting (`startFocus` with `minutes`). */
  armedMinutes?: number;
  /** The length `startFocus` would actually arm for a requested sitting length (the same clamp). */
  sittingLengthFor: (minutes: number | undefined) => number;
  paperId?: string;
  passNo?: 1 | 2 | 3;
  findPaper?: boolean;
}

const FocusSessionContext = createContext<FocusSessionContextValue | null>(null);

/**
 * The survey for a session that is already logged. Kept in localStorage as well as state: the tab
 * that wins the right to log a session (`claimRun`) is whichever reached zero first — often a
 * background tab — so every tab shows the survey, a reload keeps it, and answering it in any tab
 * clears it from all of them.
 */
interface PendingSurvey {
  /** The logged session's doc id (its run id) — the survey only annotates it. */
  docId: string;
  /** Epoch ms the session ended. */
  at: number;
  label: string;
  paperId?: string;
  passNo?: 1 | 2 | 3;
}

/**
 * Owns the focus timer above every page (mounted in the root `app/layout.tsx` since plan/17, so the
 * reader at `/read` shares the same session, and the floating widget — a portal into this same tree
 * — shows and drives the very same countdown).
 *
 * Completion is synchronous and save-first: the moment a focus session ends it is written, the
 * block's auto-status re-checked, and the timer moved on to its break — the rating survey only
 * annotates the logged doc afterwards. It used to be the other way round: nothing was written until
 * the survey (which renders in the main window only) was answered, so a reload lost the session,
 * and starting another one from the floating widget while the survey sat unanswered overwrote it —
 * then the delayed mode advance flipped the new session into a "break" mid-run.
 *
 * Breaks are never logged. Nothing reads a break session, and logging them carried the focus
 * block's slot, task and label along, so surfaces that didn't filter on `mode` showed them as work.
 */
export function FocusSessionProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { settings, loaded: settingsLoaded, update: updateSettings } = useUserSettings();
  const [work, setWork] = useState(25);
  const [shortBreak, setShortBreak] = useState(5);
  const [longBreak, setLongBreak] = useState(15);
  const [core, setCore] = useState<TimerCore>(freshCore);
  const [ctx, setCtx] = useState<SessionContext>({ label: "research", category: "research", contextTouched: false, taskId: "" });
  // Ticks only while running; every displayed number derives from `targetEndTime` against it.
  const [now, setNow] = useState(() => Date.now());
  const [pendingSurvey, setPendingSurvey] = useState<PendingSurvey | null>(null);
  // L3 — flips true once the storage restore has run, so the persistence write never fires on the
  // pre-restore render and stomps a saved session with the provider's defaults.
  const [hydrated, setHydrated] = useState(false);
  // One completion per armed countdown, even if the zero-crossing effect re-runs before re-render.
  const completedRunRef = useRef<string | null>(null);

  const { mode, phase } = core;
  // plan/16 §5.5 — a sitting's own length wins over the settings work length, and only in work mode:
  // breaks are always the configured break, never a fraction of the sitting.
  const idleMinutes = mode === "work" ? ctx.armedMinutes ?? work : mode === "short_break" ? shortBreak : longBreak;
  const totalSeconds = phase === "idle" ? idleMinutes * 60 : core.totalSeconds;
  const secondsLeft =
    phase === "idle"
      ? totalSeconds
      : phase === "paused"
        ? core.remainingSeconds
        : Math.max(0, Math.ceil(((core.targetEndTime ?? now) - now) / 1000));
  const elapsedSeconds = Math.max(0, totalSeconds - secondsLeft);
  const progress = totalSeconds > 0 ? 100 - (secondsLeft / totalSeconds) * 100 : 0;
  const cycle = core.cycleDateKey === todayKey() ? core.cycle : 1;

  function setLabel(next: string) {
    setCtx((current) => ({ ...current, label: next, contextTouched: true }));
  }
  function setCategory(next: Category) {
    // Until a label is set by hand it reads as the category (plan/13 A32).
    setCtx((current) => ({ ...current, category: next, label: current.contextTouched ? current.label : next, contextTouched: true }));
  }
  function setTaskId(next: string) {
    setCtx((current) => ({ ...current, taskId: next, contextTouched: true }));
  }
  function setSlotId(next: string | undefined) {
    setCtx((current) => ({ ...current, slotId: next, contextTouched: true }));
  }
  function setCourseId(next: string | undefined) {
    setCtx((current) => ({ ...current, courseId: next, contextTouched: true }));
  }
  function setBucket(next: TaskBucket | undefined) {
    setCtx((current) => ({ ...current, bucket: next, contextTouched: true }));
  }

  function showSurvey(next: PendingSurvey | null) {
    setPendingSurvey(next);
    writePendingSurvey(next);
  }

  // L3 — restore a running/paused session (and an unanswered survey) across a hard reload, once.
  useEffect(() => {
    const stored = parseStoredSession(readStorage(SESSION_STORAGE_KEY));
    if (stored) {
      setCore(stored.core);
      setCtx(stored.ctx);
    }
    setPendingSurvey(parsePendingSurvey(readStorage(PENDING_SURVEY_STORAGE_KEY)));
    setHydrated(true);
  }, []);

  // Two tabs each mount this provider. Without this they ran two independent timers over one stored
  // session — each logging it on completion. Adopting the other tab's writes keeps them one timer.
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === PENDING_SURVEY_STORAGE_KEY) {
        setPendingSurvey(parsePendingSurvey(event.newValue));
        return;
      }
      if (event.key !== SESSION_STORAGE_KEY) return;
      const stored = parseStoredSession(event.newValue);
      if (!stored) return;
      setCore(stored.core);
      setCtx(stored.ctx);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Persist on every transition. `now` is deliberately not part of the stored value: a running
  // countdown is fully described by `targetEndTime`, so this writes on transitions, not every second
  // — which is also what keeps the cross-tab sync above from echoing writes back and forth.
  useEffect(() => {
    if (!hydrated) return;
    writeStoredSession({ core, ctx });
  }, [hydrated, core, ctx]);

  // §6.2 — while idle and nothing has been set by hand, follow whichever block is active, so the
  // first Start needs no dropdown. Idle only: a paused session belongs to whatever it was started
  // for, and re-attributing it on the next minute tick would log it against a block it never was.
  const focusContext = useFocusContext();
  useEffect(() => {
    // Not before the restore has landed: on the mount commit this effect still sees the pre-restore
    // "idle, untouched" state, and its updater would then overwrite the restored session's context —
    // a running sitting reloaded mid-way would log as a bare "research" session against no block.
    if (!hydrated || phase !== "idle" || ctx.contextTouched) return;
    setCtx((current) => {
      const next: SessionContext = {
        ...current,
        label: focusContext?.label ?? current.category,
        category: focusContext?.category ?? current.category,
        slotId: focusContext?.slotId,
        courseId: focusContext?.courseId,
        bucket: focusContext?.bucket,
        taskId: focusContext?.taskId ?? "",
        // plan/16 §5.5 — paper/sitting state from a previous block must clear too, or the next manual
        // session would be attributed to whatever paper was open an hour ago.
        paperId: undefined,
        passNo: undefined,
        findPaper: undefined,
        armedMinutes: undefined
      };
      // `useFocusContext` hands back a new object every render, so this effect runs every render;
      // returning the same state when nothing changed is what stops that becoming a render loop.
      return sameContext(next, current) ? current : next;
    });
  }, [hydrated, focusContext, phase, ctx.contextTouched]);

  // An untouched break left idle for longer than the break itself is over: drop back to an idle
  // focus countdown, so the next Start is focus — not a stale "Short break" from before lunch.
  const minute = useCurrentMinute();
  useEffect(() => {
    if (phase !== "idle" || mode === "work") return;
    if (Date.now() - core.phaseChangedAt <= idleMinutes * 60 * 1000) return;
    setCore((current) => (current.phase === "idle" && current.mode !== "work" ? { ...current, mode: "work", phaseChangedAt: Date.now() } : current));
  }, [minute, phase, mode, core.phaseChangedAt, idleMinutes]);

  // Pulls saved lengths (and built-in preset choices) in once settings load. Only an idle countdown
  // reads them (`idleMinutes`); one already armed keeps its own `totalSeconds`.
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

  const syncClock = useCallback(() => setNow(Date.now()), []);

  useEffect(() => {
    if (phase !== "running") return;
    syncClock();
    const id = window.setInterval(syncClock, 1000);
    // A backgrounded tab's interval can be throttled or suspended — resync the instant it's back.
    function syncOnForeground() {
      if (document.visibilityState === "visible") syncClock();
    }
    document.addEventListener("visibilitychange", syncOnForeground);
    window.addEventListener("focus", syncOnForeground);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", syncOnForeground);
      window.removeEventListener("focus", syncOnForeground);
    };
  }, [phase, core.targetEndTime, syncClock]);

  useEffect(() => {
    if (phase !== "running" || secondsLeft !== 0 || !user) return;
    if (completedRunRef.current === core.runId) return;
    completedRunRef.current = core.runId;
    // The tab may have been backgrounded well past the real end — stamp completion at
    // `targetEndTime`, not now, so a session never lands hours late or on the wrong day.
    complete({ endedAt: core.targetEndTime ?? Date.now(), minutes: Math.round(core.totalSeconds / 60) });
  }, [phase, secondsLeft, user, core.runId]);

  /** The core for a countdown that starts now — a new run, armed with `seconds`. */
  function armedCore(base: TimerCore, nextMode: TimerMode, seconds: number): TimerCore {
    const today = todayKey();
    const sameDay = base.cycleDateKey === today;
    return {
      ...base,
      mode: nextMode,
      phase: "running",
      targetEndTime: Date.now() + seconds * 1000,
      remainingSeconds: seconds,
      totalSeconds: seconds,
      cycle: sameDay ? base.cycle : 1,
      cycleDateKey: today,
      runId: newRunId(),
      phaseChangedAt: Date.now()
    };
  }

  function toggleRunning() {
    const at = Date.now();
    if (phase === "running") {
      const remaining = Math.max(0, Math.ceil(((core.targetEndTime ?? at) - at) / 1000));
      setCore({ ...core, phase: "paused", targetEndTime: null, remainingSeconds: remaining, phaseChangedAt: at });
      setNow(at);
      return;
    }
    if (phase === "paused") {
      setCore({ ...core, phase: "running", targetEndTime: at + core.remainingSeconds * 1000, phaseChangedAt: at });
      setNow(at);
      return;
    }
    setCore(armedCore(core, mode, idleMinutes * 60));
    setNow(at);
  }

  /** Back to a fresh, idle countdown in the same mode. Discards the time on it, by request. */
  function reset() {
    setCore({ ...core, phase: "idle", targetEndTime: null, phaseChangedAt: Date.now() });
  }

  function skipBreak() {
    if (mode === "work") return;
    setCore({ ...core, mode: "work", phase: "idle", targetEndTime: null, phaseChangedAt: Date.now() });
  }

  function finishNow() {
    if (phase === "idle") return;
    complete({ endedAt: Date.now(), minutes: Math.round(elapsedSeconds / 60) });
  }

  /**
   * Ends the current countdown with `minutes` to its credit. A focus session is logged (unless it is
   * too short to be one) and the timer moves to its break; a break logs nothing and returns to focus.
   * Every state change here is synchronous — persistence runs after, and never gates the next state.
   */
  function complete(opts: { endedAt: number; minutes: number; survey?: boolean }) {
    const at = Date.now();
    if (mode !== "work") {
      setCore({ ...core, mode: "work", phase: "idle", targetEndTime: null, phaseChangedAt: at });
      return;
    }
    const reading = Boolean(ctx.paperId || ctx.findPaper);
    const loggable = opts.minutes >= 1 && !(reading && opts.minutes < MIN_READING_SESSION_MINUTES);
    if (loggable) {
      const record: Omit<PomodoroSession, "id"> = {
        label: ctx.label,
        category: ctx.category,
        mode: "work",
        minutes: opts.minutes,
        completedAt: new Date(opts.endedAt).toISOString(),
        cycle,
        taskId: ctx.taskId || undefined,
        slotId: ctx.slotId,
        courseId: ctx.courseId,
        bucket: ctx.bucket,
        paperId: ctx.paperId,
        passNo: ctx.passNo,
        ...(ctx.findPaper ? { findPaper: true } : {})
      };
      void persistWorkSession(record, core.runId, opts.survey !== false);
      const nextMode: TimerMode = cycle % 4 === 0 ? "long_break" : "short_break";
      setCore({ ...core, mode: nextMode, phase: "idle", targetEndTime: null, cycle: cycle + 1, cycleDateKey: todayKey(), phaseChangedAt: at });
    } else {
      // Too short to be a session: nothing logged, no break earned — back to an idle focus countdown.
      setCore({ ...core, phase: "idle", targetEndTime: null, phaseChangedAt: at });
    }
    // plan/16 §5.5 / plan/17 §5.5 — one sitting, one armed length and one paper. Left in place, the
    // next bare-timer session would run at this sitting's length and log against this paper's pass.
    // A linked task keeps its title across repeat sessions; otherwise the category default resumes.
    setCtx((current) => ({
      ...current,
      armedMinutes: undefined,
      paperId: undefined,
      passNo: undefined,
      findPaper: undefined,
      contextTouched: current.taskId ? current.contextTouched : false
    }));
  }

  /**
   * Save-first: the session is written now, task credit and the block's auto-status follow it, and
   * the survey — raised by the tab that logged it, shown by every tab — annotates it afterwards.
   */
  async function persistWorkSession(record: Omit<PomodoroSession, "id">, runId: string, survey: boolean) {
    if (!user) return;
    const uid = user.uid;
    if (!(await claimRun(runId))) return;
    if (survey) showSurvey({ docId: runId, at: Date.now(), label: record.label, paperId: record.paperId, passNo: record.passNo });
    try {
      await savePomodoro(uid, record, runId);
      if (record.taskId && record.minutes >= MIN_MINUTES_FOR_TASK_CREDIT) await incrementTaskCompletedPomodoros(uid, record.taskId);
      // §6.5 — this session may have just pushed its block past the auto-complete threshold.
      if (record.slotId) await syncSlotAutoStatus(uid, record.slotId);
    } catch (error) {
      console.error("[focus] logging the session failed", error);
    }
  }

  function clampSitting(minutes: number) {
    return Math.max(5, Math.min(Math.round(minutes), settings.maxChunkMinutes ?? DEFAULT_MAX_CHUNK_MINUTES));
  }

  function startFocus(opts: {
    label: string;
    category: Category;
    slotId?: string;
    taskId?: string;
    courseId?: string;
    bucket?: TaskBucket;
    paperId?: string;
    passNo?: 1 | 2 | 3;
    findPaper?: boolean;
    minutes?: number;
  }) {
    // A focus session already under way is logged for the time it ran — without a survey, since the
    // user has just chosen to move on — instead of being overwritten with nothing recorded.
    if (mode === "work" && phase !== "idle" && elapsedSeconds >= 60) {
      complete({ endedAt: Date.now(), minutes: Math.round(elapsedSeconds / 60), survey: false });
    }
    // plan/16 §5.5 — arm the sitting's own length when the caller knows it, clamped: below 5 minutes
    // a sitting isn't worth a timer, and above the sitting cap a stale block could arm hours.
    const armed = opts.minutes != null ? clampSitting(opts.minutes) : undefined;
    setCtx({
      label: opts.label,
      category: opts.category,
      contextTouched: true,
      taskId: opts.taskId ?? "",
      slotId: opts.slotId,
      courseId: opts.courseId,
      bucket: opts.bucket,
      paperId: opts.paperId,
      passNo: opts.passNo,
      findPaper: opts.findPaper,
      armedMinutes: armed
    });
    // Functional, so it composes with the `complete` above when that just ran in the same handler.
    setCore((current) => armedCore(current, "work", (armed ?? work) * 60));
    setNow(Date.now());
  }

  const running = phase === "running";
  const value: FocusSessionContextValue = {
    mode,
    modeLabel: MODE_LABELS[mode],
    phase,
    secondsLeft,
    running,
    focusRunning: running && mode === "work",
    focusInProgress: mode === "work" && phase !== "idle",
    duration: Math.round(totalSeconds / 60),
    totalSeconds,
    elapsedSeconds,
    progress,
    cycle,
    label: ctx.label,
    category: ctx.category,
    taskId: ctx.taskId,
    slotId: ctx.slotId,
    courseId: ctx.courseId,
    bucket: ctx.bucket,
    paperId: ctx.paperId,
    passNo: ctx.passNo,
    findPaper: ctx.findPaper,
    armedMinutes: ctx.armedMinutes,
    sittingLengthFor: (minutes) => (minutes != null ? clampSitting(minutes) : work),
    autoFollowing: !ctx.contextTouched,
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
    finishNow,
    skipBreak,
    syncClock,
    startFocus
  };

  async function rate(survey: PendingSurvey, rating?: { productivityRating: number; comment: string }) {
    showSurvey(null);
    if (!rating || !user) return;
    try {
      // `updateDoc` on a doc whose create is still queued applies after it — Firestore orders a
      // client's writes — so rating straight after the session ends is safe.
      await updatePomodoro(user.uid, survey.docId, { productivityRating: rating.productivityRating, comment: rating.comment || undefined });
    } catch (error) {
      console.error("[focus] saving the rating failed", error);
    }
  }

  return (
    <FocusSessionContext.Provider value={value}>
      {children}
      {pendingSurvey?.paperId ? (
        // plan/17 §5.4 step 3 — a reading sitting ends with the check-in, not the generic rating.
        <ReadingCheckIn
          key={pendingSurvey.docId}
          label={pendingSurvey.label}
          paperId={pendingSurvey.paperId}
          passNo={pendingSurvey.passNo}
          onSave={(productivityRating, comment) => rate(pendingSurvey, { productivityRating, comment })}
          onSkip={() => rate(pendingSurvey)}
        />
      ) : pendingSurvey ? (
        <PomodoroSurveyModal
          label={pendingSurvey.label}
          onSave={(productivityRating, comment) => void rate(pendingSurvey, { productivityRating, comment })}
          onSkip={() => void rate(pendingSurvey)}
        />
      ) : null}
    </FocusSessionContext.Provider>
  );
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function useFocusSession() {
  const ctx = useContext(FocusSessionContext);
  if (!ctx) throw new Error("useFocusSession must be used within FocusSessionProvider");
  return ctx;
}
