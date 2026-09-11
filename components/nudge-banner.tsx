"use client";

import { Sparkle, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useAuth } from "@/components/auth-provider";
import { useFeatures } from "@/hooks/use-features";
import { useUserSettings } from "@/hooks/use-user-settings";
import { withModuleToggled } from "@/lib/features";
import { computeNudges, type NudgeData } from "@/lib/nudges";
import { todayKey } from "@/lib/dates";

/**
 * Plan §11.1 — "shown once each, max one visible at a time and one new per day." `activeNudge`
 * locks in whichever nudge qualified first today; dismissing it adds the key to
 * `dismissedHints` (never shown again) but leaves `activeNudge.shownDate` alone so a *different*
 * nudge can't take its place until tomorrow, even if more than one currently qualifies.
 */
export function NudgeBanner({ data }: { data: NudgeData }) {
  const { user } = useAuth();
  const { isEnabled } = useFeatures();
  const { settings, loaded, update } = useUserSettings();

  const today = todayKey();
  const dismissed = new Set(settings.dismissedHints ?? []);
  const qualifying = computeNudges(data, isEnabled).filter((nudge) => !dismissed.has(nudge.key));

  const lockedToday = settings.activeNudge?.shownDate === today;
  const lockedNudge = lockedToday ? qualifying.find((item) => item.key === settings.activeNudge!.key) : undefined;
  // If today's locked nudge stopped qualifying (turned on, or its own trigger no longer holds),
  // fall through to whatever else qualifies rather than going silent for the rest of the day —
  // without re-stamping `activeNudge`, so this stays a display-only fallback and doesn't spend a
  // second "new nudge" slot on the same day.
  const nudge = lockedToday ? (lockedNudge ?? qualifying[0]) : qualifying[0];

  const nudgeKey = nudge?.key;
  // `update` (from useUserSettings) isn't referentially stable across renders, so it can't be
  // trusted to keep this effect from re-firing on its own — the ref guard is what actually
  // prevents a duplicate write for the same key while waiting for the Firestore round-trip to
  // flip `lockedToday` true.
  const lockWrittenForKey = useRef<string | null>(null);

  useEffect(() => {
    if (!user || !loaded || lockedToday || !nudgeKey) return;
    if (lockWrittenForKey.current === nudgeKey) return;
    lockWrittenForKey.current = nudgeKey;
    update({ activeNudge: { key: nudgeKey, shownDate: today } });
  }, [user, loaded, lockedToday, nudgeKey, today, update]);

  if (!user || !loaded || !nudge) return null;

  function dismiss() {
    update({ dismissedHints: [...dismissed, nudge!.key] });
  }

  function turnOn() {
    update({ enabledModules: withModuleToggled(settings, nudge!.moduleId, true) });
  }

  return (
    <div className="flex items-start gap-2 rounded-md border border-moss-600/30 bg-moss-600/5 p-3 text-sm">
      <Sparkle className="mt-0.5 h-4 w-4 shrink-0 text-moss-600" />
      <p className="flex-1">{nudge.message}</p>
      <button className="btn-primary py-1 text-xs" onClick={turnOn}>
        Turn on
      </button>
      <button className="opacity-60 hover:opacity-100" onClick={dismiss} aria-label="Dismiss">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
