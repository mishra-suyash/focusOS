"use client";

import { clsx } from "clsx";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { MoreOptions } from "@/components/more-options";
import { subscribeDoc, updatePaper } from "@/lib/firestore";
import { PASS_LABELS, READER_PAGE_STORAGE_PREFIX } from "@/lib/papers";
import type { Paper } from "@/types";

const RATINGS = [1, 2, 3, 4, 5];

/** The event the reader listens for to open its pass panel (plan/17 §5.4 step 3, "Yes"). */
export const OPEN_PASS_PANEL_EVENT = "focusos:open-pass-panel";

/**
 * plan/17 §5.4 step 3 — the end of a reading sitting, in one sheet instead of the generic rating
 * dialog: where you got to (prefilled from the reader's current page, stored on the pass so the next
 * sitting resumes there), whether the pass is done, and the same productivity rating.
 *
 * "Not yet" leaves the pass in progress — the next sitting resumes it. "Yes" saves the sitting and
 * takes you to the pass's endings (the reader's pass panel, or the paper's page), because each ending
 * needs its own few words (a takeaway, a summary) and a choice that should be made looking at them.
 * If the pass was already finished in the form that ended this sitting, the question isn't asked.
 */
export function ReadingCheckIn({
  label,
  paperId,
  passNo,
  onSave,
  onSkip
}: {
  label: string;
  paperId: string;
  passNo?: 1 | 2 | 3;
  onSave: (rating: number, comment: string) => Promise<void>;
  onSkip: () => Promise<void>;
}) {
  const { user } = useAuth();
  const router = useRouter();
  const [paper, setPaper] = useState<Paper | null>(null);
  const [rating, setRating] = useState(3);
  const [comment, setComment] = useState("");
  const [page, setPage] = useState("");
  const [passDone, setPassDone] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    return subscribeDoc<Paper>(user.uid, "papers", paperId, setPaper);
  }, [user, paperId]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(`${READER_PAGE_STORAGE_PREFIX}${paperId}`);
      if (stored) setPage(stored);
    } catch {
      // No prefill.
    }
  }, [paperId]);

  const pass = passNo ? paper?.[passNo === 1 ? "pass1" : passNo === 2 ? "pass2" : "pass3"] : undefined;
  const passOpen = Boolean(passNo && pass?.status === "in_progress");

  async function finish(save: boolean) {
    setSaving(true);
    try {
      // Logged first: nothing below may run with the sitting still unsaved.
      if (save) await onSave(rating, comment.trim());
      else await onSkip();
      const pageNumber = Number(page);
      if (user && passNo && passOpen && Number.isFinite(pageNumber) && pageNumber > 0) {
        // A field path, so the rest of the pass (its startedAt, its output) is untouched.
        await updatePaper(user.uid, paperId, { [`pass${passNo}.lastPage`]: Math.round(pageNumber) } as unknown as Partial<Paper>);
      }
      if (passOpen && passDone) {
        if (window.location.pathname.startsWith("/read/")) window.dispatchEvent(new CustomEvent(OPEN_PASS_PANEL_EVENT));
        else router.push(`/papers/${paperId}#pass-${passNo}`);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-sm p-5">
        <h2 className="text-lg font-semibold">End of sitting</h2>
        <p className="mt-0.5 truncate text-xs text-ink-500">{label}</p>

        {passOpen ? (
          <>
            <label className="mt-4 flex items-center gap-2 text-sm">
              Where did you get to? Page
              <input className="input w-20 py-1 text-sm" inputMode="numeric" value={page} onChange={(e) => setPage(e.target.value.replace(/[^0-9]/g, ""))} placeholder="—" />
            </label>
            <p className="mt-4 text-sm">Is this {PASS_LABELS[passNo!]} done?</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button type="button" className={clsx("btn-secondary py-1.5 text-xs", passDone === false && "ring-2 ring-moss-500")} onClick={() => setPassDone(false)}>
                Not yet — resume next sitting
              </button>
              <button type="button" className={clsx("btn-secondary py-1.5 text-xs", passDone === true && "ring-2 ring-moss-500")} onClick={() => setPassDone(true)}>
                Yes — choose how it ends
              </button>
            </div>
          </>
        ) : null}

        <p className="mt-4 text-sm">How did it go?</p>
        <div className="mt-2 grid grid-cols-5 gap-2">
          {RATINGS.map((value) => (
            <button
              key={value}
              type="button"
              className={clsx("btn-secondary py-2 text-sm", rating === value && "ring-2 ring-moss-500")}
              onClick={() => setRating(value)}
              aria-label={`Productivity ${value}`}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="mt-4">
          <MoreOptions label="Add a comment">
            <textarea className="input min-h-20" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What clicked, what didn't, where to pick up..." />
          </MoreOptions>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => finish(false)} disabled={saving}>
            Skip rating
          </button>
          <button className="btn-primary" onClick={() => finish(true)} disabled={saving}>
            {passOpen && passDone ? "Save & finish the pass" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
