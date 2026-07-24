"use client";

import { orderBy } from "firebase/firestore";
import { useMemo, useState } from "react";
import { SectionHeader } from "@/components/section-header";
import { useAuth } from "@/components/auth-provider";
import { useUserCollection } from "@/hooks/use-user-collection";
import { createWeeklyGoal, updateWeeklyGoal } from "@/lib/firestore";
import { currentWeekDays, weekStartKey } from "@/lib/dates";
import type { WeeklyGoal } from "@/types";

export default function PlannerPage() {
  const { user } = useAuth();
  const weekStart = weekStartKey();
  const days = currentWeekDays();
  const { items: goals } = useUserCollection<WeeklyGoal>("weeklyGoals", useMemo(() => [orderBy("createdAt", "desc")], []));
  const weekGoals = goals.filter((goal) => goal.weekStart === weekStart);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<WeeklyGoal["type"]>("goal");

  async function addGoal(day?: string) {
    if (!user || !title.trim()) return;
    await createWeeklyGoal(user.uid, { weekStart, title: title.trim(), type, day, completed: false });
    setTitle("");
  }

  return (
    <>
      <SectionHeader title="Weekly Planner" eyebrow={`Week of ${weekStart}`} />
      <section className="card mb-6 p-5">
        <div className="grid gap-3 md:grid-cols-[1fr_180px_120px]">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Weekly goal or focus theme" />
          <select className="input" value={type} onChange={(e) => setType(e.target.value as WeeklyGoal["type"])}>
            <option value="goal">Goal</option>
            <option value="must_finish">Must finish</option>
            <option value="can_move">Can move</option>
          </select>
          <button className="btn-primary" onClick={() => addGoal()}>Add</button>
        </div>
      </section>
      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        {(["goal", "must_finish", "can_move"] as const).map((bucket) => (
          <section key={bucket} className="card p-4">
            <h2 className="mb-3 text-sm font-semibold capitalize">{bucket.replace("_", " ")}</h2>
            <div className="space-y-2">
              {weekGoals.filter((goal) => goal.type === bucket && !goal.day).map((goal) => (
                <label key={goal.id} className="flex items-center gap-2 rounded-md bg-ink-50 p-2 text-sm dark:bg-ink-800">
                  <input type="checkbox" checked={goal.completed} onChange={(e) => updateWeeklyGoal(user!.uid, goal.id, { completed: e.target.checked })} />
                  <span className={goal.completed ? "text-ink-400 line-through" : ""}>{goal.title}</span>
                </label>
              ))}
              {weekGoals.filter((goal) => goal.type === bucket && !goal.day).length === 0 ? <p className="text-sm text-ink-500">Empty</p> : null}
            </div>
          </section>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-7">
        {days.map((day) => (
          <section key={day.key} className="card min-h-64 p-4">
            <div className="mb-3">
              <h3 className="font-semibold">{day.label}</h3>
              <p className={`text-xs ${day.isToday ? "text-moss-600" : "text-ink-500"}`}>{day.display}</p>
            </div>
            <div className="space-y-2">
              {weekGoals.filter((goal) => goal.day === day.key).map((goal) => (
                <label key={goal.id} className="flex items-start gap-2 rounded-md bg-ink-50 p-2 text-sm dark:bg-ink-800">
                  <input className="mt-1" type="checkbox" checked={goal.completed} onChange={(e) => updateWeeklyGoal(user!.uid, goal.id, { completed: e.target.checked })} />
                  <span>{goal.title}</span>
                </label>
              ))}
              <button className="btn-secondary w-full py-1.5 text-xs" onClick={() => addGoal(day.key)}>Assign typed goal</button>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
