import { adminDb } from "@/lib/firebase-admin";
import { DEFAULT_ALLOWED_MODELS, DEFAULT_TIER_LIMITS } from "@/lib/tier-defaults";
import type { AiProvider, Tier, TierLimits } from "@/types";

export interface ResolvedTier {
  tier: Tier | null;
  limits: TierLimits;
  allowedModels: AiProvider[];
  /** Per-user overrides from users/{uid} (admin panel §3.1) — read once here, alongside the tier lookup, to avoid a second Firestore read. */
  aiEnabled: boolean;
  effectiveBudgetUsd: number;
  effectiveBlobQuotaMb: number;
}

/**
 * Server-side mirror of lib/tiers.ts's useUserTier, for the places that need a
 * model-allowed check and effective budget before spending an AI call:
 * /api/insights, the daily cron, and lib/ai/run.ts. Same fallback behavior as
 * the client hook — no tiers configured, or no tier assigned, means
 * unrestricted access, so introducing tiers never silently cuts off AI for an
 * existing account.
 */
export async function resolveUserTier(uid: string): Promise<ResolvedTier> {
  const [userDoc, tiersSnapshot] = await Promise.all([
    adminDb().collection("users").doc(uid).get(),
    adminDb().collection("tiers").get()
  ]);

  const tiers = tiersSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Tier);
  const userData = userDoc.exists ? userDoc.data() : undefined;
  const tierId = userData?.tierId as string | undefined;
  const tier = (tierId ? tiers.find((item) => item.id === tierId) : undefined) ?? tiers.find((item) => item.isDefault) ?? null;
  const limits = tier?.limits ?? DEFAULT_TIER_LIMITS;

  return {
    tier,
    limits,
    allowedModels: tier?.allowedModels ?? DEFAULT_ALLOWED_MODELS,
    aiEnabled: (userData?.aiEnabled as boolean | undefined) ?? true,
    effectiveBudgetUsd: (userData?.monthlyBudgetUsd as number | undefined) ?? limits.aiMonthlyBudgetUsd,
    effectiveBlobQuotaMb: (userData?.blobQuotaMb as number | undefined) ?? limits.blobQuotaMb
  };
}

export async function isModelAllowedForUser(uid: string, provider: AiProvider): Promise<{ allowed: boolean; tierName?: string }> {
  const { tier, allowedModels } = await resolveUserTier(uid);
  return { allowed: allowedModels.includes(provider), tierName: tier?.name };
}
