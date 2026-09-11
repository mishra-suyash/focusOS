"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { OPTIONAL_DASHBOARD_WIDGETS, resolveDashboardWidgets } from "@/lib/dashboard-widgets";
import type { UserSettings } from "@/types";

/** "Customize" (plan §9.4) — toggles the five optional Today widgets, persisted as an explicit `dashboardWidgets` list (present = exact set, overriding the pack-derived default). */
export function DashboardCustomizeDialog({
  settings,
  onChange,
  onClose
}: {
  settings: Pick<UserSettings, "packId" | "dashboardWidgets">;
  onChange: (widgetIds: string[]) => void;
  onClose: () => void;
}) {
  const [enabled, setEnabled] = useState(() => resolveDashboardWidgets(settings));

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
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Customize</h2>
          <button className="btn-secondary px-2 py-1.5" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-2">
          {OPTIONAL_DASHBOARD_WIDGETS.map((widget) => (
            <label key={widget.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={enabled.has(widget.id)} onChange={() => toggle(widget.id)} />
              {widget.label}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
