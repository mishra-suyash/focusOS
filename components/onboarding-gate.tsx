"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { OnboardingFlow } from "@/components/onboarding-flow";
import { useUserSettings } from "@/hooks/use-user-settings";

/**
 * "Existing accounts never see onboarding" (plan §8.4/§10.2). `scripts/migrate-ux.mjs`
 * is the primary path — it backfills `packId`+`onboarding.status: "done"` for every
 * account that predates this release. This is only the client-side safety net for
 * an account created in the gap between that migration running and this deploy: it
 * costs zero Firestore reads (Firebase Auth's own `metadata.creationTime`, already
 * in memory) rather than querying the account's collections for prior usage.
 */
export const RELEASE_CUTOFF = new Date("2026-09-10T00:00:00.000Z").getTime();

export function OnboardingGate() {
  const { user } = useAuth();
  const { settings, loaded, update } = useUserSettings();
  const [dismissed, setDismissed] = useState(false);
  const safetyNetApplied = useRef(false);

  const status = settings.onboarding?.status;
  const alreadyResolved = status === "done" || status === "skipped";
  const createdAtMs = user?.metadata.creationTime ? new Date(user.metadata.creationTime).getTime() : null;
  const isPreCutoff = createdAtMs !== null && createdAtMs < RELEASE_CUTOFF;

  useEffect(() => {
    if (!user || !loaded || alreadyResolved || !isPreCutoff || safetyNetApplied.current) return;
    safetyNetApplied.current = true;
    update({ packId: "everything", onboarding: { status: "done", completedAt: new Date().toISOString() } });
  }, [user, loaded, alreadyResolved, isPreCutoff, update]);

  if (!user || !loaded || alreadyResolved || dismissed) return null;
  if (isPreCutoff) return null; // the safety-net write above is in flight; `alreadyResolved` flips true once it lands

  return <OnboardingFlow onDone={() => setDismissed(true)} />;
}
