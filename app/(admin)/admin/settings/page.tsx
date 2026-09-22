"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { adminFetch } from "@/lib/admin-client";
import { SectionHeader } from "@/components/section-header";
import type { AdminSettings } from "@/types";

export default function AdminSettingsPage() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [maxActiveUsersInput, setMaxActiveUsersInput] = useState("");

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const result = await adminFetch<AdminSettings>(user, "/api/admin/settings");
      setSettings(result);
      setMaxActiveUsersInput(String(result.maxActiveUsers));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load settings.");
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(patch: Partial<AdminSettings>) {
    if (!user) return;
    setSaving(true);
    setError("");
    try {
      setSettings(await adminFetch<AdminSettings>(user, "/api/admin/settings", { method: "PUT", body: patch }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return <p className="text-sm text-ink-500">Loading...</p>;

  return (
    <>
      <SectionHeader title="Settings" eyebrow="Admin panel — runtime switches" />
      {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}

      <section className="card mb-4 space-y-3 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Runtime switches</h2>
        <label className="flex items-center justify-between text-sm">
          AI globally enabled — off sends every task to its rule-based fallback
          <input type="checkbox" checked={settings.aiGloballyEnabled} disabled={saving} onChange={(e) => save({ aiGloballyEnabled: e.target.checked })} />
        </label>
        <label className="flex items-center justify-between text-sm">
          Cron enabled — off stops the daily insight job without a redeploy
          <input type="checkbox" checked={settings.cronEnabled} disabled={saving} onChange={(e) => save({ cronEnabled: e.target.checked })} />
        </label>
        <label className="flex items-center justify-between text-sm">
          Maintenance mode — members see a banner; admins still get in
          <input type="checkbox" checked={settings.maintenanceMode} disabled={saving} onChange={(e) => save({ maintenanceMode: e.target.checked })} />
        </label>
      </section>

      <section className="card mb-4 space-y-3 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Access</h2>
        <label className="block text-sm">
          Signup mode
          <select className="input mt-1" value={settings.signupMode} onChange={(e) => save({ signupMode: e.target.value as AdminSettings["signupMode"] })}>
            <option value="open">Open</option>
            <option value="invite">Invite only</option>
            <option value="closed">Closed</option>
          </select>
          <span className="mt-1 block text-xs text-ink-500">
            Only gates brand-new accounts (identified by matching creation/last-sign-in time) — never affects anyone already signed up,
            and never affects anonymous &quot;guest testing&quot; sign-ins (disable those separately below, under Sign-in methods).
          </span>
        </label>
      </section>

      <section className="card mb-4 space-y-3 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Budget estimate</h2>
        <label className="block text-sm">
          Users assumed for budget estimate
          <div className="mt-1 flex gap-2">
            <input
              className="input max-w-[120px]"
              type="number"
              value={maxActiveUsersInput}
              onChange={(e) => setMaxActiveUsersInput(e.target.value)}
            />
            <button
              className="btn-secondary py-1.5 text-xs"
              disabled={saving || Number(maxActiveUsersInput) === settings.maxActiveUsers}
              onClick={() => save({ maxActiveUsers: Number(maxActiveUsersInput) })}
            >
              Save
            </button>
          </div>
          <span className="mt-1 block text-xs text-ink-500">
            Not a cap — just how many users the Overview page&apos;s &quot;Month-to-date AI spend&quot; ceiling assumes when multiplying by the per-user
            budget. Doesn&apos;t limit signups or disable anyone.
          </span>
        </label>
      </section>

      <section className="card p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">Sign-in methods on /login</h2>
        {(["google", "emailPassword", "emailLink", "anonymous"] as const).map((method) => (
          <label key={method} className="flex items-center justify-between py-1 text-sm">
            {method}
            <input
              type="checkbox"
              checked={settings.signInMethods[method]}
              disabled={saving}
              onChange={(e) => save({ signInMethods: { ...settings.signInMethods, [method]: e.target.checked } })}
            />
          </label>
        ))}
        <p className="mt-2 text-xs text-ink-500">
          This only controls which buttons /login renders. Enabling/disabling a provider at the Firebase Auth project level is separate — see the README.
        </p>
      </section>
    </>
  );
}
