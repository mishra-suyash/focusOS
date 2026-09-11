"use client";

import { Sparkles } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/auth-provider";
import type { MorningBrief } from "@/types";

/** Deterministic, no AI call (lib/dailyloop.ts) — "Generate" here just triggers the same computation the cron runs, on demand. */
export function MorningBriefCard({ brief }: { brief?: MorningBrief }) {
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

  return (
    <section className="card p-4">
      <div className="mb-3 flex items-center justify-between">
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
            {current.requiredMinutesTarget} min target today · {current.revisionsDue} revision{current.revisionsDue === 1 ? "" : "s"} due
            {current.unresolvedCriticalAlerts > 0 ? ` · ${current.unresolvedCriticalAlerts} urgent heads-up${current.unresolvedCriticalAlerts === 1 ? "" : "s"}` : ""}
          </p>
          {current.checkpointsInWindow.length > 0 ? (
            <p>
              <span className="label">Assessments in prep window: </span>
              {current.checkpointsInWindow.map((c) => c.title).join(", ")}
            </p>
          ) : null}
          {current.goalMilestonesThisWeek.length > 0 ? (
            <p>
              <span className="label">Goal milestones this week: </span>
              {current.goalMilestonesThisWeek.map((m) => m.title).join(", ")}
            </p>
          ) : null}
          {current.externalTasksInWindow.length > 0 ? (
            <p>
              <span className="label">Hard deadlines: </span>
              {current.externalTasksInWindow.map((t) => `${t.title} (${t.dueDate})`).join(", ")}
            </p>
          ) : null}
          {current.papersScheduled.length > 0 ? (
            <p>
              <span className="label">Reading queue: </span>
              {current.papersScheduled.map((p) => p.title).join(", ")}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
