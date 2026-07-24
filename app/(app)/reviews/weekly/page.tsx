"use client";

import { orderBy } from "firebase/firestore";
import { useMemo, useState } from "react";
import { SectionHeader } from "@/components/section-header";
import { useAuth } from "@/components/auth-provider";
import { useUserCollection } from "@/hooks/use-user-collection";
import { averageFocusRating, todayMetrics } from "@/lib/analytics";
import { saveWeeklyReview } from "@/lib/firestore";
import { weekStartKey } from "@/lib/dates";
import type { DailyReview, PomodoroSession, Task, WeeklyReview } from "@/types";

export default function WeeklyReviewPage() {
  const { user } = useAuth();
  const weekStart = weekStartKey();
  const { items: reviews } = useUserCollection<WeeklyReview>("weeklyReviews", useMemo(() => [orderBy("updatedAt", "desc")], []));
  const { items: dailyReviews } = useUserCollection<DailyReview>("dailyReviews", useMemo(() => [orderBy("updatedAt", "desc")], []));
  const { items: sessions } = useUserCollection<PomodoroSession>("pomodoroSessions", useMemo(() => [orderBy("completedAt", "desc")], []));
  const { items: tasks } = useUserCollection<Task>("tasks", useMemo(() => [orderBy("createdAt", "desc")], []));
  const existing = reviews.find((review) => review.weekStart === weekStart);
  const [wins, setWins] = useState(existing?.wins ?? "");
  const [missedGoals, setMissedGoals] = useState(existing?.missedGoals ?? "");
  const [blockers, setBlockers] = useState(existing?.blockers ?? "");
  const [nextWeekPriorities, setNextWeekPriorities] = useState(existing?.nextWeekPriorities ?? "");
  const metrics = todayMetrics(tasks, sessions);
  const avg = averageFocusRating(dailyReviews);

  async function save() {
    if (!user) return;
    await saveWeeklyReview(user.uid, { weekStart, wins, missedGoals, blockers, nextWeekPriorities, averageFocusRating: avg });
  }

  return (
    <>
      <SectionHeader title="Weekly Review" eyebrow={`Week of ${weekStart}`} />
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <div className="card p-4"><p className="label">Focus average</p><p className="mt-2 text-3xl font-semibold">{avg || "-"}</p></div>
        <div className="card p-4"><p className="label">Today focus minutes</p><p className="mt-2 text-3xl font-semibold">{metrics.focusedMinutes}</p></div>
        <div className="card p-4"><p className="label">Current streak</p><p className="mt-2 text-3xl font-semibold">{metrics.streak}</p></div>
      </div>
      <section className="card max-w-4xl p-5">
        <Textarea label="Wins" value={wins} onChange={setWins} />
        <Textarea label="Missed goals" value={missedGoals} onChange={setMissedGoals} />
        <Textarea label="Blockers" value={blockers} onChange={setBlockers} />
        <Textarea label="Next week priorities" value={nextWeekPriorities} onChange={setNextWeekPriorities} />
        <button className="btn-primary" onClick={save}>Save weekly review</button>
      </section>
    </>
  );
}

function Textarea({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="mb-4 block">
      <span className="label mb-2 block">{label}</span>
      <textarea className="input min-h-28" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
