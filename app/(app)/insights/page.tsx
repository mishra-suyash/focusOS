"use client";

import { orderBy } from "firebase/firestore";
import { Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ModuleGate } from "@/components/module-gate";
import { SectionHeader } from "@/components/section-header";
import { useAuth } from "@/components/auth-provider";
import { useUserCollection } from "@/hooks/use-user-collection";
import { todayKey } from "@/lib/dates";
import type { AiInsight } from "@/types";

interface AiHealth {
  providers: {
    claude: { configured: boolean; open: boolean };
    gemini: { configured: boolean; open: boolean };
    ollama: { enabled: boolean; available: boolean };
  };
  budget: { spentUsd: number; capUsd: number; pct: number };
}

function InsightsPageContent() {
  const { user } = useAuth();
  const { items: insights } = useUserCollection<AiInsight>("aiInsights", useMemo(() => [orderBy("generatedAt", "desc")], []));
  const today = todayKey();
  const todayInsight = insights.find((item) => item.date === today);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [health, setHealth] = useState<AiHealth | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    user
      .getIdToken()
      .then((token) => fetch("/api/ai/health", { headers: { Authorization: `Bearer ${token}` } }))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setHealth(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user]);

  async function regenerate() {
    if (!user) return;
    setLoading(true);
    setError("");
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/insights", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Failed to generate insight.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate insight.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <SectionHeader title="AI Insights" eyebrow="Claude / Gemini powered planning">
        <button className="btn-primary py-1.5 text-xs" onClick={regenerate} disabled={loading}>
          <Sparkles className="h-3.5 w-3.5" />
          {loading ? "Analyzing..." : "Regenerate today's insight"}
        </button>
      </SectionHeader>
      {error ? (
        <p className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      ) : null}
      {health ? (
        <section className="mb-4 card flex flex-wrap items-center gap-4 p-3 text-xs text-ink-500 dark:text-ink-400">
          <span>
            Claude: {health.providers.claude.configured ? (health.providers.claude.open ? "paused after repeated failures, retrying automatically" : "ready") : "not configured"}
          </span>
          <span>
            Gemini: {health.providers.gemini.configured ? (health.providers.gemini.open ? "paused after repeated failures, retrying automatically" : "ready") : "not configured"}
          </span>
          <span>Ollama: {health.providers.ollama.enabled ? (health.providers.ollama.available ? "reachable" : "unreachable") : "disabled"}</span>
          <span>
            Budget: ${health.budget.spentUsd.toFixed(2)} / ${health.budget.capUsd.toFixed(2)} ({Math.round(health.budget.pct * 100)}%)
          </span>
        </section>
      ) : null}
      {todayInsight ? (
        <section className="card p-5">
          <p className="label mb-2">
            {todayInsight.degraded ? "Rule-based" : todayInsight.provider} ·{" "}
            {todayInsight.source === "cron" ? "generated automatically this morning" : "generated on demand"}
          </p>
          <p className="text-base">{todayInsight.summary}</p>
          <ul className="mt-4 space-y-2">
            {todayInsight.suggestions.map((suggestion, index) => (
              <li key={index} className="rounded-md bg-ink-50 px-3 py-2 text-sm dark:bg-ink-800">
                {suggestion}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <div className="card p-8 text-center text-sm text-ink-500 dark:text-ink-400">
          No insight yet for today. Click &ldquo;Regenerate&rdquo; or wait for the scheduled morning run — works either way, even without an AI
          provider key configured (you&apos;ll get a rule-based summary instead of an AI-written one).
        </div>
      )}
      <section className="mt-6">
        <h2 className="mb-3 text-lg font-semibold">History</h2>
        <div className="space-y-3">
          {insights
            .filter((item) => item.date !== today)
            .slice(0, 10)
            .map((insight) => (
              <article key={insight.id} className="card p-4">
                <p className="label mb-1">{insight.date}</p>
                <p className="text-sm">{insight.summary}</p>
              </article>
            ))}
          {insights.length <= 1 ? <p className="text-sm text-ink-500">No history yet.</p> : null}
        </div>
      </section>
    </>
  );
}

export default function InsightsPage() {
  return (
    <ModuleGate moduleId="insights">
      <InsightsPageContent />
    </ModuleGate>
  );
}
