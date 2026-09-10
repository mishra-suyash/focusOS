"use client";

import { orderBy, where } from "firebase/firestore";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { useDay } from "@/hooks/use-day";
import { useUserSettings } from "@/hooks/use-user-settings";
import { todayKey } from "@/lib/dates";
import { courseSlotsForDate } from "@/lib/courses";
import {
  endWorkdaySession,
  fetchCollection,
  fetchCourseCheckpoints,
  recordBreak,
  recordHydration,
  saveDailySchedule,
  saveDayFields,
  startWorkdaySession,
  subscribeDoc
} from "@/lib/firestore";
import { buildLoadIndexSnapshot } from "@/lib/loadindex";
import { getActiveSlot, minutesFromTime, scheduleFromTemplate, scheduleSummary, sortedSlots } from "@/lib/schedule";
import { materializeBuiltinDayTemplate, resolvePackBreakDayTemplate, resolvePackWorkdayTemplate } from "@/lib/templates/builtin";
import { isBreakMode } from "@/lib/terms";
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
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        await Notification.requestPermission();
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
        // F3: class blocks always win — skip any template block that overlaps one, rather than
        // silently colliding (Plan/Save day would reject the overlap outright otherwise).
        const nonOverlapping = baseSlots.filter((slot) => !classSlots.some((classSlot) => slotsOverlap(slot, classSlot)));
        const skippedTitles = baseSlots.filter((slot) => !nonOverlapping.includes(slot)).map((slot) => slot.title);
        const slots = sortedSlots([...nonOverlapping, ...classSlots]);
        if (slots.length > 0) {
          await saveDailySchedule(user.uid, { dateKey: today, templateId: chosenTemplate?.id, slots });
        }

        const notices: string[] = [];
        if (usedFallbackName) notices.push(`Used the ${usedFallbackName} template. Change it in Plan → Templates.`);
        if (skippedTitles.length > 0) notices.push(`Skipped ${skippedTitles.length} template block${skippedTitles.length > 1 ? "s" : ""} that overlapped a class: ${skippedTitles.join(", ")}.`);
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
      const focusedMinutes = sessions
        .filter((item) => item.mode === "work" && item.completedAt.startsWith(today))
        .reduce((sum, item) => sum + item.minutes, 0);
      const snapshot = buildLoadIndexSnapshot({
        scheduledDeepWorkMinutes: scheduleSummary(todaySchedule?.slots ?? []).plannedDeepWork,
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
