/**
 * plan/08.FocusOS-v2-Floating-Widget-Plan.md §4 — rows shown in the floating focus widget (the
 * Document Picture-in-Picture window). Deliberately not a generic "pin anything" framework: this
 * is a fixed, small list, each item picked because it's glanceable (a number/progress bar, not
 * prose) and single-tap actionable — see the plan doc §2–3 for why a "quotes" or generic
 * "reminders" item didn't make this list.
 */
export type FloatingWidgetItemId = "timer" | "currentFocus" | "hydrationNudge" | "loadIndex" | "nextAction" | "dayScore";

/**
 * plan/16 §5.7 adds the last two, and narrows plan/08's charter by exactly as much as it has to.
 *
 * The ban on a generic "pin anything" reminders feed stands absolutely: this is still a fixed list
 * of named cards and nothing becomes pinnable. The ban on *motivational text* also stands — no
 * "You've got this!", no streak-loss warnings, no praise strings. What `dayScore` narrows is the
 * implicit reading that anything motivating is banned: plan/08's own stated test is "a number or a
 * progress bar, not prose", and a score derived from real logged minutes is a number. `nextAction`
 * is not a feed either; it is the single next thing, computed by the same `pickNextAction` cascade
 * the dashboard's own card uses.
 *
 * Both default on, which via `isFloatingWidgetItemEnabled` below means: on for accounts that have
 * never customized the widget, and *off* for accounts with an explicit `floatingWidgetItems` list,
 * since an explicit list always wins. That is the right trade — a customized widget shouldn't
 * silently grow new cards — and it is why /settings says the two new items exist.
 */
export const FLOATING_WIDGET_ITEMS: { id: FloatingWidgetItemId; label: string; defaultOn: boolean }[] = [
  { id: "timer", label: "Focus timer", defaultOn: true },
  { id: "currentFocus", label: "Current focus", defaultOn: true },
  { id: "nextAction", label: "What's next", defaultOn: true },
  { id: "hydrationNudge", label: "Hydration & break nudges", defaultOn: true },
  { id: "loadIndex", label: "Today's Workload", defaultOn: true },
  { id: "dayScore", label: "Today's score", defaultOn: true }
];

/** Absent `floatingWidgetItems` = each item's own `defaultOn`. An explicit list always wins, even an empty one — same convention as `lib/dashboard-widgets.ts`. */
export function isFloatingWidgetItemEnabled(settings: { floatingWidgetItems?: string[] }, itemId: FloatingWidgetItemId): boolean {
  if (settings.floatingWidgetItems) return settings.floatingWidgetItems.includes(itemId);
  return FLOATING_WIDGET_ITEMS.find((item) => item.id === itemId)?.defaultOn ?? false;
}

export function resolveFloatingWidgetItems(settings: { floatingWidgetItems?: string[] }): Set<FloatingWidgetItemId> {
  return new Set(FLOATING_WIDGET_ITEMS.map((item) => item.id).filter((id) => isFloatingWidgetItemEnabled(settings, id)));
}
