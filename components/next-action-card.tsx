"use client";

import { ArrowRight, Sparkle } from "lucide-react";
import Link from "next/link";
import { InfoHint } from "@/components/info-hint";
import type { NextAction } from "@/lib/next-action";

export function NextActionCard({ action, onScheduleIt }: { action: NextAction | null; onScheduleIt?: () => void }) {
  // plan/14 §7.1 — `kind: "block"` means a block is active or about to start; the Now card
  // (components/now-card.tsx) already shows that block with its own primary action, elapsed bar,
  // and assigned tasks. Rendering it again here would be the "second card" §7.1 explicitly says
  // this replacement is not — so this card steps aside rather than duplicate it.
  // plan/15 §5.1 — `kind: "day-off"` gets the same treatment: the Now card already replaces itself
  // with a "Day off" state for a marked-off today, so this card would just repeat it.
  if (action?.kind === "block" || action?.kind === "day-off") return null;
  if (!action) {
    return (
      <section className="card p-4">
        <p className="label mb-1 flex items-center gap-1">
          Up next
          <InfoHint term="upNext" />
        </p>
        <p className="text-sm text-ink-500">Nothing urgent — pick anything from today&apos;s schedule.</p>
      </section>
    );
  }

  return (
    <section className="card border-moss-600/30 bg-moss-600/5 p-4">
      <div className="flex items-start gap-3">
        <Sparkle className="mt-0.5 h-5 w-5 shrink-0 text-moss-600" />
        <div className="min-w-0 flex-1">
          <p className="label mb-1 flex items-center gap-1">
            Up next
            <InfoHint term="upNext" />
          </p>
          <h2 className="text-lg font-semibold leading-snug">{action.title}</h2>
          <p className="mt-1 text-sm text-ink-500">{action.why}</p>
          {action.kind !== "rest" ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href={action.href} className="btn-primary py-1.5 text-xs">
                Go
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
              {onScheduleIt ? (
                <button className="btn-secondary py-1.5 text-xs" onClick={onScheduleIt}>
                  Schedule it
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
