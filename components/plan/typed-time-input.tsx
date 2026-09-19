"use client";

import { useEffect, useState } from "react";
import { parseTypedTime } from "@/lib/timeline";

/**
 * plan/05.FocusOS-v2-Plan-Day-Timeline.md §4.3 — "Typeable HH:mm fields (accept '9', '930',
 * '9:30pm')", replacing the native `<input type="time">` (A5's clipping, slow 15-minute
 * adjustments). Free text while focused; parsed and committed on blur/Enter via
 * `lib/timeline.ts`'s `parseTypedTime`.
 *
 * `onChange` may return `false` to reject a syntactically-valid time for a reason this component
 * can't see (§6: "validated inline — end after start, no overlap" needs the *other* slots, which
 * this component never receives) — the caller validates and returns `false` synchronously so the
 * displayed text can revert to the last-good `value` in the same tick, rather than getting stuck
 * showing a rejected value the underlying data never actually took on.
 */
export function TypedTimeInput({
  value,
  onChange,
  disabled = false,
  className
}: {
  value: string;
  onChange: (time: string) => boolean | void;
  disabled?: boolean;
  className?: string;
}) {
  const [text, setText] = useState(value);

  useEffect(() => {
    setText(value);
  }, [value]);

  function commit() {
    const parsed = parseTypedTime(text);
    if (!parsed) {
      setText(value);
      return;
    }
    const accepted = parsed === value || onChange(parsed) !== false;
    setText(accepted ? parsed : value);
  }

  return (
    <input
      className={className ?? "input"}
      value={text}
      inputMode="numeric"
      placeholder="9:30am"
      disabled={disabled}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
          event.currentTarget.blur();
        }
      }}
    />
  );
}
