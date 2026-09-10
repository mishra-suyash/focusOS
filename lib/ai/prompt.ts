import { averageFocusRating, completionRate, focusedMinutesByCategory, todayMetrics, weeklyPomodoros } from "@/lib/analytics";
import type { InsightData } from "@/lib/admin-firestore";
import type { InsightDailyOutput } from "@/lib/ai/schemas";

export function buildInsightPrompt({ tasks, sessions, days, papers, checkpoints }: InsightData) {
  const metrics = todayMetrics(tasks, sessions);
  const weekly = weeklyPomodoros(sessions);
  const byCategory = focusedMinutesByCategory(sessions).filter((item) => item.minutes > 0);
  const rate = completionRate(tasks);
  const avgFocus = averageFocusRating(days);

  const openHighPriorityTasks = tasks
    .filter((task) => task.status !== "done" && task.priority === "high")
    .map((task) => `- ${task.title}${task.dueDate ? ` (due ${task.dueDate})` : ""}`)
    .join("\n");

  const upcomingCheckpoints = checkpoints
    .filter((checkpoint) => checkpoint.status !== "done" && checkpoint.status !== "missed")
    .sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1))
    .slice(0, 10)
    .map((checkpoint) => `- [${checkpoint.type}] ${checkpoint.title} (due ${checkpoint.dueAt})`)
    .join("\n");

  const readingQueue = papers
    .filter((paper) => paper.status === "to_read" || paper.status === "reading")
    .slice(0, 10)
    .map((paper) => `- [${paper.status}] ${paper.title}`)
    .join("\n");

  const recentComments = sessions
    .filter((session) => session.comment)
    .slice(0, 15)
    .map((session) => `- (${session.category}) ${session.label}: ${session.comment}`)
    .join("\n");

  return `You are a productivity coach for a PhD scholar using their personal focus app, FocusOS.

Today's metrics: ${metrics.pomodoros} pomodoros, ${metrics.focusedMinutes} focused minutes, ${metrics.tasksCompleted} tasks completed, ${metrics.streak}-day streak.
Task completion rate: ${rate}%. Average recent daily focus rating: ${avgFocus}/5.
Pomodoros over the last 7 days: ${weekly.map((day) => `${day.day}:${day.pomodoros}`).join(", ")}.
Focused minutes by category: ${byCategory.map((item) => `${item.category}:${item.minutes}m`).join(", ") || "none yet"}.

High priority open tasks:
${openHighPriorityTasks || "None"}

Upcoming checkpoints:
${upcomingCheckpoints || "None"}

Reading queue:
${readingQueue || "None"}

Recent pomodoro session comments:
${recentComments || "None"}

Based on this, write a short, encouraging analysis and a concrete plan for today. Respond with ONLY valid JSON of the shape {"summary": string, "suggestions": string[]}. Keep the summary to 2-3 sentences and suggestions to 3-5 short, specific, actionable items.`;
}

/**
 * The `insight.daily` task's deterministic fallback (plan §9.1: "no feature is
 * AI-only") — a numeric, non-generated summary from the same data the prompt
 * uses, so the Insights page still shows something real with no provider key set.
 */
export function buildInsightFallback({ tasks, sessions, checkpoints, papers }: InsightData): InsightDailyOutput {
  const metrics = todayMetrics(tasks, sessions);
  const rate = completionRate(tasks);
  const suggestions: string[] = [];

  const urgentCheckpoint = checkpoints
    .filter((c) => c.status !== "done" && c.status !== "missed")
    .sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1))[0];
  if (urgentCheckpoint) suggestions.push(`Next checkpoint: ${urgentCheckpoint.title} (due ${urgentCheckpoint.dueAt})`);

  const topTask = tasks.find((task) => task.status !== "done" && task.priority === "high");
  if (topTask) suggestions.push(`Highest-priority open task: ${topTask.title}`);

  const readingPaper = papers.find((paper) => paper.status === "reading");
  if (readingPaper) suggestions.push(`Continue reading: ${readingPaper.title}`);

  if (suggestions.length === 0) suggestions.push("No urgent items — a good day to get ahead on the revision queue or reading list.");

  return {
    summary: `${metrics.pomodoros} pomodoros and ${metrics.focusedMinutes} focused minutes today, ${metrics.tasksCompleted} tasks completed. 7-day completion rate: ${rate}%.`,
    suggestions
  };
}
