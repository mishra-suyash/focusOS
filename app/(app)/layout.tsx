import { AppShell } from "@/components/app-shell";
import { WorkdaySessionProvider } from "@/components/workday-session-provider";

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <WorkdaySessionProvider>
      <AppShell>{children}</AppShell>
    </WorkdaySessionProvider>
  );
}
