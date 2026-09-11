"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SectionHeader } from "@/components/section-header";
import { useAuth } from "@/components/auth-provider";
import { useFeatures } from "@/hooks/use-features";
import { useUserSettings } from "@/hooks/use-user-settings";
import { CORE_MODULES, FEATURE_MODULES, withModuleToggled, type ModuleId } from "@/lib/features";

const TOGGLEABLE_MODULES: ModuleId[] = (Object.keys(FEATURE_MODULES) as ModuleId[]).filter((id) => !CORE_MODULES.includes(id));

/**
 * U5's `/settings/features` (plan §8.3's "Discover more features" link, §11's U5 row) — the full
 * toggle list Onboarding/`ModuleGate`'s one-click "turn it on?" only offers piecemeal. Toggling
 * here writes the same `enabledModules` list `ModuleGate` writes, so a module turned on/off here
 * takes effect everywhere else immediately (nav, dashboard widgets, `pickNextAction`, the
 * heads-up banner) — there's no separate "features" state. No pack switcher: `enabledModules` is
 * already an arbitrary custom set independent of `packId` (the pack only seeds the *default* set
 * at onboarding), so full customization doesn't need one.
 */
export default function FeaturesSettingsPage() {
  const { user } = useAuth();
  const { isEnabled } = useFeatures();
  const { settings, update } = useUserSettings();

  const hasCustomSelection = Boolean(settings.enabledModules);

  function toggle(moduleId: ModuleId, enabled: boolean) {
    if (!user) return;
    update({ enabledModules: withModuleToggled(settings, moduleId, enabled) });
  }

  function resetToPackDefaults() {
    if (!user) return;
    update({ enabledModules: undefined });
  }

  return (
    <>
      <SectionHeader title="Features" eyebrow="Turn modules on or off">
        <Link href="/settings" className="btn-secondary py-1.5 text-xs">
          <ArrowLeft className="h-3.5 w-3.5" />
          Settings
        </Link>
      </SectionHeader>
      <p className="mb-4 text-sm text-ink-500">
        Today, Tasks, Plan, Focus timer, Daily wrap-up, Papers, and Staged reading are always on — everyone plans days and reads papers.
        Everything below is optional.
      </p>
      <div className="card divide-y divide-ink-100 dark:divide-ink-800">
        {TOGGLEABLE_MODULES.map((moduleId) => {
          const moduleInfo = FEATURE_MODULES[moduleId];
          const enabled = isEnabled(moduleId);
          return (
            <label key={moduleId} className="flex items-center justify-between gap-4 p-4">
              <div>
                <p className="text-sm font-medium">{moduleInfo.label}</p>
                <p className="text-xs text-ink-500">{moduleInfo.description}</p>
              </div>
              <input
                type="checkbox"
                className="h-5 w-9 shrink-0 accent-moss-600"
                checked={enabled}
                onChange={(event) => toggle(moduleId, event.target.checked)}
              />
            </label>
          );
        })}
      </div>
      {hasCustomSelection ? (
        <button className="btn-secondary mt-4 py-1.5 text-xs" onClick={resetToPackDefaults}>
          Reset to {settings.packId ?? "everything"} pack defaults
        </button>
      ) : null}
    </>
  );
}
