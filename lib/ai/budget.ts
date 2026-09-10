import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import type { AiProvider, AiTaskId } from "@/types";

/**
 * Extends the `users/{uid}/usage/{yyyy-MM}` doc already written by the client's
 * read/write counter (lib/usage.ts) with an `ai` sub-object — same doc, same
 * collection, no new Firestore location to reason about.
 */

function monthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

export interface BudgetStatus {
  spentUsd: number;
  capUsd: number;
  pct: number;
  exceeded: boolean;
}

/** The effective cap is the tighter of the user's tier budget and the global env ceiling, if set — the global var is a hard backstop, not a default to be overridden upward. */
export function effectiveCapUsd(tierCapUsd: number): number {
  const globalCap = Number(process.env.AI_MONTHLY_BUDGET_USD);
  if (Number.isFinite(globalCap) && globalCap > 0) return Math.min(tierCapUsd, globalCap);
  return tierCapUsd;
}

export async function checkBudget(uid: string, tierCapUsd: number): Promise<BudgetStatus> {
  const capUsd = effectiveCapUsd(tierCapUsd);
  const snapshot = await adminDb().collection("users").doc(uid).collection("usage").doc(monthKey()).get();
  const spentUsd = (snapshot.data()?.ai?.estimatedCostUsd as number | undefined) ?? 0;
  return { spentUsd, capUsd, pct: capUsd > 0 ? spentUsd / capUsd : 0, exceeded: capUsd > 0 && spentUsd >= capUsd };
}

export async function recordAiUsage(
  uid: string,
  usage: { task: AiTaskId; provider: AiProvider; inputTokens: number; outputTokens: number; costUsd: number }
): Promise<void> {
  await adminDb()
    .collection("users")
    .doc(uid)
    .collection("usage")
    .doc(monthKey())
    .set(
      {
        month: monthKey(),
        ai: {
          inputTokens: FieldValue.increment(usage.inputTokens),
          outputTokens: FieldValue.increment(usage.outputTokens),
          estimatedCostUsd: FieldValue.increment(usage.costUsd),
          [`runsByTask.${usage.task}`]: FieldValue.increment(1),
          [`runsByProvider.${usage.provider}`]: FieldValue.increment(1)
        }
      },
      { merge: true }
    );
}
