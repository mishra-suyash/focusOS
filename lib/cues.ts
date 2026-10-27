import type { UserSettings } from "@/types";

/**
 * plan/18 — the pure half of sounds and notifications: which cues are on, and the cross-tab
 * "exactly one tab speaks" claim. No DOM here, so `scripts/verify-notify.ts` can settle it; the
 * browser half lives in `lib/sounds.ts` (Web Audio) and `lib/notify.ts` (Notification, Web Locks).
 */

export type CueName = "sessionEnd" | "breakEnd" | "headsUp" | "reminder" | "blockClosed";

export interface ResolvedSounds {
  enabled: boolean;
  volume: number;
  cues: Record<CueName, boolean>;
}

/** plan/18 §6 D1 — the two chimes for a countdown you started yourself are on; everything else is opt-in. */
export const DEFAULT_CUES: Record<CueName, boolean> = {
  sessionEnd: true,
  breakEnd: true,
  headsUp: false,
  reminder: false,
  blockClosed: false
};

export const DEFAULT_SOUND_VOLUME = 0.6;

/** Absent fields read as their defaults, so an account that never opened the setting gets D1. */
export function resolveSounds(sounds: UserSettings["sounds"]): ResolvedSounds {
  return {
    enabled: sounds?.enabled ?? true,
    volume: clamp01(sounds?.volume ?? DEFAULT_SOUND_VOLUME),
    cues: { ...DEFAULT_CUES, ...(sounds?.cues ?? {}) }
  };
}

/** The cues about the planned day go quiet on a day off; the two timer chimes don't — you started that countdown. */
const DAY_CUES = new Set<CueName>(["headsUp", "reminder", "blockClosed"]);

export function cueEnabled(sounds: ResolvedSounds, cue: CueName, opts: { dayOff?: boolean } = {}): boolean {
  if (!sounds.enabled || !sounds.cues[cue]) return false;
  if (opts.dayOff && DAY_CUES.has(cue)) return false;
  return true;
}

/** plan/18 N3 — absent = on, which is what the block-start notification did before it had a setting. */
export function blockStartNotificationsOn(settings: Pick<UserSettings, "notifications">): boolean {
  return settings.notifications?.blockStart !== false;
}

/**
 * Cue keys. Anything about a slot carries the date: recurring class and routine slots reuse the same
 * id on every date they materialize on, so a key without it would swallow tomorrow's cue.
 */
export const cueKeys = {
  timer: (runId: string) => `timer:${runId}`,
  reminder: (kind: "hydration" | "break", dateKey: string) => `reminder:${kind}:${dateKey}`,
  blockStart: (dateKey: string, slotId: string) => `start:${dateKey}:${slotId}`,
  sittingLead: (dateKey: string, slotId: string) => `${dateKey}:${slotId}:lead`,
  sittingEnd: (dateKey: string, slotId: string) => `${dateKey}:${slotId}:end`,
  blockClosed: (dateKey: string, slotId: string) => `closed:${dateKey}:${slotId}`
};

/** How long a claimed key is remembered at most. Long enough to outlast any one day's tabs. */
export const CUE_MEMORY_MS = 12 * 60 * 60 * 1000;

/**
 * One claim against the shared map of `key -> claimedAt`. A key is claimable again once `windowMs`
 * has passed — which is how a recurring reminder (one key per kind per day) fires once per reminder
 * across tabs whose 30-second ticks don't line up, rather than once per tab or once per day.
 * Entries older than `CUE_MEMORY_MS` are dropped so the map can't grow without bound.
 */
export function claimInStore(
  store: Record<string, number>,
  key: string,
  now: number,
  windowMs: number = CUE_MEMORY_MS
): { claimed: boolean; next: Record<string, number> } {
  const next: Record<string, number> = {};
  for (const [storedKey, at] of Object.entries(store)) {
    if (now - at < CUE_MEMORY_MS) next[storedKey] = at;
  }
  const last = next[key];
  if (last != null && now - last < windowMs) return { claimed: false, next };
  next[key] = now;
  return { claimed: true, next };
}

/** A reminder's claim window: half its interval, never under a minute — wide enough to cover two
 *  tabs' out-of-step ticks, narrow enough that the next reminder is never swallowed. */
export function reminderClaimWindowMs(intervalMinutes: number): number {
  return Math.max(60_000, (intervalMinutes * 60_000) / 2);
}

function clamp01(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
