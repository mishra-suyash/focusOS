"use client";

import { orderBy } from "firebase/firestore";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DailyScheduleWidget } from "@/components/daily-schedule-widget";
import { PomodoroTimer } from "@/components/pomodoro-timer";
import { ThoughtWidget } from "@/components/thought-widget";
import { useAuth } from "@/components/auth-provider";
import { useUserCollection } from "@/hooks/use-user-collection";
import { friendlyDate, todayKey } from "@/lib/dates";
import { saveDailyNote, saveDailyPlan, updateTask } from "@/lib/firestore";
import { todayMetrics } from "@/lib/analytics";
import type {
  DailyNote,
  DailyPlan,
  DailySchedule,
  PomodoroSession,
  Task,
  TaskStatus,
  Thought,
  ThoughtSelection
} from "@/types";

export default function DashboardPage() {
  const { user } = useAuth();
  const today = todayKey();
  const { items: tasks } = useUserCollection<Task>("tasks", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: sessions } = useUserCollection<PomodoroSession>("pomodoroSessions", useMemo(() => [orderBy("completedAt", "desc")], []));
  const { items: notes } = useUserCollection<DailyNote>("dailyNotes", useMemo(() => [orderBy("updatedAt", "desc")], []));
  const { items: plans } = useUserCollection<DailyPlan>("dailyPlans", useMemo(() => [orderBy("updatedAt", "desc")], []));
  const { items: dailySchedules } = useUserCollection<DailySchedule>("dailySchedules", useMemo(() => [orderBy("updatedAt", "desc")], []));
  const { items: thoughts } = useUserCollection<Thought>("thoughts", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: thoughtSelections } = useUserCollection<ThoughtSelection>("thoughtSelections", useMemo(() => [orderBy("updatedAt", "desc")], []));
  const [note, setNote] = useState(todayNoteContent(notes, today));
  const todayNote = notes.find((item) => item.date === today);
  const plan = plans.find((item) => item.date === today);
  const dailySchedule = dailySchedules.find((item) => item.dateKey === today);
  const thoughtSelection = thoughtSelections.find((item) => item.dateKey === today);
  const todaysTasks = tasks.filter((task) => task.dueDate === today || task.status === "in_progress").slice(0, 5);
  const todaysSessions = sessions.filter((session) => session.completedAt.startsWith(today));
  const metrics = todayMetrics(tasks, sessions);
  const [priorities, setPriorities] = useState<string[]>(plan?.priorities ?? ["", "", ""]);

  useEffect(() => {
    setNote(todayNote?.content ?? "");
  }, [todayNote]);

  useEffect(() => {
    setPriorities(plan?.priorities ?? ["", "", ""]);
  }, [plan]);

  async function savePlan() {
    if (!user) return;
    await saveDailyPlan(user.uid, { date: today, priorities, schedule: plan?.schedule ?? [] });
  }

  return (
    <div className="space-y-4 xl:h-[calc(100vh-6.5rem)] xl:overflow-hidden">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="label mb-1">{friendlyDate(today)}</p>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-950 dark:text-ink-50">Today</h1>
        </div>
        <Link href="/planner/day" className="btn-secondary w-fit py-1.5">
          Open day planner
        </Link>
      </div>
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
      <div className="grid gap-4 xl:h-[calc(100%_-_6.75rem)] xl:grid-cols-[340px_minmax(0,1fr)_340px] xl:overflow-hidden">
        <div className="space-y-4 xl:min-h-0 xl:overflow-hidden">
          <PomodoroTimer sessions={todaysSessions} compact />
          <ThoughtWidget thoughts={thoughts} selection={thoughtSelection} dateKey={today} compact />
        </div>
        <div className="xl:min-h-0 xl:overflow-hidden">
          <DailyScheduleWidget schedule={dailySchedule} tasks={tasks} compact />
        </div>
        <div className="space-y-4 xl:min-h-0 xl:overflow-hidden">
          <section className="card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Top 3 priorities</h2>
              <button className="btn-secondary py-1.5 text-xs" onClick={savePlan}>Save</button>
            </div>
            <div className="space-y-2">
              {[0, 1, 2].map((index) => (
                <input
                  key={index}
                  className="input"
                  value={priorities[index] ?? ""}
                  onChange={(event) => setPriorities((current) => current.map((item, i) => (i === index ? event.target.value : item)))}
                  placeholder={`Priority ${index + 1}`}
                />
              ))}
            </div>
          </section>
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
          <section className="card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Scratchpad</h2>
              <button className="btn-secondary py-1.5 text-xs" onClick={() => user && saveDailyNote(user.uid, today, note)}>Save</button>
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

function todayNoteContent(notes: DailyNote[], today: string) {
  return notes.find((item) => item.date === today)?.content ?? "";
}
