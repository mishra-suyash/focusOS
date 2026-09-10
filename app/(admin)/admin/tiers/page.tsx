"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { adminFetch } from "@/lib/admin-client";
import { SectionHeader } from "@/components/section-header";
import type { AiProvider, Tier, TierLimits } from "@/types";

type TierRow = Tier & { userCount: number };

const EMPTY_LIMITS: TierLimits = { maxRevisionsPerDay: 20, maxRevisionMinutesPerDay: 45, aiMonthlyBudgetUsd: 5, blobQuotaMb: 75 };
const ALL_PROVIDERS: AiProvider[] = ["claude", "gemini", "ollama"];

export default function AdminTiersPage() {
  const { user } = useAuth();
  const [tiers, setTiers] = useState<TierRow[]>([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Partial<Tier> | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const result = await adminFetch<{ tiers: TierRow[] }>(user, "/api/admin/tiers");
      setTiers(result.tiers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tiers.");
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!user || !editing?.name) return;
    try {
      if (editing.id) {
        await adminFetch(user, `/api/admin/tiers/${editing.id}`, {
          method: "PATCH",
          body: { name: editing.name, description: editing.description, limits: editing.limits, allowedModels: editing.allowedModels }
        });
      } else {
        await adminFetch(user, "/api/admin/tiers", {
          method: "POST",
          body: {
            name: editing.name,
            description: editing.description,
            isDefault: tiers.length === 0,
            limits: editing.limits ?? EMPTY_LIMITS,
            allowedModels: editing.allowedModels ?? []
          }
        });
      }
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    }
  }

  async function setDefault(tierId: string) {
    if (!user) return;
    try {
      await adminFetch(user, `/api/admin/tiers/${tierId}/set-default`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set default.");
    }
  }

  async function remove(tierId: string, isDefault: boolean) {
    if (!user || isDefault) return;
    if (!confirm("Delete this tier? Any users on it move to the default tier.")) return;
    try {
      await adminFetch(user, `/api/admin/tiers/${tierId}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  function toggleModel(provider: AiProvider) {
    setEditing((prev) => {
      if (!prev) return prev;
      const current = prev.allowedModels ?? [];
      const next = current.includes(provider) ? current.filter((p) => p !== provider) : [...current, provider];
      return { ...prev, allowedModels: next };
    });
  }

  return (
    <>
      <SectionHeader title="Tiers" eyebrow="Admin panel">
        <button className="btn-primary py-1.5 text-xs" onClick={() => setEditing({ limits: EMPTY_LIMITS, allowedModels: [] })}>
          New tier
        </button>
      </SectionHeader>
      {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}

      <div className="space-y-3">
        {tiers.map((tier) => (
          <div key={tier.id} className="card flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="font-medium">
                {tier.name} {tier.isDefault ? <span className="ml-1 rounded bg-moss-600/10 px-1.5 py-0.5 text-xs text-moss-700 dark:text-moss-400">default</span> : null}
              </p>
              <p className="text-xs text-ink-500">
                {tier.userCount} user(s) · ${tier.limits.aiMonthlyBudgetUsd}/mo AI · {tier.limits.blobQuotaMb} MB · {tier.limits.maxRevisionsPerDay}/day revisions ·
                models: {tier.allowedModels.join(", ") || "none"}
              </p>
            </div>
            <div className="flex gap-2">
              {!tier.isDefault ? (
                <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setDefault(tier.id)}>
                  Set default
                </button>
              ) : null}
              <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setEditing(tier)}>
                Edit
              </button>
              <button className="btn-secondary px-2 py-1 text-xs text-red-600" disabled={tier.isDefault} onClick={() => remove(tier.id, tier.isDefault)}>
                Delete
              </button>
            </div>
          </div>
        ))}
        {tiers.length === 0 ? <p className="text-sm text-ink-500">No tiers yet — every user uses hardcoded fallback limits.</p> : null}
      </div>

      {editing ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
          <div className="w-full max-w-md space-y-3 rounded-lg bg-white p-5 dark:bg-ink-900">
            <h2 className="text-lg font-semibold">{editing.id ? "Edit tier" : "New tier"}</h2>
            <input className="input" placeholder="Name" value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <input
              className="input"
              placeholder="Description (optional)"
              value={editing.description ?? ""}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            />
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-ink-500">
                Revisions/day
                <input
                  className="input"
                  type="number"
                  value={editing.limits?.maxRevisionsPerDay ?? 0}
                  onChange={(e) => setEditing({ ...editing, limits: { ...(editing.limits ?? EMPTY_LIMITS), maxRevisionsPerDay: Number(e.target.value) } })}
                />
              </label>
              <label className="text-xs text-ink-500">
                Revision minutes/day
                <input
                  className="input"
                  type="number"
                  value={editing.limits?.maxRevisionMinutesPerDay ?? 0}
                  onChange={(e) => setEditing({ ...editing, limits: { ...(editing.limits ?? EMPTY_LIMITS), maxRevisionMinutesPerDay: Number(e.target.value) } })}
                />
              </label>
              <label className="text-xs text-ink-500">
                AI budget $/mo
                <input
                  className="input"
                  type="number"
                  value={editing.limits?.aiMonthlyBudgetUsd ?? 0}
                  onChange={(e) => setEditing({ ...editing, limits: { ...(editing.limits ?? EMPTY_LIMITS), aiMonthlyBudgetUsd: Number(e.target.value) } })}
                />
              </label>
              <label className="text-xs text-ink-500">
                Blob quota MB
                <input
                  className="input"
                  type="number"
                  value={editing.limits?.blobQuotaMb ?? 0}
                  onChange={(e) => setEditing({ ...editing, limits: { ...(editing.limits ?? EMPTY_LIMITS), blobQuotaMb: Number(e.target.value) } })}
                />
              </label>
            </div>
            <div>
              <p className="mb-1 text-xs text-ink-500">Allowed AI models</p>
              <div className="flex gap-3">
                {ALL_PROVIDERS.map((provider) => (
                  <label key={provider} className="flex items-center gap-1 text-sm">
                    <input type="checkbox" checked={(editing.allowedModels ?? []).includes(provider)} onChange={() => toggleModel(provider)} />
                    {provider}
                  </label>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button className="btn-secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="btn-primary" onClick={save} disabled={!editing.name}>
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
