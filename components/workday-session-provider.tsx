"use client";

import { orderBy, where } from "firebase/firestore";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { useDay } from "@/hooks/use-day";
import { useUserSettings } from "@/hooks/use-user-settings";
import { todayKey } from "@/lib/dates";
import { courseSlotsForDate } from "@/lib/courses";
import { DEFAULT_ROUTINE_BLOCKS, routineSlotsForDate } from "@/lib/routine";
import {
  endWorkdaySession,
  fetchCollection,
  fetchCourseCheckpoints,
  fetchCourseClassLogs,
  recordBreak,
  recordHydration,
  saveDailySchedule,
  saveDayFields,
  startWorkdaySession,
  subscribeDoc,
  undoEndWorkdaySession
} from "@/lib/firestore";
import { buildLoadIndexSnapshot } from "@/lib/loadindex";
import { getActiveSlot, minutesFromTime, scheduleFromTemplate, scheduleSummary, sortedSlots } from "@/lib/schedule";
import { materializeBuiltinDayTemplate, resolvePackBreakDayTemplate, resolvePackWorkdayTemplate } from "@/lib/templates/builtin";
import { isBreakMode } from "@/lib/terms";
import { slotAutoStatus } from "@/lib/tracking";
import type { Course, DailySchedule, DayTemplate, Goal, PomodoroSession, RevisionItem, ScheduleSlot, Term } from "@/types";

function slotsOverlap(a: ScheduleSlot, b: ScheduleSlot) {
  return minutesFromTime(a.startTime) < minutesFromTime(b.endTime) && minutesFromTime(b.startTime) < minutesFromTime(a.endTime);
}

const NO_PROMPT_SLOT_TYPES = new Set(["break", "meal", "sleep", "free"]);

export interface ReminderEvent {
  kind: "hydration" | "break";
  message: string;
  firedAt: number;
}

interface WorkdaySessionContextValue {
  session: { startedAt?: string; endedAt?: string; hydrationCount: number; breaksTaken: number } | null;
  active: boolean;
  starting: boolean;
  start: () => Promise<void>;
  end: () => Promise<void>;
  /** F11 (plan §11.2) — reverses `end()`'s `session.endedAt` write; the caller owns the 10-second undo window/toast. */
  undoEnd: () => Promise<void>;
  reminder: ReminderEvent | null;
  acknowledgeReminder: () => void;
  dismissReminder: () => void;
  /** One-time notice from the day-start flow (F1 built-in fallback used, F3 class-overlap blocks skipped). */
  startDayNotice: string | null;
  dismissStartDayNotice: () => void;
  hydrationMinutes: number;
  breakMinutes: number;
  setHydrationMinutes: (minutes: number) => void;
  setBreakMinutes: (minutes: number) => void;
}

const WorkdaySessionContext = createContext<WorkdaySessionContextValue | null>(null);

export function WorkdaySessionProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const today = todayKey();
  const { day } = useDay(today);
  const { settings, update: updateSettings } = useUserSettings();
  const [starting, setStarting] = useState(false);
  const [schedule, setSchedule] = useState<DailySchedule | null>(null);
  const [reminder, setReminder] = useState<ReminderEvent | null>(null);
  const [startDayNotice, setStartDayNotice] = useState<string | null>(null);
  const lastHydrationRef = useRef<number>(0);
  const lastBreakRef = useRef<number>(0);

  const session = day?.session ?? null;

  useEffect(() => {
    if (!user) {
      setSchedule(null);
      return;
    }
    return subscribeDoc<DailySchedule>(user.uid, "dailySchedules", today, setSchedule);
  }, [user, today]);

  useEffect(() => {
    if (!session?.startedAt) return;
    const startedAtMs = new Date(session.startedAt).getTime();
    lastHydrationRef.current = session.lastHydrationAt ? new Date(session.lastHydrationAt).getTime() : startedAtMs;
    lastBreakRef.current = session.lastBreakPromptAt ? new Date(session.lastBreakPromptAt).getTime() : startedAtMs;
  }, [session?.startedAt, session?.lastHydrationAt, session?.lastBreakPromptAt]);

  const active = Boolean(session?.startedAt && !session?.endedAt);

  const fireReminder = useCallback((kind: ReminderEvent["kind"], message: string) => {
    setReminder((current) => current ?? { kind, message, firedAt: Date.now() });
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification("FocusOS", { body: message });
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      const now = Date.now();
      if (now - lastHydrationRef.current >= settings.hydrationMinutes * 60 * 1000) {
        fireReminder("hydration", "Time for a water break. Stay hydrated.");
        return;
      }
      const inRestSlot = schedule ? NO_PROMPT_SLOT_TYPES.has(getActiveSlot(sortedSlots(schedule.slots))?.type ?? "") : false;
      if (inRestSlot) {
        lastBreakRef.current = now;
        return;
      }
      if (now - lastBreakRef.current >= settings.breakMinutes * 60 * 1000) {
        fireReminder("break", "You have been heads-down a while. Take a short break.");
      }
    }, 30_000);
    return () => window.clearInterval(id);
  }, [active, settings.hydrationMinutes, settings.breakMinutes, schedule, fireReminder]);

  const start = useCallback(async () => {
    if (!user || starting) return;
    setStarting(true);
    try {
      // L1 (plan/14 §2.4) — this used to be `await`ed as the first statement, so a permission
      // dialog the user never answers (dismissed by clicking away, or suppressed by the browser)
      // left the promise unsettled forever and Start day stuck on "Starting…" with no schedule
      // written. Reminders already degrade gracefully without permission (`fireReminder` only
      // calls `new Notification` when `Notification.permission === "granted"`), so there is nothing
      // downstream in this function that actually needs the prompt to have resolved — fire it and
      // move on immediately instead of gating the day on it.
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        void Notification.requestPermission();
      }
      const existingSchedule = await fetchCollection<DailySchedule>(user.uid, "dailySchedules", [orderBy("updatedAt", "desc")]);
      const todaySchedule = existingSchedule.find((item) => item.dateKey === today);
      if (!todaySchedule) {
        const [templates, courses, terms] = await Promise.all([
          fetchCollection<DayTemplate>(user.uid, "dayTemplates", [orderBy("createdAt", "desc")]),
          fetchCollection<Course>(user.uid, "courses", [orderBy("createdAt", "desc")]),
          fetchCollection<Term>(user.uid, "terms", [orderBy("startDate", "desc")])
        ]);
        const onBreak = isBreakMode(terms, today);
        const chosenTemplate = onBreak
          ? templates.find((template) => template.id === settings.breakTemplateId) ?? templates.find((template) => template.isDefault) ?? templates[0]
          : templates.find((template) => template.isDefault) ?? templates[0];

        // F1: with zero templates at all, fall back to the pack's built-in default in memory
        // instead of leaving Start day producing nothing (plan §6.1).
        let baseSlots: ScheduleSlot[];
        let usedFallbackName: string | null = null;
        if (chosenTemplate) {
          baseSlots = scheduleFromTemplate(chosenTemplate, today).slots;
        } else if (templates.length === 0) {
          const builtin = (onBreak && resolvePackBreakDayTemplate(settings.packId)) || resolvePackWorkdayTemplate(settings.packId);
          baseSlots = materializeBuiltinDayTemplate(builtin).slots.map((slot) => ({ ...slot, id: crypto.randomUUID() }));
          usedFallbackName = builtin.name;
        } else {
          baseSlots = [];
        }

        const classSlots = onBreak ? [] : courseSlotsForDate(courses, today);
        // Routine-Blocks-and-AI-Templates spec §2.4 — routine blocks (Sleep, meals, Gym, or a
        // custom one) get the same "always win over the template" treatment class blocks already
        // have (F3), just one rung below classes: a lecture is a fixed external commitment, a
        // personal routine anchor isn't, so classes get first pick of the day and routine takes
        // whatever's left after that.
        const routineSlots = routineSlotsForDate(settings.routineBlocks ?? DEFAULT_ROUTINE_BLOCKS, today).filter(
          (slot) => !classSlots.some((classSlot) => slotsOverlap(slot, classSlot))
        );
        const lockedSlots = [...classSlots, ...routineSlots];
        // F3: class/routine blocks always win — skip any template block that overlaps one, rather
        // than silently colliding (Plan/Save day would reject the overlap outright otherwise).
        const nonOverlapping = baseSlots.filter((slot) => !lockedSlots.some((lockedSlot) => slotsOverlap(slot, lockedSlot)));
        const skippedTitles = baseSlots.filter((slot) => !nonOverlapping.includes(slot)).map((slot) => slot.title);
        const slots = sortedSlots([...nonOverlapping, ...lockedSlots]);
        if (slots.length > 0) {
          await saveDailySchedule(user.uid, { dateKey: today, templateId: chosenTemplate?.id, slots });
        }

        const notices: string[] = [];
        if (usedFallbackName) notices.push(`Used the ${usedFallbackName} template. Change it in Plan → Templates.`);
        if (skippedTitles.length > 0) notices.push(`Skipped ${skippedTitles.length} template block${skippedTitles.length > 1 ? "s" : ""} that overlapped a class or routine block: ${skippedTitles.join(", ")}.`);
        if (notices.length > 0) setStartDayNotice(notices.join(" "));
      }
      await startWorkdaySession(user.uid, today);
      lastHydrationRef.current = Date.now();
      lastBreakRef.current = Date.now();
    } finally {
      setStarting(false);
    }
  }, [user, starting, today, settings.breakTemplateId, settings.packId]);

  const end = useCallback(async () => {
    if (!user) return;
    try {
      const [courses, dueItems, reviewedToday, sessions, schedules, goals, terms] = await Promise.all([
        fetchCollection<Course>(user.uid, "courses"),
        fetchCollection<RevisionItem>(user.uid, "revisionItems", [
          where("suspended", "==", false),
          where("dueDate", "<=", today),
          orderBy("dueDate", "asc")
        ]),
        fetchCollection<RevisionItem>(user.uid, "revisionItems", [where("lastReviewedAt", ">=", `${today}T00:00:00.000Z`)]),
        fetchCollection<PomodoroSession>(user.uid, "pomodoroSessions"),
        fetchCollection<DailySchedule>(user.uid, "dailySchedules"),
        fetchCollection<Goal>(user.uid, "goals"),
        fetchCollection<Term>(user.uid, "terms")
      ]);
      const checkpoints = (await Promise.all(courses.map((course) => fetchCourseCheckpoints(user.uid, course.id)))).flat();
      const todaySchedule = schedules.find((item) => item.dateKey === today);

      // §6.5 — before computing the Workload snapshot, flip every uncovered-by-the-clock-alone
      // block that real work has actually covered: a deep-work/reading/admin block once sessions
      // logged against its slotId cover at least 60% of it, a class block once today's attendance
      // log says attended/self-studied. This is what makes `completedDeepWork` below (and every
      // other reader of today's schedule) non-zero on a day where planned deep work happened —
      // never from the clock alone (13.FocusOS-v2-UI-Coherence-Audit.md A9's own fix stays intact).
      let todaySlots = todaySchedule?.slots ?? [];
      if (todaySchedule) {
        const classLogsByCourse = await Promise.all(courses.map((course) => fetchCourseClassLogs(user.uid, course.id)));
        const attendedCourseIds = new Set(
          courses
            .filter((course, index) => {
              const log = classLogsByCourse[index].find((item) => item.date === today);
              return log && (log.attendance === "attended" || log.attendance === "self_study");
            })
            .map((course) => course.id)
        );
        // Recurring class/routine slots reuse the same id on every date they materialize on
        // (`course-${courseId}-${sessionId}`, `routineSlotsForDate`'s own ids) — coverage must only
        // ever look at today's own sessions, or a session logged against last Thursday's identical
        // slot id would silently count toward today's.
        const todaySessions = sessions.filter((session) => session.completedAt.startsWith(today));
        let changed = false;
        todaySlots = todaySchedule.slots.map((slot) => {
          if (slot.status === "completed") return slot;
          const classAttended = slot.type === "class" && slot.courseId ? attendedCourseIds.has(slot.courseId) : false;
          if (slotAutoStatus(slot, todaySessions, classAttended) !== "completed") return slot;
          changed = true;
          return { ...slot, status: "completed" as const };
        });
        if (changed) {
          await saveDailySchedule(user.uid, { dateKey: today, templateId: todaySchedule.templateId, slots: todaySlots });
        }
      }

      const focusedMinutes = sessions
        .filter((item) => item.mode === "work" && item.completedAt.startsWith(today))
        .reduce((sum, item) => sum + item.minutes, 0);
      const snapshot = buildLoadIndexSnapshot({
        scheduledDeepWorkMinutes: scheduleSummary(todaySlots).plannedDeepWork,
        revisionDueCount: dueItems.length,
        revisionsCompletedCount: reviewedToday.length,
        checkpoints,
        courses,
        goals,
        terms,
        focusedMinutes,
        todayKey: today
      });
      await saveDayFields(user.uid, today, { loadIndex: snapshot });
    } catch {
      // Best-effort snapshot only — never block ending the day if this fails.
    }
    await endWorkdaySession(user.uid, today);
    setReminder(null);
  }, [user, today]);

  const undoEnd = useCallback(async () => {
    if (!user) return;
    await undoEndWorkdaySession(user.uid, today);
  }, [user, today]);

  const acknowledgeReminder = useCallback(() => {
    if (!user || !reminder) return;
    const now = Date.now();
    if (reminder.kind === "hydration") {
      lastHydrationRef.current = now;
      recordHydration(user.uid, today, (session?.hydrationCount ?? 0) + 1);
    } else {
      lastBreakRef.current = now;
      recordBreak(user.uid, today, (session?.breaksTaken ?? 0) + 1);
    }
    setReminder(null);
  }, [user, reminder, session, today]);

  const dismissReminder = useCallback(() => {
    const now = Date.now();
    if (reminder?.kind === "hydration") lastHydrationRef.current = now;
    if (reminder?.kind === "break") lastBreakRef.current = now;
    setReminder(null);
  }, [reminder]);

  const setHydrationMinutes = useCallback((minutes: number) => updateSettings({ hydrationMinutes: minutes }), [updateSettings]);
  const setBreakMinutes = useCallback((minutes: number) => updateSettings({ breakMinutes: minutes }), [updateSettings]);
  const dismissStartDayNotice = useCallback(() => setStartDayNotice(null), []);

  const value = useMemo<WorkdaySessionContextValue>(
    () => ({
      session,
      active,
      starting,
      start,
      end,
      undoEnd,
      reminder,
      acknowledgeReminder,
      dismissReminder,
      startDayNotice,
      dismissStartDayNotice,
      hydrationMinutes: settings.hydrationMinutes,
      breakMinutes: settings.breakMinutes,
      setHydrationMinutes,
      setBreakMinutes
    }),
    [
      session,
      active,
      starting,
      start,
      end,
      undoEnd,
      reminder,
      acknowledgeReminder,
      dismissReminder,
      startDayNotice,
      dismissStartDayNotice,
      settings.hydrationMinutes,
      settings.breakMinutes,
      setHydrationMinutes,
      setBreakMinutes
    ]
  );

  return <WorkdaySessionContext.Provider value={value}>{children}</WorkdaySessionContext.Provider>;
}

export function useWorkdaySession() {
  const context = useContext(WorkdaySessionContext);
  if (!context) throw new Error("useWorkdaySession must be used inside WorkdaySessionProvider");
  return context;
}
