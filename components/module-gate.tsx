"use client";

import { useAuth } from "@/components/auth-provider";
import { useFeatures } from "@/hooks/use-features";
import { useUserSettings } from "@/hooks/use-user-settings";
import { FEATURE_MODULES, dashboardWidgetsAfterModuleToggle, withModuleToggled, type ModuleId } from "@/lib/features";

/**
 * Wraps a page whose module can be turned off (plan §9.2). A disabled module's URL shows a
 * one-click "turn it on?" prompt rather than a 404 — 404 is reserved for admin routes, which
 * deliberately don't advertise their existence.
 *
 * `silent` is for gating a *part* of a page rather than a route: the section simply isn't there
 * when the module is off, with no prompt. A "Day score is turned off. Turn it on?" panel sitting in
 * the middle of the dashboard would be exactly the orphaned copy plan/16 AC #24 asks not to exist.
 */
export function ModuleGate({ moduleId, children, silent = false }: { moduleId: ModuleId; children: React.ReactNode; silent?: boolean }) {
  const { user } = useAuth();
  const { isEnabled } = useFeatures();
  const { settings, update } = useUserSettings();

  if (isEnabled(moduleId)) return <>{children}</>;
  if (silent) return null;

  const moduleInfo = FEATURE_MODULES[moduleId];

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-semibold">{moduleInfo.label} is turned off.</h1>
      <p className="mt-2 text-sm text-ink-500">{moduleInfo.description}</p>
      {user ? (
        <button
          className="btn-primary mt-4"
          onClick={() => {
            const dashboardWidgets = dashboardWidgetsAfterModuleToggle(settings, moduleId, true);
            update({
              enabledModules: withModuleToggled(settings, moduleId, true),
              ...(dashboardWidgets ? { dashboardWidgets } : {})
            });
          }}
        >
          Turn it on?
        </button>
      ) : null}
    </div>
  );
}
