"use client";

/**
 * plan/19 §4.2 — the consent screen Claude sends the person to. Signed out, AuthProvider takes them to
 * /login with this whole request in `returnTo`, and back here afterwards. The card names the app, the
 * host it will return to, and the scopes as checkboxes. Seeing the data is the point of connecting;
 * making changes can be left off.
 */
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth-provider";

interface ClientInfo {
  ok: boolean;
  clientName?: string;
  redirectHost?: string;
  scopes?: string[];
  description?: string;
  redirect?: string;
}

export default function AuthorizePage() {
  return (
    <Suspense fallback={null}>
      <AuthorizeContent />
    </Suspense>
  );
}

function AuthorizeContent() {
  const { user, loading, logOut } = useAuth();
  const searchParams = useSearchParams();
  const params = useMemo(() => Object.fromEntries(searchParams.entries()), [searchParams]);
  const [info, setInfo] = useState<ClientInfo | null>(null);
  const [allowWrite, setAllowWrite] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) return;
    fetch(`/api/oauth/authorize/client?${searchParams.toString()}`)
      .then((res) => res.json() as Promise<ClientInfo>)
      .then((data) => {
        setInfo(data);
        if (data.ok) setAllowWrite(Boolean(data.scopes?.includes("write")));
      })
      .catch(() => setInfo({ ok: false, description: "Couldn't check this request. Try again from Claude." }));
  }, [user, searchParams]);

  async function decide(decision: "allow" | "deny") {
    if (!user) return;
    setBusy(true);
    setError("");
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/oauth/authorize/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ params, decision, allowWrite })
      });
      const body = (await response.json()) as { redirect?: string; error?: string };
      if (body.redirect) {
        window.location.assign(body.redirect);
        return;
      }
      setError(body.error ?? "Something went wrong.");
    } catch {
      setError("Something went wrong. Please try again.");
    }
    setBusy(false);
  }

  if (loading || !user) {
    return <main className="grid min-h-screen place-items-center bg-ink-50 px-4 dark:bg-ink-950"><p className="text-sm text-ink-500">Loading…</p></main>;
  }

  const wantsWrite = Boolean(info?.scopes?.includes("write"));

  return (
    <main className="grid min-h-screen place-items-center bg-ink-50 px-4 py-10 dark:bg-ink-950">
      <section className="w-full max-w-md rounded-lg border border-ink-200 bg-white p-8 shadow-soft dark:border-ink-800 dark:bg-ink-900">
        <div className="mb-5 grid h-11 w-11 place-items-center rounded-md bg-moss-600 text-lg font-bold text-white">F</div>
        {!info ? (
          <p className="text-sm text-ink-500">Checking the request…</p>
        ) : !info.ok ? (
          <>
            <h1 className="text-xl font-semibold text-ink-950 dark:text-ink-50">This connection can&apos;t continue</h1>
            <p className="mt-2 text-sm leading-6 text-ink-600 dark:text-ink-300">{info.description}</p>
            {info.redirect ? (
              <button className="btn-secondary mt-5 w-full" onClick={() => window.location.assign(info.redirect!)}>
                Back to the app
              </button>
            ) : null}
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-ink-950 dark:text-ink-50">Connect {info.clientName} to FocusLab?</h1>
            <p className="mt-2 text-sm leading-6 text-ink-600 dark:text-ink-300">
              {info.clientName} will be able to work with your FocusLab account. When you&apos;re done here you&apos;ll go back to{" "}
              <span className="font-medium text-ink-900 dark:text-ink-100">{info.redirectHost}</span>.
            </p>
            <fieldset className="mt-5 space-y-3">
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" className="mt-0.5" checked disabled />
                <span>
                  <span className="font-medium">See your FocusLab data</span>
                  <span className="block text-ink-500">Tasks, plans, courses, papers, goals, focus history and settings.</span>
                </span>
              </label>
              {wantsWrite ? (
                <label className="flex items-start gap-3 text-sm">
                  <input type="checkbox" className="mt-0.5" checked={allowWrite} onChange={(event) => setAllowWrite(event.target.checked)} />
                  <span>
                    <span className="font-medium">Make changes</span>
                    <span className="block text-ink-500">Add and update tasks, papers, notes, assessments, class logs, goals and days off, and add, move or remove blocks on your plan. It can&apos;t delete a task, paper, course or goal, and every change is listed in Settings.</span>
                  </span>
                </label>
              ) : null}
            </fieldset>
            {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}
            <div className="mt-6 flex gap-3">
              <button className="btn-secondary flex-1" onClick={() => decide("deny")} disabled={busy}>
                Cancel
              </button>
              <button className="btn-primary flex-1" onClick={() => decide("allow")} disabled={busy}>
                {busy ? "Connecting…" : "Allow"}
              </button>
            </div>
            <p className="mt-5 text-xs text-ink-500">
              Signed in as {user.email || "a guest"}.{" "}
              <button className="underline" onClick={() => void logOut()}>
                Not you?
              </button>{" "}
              You can disconnect any time in Settings → Connected apps.
            </p>
          </>
        )}
      </section>
    </main>
  );
}
