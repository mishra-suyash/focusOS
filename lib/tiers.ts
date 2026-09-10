"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { subscribeTiers, subscribeUserProfile } from "@/lib/firestore";
import { DEFAULT_ALLOWED_MODELS, DEFAULT_TIER_LIMITS } from "@/lib/tier-defaults";
import type { AiProvider, Tier, TierLimits } from "@/types";

export { DEFAULT_ALLOWED_MODELS, DEFAULT_TIER_LIMITS };

export interface EffectiveTier {
  tier: Tier | null;
  limits: TierLimits;
  allowedModels: AiProvider[];
  loading: boolean;
}

/** Resolves the current user's tier (explicit tierId, else whichever tier is marked default, else hardcoded fallbacks). */
export function useUserTier(): EffectiveTier {
  const { user } = useAuth();
  const [tierId, setTierId] = useState<string | undefined>(undefined);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [profileLoaded, setProfileLoaded] = useState(false);

  useEffect(() => {
    if (!user) {
      setTierId(undefined);
      setProfileLoaded(false);
      return;
    }
    return subscribeUserProfile(user.uid, (profile) => {
      setTierId(profile?.tierId);
      setProfileLoaded(true);
    });
  }, [user]);

  useEffect(() => {
    if (!user) {
      setTiers([]);
      return;
    }
    return subscribeTiers(setTiers);
  }, [user]);

  const tier = (tierId ? tiers.find((item) => item.id === tierId) : undefined) ?? tiers.find((item) => item.isDefault) ?? null;

  return {
    tier,
    limits: tier?.limits ?? DEFAULT_TIER_LIMITS,
    allowedModels: tier?.allowedModels ?? DEFAULT_ALLOWED_MODELS,
    loading: !profileLoaded
  };
}
