import { parseISO, subDays } from "date-fns";
import { dateKeyOfIso, lastSevenDays, sessionDayKey, todayKey } from "@/lib/dates";
import type { Category, Day, PomodoroSession, Task } from "@/types";

export function todayMetrics(tasks: Task[], sessions: PomodoroSession[]) {
  const today = todayKey();
  const todaysSessions = sessions.filter((session) => sessionDayKey(session) === today);
  const completedTasks = tasks.filter((task) => task.completedAt && dateKeyOfIso(task.completedAt) === today);
  return {
    pomodoros: todaysSessions.filter((session) => session.mode === "work").length,
    focusedMinutes: todaysSessions.reduce((sum, session) => sum + (session.mode === "work" ? session.minutes : 0), 0),
    tasksCompleted: completedTasks.length,
    streak: calculateStreak(sessions)
  };
}

export function calculateStreak(sessions: PomodoroSession[]) {
  const activeDates = new Set(sessions.filter((s) => s.mode === "work").map(sessionDayKey));
  let cursor = parseISO(todayKey());
  // Today isn't over, so nothing logged yet doesn't break the run: it only counts once it's done.
  if (!activeDates.has(todayKey(cursor))) cursor = subDays(cursor, 1);
  let streak = 0;
  while (activeDates.has(todayKey(cursor))) {
    streak += 1;
    cursor = subDays(cursor, 1);
  }
  return streak;
}

export function weeklyPomodoros(sessions: PomodoroSession[], days: string[] = lastSevenDays()) {
  return days.map((day) => ({
    day: day.slice(5),
    pomodoros: sessions.filter((s) => s.mode === "work" && sessionDayKey(s) === day).length
  }));
}

/** Focused minutes by category, windowed to `days` (defaults to the last 7 days). */
export function focusedMinutesByCategory(sessions: PomodoroSession[], days: string[] = lastSevenDays()) {
  const dateSet = new Set(days);
  const categories: Category[] = ["research", "coding", "reading", "writing", "admin", "personal"];
  return categories.map((category) => ({
    category,
    minutes: sessions
      .filter((s) => s.mode === "work" && s.category === category && dateSet.has(sessionDayKey(s)))
      .reduce((sum, session) => sum + session.minutes, 0)
  }));
}

export function completedTasksByDay(tasks: Task[], days: string[] = lastSevenDays()) {
  return days.map((day) => ({
    day: day.slice(5),
    completed: tasks.filter((task) => task.completedAt && dateKeyOfIso(task.completedAt) === day).length
  }));
}

/**
 * Completion rate windowed to `days` (defaults to the last 7 days): of the tasks
 * that were either due or completed in that window, what fraction are done.
 * A lifetime backlog of untouched tasks no longer drags this number around.
 */
export function completionRate(tasks: Task[], days: string[] = lastSevenDays()) {
  const dateSet = new Set(days);
  const relevant = tasks.filter(
    (task) => (task.dueDate && dateSet.has(task.dueDate)) || (task.completedAt && dateSet.has(dateKeyOfIso(task.completedAt)))
  );
  if (relevant.length === 0) return 0;
  return Math.round((relevant.filter((task) => task.status === "done").length / relevant.length) * 100);
}

/** Average focus rating over the given `days` docs only — callers scope this to a specific week. */
export function averageFocusRating(days: Day[]) {
  const rated = days.filter((day): day is Day & { review: { focusRating: number } } => typeof day.review?.focusRating === "number");
  if (rated.length === 0) return 0;
  return Number((rated.reduce((sum, day) => sum + day.review.focusRating, 0) / rated.length).toFixed(1));
}
