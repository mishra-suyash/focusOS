"use client";

import { clsx } from "clsx";
import { useAuth } from "@/components/auth-provider";
import { updatePaper } from "@/lib/firestore";
import { BUILTIN_READING_GOAL_PRESETS } from "@/lib/templates/builtin/reading-goal-presets";
import type { GoalKind, Paper } from "@/types";

export const GOAL_KINDS: GoalKind[] = ["survey", "method", "baseline", "related-work", "reproduce", "critique"];

/**
 * The six "Why am I reading this?" presets as one-tap chips — on the paper page, and inline wherever
 * a Skim is about to start without a goal (plan/17 §5.3: the gate moved from planning to the start of
 * a sitting, so answering it has to be possible right there). The chosen one shows as selected,
 * which it never used to (F11).
 */
export function ReadingGoalChips({ paper, onPicked, size = "sm" }: { paper: Pick<Paper, "id" | "goalKind">; onPicked?: (kind: GoalKind, text: string) => void; size?: "sm" | "xs" }) {
  const { user } = useAuth();
  return (
    <div className="flex flex-wrap gap-1.5">
      {GOAL_KINDS.map((kind) => {
        const selected = paper.goalKind === kind;
        return (
          <button
            key={kind}
            type="button"
            aria-pressed={selected}
            className={clsx(
              "rounded-full border px-2 py-1",
              size === "xs" ? "text-[10px]" : "text-[11px]",
              selected
                ? "border-moss-600 bg-moss-600 text-white"
                : "border-ink-200 text-ink-600 hover:border-moss-500 hover:text-moss-700 dark:border-ink-700 dark:text-ink-300 dark:hover:text-moss-400"
            )}
            title={BUILTIN_READING_GOAL_PRESETS[kind].text}
            onClick={async () => {
              const text = BUILTIN_READING_GOAL_PRESETS[kind].text;
              if (user) await updatePaper(user.uid, paper.id, { goal: text, goalKind: kind });
              onPicked?.(kind, text);
            }}
          >
            {kind}
          </button>
        );
      })}
    </div>
  );
}
