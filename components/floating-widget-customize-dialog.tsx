"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { FLOATING_WIDGET_ITEMS, resolveFloatingWidgetItems } from "@/lib/floating-widget";
import type { UserSettings } from "@/types";

/** Checkbox list for the floating widget's rows — same shape as `DashboardCustomizeDialog`, new domain. */
export function FloatingWidgetCustomizeDialog({
  settings,
  onChange,
  onClose
}: {
  settings: Pick<UserSettings, "floatingWidgetItems">;
  onChange: (itemIds: string[]) => void;
  onClose: () => void;
}) {
  const [enabled, setEnabled] = useState(() => resolveFloatingWidgetItems(settings));

  function toggle(id: string) {
    setEnabled((current) => {
      const next = new Set(current);
      if (next.has(id as never)) next.delete(id as never);
      else next.add(id as never);
      onChange(Array.from(next));
      return next;
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-16" onClick={onClose}>
      <div className="card w-full max-w-sm p-5" onClick={(event) => event.stopPropagation()}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Floating widget</h2>
          <button className="btn-secondary px-2 py-1.5" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-3 text-xs text-ink-500">
          Shown in the floating window (the picture-in-picture button near the top of the app). Chromium browsers only — Chrome, Edge, Arc, Dia.
        </p>
        <div className="space-y-2">
          {FLOATING_WIDGET_ITEMS.map((item) => (
            <label key={item.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={enabled.has(item.id)} onChange={() => toggle(item.id)} />
              {item.label}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
