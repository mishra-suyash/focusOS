"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { adminFetch } from "@/lib/admin-client";
import { SectionHeader } from "@/components/section-header";
import { DEFAULT_TIER_LIMITS } from "@/lib/tier-defaults";
import type { TierLimits, UserProfile, UserRole, UserStatus } from "@/types";

interface Tier {
  id: string;
  name: string;
  isDefault: boolean;
  limits: TierLimits;
}

export default function AdminUsersPage() {
  const { user, role: myRole } = useAuth();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<UserProfile | null>(null);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [exportFirst, setExportFirst] = useState(true);
  const [deleteResult, setDeleteResult] = useState<string>("");
  const [revokedUid, setRevokedUid] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const [usersResult, tiersResult] = await Promise.all([
        adminFetch<{ users: UserProfile[] }>(user, `/api/admin/users${search ? `?search=${encodeURIComponent(search)}` : ""}`),
        adminFetch<{ tiers: Tier[] }>(user, "/api/admin/tiers")
      ]);
      setUsers(usersResult.users);
      setTiers(tiersResult.tiers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users.");
    }
  }, [user, search]);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(uid: string, body: Record<string, unknown>) {
    if (!user) return;
    setBusyUid(uid);
    setError("");
    try {
      await adminFetch(user, `/api/admin/users/${uid}`, { method: "PATCH", body });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setBusyUid(null);
    }
  }

  async function assignTier(uid: string, tierId: string) {
    if (!user) return;
    setBusyUid(uid);
    try {
      await adminFetch(user, `/api/admin/users/${uid}/tier`, { method: "PATCH", body: { tierId: tierId || null } });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tier assignment failed.");
    } finally {
      setBusyUid(null);
    }
  }

  async function revoke(uid: string) {
    if (!user) return;
    setBusyUid(uid);
    setRevokedUid(null);
    try {
      await adminFetch(user, `/api/admin/users/${uid}/revoke`, { method: "POST" });
      // No table field changes from this action, so a reload wouldn't show anything either —
      // this transient confirmation is the only feedback that it actually happened.
      setRevokedUid(uid);
      setTimeout(() => setRevokedUid((current) => (current === uid ? null : current)), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Force sign-out failed.");
    } finally {
      setBusyUid(null);
    }
  }

  async function sendInvite() {
    if (!user || !inviteEmail) return;
    try {
      await adminFetch(user, "/api/admin/users/invite", { method: "POST", body: { email: inviteEmail } });
      setInviteEmail("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invite failed.");
    }
  }

  async function runDelete() {
    if (!user || !deleteTarget) return;
    setBusyUid(deleteTarget.uid);
    setDeleteResult("");
    try {
      const result = await adminFetch<{ job?: { exportUrl?: string; status: string } }>(
        user,
        `/api/admin/users/${deleteTarget.uid}/delete-job`,
        { method: "POST", body: { exportFirst } }
      );
      setDeleteResult(result.job?.exportUrl ? `Done. Export: ${result.job.exportUrl}` : `Status: ${result.job?.status ?? "unknown"}`);
      await load();
    } catch (err) {
      setDeleteResult(err instanceof Error ? err.message : "Deletion failed.");
    } finally {
      setBusyUid(null);
    }
  }

  return (
    <>
      <SectionHeader title="Users" eyebrow="Admin panel" />
      {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}

      <div className="mb-4 flex flex-wrap gap-2">
        <input className="input max-w-xs" placeholder="Search by email prefix" value={search} onChange={(e) => setSearch(e.target.value)} />
        <input className="input max-w-xs" placeholder="Invite email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
        <button className="btn-secondary" onClick={sendInvite} disabled={!inviteEmail}>
          Invite
        </button>
      </div>

      <p className="mb-2 text-xs text-ink-500">
        Role and Status both offer &quot;disabled&quot; — they&apos;re mirrored server-side (setting either flips the other), not two
        independent switches to keep in sync by hand.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="py-2">Email</th>
              <th className="py-2">Role</th>
              <th className="py-2">Status</th>
              <th className="py-2">Tier</th>
              <th className="py-2">AI</th>
              <th className="py-2">Budget/Quota</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((row) => (
              <tr key={row.uid} className="border-t border-ink-100 dark:border-ink-800">
                <td className="py-2">{row.email}</td>
                <td className="py-2">
                  <select
                    className="input py-1 text-xs"
                    value={row.role ?? "member"}
                    disabled={row.role === "owner" || busyUid === row.uid || (myRole !== "owner" && row.role === "admin")}
                    onChange={(e) => patch(row.uid, { role: e.target.value as UserRole })}
                  >
                    <option value="member">member</option>
                    {myRole === "owner" ? <option value="admin">admin</option> : null}
                    <option value="disabled">disabled</option>
                  </select>
                </td>
                <td className="py-2">
                  <select
                    className="input py-1 text-xs"
                    value={row.status ?? "active"}
                    disabled={row.role === "owner" || busyUid === row.uid}
                    onChange={(e) => patch(row.uid, { status: e.target.value as UserStatus })}
                  >
                    <option value="active">active</option>
                    <option value="invited">invited</option>
                    <option value="disabled">disabled</option>
                  </select>
                </td>
                <td className="py-2">
                  <select className="input py-1 text-xs" value={row.tierId ?? ""} disabled={busyUid === row.uid} onChange={(e) => assignTier(row.uid, e.target.value)}>
                    <option value="">(default)</option>
                    {tiers.map((tier) => (
                      <option key={tier.id} value={tier.id}>
                        {tier.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-2">
                  <input
                    type="checkbox"
                    checked={row.aiEnabled ?? true}
                    disabled={busyUid === row.uid}
                    onChange={(e) => patch(row.uid, { aiEnabled: e.target.checked })}
                  />
                </td>
                <td className="py-2 text-xs text-ink-500">
                  {(() => {
                    const tier = tiers.find((item) => item.id === row.tierId) ?? tiers.find((item) => item.isDefault);
                    const limits = tier?.limits ?? DEFAULT_TIER_LIMITS;
                    const budget = row.monthlyBudgetUsd ?? limits.aiMonthlyBudgetUsd;
                    const quota = row.blobQuotaMb ?? limits.blobQuotaMb;
                    return (
                      <>
                        ${budget} {row.monthlyBudgetUsd === undefined ? <span className="italic">(tier)</span> : null} / {quota} MB{" "}
                        {row.blobQuotaMb === undefined ? <span className="italic">(tier)</span> : null}
                      </>
                    );
                  })()}
                </td>
                <td className="py-2">
                  <div className="flex flex-col items-start gap-1">
                    <button className="btn-secondary px-2 py-1 text-xs" onClick={() => revoke(row.uid)} disabled={busyUid === row.uid}>
                      Sign out
                    </button>
                    {revokedUid === row.uid ? <span className="text-xs text-moss-600 dark:text-moss-400">Signed out</span> : null}
                  </div>
                  <div className="mt-1 flex gap-1">
                    {row.role !== "owner" ? (
                      <button className="btn-secondary px-2 py-1 text-xs text-red-600" onClick={() => setDeleteTarget(row)}>
                        Delete
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {deleteTarget ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-5 dark:bg-ink-900">
            <h2 className="mb-2 text-lg font-semibold">Delete {deleteTarget.email}</h2>
            <p className="mb-3 text-sm text-ink-500">This deletes all Firestore data, Blob files, and the Auth record. Type the email to confirm.</p>
            <input className="input mb-3" placeholder={deleteTarget.email} value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} />
            <label className="mb-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={exportFirst} onChange={(e) => setExportFirst(e.target.checked)} />
              Export data first
            </label>
            {deleteResult ? <p className="mb-3 break-all text-xs text-ink-500">{deleteResult}</p> : null}
            <div className="flex justify-end gap-2">
              <button
                className="btn-secondary"
                onClick={() => {
                  setDeleteTarget(null);
                  setConfirmEmail("");
                  setDeleteResult("");
                }}
              >
                Cancel
              </button>
              <button className="btn-primary bg-red-600 hover:bg-red-700" disabled={confirmEmail !== deleteTarget.email || busyUid === deleteTarget.uid} onClick={runDelete}>
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
