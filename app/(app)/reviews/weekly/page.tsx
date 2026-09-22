"use client";

import { orderBy, where } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { InfoHint } from "@/components/info-hint";
import { ModuleGate } from "@/components/module-gate";
import { SectionHeader } from "@/components/section-header";
import { useAuth } from "@/components/auth-provider";
import { useUserCollection } from "@/hooks/use-user-collection";
import { averageFocusRating, todayMetrics } from "@/lib/analytics";
import { saveWeeklyReview, updateGoal } from "@/lib/firestore";
import { weekDates, weekStartKey } from "@/lib/dates";
import { isGoalActiveForDate } from "@/lib/goals";
import { computeDebtHours, computeLoadIndexStreak, loadIndexBandLabels, loadIndexBandStyles } from "@/lib/loadindex";
import { pass1DropRate } from "@/lib/papers";
import { todayKey } from "@/lib/dates";
import type { Day, Goal, Paper, PomodoroSession, Task, Term, WeeklyReview } from "@/types";

function WeeklyReviewPageContent() {
  const { user } = useAuth();
  const weekStart = weekStartKey();
  const dates = useMemo(() => weekDates(weekStart), [weekStart]);
  const weekEnd = dates[dates.length - 1];
  const { items: reviews } = useUserCollection<WeeklyReview>("weeklyReviews", useMemo(() => [orderBy("updatedAt", "desc")], []));
  const { items: days } = useUserCollection<Day>(
    "days",
    useMemo(() => [where("date", ">=", weekStart), where("date", "<=", weekEnd), orderBy("date")], [weekStart, weekEnd])
  );
  const { items: recentDays } = useUserCollection<Day>("days", useMemo(() => [orderBy("date", "desc")], []));
  const { items: sessions } = useUserCollection<PomodoroSession>("pomodoroSessions", useMemo(() => [orderBy("completedAt", "desc")], []));
  const { items: tasks } = useUserCollection<Task>("tasks", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: papers } = useUserCollection<Paper>("papers", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: goals } = useUserCollection<Goal>("goals", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: terms } = useUserCollection<Term>("terms", useMemo(() => [orderBy("startDate", "desc")], []));
  const existing = reviews.find((review) => review.weekStart === weekStart);
  const today = todayKey();
  const activeGoals = goals.filter((goal) => isGoalActiveForDate(goal, terms, today));
  const daysWithLI = [...recentDays].filter((d) => d.loadIndex).sort((a, b) => (a.date < b.date ? -1 : 1));
  const weekLI = days.filter((d) => d.loadIndex);
  const debtHours = computeDebtHours(daysWithLI.map((d) => d.loadIndex!));
  const streak = computeLoadIndexStreak(daysWithLI.map((d) => d.loadIndex!));
  const [wins, setWins] = useState(existing?.wins ?? "");
  const [missedGoals, setMissedGoals] = useState(existing?.missedGoals ?? "");
  const [blockers, setBlockers] = useState(existing?.blockers ?? "");
  const [nextWeekPriorities, setNextWeekPriorities] = useState(existing?.nextWeekPriorities ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const metrics = todayMetrics(tasks, sessions);
  const avg = averageFocusRating(days);

  useEffect(() => {
    setWins(existing?.wins ?? "");
    setMissedGoals(existing?.missedGoals ?? "");
    setBlockers(existing?.blockers ?? "");
    setNextWeekPriorities(existing?.nextWeekPriorities ?? "");
    setMessage("");
  }, [existing]);

  async function save() {
    if (!user) return;
    setSaving(true);
    try {
      await saveWeeklyReview(user.uid, { weekStart, wins, missedGoals, blockers, nextWeekPriorities, averageFocusRating: avg });
      setMessage("Weekly check-in saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <SectionHeader title="Weekly check-in" eyebrow={`Week of ${weekStart}`} />
      <div className="mb-6 grid gap-3 sm:grid-cols-5">
        <div className="card p-4"><p className="label">Focus average (this week)</p><p className="mt-2 text-3xl font-semibold">{avg || "-"}</p></div>
        <div className="card p-4"><p className="label">Today focus minutes</p><p className="mt-2 text-3xl font-semibold">{metrics.focusedMinutes}</p></div>
        <div className="card p-4"><p className="label flex items-center gap-1">On-track streak<InfoHint term="onTrackStreak" /></p><p className="mt-2 text-3xl font-semibold">{streak}d</p></div>
        <div className="card p-4"><p className="label flex items-center gap-1">Catch-up hours (14-day)<InfoHint term="catchUpHours" /></p><p className="mt-2 text-3xl font-semibold">{debtHours}h</p></div>
        <div className="card p-4"><p className="label flex items-center gap-1">Skim drop/park rate (all-time)<InfoHint term="skimDropParkRate" /></p><p className="mt-2 text-3xl font-semibold">{pass1DropRate(papers)}%</p></div>
      </div>

      <section className="card mb-6 max-w-4xl p-5">
        <h2 className="mb-3 text-base font-semibold">Workload this week</h2>
        {weekLI.length === 0 ? (
          <p className="text-sm text-ink-500">No Workload snapshots yet this week — they&apos;re written when you click &quot;End day&quot;.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {weekLI.map((d) => (
              <div key={d.date} className={`rounded-md px-3 py-2 text-xs ${loadIndexBandStyles[d.loadIndex!.band]}`}>
                <p className="font-medium">{d.date.slice(5)}</p>
                <p>{d.loadIndex!.value.toFixed(2)} — {loadIndexBandLabels[d.loadIndex!.band]}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card mb-6 max-w-4xl p-5">
        <h2 className="mb-3 text-base font-semibold">Goals</h2>
        {activeGoals.length === 0 ? (
          <p className="text-sm text-ink-500">No active goals — add one on the Goals page to see milestone progress and hours here.</p>
        ) : (
          <div className="space-y-3">
            {activeGoals.map((goal) => {
              const done = goal.milestones.filter((m) => m.done).length;
              return (
                <div key={goal.id} className="flex items-center justify-between gap-3 rounded-md border border-ink-200 p-3 text-sm dark:border-ink-800">
                  <div>
                    <p className="font-medium">{goal.title}</p>
                    <p className="text-xs text-ink-500">
                      {done}/{goal.milestones.length} milestones done
                      {goal.targetHoursPerWeek ? ` · ${goal.targetHoursPerWeek}h/week target` : ""}
                      {goal.lastReviewedAt ? ` · last reviewed ${goal.lastReviewedAt.slice(0, 10)}` : ""}
                    </p>
                  </div>
                  {goal.reviewCadence === "weekly" ? (
                    <button
                      className="btn-secondary px-2 py-1 text-xs"
                      onClick={() => user && updateGoal(user.uid, goal.id, { lastReviewedAt: new Date().toISOString() })}
                    >
                      Mark reviewed
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="card max-w-4xl p-5">
        <Textarea label="Wins" value={wins} onChange={setWins} />
        <Textarea label="Missed goals" value={missedGoals} onChange={setMissedGoals} />
        <Textarea label="Blockers" value={blockers} onChange={setBlockers} />
        <Textarea label="Next week priorities" value={nextWeekPriorities} onChange={setNextWeekPriorities} />
        <div className="flex items-center gap-3">
          <button className="btn-primary" onClick={save} disabled={saving}>{saving ? "Saving..." : "Save weekly check-in"}</button>
          {message ? <p className="text-sm text-moss-700 dark:text-moss-400">{message}</p> : null}
        </div>
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

export default function WeeklyReviewPage() {
  return (
    <ModuleGate moduleId="weeklyCheckin">
      <WeeklyReviewPageContent />
    </ModuleGate>
  );
}
