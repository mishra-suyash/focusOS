"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { adminFetch } from "@/lib/admin-client";
import { SectionHeader } from "@/components/section-header";
import type { AuditEntry } from "@/types";

export default function AdminAuditPage() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) return;
    adminFetch<{ entries: AuditEntry[] }>(user, "/api/admin/audit")
      .then((result) => setEntries(result.entries))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load audit log."));
  }, [user]);

  return (
    <>
      <SectionHeader title="Audit log" eyebrow="Admin panel — read-only, 180 days" />
      {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}
      <div className="space-y-2">
        {entries.map((entry) => (
          <div key={entry.id} className="card p-3 text-sm">
            <p>
              <span className="font-medium">{entry.action}</span> by {entry.actorEmail} on {entry.targetType} <code className="text-xs">{entry.targetId}</code>
            </p>
            <p className="text-xs text-ink-500">{new Date(entry.at).toLocaleString()}</p>
          </div>
        ))}
        {entries.length === 0 ? <p className="text-sm text-ink-500">No audit entries yet.</p> : null}
      </div>
    </>
  );
}
