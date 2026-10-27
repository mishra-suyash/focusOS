import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/components/auth-provider";
import { FocusSessionProvider } from "@/components/focus-session-provider";
import { ReadingPickerProvider } from "@/components/reading-picker";
import { SoundscapeProvider } from "@/components/soundscape-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { ToastProvider } from "@/components/toast-host";
import { WorkdaySessionProvider } from "@/components/workday-session-provider";

export const metadata: Metadata = {
  title: "FocusOS",
  description: "A research operating system for focused academic work."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <AuthProvider>
          <ThemeProvider>
            {/* plan/18 §5.4 — above the focus timer, which raises the session toasts. */}
            <ToastProvider>
              {/* plan/17 §5.5 — the focus timer is the one clock for reading, and the reader at /read
                  lives outside the (app) shell. Hoisted here so one provider owns the running session
                  on every route, rather than unmounting it on the way into the reader. */}
              <FocusSessionProvider>
                {/* plan/18 §5.3 — hoisted for the same reason: reminders and sitting notifications
                    used to stop the moment you opened the reader. It renders nothing itself and
                    subscribes to nothing until there is a signed-in user. */}
                <WorkdaySessionProvider>
                  {/* The background-sound mixer — reads the focus timer, so it sits inside it. */}
                  <SoundscapeProvider>
                    <ReadingPickerProvider>{children}</ReadingPickerProvider>
                  </SoundscapeProvider>
                </WorkdaySessionProvider>
              </FocusSessionProvider>
            </ToastProvider>
          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
