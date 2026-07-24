"use client";

import { LogIn } from "lucide-react";
import { useAuth } from "@/components/auth-provider";

export default function LoginPage() {
  const { signInWithGoogle, signInAsGuest, loading, isDemoMode } = useAuth();

  return (
    <main className="grid min-h-screen place-items-center bg-ink-50 px-4 dark:bg-ink-950">
      <section className="w-full max-w-md rounded-lg border border-ink-200 bg-white p-8 shadow-soft dark:border-ink-800 dark:bg-ink-900">
        <div className="mb-8">
          <div className="mb-4 grid h-11 w-11 place-items-center rounded-md bg-moss-600 text-lg font-bold text-white">F</div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-950 dark:text-ink-50">FocusOS</h1>
          <p className="mt-2 text-sm leading-6 text-ink-600 dark:text-ink-300">
            A calm research operating system for planning deep work, reviewing progress, and keeping scholarly momentum visible.
          </p>
        </div>
        {isDemoMode ? (
          <div className="mb-4 rounded-md border border-amberline/30 bg-amberline/10 p-3 text-sm text-ink-700 dark:text-ink-200">
            Firebase environment variables are missing. Add them from `.env.example` to enable sign-in and persistence.
          </div>
        ) : null}
        <div className="space-y-3">
          <button className="btn-primary w-full" onClick={signInWithGoogle} disabled={loading || isDemoMode}>
            <LogIn className="h-4 w-4" />
            Continue with Google
          </button>
          <button className="btn-secondary w-full" onClick={signInAsGuest} disabled={loading || isDemoMode}>
            Guest/dev fallback
          </button>
        </div>
      </section>
    </main>
  );
}
