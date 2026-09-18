"use client";

import { Check, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { appendProposedSlotToSchedule, createTask, saveDayFields } from "@/lib/firestore";
import { todayKey } from "@/lib/dates";
import type { Category, EveningRollup, ProposalDecision, ProposedSlot, ProposedTask } from "@/types";

const CATEGORIES: Category[] = ["research", "coding", "reading", "writing", "admin", "personal"];

/**
 * Accept/Edit/Dismiss for tomorrow's proposed plan (plan §10.1). Nothing here
 * is ever auto-applied — every proposal needs an explicit click, and each
 * click's outcome is persisted (`taskDecisions`/`slotDecisions`) so
 * re-opening this page doesn't re-offer something already handled.
 */
export function EveningRollupCard({ date, rollup }: { date: string; rollup?: EveningRollup }) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [generated, setGenerated] = useState<EveningRollup | undefined>(rollup);

  const current = generated ?? rollup;
  const tomorrow = todayKey(new Date(new Date(date).getTime() + 86_400_000));

  async function generate() {
    if (!user) return;
    setLoading(true);
    setError("");
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/daily-loop/rollup", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Failed to generate suggestions for tomorrow.");
      setGenerated(body.rollup);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate suggestions for tomorrow.");
    } finally {
      setLoading(false);
    }
  }

  async function decideTask(index: number, decision: ProposalDecision, task: ProposedTask) {
    if (!user) return;
    if (decision === "accepted") {
      await createTask(user.uid, {
        title: task.title,
        status: "todo",
        priority: task.severity === "critical" ? "high" : task.severity === "important" ? "medium" : "low",
        category: task.category,
        dueDate: tomorrow,
        estimatedPomodoros: task.estimatePomodoros
      });
    }
    await saveDayFields(user.uid, date, { [`rollup.taskDecisions.${index}`]: decision });
    setGenerated((prev) => (prev ? { ...prev, taskDecisions: { ...prev.taskDecisions, [index]: decision } } : prev));
  }

  async function decideSlot(index: number, decision: ProposalDecision, slot: ProposedSlot) {
    if (!user) return;
    if (decision === "accepted") {
      await appendProposedSlotToSchedule(user.uid, tomorrow, slot, []);
    }
    await saveDayFields(user.uid, date, { [`rollup.slotDecisions.${index}`]: decision });
    setGenerated((prev) => (prev ? { ...prev, slotDecisions: { ...prev.slotDecisions, [index]: decision } } : prev));
  }

  return (
    <section className="card mt-6 max-w-3xl p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Suggestions for tomorrow</h2>
        <button className="btn-secondary py-1 text-xs" onClick={generate} disabled={loading}>
          <Sparkles className="h-3.5 w-3.5" />
          {loading ? "Generating..." : current ? "Regenerate" : "Generate"}
        </button>
      </div>
      {error ? <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      {!current ? (
        <p className="text-sm text-ink-500">
          No rollup yet for today — the ~22:00 IST cron generates one automatically, or click Generate now to see tomorrow&apos;s proposed plan.
        </p>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="text-sm">{current.summary}</p>
            {current.degraded ? <p className="mt-1 text-xs text-ink-500">Rule-based fallback — no AI provider was available.</p> : null}
          </div>
          {current.improvements.length > 0 ? (
            <ul className="space-y-1 text-sm text-ink-600 dark:text-ink-300">
              {current.improvements.map((item, i) => (
                <li key={i}>
                  <span className={item.severity === "critical" ? "font-medium text-red-600 dark:text-red-400" : ""}>{item.text}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {current.proposedTasks.length > 0 ? (
            <div>
              <p className="label mb-2">Suggested tasks for tomorrow ({tomorrow})</p>
              <div className="space-y-2">
                {current.proposedTasks.map((task, index) => (
                  <ProposedTaskRow
                    key={index}
                    task={task}
                    decision={current.taskDecisions?.[String(index)]}
                    onDecide={(decision, edited) => decideTask(index, decision, edited)}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {current.proposedSlots.length > 0 ? (
            <div>
              <p className="label mb-2">Suggested blocks for tomorrow</p>
              <div className="space-y-2">
                {current.proposedSlots.map((slot, index) => (
                  <ProposedSlotRow
                    key={index}
                    slot={slot}
                    decision={current.slotDecisions?.[String(index)]}
                    onDecide={(decision, edited) => decideSlot(index, decision, edited)}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ProposedTaskRow({
  task,
  decision,
  onDecide
}: {
  task: ProposedTask;
  decision?: ProposalDecision;
  onDecide: (decision: ProposalDecision, task: ProposedTask) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [category, setCategory] = useState(task.category);
  const [pomodoros, setPomodoros] = useState(task.estimatePomodoros);

  if (decision) {
    return (
      <p className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-500 dark:bg-ink-800">
        {task.title} — {decision}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-ink-200 p-2 text-sm dark:border-ink-800">
      <input className="input flex-1 py-1 text-xs" value={title} onChange={(e) => setTitle(e.target.value)} />
      <select className="input py-1 text-xs" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <input className="input w-16 py-1 text-xs" type="number" min={1} value={pomodoros} onChange={(e) => setPomodoros(Number(e.target.value))} />
      <button className="btn-primary px-2 py-1 text-xs" onClick={() => onDecide("accepted", { ...task, title, category, estimatePomodoros: pomodoros })}>
        <Check className="h-3 w-3" />
      </button>
      <button className="btn-secondary px-2 py-1 text-xs" onClick={() => onDecide("dismissed", task)}>
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function ProposedSlotRow({
  slot,
  decision,
  onDecide
}: {
  slot: ProposedSlot;
  decision?: ProposalDecision;
  onDecide: (decision: ProposalDecision, slot: ProposedSlot) => void;
}) {
  const [startTime, setStartTime] = useState(slot.startTime);
  const [endTime, setEndTime] = useState(slot.endTime);

  if (decision) {
    return (
      <p className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-500 dark:bg-ink-800">
        {slot.title} — {decision}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-ink-200 p-2 text-sm dark:border-ink-800">
      <span className="flex-1">{slot.title}</span>
      <input className="input w-24 py-1 text-xs" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
      <input className="input w-24 py-1 text-xs" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
      <button className="btn-primary px-2 py-1 text-xs" onClick={() => onDecide("accepted", { ...slot, startTime, endTime })}>
        <Check className="h-3 w-3" />
      </button>
      <button className="btn-secondary px-2 py-1 text-xs" onClick={() => onDecide("dismissed", slot)}>
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
