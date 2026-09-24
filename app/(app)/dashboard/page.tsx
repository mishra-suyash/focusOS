"use client";

import { limit, orderBy } from "firebase/firestore";
import { Settings2, Star } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import { AlertsBanner } from "@/components/alerts-banner";
import { NudgeBanner } from "@/components/nudge-banner";
import { DailyScheduleWidget } from "@/components/daily-schedule-widget";
import { DashboardCustomizeDialog } from "@/components/dashboard-customize";
import { useFocusSession } from "@/components/focus-session-provider";
import { GettingStartedChecklist } from "@/components/getting-started-checklist";
import { LoadIndexWidget } from "@/components/load-index-widget";
import { MorningBriefCard } from "@/components/morning-brief-card";
import { NextActionCard } from "@/components/next-action-card";
import { PomodoroTimer } from "@/components/pomodoro-timer";
import { ReadingNowCard } from "@/components/reading-now-card";
import { useAuth } from "@/components/auth-provider";
import { useCourseCheckpoints } from "@/hooks/use-course-checkpoints";
import { useDay } from "@/hooks/use-day";
import { useFeatures } from "@/hooks/use-features";
import { useRevisionCounts } from "@/hooks/use-revision-counts";
import { useUserCollection } from "@/hooks/use-user-collection";
import { useUserSettings } from "@/hooks/use-user-settings";
import { friendlyDate, todayKey, weekDates, weekStartKey } from "@/lib/dates";
import { resolveDashboardWidgets } from "@/lib/dashboard-widgets";
import { saveDailySchedule, saveDayFields, updateTask } from "@/lib/firestore";
import { categoryLabels } from "@/lib/options";
import { computeStatusPatch } from "@/lib/tasks";
import { todayMetrics } from "@/lib/analytics";
import { buildLoadIndexSnapshot, computeDebtHours, computeLoadIndexStreak } from "@/lib/loadindex";
import { pickNextAction } from "@/lib/next-action";
import { downloadDailyFramePdf } from "@/lib/pdf";
import { createSlot, currentMinute, minutesToTime, scheduleSummary, sortedSlots } from "@/lib/schedule";
import { createTaskBlock, nearestFreeGap, taskBlockMinutes } from "@/lib/timeline";
import { isBreakMode } from "@/lib/terms";
import type { Course, DailySchedule, Day, Goal, Paper, PomodoroSession, ScheduleSlotType, Task, Term } from "@/types";

export default function DashboardPage() {
  return (
    <Suspense fallback={null}>
      <DashboardContent />
    </Suspense>
  );
}

function DashboardContent() {
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { enabledModules } = useFeatures();
  const { settings, update: updateSettings } = useUserSettings();
  const widgets = resolveDashboardWidgets(settings);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [showAllTasks, setShowAllTasks] = useState(false);
  const today = todayKey();
  const { day } = useDay(today);
  const { items: tasks } = useUserCollection<Task>("tasks", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: sessions } = useUserCollection<PomodoroSession>("pomodoroSessions", useMemo(() => [orderBy("completedAt", "desc")], []));
  const { items: dailySchedules, loading: dailySchedulesLoading } = useUserCollection<DailySchedule>(
    "dailySchedules",
    useMemo(() => [orderBy("updatedAt", "desc")], [])
  );
  const { items: terms } = useUserCollection<Term>("terms", useMemo(() => [orderBy("startDate", "desc")], []));
  const { items: papers } = useUserCollection<Paper>("papers", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: courses } = useUserCollection<Course>("courses", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: goals } = useUserCollection<Goal>("goals", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: recentDays } = useUserCollection<Day>("days", useMemo(() => [orderBy("date", "desc"), limit(30)], []));
  const { allCheckpoints } = useCourseCheckpoints(courses);
  const { dueCount, reviewedTodayCount } = useRevisionCounts(today);
  const dailySchedule = dailySchedules.find((item) => item.dateKey === today);
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
    weekEndKey: weekEnd,
    enabledModules
  });

  const { startFocus } = useFocusSession();

  // DP5 S4 "Start focus session from a block" — `BlockInspector` links here with
  // `?startFocus=1&label=...&category=...&slotId=...`. `FocusSessionProvider` now owns the timer
  // (it survives navigation, so `PomodoroTimer` no longer needs a "consume once" prop dance) —
  // this effect just starts the session and clears the query string when the URL carries the param.
  useEffect(() => {
    if (searchParams.get("startFocus") !== "1") return;
    // `dailySchedules` starts empty and loads asynchronously — on a cold mount (the actual path
    // from BlockInspector's Play link, not a rare race) this effect would otherwise run once with
    // `dailySchedule` still undefined, find no linked task, then never get a second chance once the
    // real snapshot arrives (the `startFocus=1` param is already gone by then). Wait for the load
    // instead of consuming the param against incomplete data (plan/13 A7).
    if (dailySchedulesLoading) return;
    const label = searchParams.get("label");
    const category = searchParams.get("category") as Task["category"] | null;
    if (!label || !category) return;
    const slotId = searchParams.get("slotId") ?? undefined;
    // A block linked to exactly one task should credit that task's focus-session count — a block
    // with zero or several linked tasks is ambiguous, so it's left uncredited as before.
    const linkedTaskIds = slotId ? dailySchedule?.slots.find((slot) => slot.id === slotId)?.assignedTaskIds ?? [] : [];
    const courseId = searchParams.get("courseId") ?? undefined;
    const bucket = (searchParams.get("bucket") as Task["bucket"] | null) ?? undefined;
    startFocus({ label, category, slotId, taskId: linkedTaskIds.length === 1 ? linkedTaskIds[0] : undefined, courseId, bucket });
    router.replace("/dashboard", { scroll: false });
  }, [searchParams, dailySchedule, dailySchedulesLoading]);

  /** S5 "Schedule it" on the Up next card — places it in the next free gap after now and opens Plan — Day. */
  async function scheduleAction() {
    if (!user || !nextAction || nextAction.kind === "rest") return;
    const currentSlots = dailySchedule?.slots ?? [];
    const workMinutes = settings.workMinutes ?? 25;
    let block;
    if (nextAction.kind === "task" && nextAction.taskId) {
      const task = tasks.find((item) => item.id === nextAction.taskId);
      if (!task) return;
      const duration = taskBlockMinutes(task, workMinutes);
      const gapStart = nearestFreeGap(currentSlots, currentMinute(), duration);
      if (gapStart === null) return;
      block = createTaskBlock(task, workMinutes, gapStart);
    } else {
      const duration = 45;
      const type: ScheduleSlotType = nextAction.kind === "revision" ? "reading" : "admin";
      const gapStart = nearestFreeGap(currentSlots, currentMinute(), duration);
      if (gapStart === null) return;
      block = createSlot({ title: nextAction.title, type, startTime: minutesToTime(gapStart), endTime: minutesToTime(gapStart + duration) });
    }
    await saveDailySchedule(user.uid, { dateKey: today, templateId: dailySchedule?.templateId, slots: sortedSlots([...currentSlots, block]) });
    router.push(`/plan/day?date=${today}`);
  }

  const pinnedIds = day?.pinnedTaskIds ?? [];
  const pinnedTasks = pinnedIds.map((id) => tasks.find((task) => task.id === id)).filter((task): task is Task => Boolean(task));

  // Today's tasks (plan §9.4/F4) — pinned tasks (the old separate "Top priorities" card) merge
  // in here as a ★, sorted first; due-today/in-progress plus anything pinned regardless of date.
  const todaysTaskIds = new Set(tasks.filter((task) => task.dueDate === today || task.status === "in_progress").map((task) => task.id));
  for (const id of pinnedIds) todaysTaskIds.add(id);
  const allTodaysTasks = tasks
    .filter((task) => todaysTaskIds.has(task.id))
    .sort((a, b) => Number(pinnedIds.includes(b.id)) - Number(pinnedIds.includes(a.id)));
  // Pins are always visible in full (that's the point of pinning); the 5-cap applies only to
  // the unpinned remainder, so up to 3 pins never crowd out today's actual due tasks.
  const unpinnedTodaysTasks = allTodaysTasks.filter((task) => !pinnedIds.includes(task.id));
  const visibleUnpinnedCount = showAllTasks ? unpinnedTodaysTasks.length : Math.max(0, 5 - pinnedTasks.length);
  const visibleTasks = [
    ...allTodaysTasks.filter((task) => pinnedIds.includes(task.id)),
    ...unpinnedTodaysTasks.slice(0, visibleUnpinnedCount)
  ];

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
          <button className="btn-secondary px-2" onClick={() => setCustomizeOpen(true)} aria-label="Customize dashboard">
            <Settings2 className="h-4 w-4" />
          </button>
          <button
            className="btn-secondary w-fit py-1.5"
            onClick={() =>
              downloadDailyFramePdf({
                date: today,
                priorities: pinnedTasks.map((task) => task.title),
                slots: dailySchedule?.slots ?? [],
                tasks: allTodaysTasks
              })
            }
          >
            Download PDF
          </button>
          <Link href="/plan/day" className="btn-secondary w-fit py-1.5">
            Open day planner
          </Link>
        </div>
      </div>
      <AlertsBanner />
      <NudgeBanner data={{ tasks, sessions, papers, courses, goals, recentDays }} />
      <GettingStartedChecklist data={{ tasks, sessions, papers, courses, goals, recentDays }} />
      {widgets.has("morningOverview") ? <MorningBriefCard brief={day?.brief} /> : null}
      <NextActionCard action={nextAction} onScheduleIt={scheduleAction} />
      {widgets.has("metricsStrip") ? (
        <section className="card p-3">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {[
              ["Focus sessions", metrics.pomodoros],
              ["Focus min", metrics.focusedMinutes],
              ["Tasks done", metrics.tasksCompleted],
              ["Active-day streak", `${metrics.streak}d`]
            ].map(([label, value]) => (
              <div key={label} className="rounded-md bg-ink-50 px-3 py-2 dark:bg-ink-800">
                <p className="label">{label}</p>
                <p className="mt-1 text-2xl font-semibold leading-none">{value}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

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
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold">Today&apos;s tasks</h2>
              <Link href="/tasks" className="text-xs font-medium text-moss-700 dark:text-moss-400">Manage</Link>
            </div>
            <div className="space-y-2">
              {visibleTasks.map((task) => {
                const pinned = pinnedIds.includes(task.id);
                const taskCourse = task.courseId ? courses.find((item) => item.id === task.courseId) : undefined;
                return (
                  <div key={task.id} className="flex items-start gap-2 rounded-md border border-ink-200 p-2 text-sm dark:border-ink-800">
                    <input
                      className="mt-1"
                      type="checkbox"
                      checked={task.status === "done"}
                      onChange={(event) => updateTask(user!.uid, task.id, computeStatusPatch(task, event.target.checked ? "done" : "todo"))}
                    />
                    <div className="min-w-0 flex-1">
                      <span className={clsx(task.status === "done" && "text-ink-400 line-through")}>{task.title}</span>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span
                          className={clsx(
                            "rounded px-1.5 py-0.5 font-semibold uppercase",
                            task.priority === "high" && "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200",
                            task.priority === "medium" && "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
                            task.priority === "low" && "bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300"
                          )}
                        >
                          {task.priority}
                        </span>
                        <span className="rounded bg-moss-600/10 px-1.5 py-0.5 font-medium text-moss-700 dark:text-moss-500">
                          {categoryLabels[task.category]}
                        </span>
                        {taskCourse ? (
                          <span className="rounded bg-ink-100 px-1.5 py-0.5 font-medium text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                            {taskCourse.code || taskCourse.name}
                          </span>
                        ) : null}
                        {task.dueDate ? <span className="text-ink-500">Due {task.dueDate}</span> : null}
                        {task.kind === "external" ? (
                          <span className="rounded bg-sky-100 px-1.5 py-0.5 font-semibold uppercase text-sky-700 dark:bg-sky-950 dark:text-sky-300">
                            Hard deadline
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <button
                      className={clsx("shrink-0", pinned ? "text-amberline" : "text-ink-300 hover:text-ink-500 dark:text-ink-600")}
                      onClick={() => (pinned ? unpinTask(task.id) : pinTask(task.id))}
                      disabled={!pinned && pinnedIds.length >= 3}
                      aria-label={pinned ? "Unpin task" : "Pin as a top priority"}
                      title={pinned ? "Unpin" : pinnedIds.length >= 3 ? "Up to 3 pinned at once" : "Pin as a top priority"}
                    >
                      <Star className="h-4 w-4" fill={pinned ? "currentColor" : "none"} />
                    </button>
                  </div>
                );
              })}
              {allTodaysTasks.length === 0 ? <p className="rounded-md border border-dashed border-ink-300 p-3 text-sm text-ink-500 dark:border-ink-700">No active tasks for today.</p> : null}
            </div>
            {allTodaysTasks.length > 5 ? (
              <button className="btn-secondary mt-3 w-full py-1.5 text-xs" onClick={() => setShowAllTasks((current) => !current)}>
                {showAllTasks ? "Show fewer" : `Show all (${allTodaysTasks.length})`}
              </button>
            ) : null}
          </section>
        </div>

        <div className="space-y-4">
          <DailyScheduleWidget schedule={dailySchedule} tasks={tasks} compact />
        </div>

        <div className="space-y-4">
          {widgets.has("workload") ? (
            <LoadIndexWidget snapshot={loadIndex} debtHours={widgets.has("catchUpHours") ? debtHours : undefined} streak={liStreak} />
          ) : null}
          <ReadingNowCard papers={papers} onBreak={isBreakMode(terms, today)} />
          {widgets.has("scratchpad") ? (
            <section className="card p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
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
          ) : null}
        </div>
      </div>
      {customizeOpen ? (
        <DashboardCustomizeDialog
          settings={settings}
          onChange={(widgetIds) => updateSettings({ dashboardWidgets: widgetIds })}
          onClose={() => setCustomizeOpen(false)}
        />
      ) : null}
    </div>
  );
}
