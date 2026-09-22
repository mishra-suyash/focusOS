"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { adminFetch } from "@/lib/admin-client";
import { SectionHeader } from "@/components/section-header";

interface Overview {
  providers: {
    claude: { configured: boolean; open: boolean };
    gemini: { configured: boolean; open: boolean };
    ollama: { enabled: boolean; available: boolean; health: { lastOkAt?: string; lastFailAt?: string; consecutiveFailures: number } };
  };
  budget: { spentUsd: number; capUsd: number; pct: number };
  freeTierMeters: Record<string, { value: number; ceiling: number; level: "ok" | "amber" | "red" }>;
  crons: Record<string, { enabled: boolean; lastRun: { at: string; ok: boolean } | null }>;
  recentFailures: { id: string; task?: string; provider?: string; error?: string; at?: string }[];
  maintenanceMode: boolean;
  aiGloballyEnabled: boolean;
}

function levelColor(level: "ok" | "amber" | "red") {
  return level === "red" ? "text-red-600 dark:text-red-400" : level === "amber" ? "text-amberline" : "text-moss-600 dark:text-moss-400";
}

function formatBytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

export default function AdminOverviewPage() {
  const { user } = useAuth();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) return;
    adminFetch<Overview>(user, "/api/admin/overview")
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load overview."));
  }, [user]);

  return (
    <>
      <SectionHeader title="Overview" eyebrow="Admin panel" />
      {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}
      {!data ? (
        <p className="text-sm text-ink-500">Loading...</p>
      ) : (
        <div className="space-y-6">
          {!data.aiGloballyEnabled ? (
            <div className="rounded-md border border-amberline/30 bg-amberline/10 p-3 text-sm">
              AI is globally disabled — every task is running its rule-based fallback. Flip it back on in Settings.
            </div>
          ) : null}
          <section className="card p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Providers</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <p className="text-sm font-medium">Claude</p>
                <p className="text-xs text-ink-500">{data.providers.claude.configured ? (data.providers.claude.open ? "circuit open" : "ready") : "not configured (env)"}</p>
              </div>
              <div>
                <p className="text-sm font-medium">Gemini</p>
                <p className="text-xs text-ink-500">{data.providers.gemini.configured ? (data.providers.gemini.open ? "circuit open" : "ready") : "not configured (env)"}</p>
              </div>
              <div>
                <p className="text-sm font-medium">Ollama</p>
                <p className="text-xs text-ink-500">
                  {data.providers.ollama.enabled ? (data.providers.ollama.available ? "reachable" : "unreachable") : "disabled"}
                  {data.providers.ollama.health.consecutiveFailures > 0 ? ` · ${data.providers.ollama.health.consecutiveFailures} consecutive failures` : ""}
                </p>
              </div>
            </div>
          </section>

          <section className="card p-5">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-500">Month-to-date AI spend</h2>
            <p className="text-2xl font-semibold">
              ${data.budget.spentUsd.toFixed(2)} <span className="text-sm font-normal text-ink-500">/ ${data.budget.capUsd.toFixed(2)} estimated cap</span>
            </p>
            <p className="mt-1 text-xs text-ink-500">
              Not enforced — actual per-user budgets are what limit spend. This is just spend against Settings → Budget estimate&apos;s assumption.
            </p>
          </section>

          <section className="card p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Free-tier meters (month-to-date)</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <p className={`text-lg font-semibold ${levelColor(data.freeTierMeters.firestoreReads.level)}`}>{data.freeTierMeters.firestoreReads.value.toLocaleString()}</p>
                <p className="text-xs text-ink-500">reads / {data.freeTierMeters.firestoreReads.ceiling.toLocaleString()} daily ceiling</p>
              </div>
              <div>
                <p className={`text-lg font-semibold ${levelColor(data.freeTierMeters.firestoreWrites.level)}`}>{data.freeTierMeters.firestoreWrites.value.toLocaleString()}</p>
                <p className="text-xs text-ink-500">writes / {data.freeTierMeters.firestoreWrites.ceiling.toLocaleString()} daily ceiling</p>
              </div>
              <div>
                <p className={`text-lg font-semibold ${levelColor(data.freeTierMeters.blobBytes.level)}`}>{formatBytes(data.freeTierMeters.blobBytes.value)}</p>
                <p className="text-xs text-ink-500">Blob / {formatBytes(data.freeTierMeters.blobBytes.ceiling)} total</p>
              </div>
            </div>
          </section>

          <section className="card p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Crons</h2>
            {Object.entries(data.crons).map(([name, cron]) => (
              <p key={name} className="text-sm">
                <span className="font-medium">{name}</span> — {cron.enabled ? "enabled" : "disabled"}
                {cron.lastRun ? `, last ran ${new Date(cron.lastRun.at).toLocaleString()} (${cron.lastRun.ok ? "ok" : "had errors"})` : ", never ran"}
              </p>
            ))}
          </section>

          <section className="card p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Recent failed AI runs</h2>
            {data.recentFailures.length === 0 ? (
              <p className="text-sm text-ink-500">None.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {data.recentFailures.map((run) => (
                  <li key={run.id} className="rounded-md bg-ink-50 px-3 py-2 dark:bg-ink-800">
                    <span className="font-medium">{run.task}</span> via {run.provider} — {run.error}
                    {run.at ? <span className="text-ink-500"> ({new Date(run.at).toLocaleString()})</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </>
  );
}
