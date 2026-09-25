"use client";

import { Sparkles } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { slotTypeLabels, sortedSlots } from "@/lib/schedule";
import type { DailySchedule, MorningBrief } from "@/types";

/**
 * plan/14 §7.4 — `buildMorningBrief` (lib/dailyloop.ts) stays exactly as it is, a deterministic
 * count list; this card re-renders it as the day's *sequence* instead — today's blocks in order,
 * with the brief's counts folded in as annotations on the block they belong to (a course-tagged
 * block gets that course's checkpoints-in-prep-window; a reading block gets the paper queue),
 * rather than four separate bullet lines nobody can act on directly. No new data, no new writer.
 * Anything the brief counts that can't be matched to a specific block (a goal milestone, a hard
 * deadline with no block of its own) still shows, in a trailing line rather than silently dropped.
 */
export function MorningBriefCard({ brief, schedule }: { brief?: MorningBrief; schedule?: DailySchedule }) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [generated, setGenerated] = useState<MorningBrief | undefined>(brief);

  async function generate() {
    if (!user) return;
    setLoading(true);
    setError("");
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/daily-loop/brief", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Failed to generate the morning overview.");
      setGenerated(body.brief);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate the morning overview.");
    } finally {
      setLoading(false);
    }
  }

  const current = generated ?? brief;
  const slots = sortedSlots(schedule?.slots ?? []);

  const usedCheckpointIds = new Set<string>();
  const usedPaperIds = new Set<string>();

  return (
    <section className="card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Morning overview</h2>
        <button className="btn-secondary py-1 text-xs" onClick={generate} disabled={loading}>
          <Sparkles className="h-3.5 w-3.5" />
          {loading ? "Generating..." : current ? "Regenerate" : "Generate"}
        </button>
      </div>
      {error ? <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      {!current ? (
        <p className="text-sm text-ink-500">
          No overview yet for today — the ~06:00 IST cron will generate one automatically, or click Generate for it now.
        </p>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="text-ink-600 dark:text-ink-300">
            {current.requiredMinutesTarget} min target today
            {current.unresolvedCriticalAlerts > 0 ? ` · ${current.unresolvedCriticalAlerts} urgent heads-up${current.unresolvedCriticalAlerts === 1 ? "" : "s"}` : ""}
          </p>
          {slots.length === 0 ? (
            <p className="text-xs text-ink-500">No blocks planned yet — Start day, or open Plan to add some.</p>
          ) : (
            <ol className="space-y-1.5">
              {slots.map((slot) => {
                // `checkpointsInWindow`/`papersScheduled` have no slot/course link of their own, so
                // the whole list attaches to the first class-or-deep_work / reading block of the
                // day respectively — a real match (this block is course/reading context) rather
                // than a precise per-item one, which the schema doesn't support yet.
                const checkpointsHere = slot.type === "class" || slot.type === "deep_work" ? current.checkpointsInWindow.filter((cp) => !usedCheckpointIds.has(cp.id)) : [];
                const papersHere = slot.type === "reading" ? current.papersScheduled.filter((p) => !usedPaperIds.has(p.id)) : [];
                checkpointsHere.forEach((cp) => usedCheckpointIds.add(cp.id));
                papersHere.forEach((p) => usedPaperIds.add(p.id));
                return (
                  <li key={slot.id} className="rounded-md border border-ink-200 p-2 text-xs dark:border-ink-800">
                    <span className="font-mono text-ink-500">{slot.startTime}</span> <span className="font-medium">{slot.title}</span>{" "}
                    <span className="text-ink-500">({slotTypeLabels[slot.type]})</span>
                    {checkpointsHere.length > 0 ? (
                      <p className="mt-1 text-ink-600 dark:text-ink-300">Prep window: {checkpointsHere.map((c) => c.title).join(", ")}</p>
                    ) : null}
                    {papersHere.length > 0 ? <p className="mt-1 text-ink-600 dark:text-ink-300">Reading queue: {papersHere.map((p) => p.title).join(", ")}</p> : null}
                  </li>
                );
              })}
            </ol>
          )}
          {(() => {
            const unmatchedCheckpoints = current.checkpointsInWindow.filter((cp) => !usedCheckpointIds.has(cp.id));
            const unmatchedPapers = current.papersScheduled.filter((p) => !usedPaperIds.has(p.id));
            const extras: string[] = [];
            if (unmatchedCheckpoints.length > 0) extras.push(`Prep window: ${unmatchedCheckpoints.map((c) => c.title).join(", ")}`);
            if (unmatchedPapers.length > 0) extras.push(`Reading queue: ${unmatchedPapers.map((p) => p.title).join(", ")}`);
            if (current.goalMilestonesThisWeek.length > 0) extras.push(`Goal milestones: ${current.goalMilestonesThisWeek.map((m) => m.title).join(", ")}`);
            if (current.externalTasksInWindow.length > 0) extras.push(`Hard deadlines: ${current.externalTasksInWindow.map((t) => `${t.title} (${t.dueDate})`).join(", ")}`);
            return extras.length > 0 ? (
              <div className="rounded-md bg-ink-50 p-2 text-xs text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                <p className="label mb-1">Also today</p>
                {extras.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            ) : null;
          })()}
          <p className="text-xs text-ink-400">
            Snapshot from {new Date(current.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} — the Workload widget above recalculates the target live as your day changes.
          </p>
        </div>
      )}
    </section>
  );
}
