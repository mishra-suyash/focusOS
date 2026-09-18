import { AppShell } from "@/components/app-shell";
import { FocusSessionProvider } from "@/components/focus-session-provider";
import { OnboardingGate } from "@/components/onboarding-gate";
import { VocabularyRenameGate } from "@/components/vocabulary-rename-gate";
import { WorkdaySessionProvider } from "@/components/workday-session-provider";

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <WorkdaySessionProvider>
      <FocusSessionProvider>
        <AppShell>{children}</AppShell>
        <OnboardingGate />
        <VocabularyRenameGate />
      </FocusSessionProvider>
    </WorkdaySessionProvider>
  );
}
