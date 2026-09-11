"use client";

import { Check, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "@/components/auth-provider";
import { InfoHint } from "@/components/info-hint";
import { useDay } from "@/hooks/use-day";
import { appendProposedSlotToSchedule, createTask, saveDayFields } from "@/lib/firestore";
import { todayKey } from "@/lib/dates";
import type { ProposalDecision, ProposedSlot, ProposedTask } from "@/types";

/**
 * The "End day" sheet (plan §9.6) — for packs without Weekly check-in in primary nav, this
 * replaces navigating to /reviews/daily with a short in-place sheet: focus rating, one
 * carry-forward note, and the same Accept/Dismiss suggestions as the full evening rollup. It
 * writes the identical `days/{date}.review`/`rollup` fields as the full page (see
 * app/(app)/reviews/daily/page.tsx and components/evening-rollup-card.tsx), so re-opening the
 * full wrap-up later shows the same data. Fields the sheet doesn't collect (done/blocked/energy)
 * are simply left unwritten.
 */
export function DayWrapupSheet({
  onClose,
  onOpenFull,
  externalGenerating
}: {
  onClose: () => void;
  onOpenFull: () => void;
  /** True while the "End day" click's own best-effort rollup POST is still in flight — disables
   * this sheet's Generate button so it can't fire a redundant, racing second generation. */
  externalGenerating?: boolean;
}) {
  const { user } = useAuth();
  const date = todayKey();
  const { day } = useDay(date);
  const [focusRating, setFocusRating] = useState(3);
  const [carryForward, setCarryForward] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [rollupLoading, setRollupLoading] = useState(false);
  const [generated, setGenerated] = useState(day?.rollup);

  // `day` loads async (Firestore subscription); seed the editable fields once it arrives instead
  // of only at first render, so a freshly-opened sheet still reflects an already-saved review.
  useEffect(() => {
    if (day?.review) {
      setFocusRating(day.review.focusRating ?? 3);
      setCarryForward(day.review.carryForward ?? "");
    }
  }, [day?.review]);

  const rollup = generated ?? day?.rollup;
  const tomorrow = todayKey(new Date(new Date(date).getTime() + 86_400_000));

  async function generateRollup() {
    if (!user) return;
    setRollupLoading(true);
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/daily-loop/rollup", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const body = await response.json().catch(() => ({}));
      if (response.ok) setGenerated(body.rollup);
    } finally {
      setRollupLoading(false);
    }
  }

  async function save() {
    if (!user) return;
    setSaving(true);
    try {
      await saveDayFields(user.uid, date, {
        "review.focusRating": focusRating,
        "review.carryForward": carryForward,
        "review.submittedAt": new Date().toISOString()
      });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  async function decideTask(index: number, decision: ProposalDecision, task: ProposedTask) {
    if (!user || !rollup) return;
    if (decision === "accepted") {
      await createTask(user.uid, {
        title: task.title,
        status: "todo",
        priority: task.severity === "critical" ? "high" : task.severity === "important" ? "medium" : "low",
        category: task.category,
        dueDate: tomorrow,
        estimatedPomodoros: task.estimatePomodoros
      });
    }
    await saveDayFields(user.uid, date, { [`rollup.taskDecisions.${index}`]: decision });
    setGenerated((prev) => ({ ...(prev ?? rollup)!, taskDecisions: { ...rollup!.taskDecisions, [index]: decision } }));
  }

  async function decideSlot(index: number, decision: ProposalDecision, slot: ProposedSlot) {
    if (!user || !rollup) return;
    if (decision === "accepted") {
      await appendProposedSlotToSchedule(user.uid, tomorrow, slot, []);
    }
    await saveDayFields(user.uid, date, { [`rollup.slotDecisions.${index}`]: decision });
    setGenerated((prev) => ({ ...(prev ?? rollup)!, slotDecisions: { ...rollup!.slotDecisions, [index]: decision } }));
  }

  const suggestions = [
    ...(rollup?.proposedTasks.map((task, index) => ({ kind: "task" as const, index, task })) ?? []),
    ...(rollup?.proposedSlots.map((slot, index) => ({ kind: "slot" as const, index, slot })) ?? [])
  ];

  // Portaled to <body> — the sticky header (components/app-shell.tsx) uses `backdrop-blur`,
  // which makes it a containing block for `position: fixed` descendants and would otherwise
  // clip/mis-position this overlay inside the header bar instead of the viewport.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div className="card max-h-[85vh] w-full max-w-md overflow-y-auto p-5 sm:rounded-xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Day wrap-up</h2>
          <button className="btn-secondary px-2 py-1.5" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="mb-4 block">
          <span className="label mb-2 block">How focused did you feel? {focusRating}</span>
          <input
            className="w-full accent-moss-600"
            type="range"
            min={1}
            max={5}
            value={focusRating}
            onChange={(event) => setFocusRating(Number(event.target.value))}
          />
        </label>

        <label className="mb-4 block">
          <span className="label mb-2 block">Anything to carry to tomorrow?</span>
          <textarea
            className="input min-h-20"
            value={carryForward}
            onChange={(event) => setCarryForward(event.target.value)}
            placeholder="Optional"
          />
        </label>

        <div className="mb-4 flex items-center gap-3">
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
          {saved ? <p className="text-sm text-moss-700 dark:text-moss-400">Saved.</p> : null}
        </div>

        <div className="mb-2 flex items-center justify-between">
          <p className="label flex items-center gap-1">
            Suggestions for tomorrow
            <InfoHint term="suggestionsForTomorrow" />
          </p>
          {!rollup ? (
            <button className="btn-secondary px-2 py-1 text-xs" onClick={generateRollup} disabled={rollupLoading || externalGenerating}>
              <Sparkles className="h-3.5 w-3.5" />
              {rollupLoading || externalGenerating ? "Generating..." : "Generate"}
            </button>
          ) : null}
        </div>

        {!rollup ? (
          <p className="text-sm text-ink-500">
            {externalGenerating
              ? "Generating suggestions..."
              : "No suggestions yet — click Generate, or the ~22:00 IST cron will fill this in automatically."}
          </p>
        ) : suggestions.length === 0 ? (
          <p className="text-sm text-ink-500">Nothing proposed for tomorrow.</p>
        ) : (
          <div className="space-y-2">
            {suggestions.map((item) =>
              item.kind === "task" ? (
                <SuggestionChip
                  key={`task-${item.index}`}
                  title={item.task.title}
                  decision={rollup.taskDecisions?.[String(item.index)]}
                  onDecide={(decision) => decideTask(item.index, decision, item.task)}
                />
              ) : (
                <SuggestionChip
                  key={`slot-${item.index}`}
                  title={item.slot.title}
                  decision={rollup.slotDecisions?.[String(item.index)]}
                  onDecide={(decision) => decideSlot(item.index, decision, item.slot)}
                />
              )
            )}
          </div>
        )}

        <button className="btn-secondary mt-5 w-full py-2 text-sm" onClick={onOpenFull}>
          Open full wrap-up
        </button>
      </div>
    </div>,
    document.body
  );
}

function SuggestionChip({
  title,
  decision,
  onDecide
}: {
  title: string;
  decision?: ProposalDecision;
  onDecide: (decision: ProposalDecision) => void;
}) {
  if (decision) {
    return <p className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-500 dark:bg-ink-800">{title} — {decision}</p>;
  }
  return (
    <div className="flex items-center gap-2 rounded-md border border-ink-200 p-2 text-sm dark:border-ink-800">
      <span className="flex-1 truncate">{title}</span>
      <button className="btn-primary px-2 py-1 text-xs" onClick={() => onDecide("accepted")} aria-label="Accept">
        <Check className="h-3 w-3" />
      </button>
      <button className="btn-secondary px-2 py-1 text-xs" onClick={() => onDecide("dismissed")} aria-label="Dismiss">
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
