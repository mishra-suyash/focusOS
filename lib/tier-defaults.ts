import { DEFAULT_MAX_REVISIONS_PER_DAY, DEFAULT_MAX_REVISION_MINUTES_PER_DAY } from "@/lib/revision";
import { SOFT_ACCOUNT_CAP_MB } from "@/lib/files";
import type { AiProvider, TierLimits } from "@/types";

/**
 * What every limit was hardcoded to before tiers existed. If no tiers have
 * been created yet (a fresh install, or before an admin sets any up), the
 * app behaves exactly as it did pre-tiers — nothing about this feature is
 * required to use FocusOS. Shared by lib/tiers.ts (client) and
 * lib/admin-tiers.ts (server) so both sides resolve the same fallback.
 */
export const DEFAULT_TIER_LIMITS: TierLimits = {
  maxRevisionsPerDay: DEFAULT_MAX_REVISIONS_PER_DAY,
  maxRevisionMinutesPerDay: DEFAULT_MAX_REVISION_MINUTES_PER_DAY,
  aiMonthlyBudgetUsd: 5,
  blobQuotaMb: SOFT_ACCOUNT_CAP_MB
};

/** Unrestricted — the fallback when no tier is assigned, so AI access isn't silently cut off by introducing tiers. */
export const DEFAULT_ALLOWED_MODELS: AiProvider[] = ["claude", "gemini"];
