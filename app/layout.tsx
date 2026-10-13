import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/components/auth-provider";
import { FocusSessionProvider } from "@/components/focus-session-provider";
import { ReadingPickerProvider } from "@/components/reading-picker";
import { ThemeProvider } from "@/components/theme-provider";

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
            {/* plan/17 §5.5 — the focus timer is the one clock for reading, and the reader at /read
                lives outside the (app) shell. Hoisted here so one provider owns the running session
                on every route, rather than unmounting it on the way into the reader. */}
            <FocusSessionProvider>
              <ReadingPickerProvider>{children}</ReadingPickerProvider>
            </FocusSessionProvider>
          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
