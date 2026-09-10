"use client";

import { LogIn, Mail, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";

type EmailMode = "signin" | "signup";

interface SignInMethods {
  google: boolean;
  emailPassword: boolean;
  emailLink: boolean;
  anonymous: boolean;
  maintenanceMode: boolean;
}

const ALL_METHODS_ENABLED: SignInMethods = { google: true, emailPassword: true, emailLink: true, anonymous: true, maintenanceMode: false };

function friendlyAuthError(error: unknown): string {
  const code = (error as { code?: string })?.code ?? "";
  const map: Record<string, string> = {
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/user-not-found": "No account with that email — try Create account.",
    "auth/email-already-in-use": "That email already has an account — try Sign in instead.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/invalid-email": "That doesn't look like a valid email address."
  };
  return map[code] ?? "Something went wrong. Please try again.";
}

export default function LoginPage() {
  const { signInWithGoogle, signInAsGuest, signInWithEmail, signUpWithEmail, sendMagicLink, loading, isDemoMode } = useAuth();
  const [emailMode, setEmailMode] = useState<EmailMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [magicEmail, setMagicEmail] = useState("");
  const [magicSent, setMagicSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Defaults open (all methods, no maintenance banner) so a slow/failed fetch never hides a sign-in option that should be there.
  const [methods, setMethods] = useState<SignInMethods>(ALL_METHODS_ENABLED);

  useEffect(() => {
    fetch("/api/public/sign-in-methods")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setMethods(data);
      })
      .catch(() => undefined);
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitEmailForm(event: React.FormEvent) {
    event.preventDefault();
    await run(() => (emailMode === "signin" ? signInWithEmail(email, password) : signUpWithEmail(email, password)));
  }

  async function submitMagicLink(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      await sendMagicLink(magicEmail);
      setMagicSent(true);
    });
  }

  const disabled = busy || loading || isDemoMode;

  return (
    <main className="grid min-h-screen place-items-center bg-ink-50 px-4 py-10 dark:bg-ink-950">
      <section className="w-full max-w-md rounded-lg border border-ink-200 bg-white p-8 shadow-soft dark:border-ink-800 dark:bg-ink-900">
        <div className="mb-6">
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
        {methods.maintenanceMode ? (
          <div className="mb-4 rounded-md border border-amberline/30 bg-amberline/10 p-3 text-sm text-ink-700 dark:text-ink-200">
            FocusOS is in maintenance mode. Existing sessions still work; new sign-in may be limited.
          </div>
        ) : null}
        {error ? (
          <div className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        ) : null}

        {methods.google || methods.anonymous ? (
          <div className="space-y-3">
            {methods.google ? (
              <button className="btn-primary w-full" onClick={() => run(signInWithGoogle)} disabled={disabled}>
                <LogIn className="h-4 w-4" />
                Continue with Google
              </button>
            ) : null}
            {methods.anonymous ? (
              <button className="btn-secondary w-full" onClick={() => run(signInAsGuest)} disabled={disabled}>
                <UserRound className="h-4 w-4" />
                Continue as guest (testing)
              </button>
            ) : null}
          </div>
        ) : null}

        {methods.emailPassword ? (
          <>
            <div className="my-6 flex items-center gap-3 text-xs text-ink-400">
              <span className="h-px flex-1 bg-ink-200 dark:bg-ink-800" />
              or with email
              <span className="h-px flex-1 bg-ink-200 dark:bg-ink-800" />
            </div>

            <div className="mb-3 flex gap-1 rounded-md bg-ink-50 p-1 text-sm dark:bg-ink-800">
              <button
                type="button"
                className={`flex-1 rounded py-1.5 font-medium transition ${emailMode === "signin" ? "bg-white shadow-soft dark:bg-ink-900" : "text-ink-500"}`}
                onClick={() => setEmailMode("signin")}
              >
                Sign in
              </button>
              <button
                type="button"
                className={`flex-1 rounded py-1.5 font-medium transition ${emailMode === "signup" ? "bg-white shadow-soft dark:bg-ink-900" : "text-ink-500"}`}
                onClick={() => setEmailMode("signup")}
              >
                Create account
              </button>
            </div>
            <form onSubmit={submitEmailForm} className="space-y-2">
              <input className="input" type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <input
                className="input"
                type="password"
                required
                minLength={6}
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button className="btn-secondary w-full" disabled={disabled}>
                {emailMode === "signin" ? "Sign in" : "Create account"}
              </button>
            </form>
          </>
        ) : null}

        {methods.emailLink ? (
          <>
            <div className="my-6 flex items-center gap-3 text-xs text-ink-400">
              <span className="h-px flex-1 bg-ink-200 dark:bg-ink-800" />
              or a magic link
              <span className="h-px flex-1 bg-ink-200 dark:bg-ink-800" />
            </div>
            {magicSent ? (
              <p className="rounded-md bg-moss-600/10 p-3 text-sm text-moss-700 dark:text-moss-400">
                Check {magicEmail} for a sign-in link — open it on this device to finish signing in.
              </p>
            ) : (
              <form onSubmit={submitMagicLink} className="flex gap-2">
                <input
                  className="input"
                  type="email"
                  required
                  placeholder="Email"
                  value={magicEmail}
                  onChange={(e) => setMagicEmail(e.target.value)}
                />
                <button className="btn-secondary shrink-0" disabled={disabled}>
                  <Mail className="h-4 w-4" />
                  Send link
                </button>
              </form>
            )}
          </>
        ) : null}
      </section>
    </main>
  );
}
