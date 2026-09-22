/**
 * plan/08.FocusOS-v2-Floating-Widget-Plan.md §4 — rows shown in the floating focus widget (the
 * Document Picture-in-Picture window). Deliberately not a generic "pin anything" framework: this
 * is a fixed, small list, each item picked because it's glanceable (a number/progress bar, not
 * prose) and single-tap actionable — see the plan doc §2–3 for why a "quotes" or generic
 * "reminders" item didn't make this list.
 */
export type FloatingWidgetItemId = "timer" | "currentFocus" | "hydrationNudge" | "loadIndex";

export const FLOATING_WIDGET_ITEMS: { id: FloatingWidgetItemId; label: string; defaultOn: boolean }[] = [
  { id: "timer", label: "Focus timer", defaultOn: true },
  { id: "currentFocus", label: "Current focus", defaultOn: true },
  { id: "hydrationNudge", label: "Hydration & break nudges", defaultOn: true },
  { id: "loadIndex", label: "Today's Workload", defaultOn: true }
];

/** Absent `floatingWidgetItems` = each item's own `defaultOn`. An explicit list always wins, even an empty one — same convention as `lib/dashboard-widgets.ts`. */
export function isFloatingWidgetItemEnabled(settings: { floatingWidgetItems?: string[] }, itemId: FloatingWidgetItemId): boolean {
  if (settings.floatingWidgetItems) return settings.floatingWidgetItems.includes(itemId);
  return FLOATING_WIDGET_ITEMS.find((item) => item.id === itemId)?.defaultOn ?? false;
}

export function resolveFloatingWidgetItems(settings: { floatingWidgetItems?: string[] }): Set<FloatingWidgetItemId> {
  return new Set(FLOATING_WIDGET_ITEMS.map((item) => item.id).filter((id) => isFloatingWidgetItemEnabled(settings, id)));
}
