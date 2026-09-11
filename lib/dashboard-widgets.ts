import type { PackId } from "@/types";

/**
 * Optional Today-view widgets (plan §9.4) — Workload, the metrics strip,
 * catch-up hours, morning overview, and scratchpad are off by default for
 * every pack except "everything" (so the owner's account, migrated to
 * `packId: "everything"`, keeps today's exact layout by construction) and
 * on-able via Customize. Core cards (plan, tasks, focus timer, reading now)
 * are never gated — only these five are.
 */
export type DashboardWidgetId = "workload" | "metricsStrip" | "catchUpHours" | "morningOverview" | "scratchpad";

export const OPTIONAL_DASHBOARD_WIDGETS: { id: DashboardWidgetId; label: string }[] = [
  { id: "workload", label: "Workload" },
  { id: "metricsStrip", label: "Metrics strip" },
  { id: "catchUpHours", label: "Catch-up hours" },
  { id: "morningOverview", label: "Morning overview" },
  { id: "scratchpad", label: "Scratchpad" }
];

/** Absent `dashboardWidgets` = derived default (everything pack: all on; any other pack, including none set yet: all off). An explicit list always wins, even an empty one. */
export function isWidgetEnabled(settings: { packId?: PackId; dashboardWidgets?: string[] }, widgetId: DashboardWidgetId): boolean {
  if (settings.dashboardWidgets) return settings.dashboardWidgets.includes(widgetId);
  return (settings.packId ?? "everything") === "everything";
}

export function resolveDashboardWidgets(settings: { packId?: PackId; dashboardWidgets?: string[] }): Set<DashboardWidgetId> {
  return new Set(OPTIONAL_DASHBOARD_WIDGETS.map((widget) => widget.id).filter((id) => isWidgetEnabled(settings, id)));
}
