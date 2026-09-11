import { AppShell } from "@/components/app-shell";
import { OnboardingGate } from "@/components/onboarding-gate";
import { VocabularyRenameGate } from "@/components/vocabulary-rename-gate";
import { WorkdaySessionProvider } from "@/components/workday-session-provider";

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <WorkdaySessionProvider>
      <AppShell>{children}</AppShell>
      <OnboardingGate />
      <VocabularyRenameGate />
    </WorkdaySessionProvider>
  );
}
