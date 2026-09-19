"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { resolvePushEnabled } from "@/lib/google-calendar";
import { saveGoogleCalendarConnectionPrefs, subscribeGoogleCalendarConnection } from "@/lib/firestore";
import type { GoogleCalendarConnection } from "@/types";

const PUSH_CATEGORY_LABELS: Record<keyof NonNullable<GoogleCalendarConnection["pushEnabled"]>, string> = {
  courseSessions: "Course class times",
  checkpoints: "Assessment due dates",
  timedCommitments: "Timed recurring commitments (TA meets, office hours...)",
  tasksWithDueDate: "Hand-created tasks with a due date"
};

/**
 * plan/11.FocusOS-v2-Google-Calendar-Sync-Plan.md §9.1 — Phase 1 (push only): connect/disconnect,
 * per-category push toggles, and a manual "Sync now." The import-calendar picker and pull-related
 * fields are reserved for Phase 2 and intentionally don't appear here yet.
 */
export function GoogleCalendarSettings() {
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [connection, setConnection] = useState<(GoogleCalendarConnection & { id: string }) | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState("");
  const [lastSyncResult, setLastSyncResult] = useState("");

  useEffect(() => {
    if (!user) return;
    return subscribeGoogleCalendarConnection(user.uid, setConnection);
  }, [user]);

  useEffect(() => {
    if (searchParams.get("googleCalendarConnected")) {
      router.replace("/settings", { scroll: false });
    } else if (searchParams.get("googleCalendarError")) {
      setActionError(searchParams.get("googleCalendarError") ?? "Failed to connect.");
      router.replace("/settings", { scroll: false });
    }
  }, [searchParams, router]);

  async function connect() {
    if (!user) return;
    setConnecting(true);
    setActionError("");
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/integrations/google-calendar/connect", { headers: { Authorization: `Bearer ${token}` } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to start connecting.");
      window.location.href = body.url;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to start connecting.");
      setConnecting(false);
    }
  }

  async function disconnectAccount() {
    if (!user) return;
    setDisconnecting(true);
    setActionError("");
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/integrations/google-calendar/disconnect", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Failed to disconnect.");
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to disconnect.");
    } finally {
      setDisconnecting(false);
    }
  }

  async function syncNow() {
    if (!user) return;
    setSyncing(true);
    setActionError("");
    setLastSyncResult("");
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/integrations/google-calendar/sync-now", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Sync failed.");
      setLastSyncResult(`Synced — ${body.created} created, ${body.updated} updated, ${body.deleted} removed.`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  function togglePushCategory(key: keyof NonNullable<GoogleCalendarConnection["pushEnabled"]>) {
    if (!user || !connection) return;
    const resolved = resolvePushEnabled(connection.pushEnabled);
    saveGoogleCalendarConnectionPrefs(user.uid, { pushEnabled: { ...resolved, [key]: !resolved[key] } });
  }

  const isConnected = connection?.connected ?? false;
  const pushEnabled = resolvePushEnabled(connection?.pushEnabled);

  return (
    <section className="card p-5">
      <h2 className="mb-4 text-lg font-semibold">Google Calendar</h2>
      {!isConnected ? (
        <div className="space-y-3">
          <p className="text-sm text-ink-600 dark:text-ink-300">
            Pushes your class times, assessment due dates, and any timed recurring commitment onto a dedicated &ldquo;FocusOS&rdquo; calendar in
            your Google account — it never touches your personal calendars.
          </p>
          <button className="btn-primary" onClick={connect} disabled={connecting}>
            {connecting ? "Connecting..." : "Connect Google Calendar"}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">
              Connected {connection?.googleAccountEmail ? `as ${connection.googleAccountEmail}` : ""}
              {connection?.lastPushAt ? (
                <span className="text-ink-500"> · last synced {new Date(connection.lastPushAt).toLocaleString()}</span>
              ) : null}
            </p>
            <button className="btn-secondary py-1 text-xs" onClick={disconnectAccount} disabled={disconnecting}>
              {disconnecting ? "Disconnecting..." : "Disconnect"}
            </button>
          </div>
          {connection?.lastError ? <p className="text-xs text-red-600 dark:text-red-400">{connection.lastError}</p> : null}
          <div className="space-y-2">
            <p className="label">Push to Google Calendar</p>
            {(Object.keys(PUSH_CATEGORY_LABELS) as Array<keyof typeof PUSH_CATEGORY_LABELS>).map((key) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={pushEnabled[key]} onChange={() => togglePushCategory(key)} />
                {PUSH_CATEGORY_LABELS[key]}
              </label>
            ))}
          </div>
          <button className="btn-secondary py-1.5 text-xs" onClick={syncNow} disabled={syncing}>
            <RefreshCw className={syncing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            {syncing ? "Syncing..." : "Sync now"}
          </button>
          {lastSyncResult ? <p className="text-xs text-ink-500">{lastSyncResult}</p> : null}
        </div>
      )}
      {actionError ? <p className="mt-2 text-xs text-red-600 dark:text-red-400">{actionError}</p> : null}
    </section>
  );
}
