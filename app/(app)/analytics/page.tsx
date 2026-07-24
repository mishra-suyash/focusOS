"use client";

import { orderBy } from "firebase/firestore";
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { SectionHeader } from "@/components/section-header";
import { useUserCollection } from "@/hooks/use-user-collection";
import { completedTasksByDay, completionRate, focusedMinutesByCategory, weeklyPomodoros } from "@/lib/analytics";
import type { PomodoroSession, Task } from "@/types";

export default function AnalyticsPage() {
  const { items: sessions } = useUserCollection<PomodoroSession>("pomodoroSessions", useMemo(() => [orderBy("completedAt", "desc")], []));
  const { items: tasks } = useUserCollection<Task>("tasks", useMemo(() => [orderBy("createdAt", "desc")], []));
  const pomodoros = weeklyPomodoros(sessions);
  const minutes = focusedMinutesByCategory(sessions);
  const completed = completedTasksByDay(tasks);
  const rate = completionRate(tasks);

  return (
    <>
      <SectionHeader title="Analytics" eyebrow="Last 7 days" />
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Metric label="Completion rate" value={`${rate}%`} />
        <Metric label="Total focus minutes" value={minutes.reduce((sum, item) => sum + item.minutes, 0)} />
        <Metric label="Work pomodoros" value={pomodoros.reduce((sum, item) => sum + item.pomodoros, 0)} />
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <ChartCard title="Pomodoros per day">
          <BarChart data={pomodoros}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="day" /><YAxis allowDecimals={false} /><Tooltip /><Bar dataKey="pomodoros" fill="#4f8b67" radius={[4, 4, 0, 0]} /></BarChart>
        </ChartCard>
        <ChartCard title="Focused minutes by category">
          <BarChart data={minutes}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="category" /><YAxis /><Tooltip /><Bar dataKey="minutes" fill="#d39b40" radius={[4, 4, 0, 0]} /></BarChart>
        </ChartCard>
        <ChartCard title="Tasks completed by day">
          <BarChart data={completed}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="day" /><YAxis allowDecimals={false} /><Tooltip /><Bar dataKey="completed" fill="#315d45" radius={[4, 4, 0, 0]} /></BarChart>
        </ChartCard>
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
