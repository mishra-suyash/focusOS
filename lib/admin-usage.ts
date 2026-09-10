import { adminDb } from "@/lib/firebase-admin";
import { listAllUids } from "@/lib/admin-users";
import type { AiTaskId } from "@/types";

function monthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

export interface UserUsageRow {
  uid: string;
  email?: string;
  reads: number;
  writes: number;
  aiSpendUsd: number;
}

export interface AdminUsageReport {
  month: string;
  byUser: UserUsageRow[];
  byTask: Record<string, number>;
  byProvider: Record<string, number>;
}

/** Spend by task and by user for the current month (admin panel §4.3) — reads each user's own usage/{month} doc directly, same bounded-uid-list approach as lib/admin-overview.ts. */
export async function buildAdminUsageReport(): Promise<AdminUsageReport> {
  const month = monthKey();
  const uids = await listAllUids();

  const byTask: Record<string, number> = {};
  const byProvider: Record<string, number> = {};

  const rows = await Promise.all(
    uids.map(async (uid): Promise<UserUsageRow> => {
      const [usageDoc, userDoc] = await Promise.all([
        adminDb().collection("users").doc(uid).collection("usage").doc(month).get(),
        adminDb().collection("users").doc(uid).get()
      ]);
      const data = usageDoc.data();
      const ai = data?.ai as { estimatedCostUsd?: number; runsByTask?: Record<AiTaskId, number>; runsByProvider?: Record<string, number> } | undefined;

      Object.entries(ai?.runsByTask ?? {}).forEach(([task, count]) => {
        byTask[task] = (byTask[task] ?? 0) + count;
      });
      Object.entries(ai?.runsByProvider ?? {}).forEach(([provider, count]) => {
        byProvider[provider] = (byProvider[provider] ?? 0) + count;
      });

      return {
        uid,
        email: userDoc.data()?.email,
        reads: (data?.reads as number | undefined) ?? 0,
        writes: (data?.writes as number | undefined) ?? 0,
        aiSpendUsd: ai?.estimatedCostUsd ?? 0
      };
    })
  );

  return { month, byUser: rows.sort((a, b) => b.aiSpendUsd - a.aiSpendUsd), byTask, byProvider };
}
