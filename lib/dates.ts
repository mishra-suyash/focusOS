import { addDays, format, isSameDay, parseISO, startOfWeek, subDays } from "date-fns";

export function todayKey(date = new Date()) {
  return format(date, "yyyy-MM-dd");
}

export function weekStartKey(date = new Date()) {
  return format(startOfWeek(date, { weekStartsOn: 1 }), "yyyy-MM-dd");
}

export function lastSevenDays(date = new Date()) {
  return Array.from({ length: 7 }, (_, index) => todayKey(subDays(date, 6 - index)));
}

/** The 7 date keys (Mon-Sun) for the week whose Monday is `weekStart` (yyyy-MM-dd). */
export function weekDates(weekStart: string) {
  const start = parseISO(weekStart);
  return Array.from({ length: 7 }, (_, index) => todayKey(addDays(start, index)));
}

export function currentWeekDays(date = new Date()) {
  const start = startOfWeek(date, { weekStartsOn: 1 });
  return Array.from({ length: 7 }, (_, index) => {
    const day = addDays(start, index);
    return {
      key: todayKey(day),
      label: format(day, "EEE"),
      display: format(day, "MMM d"),
      isToday: isSameDay(day, new Date())
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
