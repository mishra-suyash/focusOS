"use client";

import { useAuth } from "@/components/auth-provider";
import { RELEASE_CUTOFF } from "@/components/onboarding-gate";
import { useUserSettings } from "@/hooks/use-user-settings";
import { VocabularyRenameDialog } from "@/components/vocabulary-rename-dialog";

/**
 * Plan §10.2 — "the first load after release shows existing users a one-time 'We renamed a few
 * things' dialog." Reuses `OnboardingGate`'s `RELEASE_CUTOFF` + `user.metadata.creationTime`
 * check (zero Firestore reads) to actually distinguish a pre-cutoff existing account from
 * someone who just finished today's first-run flow — a brand-new user has never seen the old
 * terms, so there's nothing for this dialog to explain to them.
 */
export function VocabularyRenameGate() {
  const { user } = useAuth();
  const { settings, loaded, update } = useUserSettings();

  const status = settings.onboarding?.status;
  const onboardingResolved = status === "done" || status === "skipped";
  const createdAtMs = user?.metadata.creationTime ? new Date(user.metadata.creationTime).getTime() : null;
  const isPreCutoff = createdAtMs !== null && createdAtMs < RELEASE_CUTOFF;

  if (!user || !loaded || !onboardingResolved || !isPreCutoff || settings.vocabularyRenameSeen) return null;

  return <VocabularyRenameDialog onDismiss={() => update({ vocabularyRenameSeen: true })} />;
}
