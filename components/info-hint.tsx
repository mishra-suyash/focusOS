"use client";

import { Info } from "lucide-react";
import { useId, useState } from "react";
import { copy, type CopyKey } from "@/lib/copy";

type HintedCopyKey = { [K in CopyKey]: (typeof copy)[K] extends { hint: string } ? K : never }[CopyKey];

/**
 * The ⓘ popover (plan §11's U5 row, using each entry's `hint` from lib/copy.ts — plan §5's
 * table). `term` is restricted to the `CopyKey`s that actually carry a `hint`, so a call site
 * pointing at a hint-less entry (e.g. "planned") fails to typecheck instead of silently
 * rendering an empty popover.
 *
 * Click-to-toggle rather than hover-only so it behaves the same on touch as with a mouse; closes
 * on blur instead of a separate click-outside listener.
 *
 * `align="right"` grows the popover leftward from the trigger's right edge instead of the default
 * rightward-from-left-edge — for a trigger that sits near the right edge of a narrow viewport
 * (e.g. the header's right-aligned toolbar), the default would push a fixed-width popover off
 * screen. `max-w-[calc(100vw-2rem)]` on top of that is a blanket backstop so no placement can
 * force the page itself to scroll horizontally, even one this prop doesn't cover.
 */
export function InfoHint({ term, className, align = "left" }: { term: HintedCopyKey; className?: string; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const entry = copy[term];
  const tooltipId = useId();

  return (
    <span className={`relative inline-flex${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className="inline-flex text-ink-400 hover:text-ink-600 dark:text-ink-500 dark:hover:text-ink-300"
        aria-label={`More about ${entry.label}`}
        aria-expanded={open}
        aria-describedby={open ? tooltipId : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        onBlur={() => setOpen(false)}
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <span
          id={tooltipId}
          role="tooltip"
          className={`absolute top-full z-20 mt-1 w-56 max-w-[calc(100vw-2rem)] rounded-md border border-ink-200 bg-white p-2 text-xs font-normal normal-case tracking-normal text-ink-600 shadow-md dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300 ${align === "right" ? "right-0" : "left-0"}`}
        >
          {entry.hint}
        </span>
      ) : null}
    </span>
  );
}
