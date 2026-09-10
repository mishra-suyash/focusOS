"use client";

import { limit, orderBy } from "firebase/firestore";
import { PinOff } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AlertsBanner } from "@/components/alerts-banner";
import { DailyScheduleWidget } from "@/components/daily-schedule-widget";
import { LoadIndexWidget } from "@/components/load-index-widget";
import { MorningBriefCard } from "@/components/morning-brief-card";
import { NextActionCard } from "@/components/next-action-card";
import { PomodoroTimer } from "@/components/pomodoro-timer";
import { useAuth } from "@/components/auth-provider";
import { useCourseCheckpoints } from "@/hooks/use-course-checkpoints";
import { useDay } from "@/hooks/use-day";
import { useRevisionCounts } from "@/hooks/use-revision-counts";
import { useUserCollection } from "@/hooks/use-user-collection";
import { friendlyDate, todayKey, weekDates, weekStartKey } from "@/lib/dates";
import { saveDayFields, updateTask } from "@/lib/firestore";
import { todayMetrics } from "@/lib/analytics";
import { buildLoadIndexSnapshot, computeDebtHours, computeLoadIndexStreak } from "@/lib/loadindex";
import { pickNextAction } from "@/lib/next-action";
import { downloadDailyFramePdf } from "@/lib/pdf";
import { scheduleSummary } from "@/lib/schedule";
import { isBreakMode } from "@/lib/terms";
import type { Course, DailySchedule, Day, Goal, Paper, PomodoroSession, Task, TaskStatus, Term } from "@/types";

export default function DashboardPage() {
  const { user } = useAuth();
  const today = todayKey();
  const { day } = useDay(today);
  const { items: tasks } = useUserCollection<Task>("tasks", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: sessions } = useUserCollection<PomodoroSession>("pomodoroSessions", useMemo(() => [orderBy("completedAt", "desc")], []));
  const { items: dailySchedules } = useUserCollection<DailySchedule>("dailySchedules", useMemo(() => [orderBy("updatedAt", "desc")], []));
  const { items: terms } = useUserCollection<Term>("terms", useMemo(() => [orderBy("startDate", "desc")], []));
  const { items: papers } = useUserCollection<Paper>("papers", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: courses } = useUserCollection<Course>("courses", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: goals } = useUserCollection<Goal>("goals", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: recentDays } = useUserCollection<Day>("days", useMemo(() => [orderBy("date", "desc"), limit(30)], []));
  const { allCheckpoints } = useCourseCheckpoints(courses);
  const { dueCount, reviewedTodayCount } = useRevisionCounts(today);
  const dailySchedule = dailySchedules.find((item) => item.dateKey === today);
  const onBreak = isBreakMode(terms, today);
  const readingQueue = papers.filter((paper) => paper.status === "to_read" || paper.status === "reading").slice(0, 5);
  const todaysTasks = tasks.filter((task) => task.dueDate === today || task.status === "in_progress").slice(0, 5);
  const todaysSessions = sessions.filter((session) => session.completedAt.startsWith(today));
  const metrics = todayMetrics(tasks, sessions);
  const [note, setNote] = useState(day?.scratchpad ?? "");

  const loadIndex = buildLoadIndexSnapshot({
    scheduledDeepWorkMinutes: scheduleSummary(dailySchedule?.slots ?? []).plannedDeepWork,
    revisionDueCount: dueCount,
    revisionsCompletedCount: reviewedTodayCount,
    checkpoints: allCheckpoints,
    courses,
    goals,
    terms,
    focusedMinutes: metrics.focusedMinutes,
    todayKey: today
  });
  const chronologicalLI = [...recentDays].filter((d) => d.loadIndex).sort((a, b) => (a.date < b.date ? -1 : 1));
  const debtHours = computeDebtHours(chronologicalLI.map((d) => d.loadIndex!));
  const liStreak = computeLoadIndexStreak(chronologicalLI.map((d) => d.loadIndex!));
  const weekEnd = weekDates(weekStartKey())[6];
  const nextAction = pickNextAction({
    checkpoints: allCheckpoints,
    dueRevisionCount: dueCount,
    tasks,
    loadIndexValue: loadIndex.value,
    todayKey: today,
    weekEndKey: weekEnd
  });

  const pinnedIds = day?.pinnedTaskIds ?? [];
  const pinnedTasks = pinnedIds.map((id) => tasks.find((task) => task.id === id)).filter((task): task is Task => Boolean(task));
  const pinnableTasks = tasks.filter((task) => task.status !== "done" && !pinnedIds.includes(task.id));

  useEffect(() => {
    setNote(day?.scratchpad ?? "");
  }, [day?.scratchpad]);

  function pinTask(id: string) {
    if (!user || pinnedIds.length >= 3 || !id) return;
    saveDayFields(user.uid, today, { pinnedTaskIds: [...pinnedIds, id] });
  }

  function unpinTask(id: string) {
    if (!user) return;
    saveDayFields(
      user.uid,
      today,
      { pinnedTaskIds: pinnedIds.filter((existing) => existing !== id) }
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="label mb-1">{friendlyDate(today)}</p>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-950 dark:text-ink-50">Today</h1>
        </div>
        <div className="flex gap-2">
          <button
            className="btn-secondary w-fit py-1.5"
            onClick={() =>
              downloadDailyFramePdf({
                date: today,
                priorities: pinnedTasks.map((task) => task.title),
                slots: dailySchedule?.slots ?? [],
                tasks: todaysTasks
              })
            }
          >
            Download PDF
          </button>
          <Link href="/planner/day" className="btn-secondary w-fit py-1.5">
            Open day planner
          </Link>
        </div>
      </div>
      <AlertsBanner />
      <MorningBriefCard brief={day?.brief} />
      <NextActionCard action={nextAction} />
      <section className="card p-3">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {[
            ["Pomodoros", metrics.pomodoros],
            ["Focus min", metrics.focusedMinutes],
            ["Tasks done", metrics.tasksCompleted],
            ["Streak", `${metrics.streak}d`]
          ].map(([label, value]) => (
            <div key={label} className="rounded-md bg-ink-50 px-3 py-2 dark:bg-ink-800">
              <p className="label">{label}</p>
              <p className="mt-1 text-2xl font-semibold leading-none">{value}</p>
            </div>
          ))}
        </div>
      </section>

      {/*
        Three themed columns rather than one big "everything on the right"
        stack: left is what you're actively executing, middle is today's plan,
        right is status/reflection. No fixed viewport height or overflow-hidden
        here any more — the dashboard scrolls like every other page once
        there's more content than one screen holds (Phase 6 added enough
        cards that the old fixed-height layout started silently clipping the
        bottom of the right column instead of scrolling to it).
      */}
      <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <PomodoroTimer sessions={todaysSessions} tasks={tasks} compact />
          <section className="card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Today tasks</h2>
              <Link href="/tasks" className="text-xs font-medium text-moss-700 dark:text-moss-400">Manage</Link>
            </div>
            <div className="space-y-2">
              {todaysTasks.map((task) => (
                <label key={task.id} className="flex items-start gap-2 rounded-md border border-ink-200 p-2 text-sm dark:border-ink-800">
                  <input
                    className="mt-1"
                    type="checkbox"
                    checked={task.status === "done"}
                    onChange={(event) =>
                      updateTask(user!.uid, task.id, {
                        status: event.target.checked ? "done" : ("todo" as TaskStatus),
                        completedAt: event.target.checked ? new Date().toISOString() : undefined
                      })
                    }
                  />
                  <span className={task.status === "done" ? "text-ink-400 line-through" : ""}>{task.title}</span>
                </label>
              ))}
              {todaysTasks.length === 0 ? <p className="rounded-md border border-dashed border-ink-300 p-3 text-sm text-ink-500 dark:border-ink-700">No active tasks for today.</p> : null}
            </div>
          </section>
        </div>

        <div className="space-y-4">
          <DailyScheduleWidget schedule={dailySchedule} tasks={tasks} compact />
        </div>

        <div className="space-y-4">
          <section className="card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Top priorities</h2>
              <span className="text-xs text-ink-500">{pinnedTasks.length}/3 pinned</span>
            </div>
            <div className="space-y-2">
              {pinnedTasks.map((task) => (
                <div key={task.id} className="flex items-center justify-between gap-2 rounded-md border border-ink-200 p-2 text-sm dark:border-ink-800">
                  <span>{task.title}</span>
                  <button className="btn-secondary px-2 py-1" onClick={() => unpinTask(task.id)} aria-label="Unpin task">
                    <PinOff className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {pinnedTasks.length === 0 ? <p className="rounded-md border border-dashed border-ink-300 p-3 text-sm text-ink-500 dark:border-ink-700">Pin up to 3 tasks to make them today&apos;s priorities.</p> : null}
            </div>
            {pinnedTasks.length < 3 && pinnableTasks.length > 0 ? (
              <select className="input mt-3" value="" onChange={(event) => pinTask(event.target.value)} aria-label="Pin a task">
                <option value="">Pin a task...</option>
                {pinnableTasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
            ) : null}
          </section>
          <LoadIndexWidget snapshot={loadIndex} debtHours={debtHours} streak={liStreak} />
          {onBreak ? (
            <section className="card p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-semibold">Break focus</h2>
                <Link href="/papers" className="text-xs font-medium text-moss-700 dark:text-moss-400">Reading list</Link>
              </div>
              <p className="mb-2 text-xs text-ink-500">No active semester term today — no class blocks are generated. Here&apos;s your reading queue instead.</p>
              <div className="space-y-1">
                {readingQueue.map((paper) => (
                  <p key={paper.id} className="truncate rounded-md bg-ink-50 px-2 py-1.5 text-sm dark:bg-ink-800">{paper.title}</p>
                ))}
                {readingQueue.length === 0 ? <p className="text-sm text-ink-500">Reading queue is empty.</p> : null}
              </div>
            </section>
          ) : null}
          <section className="card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Scratchpad</h2>
              <button className="btn-secondary py-1.5 text-xs" onClick={() => user && saveDayFields(user.uid, today, { scratchpad: note })}>Save</button>
            </div>
            <textarea
              className="input h-28 resize-none"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Loose notes, equations, or tomorrow's first move."
            />
          </section>
        </div>
      </div>
    </div>
  );
}
