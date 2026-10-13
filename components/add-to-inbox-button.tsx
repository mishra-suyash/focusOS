"use client";

import { useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { createPaper } from "@/lib/firestore";
import { inboxPaper } from "@/lib/paper-capture";
import type { Paper } from "@/types";

/**
 * plan/17 §5.6 — one-tap capture of a reference the app is already showing you (a layered summary's
 * "Citations to read", a paper set's shared citation): it becomes an inbox paper to triage, instead of
 * a line of text nothing could act on (F2).
 */
export function AddToInboxButton({ title, fromPaperId, kind = "citation" }: { title: string; fromPaperId?: string; kind?: NonNullable<Paper["source"]>["kind"] }) {
  const { user } = useAuth();
  const [state, setState] = useState<"idle" | "saving" | "added">("idle");
  if (state === "added") return <span className="ml-1 text-[11px] text-moss-700 dark:text-moss-400">in inbox</span>;
  return (
    <button
      type="button"
      className="ml-1 text-[11px] text-moss-700 underline decoration-dotted disabled:opacity-50 dark:text-moss-400"
      disabled={state === "saving" || !user}
      onClick={async () => {
        if (!user) return;
        setState("saving");
        await createPaper(user.uid, inboxPaper({ title, source: { kind, ...(fromPaperId ? { fromPaperId } : {}) } }));
        setState("added");
      }}
    >
      Add to inbox
    </button>
  );
}
