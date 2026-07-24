"use client";

import { SectionHeader } from "@/components/section-header";
import { useAuth } from "@/components/auth-provider";
import { useTheme } from "@/components/theme-provider";

export default function SettingsPage() {
  const { user, isDemoMode } = useAuth();
  const { theme, toggleTheme } = useTheme();

  return (
    <>
      <SectionHeader title="Settings" eyebrow="Workspace" />
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="mb-4 text-lg font-semibold">Profile</h2>
          <dl className="space-y-3 text-sm">
            <div><dt className="label">Name</dt><dd>{user?.displayName ?? "FocusOS Scholar"}</dd></div>
            <div><dt className="label">Email</dt><dd>{user?.email ?? "Guest"}</dd></div>
            <div><dt className="label">User ID</dt><dd className="break-all font-mono text-xs">{user?.uid}</dd></div>
          </dl>
        </section>
        <section className="card p-5">
          <h2 className="mb-4 text-lg font-semibold">Preferences</h2>
          <div className="flex items-center justify-between rounded-md bg-ink-50 p-3 dark:bg-ink-800">
            <div>
              <p className="text-sm font-medium">Dark mode</p>
              <p className="text-xs text-ink-500">Current theme: {theme}</p>
            </div>
            <button className="btn-secondary" onClick={toggleTheme}>Toggle</button>
          </div>
        </section>
        <section className="card p-5 lg:col-span-2">
          <h2 className="mb-4 text-lg font-semibold">Firebase status</h2>
          <p className="text-sm text-ink-600 dark:text-ink-300">
            {isDemoMode
              ? "Firebase environment variables are missing. Configure .env.local or Vercel environment variables before production use."
              : "Firebase Auth and Firestore are configured from environment variables."}
          </p>
        </section>
      </div>
    </>
  );
}
