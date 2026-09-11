"use client";

import { orderBy, where } from "firebase/firestore";
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ModuleGate } from "@/components/module-gate";
import { SectionHeader } from "@/components/section-header";
import { useUserCollection } from "@/hooks/use-user-collection";
import { completedTasksByDay, completionRate, focusedMinutesByCategory, weeklyPomodoros } from "@/lib/analytics";
import { todayKey } from "@/lib/dates";
import type { Day, PomodoroSession, Task } from "@/types";

const HISTORY_DAYS = 30;

function AnalyticsPageContent() {
  const { items: sessions } = useUserCollection<PomodoroSession>("pomodoroSessions", useMemo(() => [orderBy("completedAt", "desc")], []));
  const { items: tasks } = useUserCollection<Task>("tasks", useMemo(() => [orderBy("createdAt", "desc")], []));
  const historyStart = useMemo(() => {
    const date = new Date();
    date.setDate(date.getDate() - HISTORY_DAYS);
    return todayKey(date);
  }, []);
  const { items: days } = useUserCollection<Day>(
    "days",
    useMemo(() => [where("date", ">=", historyStart), orderBy("date", "asc")], [historyStart])
  );
  const pomodoros = weeklyPomodoros(sessions);
  const minutes = focusedMinutesByCategory(sessions);
  const completed = completedTasksByDay(tasks);
  const rate = completionRate(tasks);
  const loadIndexHistory = days
    .filter((day) => day.loadIndex)
    .map((day) => ({ day: day.date.slice(5), value: day.loadIndex!.value }));

  return (
    <>
      <SectionHeader title="Analytics" eyebrow="Last 7 days" />
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Metric label="Completion rate" value={`${rate}%`} />
        <Metric label="Total focus minutes" value={minutes.reduce((sum, item) => sum + item.minutes, 0)} />
        <Metric label="Focus sessions" value={pomodoros.reduce((sum, item) => sum + item.pomodoros, 0)} />
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <ChartCard title="Focus sessions per day">
          <BarChart data={pomodoros}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="day" /><YAxis allowDecimals={false} /><Tooltip /><Bar dataKey="pomodoros" fill="#4f8b67" radius={[4, 4, 0, 0]} /></BarChart>
        </ChartCard>
        <ChartCard title="Focused minutes by category">
          <BarChart data={minutes}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="category" /><YAxis /><Tooltip /><Bar dataKey="minutes" fill="#d39b40" radius={[4, 4, 0, 0]} /></BarChart>
        </ChartCard>
        <ChartCard title="Tasks completed by day">
          <BarChart data={completed}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="day" /><YAxis allowDecimals={false} /><Tooltip /><Bar dataKey="completed" fill="#315d45" radius={[4, 4, 0, 0]} /></BarChart>
        </ChartCard>
        <section className="card p-5">
          <h2 className="mb-4 text-lg font-semibold">Workload trend (last 30 days)</h2>
          <div className="h-72">
            {loadIndexHistory.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={loadIndexHistory}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="day" />
                  <YAxis domain={[0, "auto"]} />
                  <Tooltip />
                  <Line type="monotone" dataKey="value" stroke="#4f8b67" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-center text-sm text-ink-500">
                No Workload history yet — it&apos;s recorded each time you click &ldquo;End day.&rdquo;
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div className="card p-4"><p className="label">{label}</p><p className="mt-2 text-3xl font-semibold">{value}</p></div>;
}

function ChartCard({ title, children }: { title: string; children: React.ReactElement }) {
  return (
    <section className="card p-5">
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
      </div>
    </section>
  );
}

export default function AnalyticsPage() {
  return (
    <ModuleGate moduleId="analytics">
      <AnalyticsPageContent />
    </ModuleGate>
  );
}
