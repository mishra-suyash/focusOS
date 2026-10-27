import { AppShell } from "@/components/app-shell";
import { OnboardingGate } from "@/components/onboarding-gate";
import { VocabularyRenameGate } from "@/components/vocabulary-rename-gate";

/** `WorkdaySessionProvider` lives in the root layout (plan/18 §5.3), so the reader at /read has it too. */
export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AppShell>{children}</AppShell>
      <OnboardingGate />
      <VocabularyRenameGate />
    </>
  );
}
