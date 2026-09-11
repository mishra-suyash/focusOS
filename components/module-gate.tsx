"use client";

import { useAuth } from "@/components/auth-provider";
import { useFeatures } from "@/hooks/use-features";
import { useUserSettings } from "@/hooks/use-user-settings";
import { FEATURE_MODULES, withModuleToggled, type ModuleId } from "@/lib/features";

/**
 * Wraps a page whose module can be turned off (plan §9.2). A disabled module's URL shows a
 * one-click "turn it on?" prompt rather than a 404 — 404 is reserved for admin routes, which
 * deliberately don't advertise their existence.
 */
export function ModuleGate({ moduleId, children }: { moduleId: ModuleId; children: React.ReactNode }) {
  const { user } = useAuth();
  const { isEnabled } = useFeatures();
  const { settings, update } = useUserSettings();

  if (isEnabled(moduleId)) return <>{children}</>;

  const moduleInfo = FEATURE_MODULES[moduleId];

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-semibold">{moduleInfo.label} is turned off.</h1>
      <p className="mt-2 text-sm text-ink-500">{moduleInfo.description}</p>
      {user ? (
        <button className="btn-primary mt-4" onClick={() => update({ enabledModules: withModuleToggled(settings, moduleId, true) })}>
          Turn it on?
        </button>
      ) : null}
    </div>
  );
}
