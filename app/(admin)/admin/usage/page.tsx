"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { adminFetch } from "@/lib/admin-client";
import { SectionHeader } from "@/components/section-header";

interface UsageReport {
  month: string;
  byUser: { uid: string; email?: string; reads: number; writes: number; aiSpendUsd: number }[];
  byTask: Record<string, number>;
  byProvider: Record<string, number>;
}

export default function AdminUsagePage() {
  const { user } = useAuth();
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) return;
    adminFetch<UsageReport>(user, "/api/admin/usage")
      .then(setReport)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load usage."));
  }, [user]);

  return (
    <>
      <SectionHeader title="Usage" eyebrow={report ? `Admin panel — ${report.month}` : "Admin panel"} />
      {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}
      {!report ? (
        <p className="text-sm text-ink-500">Loading...</p>
      ) : (
        <div className="space-y-6">
          <section className="card p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">By user</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-ink-500">
                  <tr>
                    <th className="py-1">Email</th>
                    <th className="py-1">Reads</th>
                    <th className="py-1">Writes</th>
                    <th className="py-1">AI spend</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byUser.map((row) => (
                    <tr key={row.uid} className="border-t border-ink-100 dark:border-ink-800">
                      <td className="py-1">{row.email ?? row.uid}</td>
                      <td className="py-1">{row.reads.toLocaleString()}</td>
                      <td className="py-1">{row.writes.toLocaleString()}</td>
                      <td className="py-1">${row.aiSpendUsd.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card p-5">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-500">By task</h2>
            <p className="mb-2 text-xs text-ink-500">
              Internal AI task ids (from lib/ai/tasks.ts&apos;s registry) — no fixed expected volume per id, these are for spotting an
              unexpected spike, not for reading at a glance.
            </p>
            {Object.entries(report.byTask).map(([task, count]) => (
              <p key={task} className="text-sm">
                {task}: {count}
              </p>
            ))}
          </section>

          <section className="card p-5">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-500">By provider</h2>
            <p className="mb-2 text-xs text-ink-500">Which AI provider (Claude, Gemini, Ollama, or the rule-based fallback) actually served each call.</p>
            {Object.entries(report.byProvider).map(([provider, count]) => (
              <p key={provider} className="text-sm">
                {provider}: {count}
              </p>
            ))}
          </section>
        </div>
      )}
    </>
  );
}
