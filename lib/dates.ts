import { addDays, format, isSameDay, parseISO, startOfWeek, subDays, subMinutes } from "date-fns";

const DAY_END_STORAGE_KEY = "focusos-day-ends-at";
/** The latest a day can end. The close-day cron runs after this, so it always reads a finished day. */
export const LATEST_DAY_END_MINUTES = 5 * 60;

/** `UserSettings.dayEndsAt` ("04:00") as minutes past midnight. Absent or out of range is midnight. */
export function dayEndMinutes(dayEndsAt?: string): number {
  const match = dayEndsAt?.match(/^(\d{2}):(\d{2})$/);
  const minutes = match ? Number(match[1]) * 60 + Number(match[2]) : 0;
  return minutes <= LATEST_DAY_END_MINUTES ? minutes : 0;
}

function storedDayEnd(): number {
  try {
    return typeof window === "undefined" ? 0 : dayEndMinutes(window.localStorage.getItem(DAY_END_STORAGE_KEY) ?? undefined);
  } catch {
    return 0;
  }
}

/**
 * When the day ends (`UserSettings.dayEndsAt`), for every reader of "today" on this device. A module
 * value rather than an argument because 40-odd call sites read `todayKey()` at render, and it's cached so
 * the first render after a reload doesn't flash yesterday's numbers. The server has no such state: it
 * calls `zonedDayKey` with the user's own settings.
 */
let dayEnd = storedDayEnd();

export function setDayEnd(dayEndsAt?: string) {
  dayEnd = dayEndMinutes(dayEndsAt);
  try {
    window.localStorage.setItem(DAY_END_STORAGE_KEY, dayEndsAt ?? "00:00");
  } catch {
    // Only a cache: settings are the source of truth.
  }
}

function logicalNow() {
  return subMinutes(new Date(), dayEnd);
}

/**
 * Two kinds of "which day", and they differ between midnight and `dayEndsAt`. With a day ending at 04:00,
 * 01:00 on Thursday is still Wednesday for accounting, but a schedule document is a calendar date read
 * against the clock, so the block at 01:00 lives on Thursday's.
 *
 * - `todayKey()` is the day you're on: stats, streak, wrap-up, Start and End day, Workload.
 * - `scheduleDayKey()` is the date the clock is on: anything pairing a day's blocks with `currentMinute()`.
 *
 * Given a date, `todayKey(date)` just formats it.
 */
export function todayKey(date?: Date) {
  return format(date ?? logicalNow(), "yyyy-MM-dd");
}

export function scheduleDayKey(date = new Date()) {
  return format(date, "yyyy-MM-dd");
}

/**
 * The local day (the same frame as `todayKey`) an ISO timestamp like `completedAt` falls on. Its first
 * ten characters are the UTC date instead: in IST a session finished at 00:15 would read as the day
 * before, dropping out of today's stats, its block's coverage and the streak.
 */
export function dateKeyOfIso(iso: string) {
  return format(subMinutes(new Date(iso), dayEnd), "yyyy-MM-dd");
}

/**
 * The day a session counts for: stored when it was logged, so changing when the day ends never re-files
 * history. A session from before `dayKey` existed was logged under a midnight day, and stays there.
 */
export function sessionDayKey(session: { dayKey?: string; completedAt: string }) {
  return session.dayKey ?? scheduleDayKey(new Date(session.completedAt));
}

/**
 * The date of the schedule document a session's block is on, for matching a session to a block. Recurring
 * slots reuse one id on every date, so this must be the block's own date, not the day the session counts
 * for: a block at 01:00 is on Thursday's document, however late your Wednesday runs.
 */
export function sessionSlotDayKey(session: { slotDateKey?: string; completedAt: string }) {
  return session.slotDateKey ?? scheduleDayKey(new Date(session.completedAt));
}

/** `todayKey` for the server, which has no local time zone of its own: the day `date` falls on for someone in `timeZone`. */
export function zonedDayKey(date: Date, timeZone: string, dayEndsAt?: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(subMinutes(date, dayEndMinutes(dayEndsAt)));
}

/** `currentMinute` for the server: minutes past midnight on the wall clock in `timeZone` (no day-end shift — it pairs with a schedule date). */
export function zonedMinute(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return value("hour") * 60 + value("minute");
}

export function weekStartKey(date = logicalNow()) {
  return format(startOfWeek(date, { weekStartsOn: 1 }), "yyyy-MM-dd");
}

export function lastSevenDays(date = logicalNow()) {
  return Array.from({ length: 7 }, (_, index) => todayKey(subDays(date, 6 - index)));
}

/** The 7 date keys (Mon-Sun) for the week whose Monday is `weekStart` (yyyy-MM-dd). */
export function weekDates(weekStart: string) {
  const start = parseISO(weekStart);
  return Array.from({ length: 7 }, (_, index) => todayKey(addDays(start, index)));
}

export function currentWeekDays(date = logicalNow()) {
  const start = startOfWeek(date, { weekStartsOn: 1 });
  return Array.from({ length: 7 }, (_, index) => {
    const day = addDays(start, index);
    return {
      key: todayKey(day),
      label: format(day, "EEE"),
      display: format(day, "MMM d"),
      isToday: isSameDay(day, logicalNow())
    };
  });
}

export function friendlyDate(dateKey: string) {
  return format(parseISO(dateKey), "EEEE, MMMM d");
}

/** `dateKey` offset by `days` (negative = earlier) — used to turn a task pack's/goal template's relative offsets into real due dates once an anchor date is picked. */
export function addDaysToKey(dateKey: string, days: number) {
  return todayKey(addDays(parseISO(dateKey), days));
}
