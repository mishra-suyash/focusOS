"use client";

import { orderBy } from "firebase/firestore";
import { useMemo } from "react";
import { useCourseCheckpoints } from "@/hooks/use-course-checkpoints";
import { useRevisionCounts } from "@/hooks/use-revision-counts";
import { useUserCollection } from "@/hooks/use-user-collection";
import { todayMetrics } from "@/lib/analytics";
import { buildLoadIndexSnapshot } from "@/lib/loadindex";
import { scheduleSummary } from "@/lib/schedule";
import type { Course, DailySchedule, Goal, PomodoroSession, Task, Term } from "@/types";

/**
 * The same live Workload computation the Dashboard's widget shows, recomputed from current data
 * on every render — never the stale cron/end-of-day snapshot saved on `Day.loadIndex`. Extracted
 * so every surface claiming to show "today's Workload" (Dashboard, the floating/PiP widget) agrees
 * on one number instead of drifting apart.
 */
export function useLiveLoadIndex(todayKey: string) {
  const { items: tasks } = useUserCollection<Task>("tasks", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: sessions } = useUserCollection<PomodoroSession>("pomodoroSessions", useMemo(() => [orderBy("completedAt", "desc")], []));
  const { items: dailySchedules } = useUserCollection<DailySchedule>("dailySchedules", useMemo(() => [orderBy("updatedAt", "desc")], []));
  const { items: terms } = useUserCollection<Term>("terms", useMemo(() => [orderBy("startDate", "desc")], []));
  const { items: courses } = useUserCollection<Course>("courses", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: goals } = useUserCollection<Goal>("goals", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { allCheckpoints } = useCourseCheckpoints(courses);
  const { dueCount, reviewedTodayCount } = useRevisionCounts(todayKey);
  const dailySchedule = dailySchedules.find((item) => item.dateKey === todayKey);
  const metrics = todayMetrics(tasks, sessions);

  return buildLoadIndexSnapshot({
    scheduledDeepWorkMinutes: scheduleSummary(dailySchedule?.slots ?? []).plannedDeepWork,
    revisionDueCount: dueCount,
    revisionsCompletedCount: reviewedTodayCount,
    checkpoints: allCheckpoints,
    courses,
    goals,
    terms,
    focusedMinutes: metrics.focusedMinutes,
    todayKey
  });
}
