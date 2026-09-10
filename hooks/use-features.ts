"use client";

import { useMemo } from "react";
import { useUserSettings } from "@/hooks/use-user-settings";
import { resolveEnabledModules, type ModuleId } from "@/lib/features";

/** Wraps `useUserSettings` (already synced, no extra reads) to expose the resolved module set. Nothing gates on this yet — U4 wires it into nav/widgets/routes. */
export function useFeatures() {
  const { settings } = useUserSettings();
  const enabled = useMemo(() => resolveEnabledModules(settings), [settings.packId, settings.enabledModules]);

  function isEnabled(moduleId: ModuleId) {
    return enabled.has(moduleId);
  }

  return { enabledModules: enabled, isEnabled, packId: settings.packId };
}
