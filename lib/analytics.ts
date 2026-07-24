import { lastSevenDays, todayKey } from "@/lib/dates";
import type { Category, DailyReview, PomodoroSession, Task } from "@/types";

export function todayMetrics(tasks: Task[], sessions: PomodoroSession[]) {
  const today = todayKey();
  const todaysSessions = sessions.filter((session) => session.completedAt.startsWith(today));
  const completedTasks = tasks.filter((task) => task.completedAt?.startsWith(today));
  return {
    pomodoros: todaysSessions.filter((session) => session.mode === "work").length,
    focusedMinutes: todaysSessions.reduce((sum, session) => sum + (session.mode === "work" ? session.minutes : 0), 0),
    tasksCompleted: completedTasks.length,
    streak: calculateStreak(sessions)
  };
}

export function calculateStreak(sessions: PomodoroSession[]) {
  const activeDates = new Set(sessions.filter((s) => s.mode === "work").map((s) => s.completedAt.slice(0, 10)));
  let streak = 0;
  let cursor = new Date();
  while (activeDates.has(todayKey(cursor))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
  }
  return streak;
}

export function weeklyPomodoros(sessions: PomodoroSession[]) {
  return lastSevenDays().map((day) => ({
    day: day.slice(5),
    pomodoros: sessions.filter((s) => s.mode === "work" && s.completedAt.startsWith(day)).length
  }));
}

export function focusedMinutesByCategory(sessions: PomodoroSession[]) {
  const categories: Category[] = ["research", "coding", "reading", "writing", "admin", "personal"];
  return categories.map((category) => ({
    category,
    minutes: sessions
      .filter((s) => s.mode === "work" && s.category === category)
      .reduce((sum, session) => sum + session.minutes, 0)
  }));
}

export function completedTasksByDay(tasks: Task[]) {
  return lastSevenDays().map((day) => ({
    day: day.slice(5),
    completed: tasks.filter((task) => task.completedAt?.startsWith(day)).length
  }));
}

export function completionRate(tasks: Task[]) {
  if (tasks.length === 0) return 0;
  return Math.round((tasks.filter((task) => task.status === "done").length / tasks.length) * 100);
}

export function averageFocusRating(reviews: DailyReview[]) {
  if (reviews.length === 0) return 0;
  return Number((reviews.reduce((sum, review) => sum + review.focusRating, 0) / reviews.length).toFixed(1));
}
