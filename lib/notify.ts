import { claimInStore, CUE_MEMORY_MS, type CueName } from "@/lib/cues";
import { audioReady, playCue } from "@/lib/sounds";

/**
 * plan/18 §4 — the one path every sound and OS notification goes through, so the cross-tab and
 * permission rules live in one place rather than at five call sites.
 *
 * Every open FocusOS tab runs the same timers (both providers mount once per tab), so every tab
 * reaches every moment. `deliverCue` lets exactly one of them speak: a Web Lock serializes a
 * check-and-set on a shared localStorage map — the same shape as the focus timer's `claimRun`.
 * The sound and the notification are claimed separately, because only a tab whose audio is
 * unlocked may compete for the sound (a suspended tab would win and play nothing, plan/18 C1),
 * while any tab can show a notification.
 */

const CUE_STORAGE_KEY = "focusos-cued";
const FOCUS_BEACON_KEY = "focusos-focused-at";
/** A focused tab re-stamps the beacon this often; older than `FOCUS_BEACON_STALE_MS` is a tab that went away without blurring. */
const FOCUS_BEACON_MS = 15_000;
const FOCUS_BEACON_STALE_MS = 40_000;

function readStore(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(CUE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** True for exactly one tab per `key` within `windowMs`. */
export async function claimCue(key: string, windowMs: number = CUE_MEMORY_MS): Promise<boolean> {
  const check = () => {
    const { claimed, next } = claimInStore(readStore(), key, Date.now(), windowMs);
    if (!claimed) return false;
    try {
      window.localStorage.setItem(CUE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Without storage there is no second tab to race with.
    }
    return true;
  };
  if (typeof navigator === "undefined" || !navigator.locks) return check();
  return navigator.locks.request("focusos-cue", async () => check());
}

export function notificationsAllowed(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

/** Asks for permission only when it hasn't been answered yet. Call from a real click. */
export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  return Notification.requestPermission();
}

export interface NotificationSpec {
  body: string;
  tag: string;
}

/** Clicking any FocusOS notification brings its tab forward (plan/18 F5). */
function showNotification({ body, tag }: NotificationSpec) {
  if (!notificationsAllowed()) return;
  try {
    const notification = new Notification("FocusOS", { body, tag });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Some platforms (Android Chrome) only allow notifications through a service worker.
  }
}

/**
 * Plays `sound` and shows `notification` for the moment `key`, each from exactly one tab. Either may
 * be omitted. The live `Notification.permission` is always the authority — a permission revoked in
 * browser settings never tells the app.
 */
export async function deliverCue({
  key,
  windowMs,
  sound,
  notification
}: {
  key: string;
  windowMs?: number;
  sound?: { cue: CueName; volume: number };
  notification?: NotificationSpec;
}) {
  if (notification && notificationsAllowed() && (await claimCue(`n:${key}`, windowMs))) showNotification(notification);
  if (sound && audioReady() && (await claimCue(`s:${key}`, windowMs))) playCue(sound.cue, sound.volume);
}

/**
 * plan/18 N1 — a timer-end notification is skipped while the user is looking at FocusOS: this tab,
 * another FocusOS tab (the beacon), or the floating widget. The tab that reaches zero first is often
 * a background one, so its own `document.hasFocus()` alone can't answer this.
 */
export function anyFocusOSWindowFocused(): boolean {
  if (typeof document === "undefined") return false;
  if (document.hasFocus()) return true;
  try {
    if (window.documentPictureInPicture?.window?.document.hasFocus()) return true;
  } catch {
    // A closing PiP window can throw on access.
  }
  try {
    const at = Number(window.localStorage.getItem(FOCUS_BEACON_KEY));
    return Number.isFinite(at) && at > 0 && Date.now() - at < FOCUS_BEACON_STALE_MS;
  } catch {
    return false;
  }
}

/** Keeps `FOCUS_BEACON_KEY` stamped while this tab has focus, and clears it on blur. Returns a cleanup. */
export function installFocusBeacon(): () => void {
  let id: number | null = null;
  const stamp = () => {
    try {
      window.localStorage.setItem(FOCUS_BEACON_KEY, String(Date.now()));
    } catch {
      // No beacon — other tabs just can't tell this one is focused.
    }
  };
  const start = () => {
    stamp();
    if (id == null) id = window.setInterval(stamp, FOCUS_BEACON_MS);
  };
  const stop = () => {
    if (id != null) window.clearInterval(id);
    id = null;
    try {
      window.localStorage.removeItem(FOCUS_BEACON_KEY);
    } catch {
      // Goes stale on its own.
    }
  };
  if (document.hasFocus()) start();
  window.addEventListener("focus", start);
  window.addEventListener("blur", stop);
  window.addEventListener("pagehide", stop);
  return () => {
    stop();
    window.removeEventListener("focus", start);
    window.removeEventListener("blur", stop);
    window.removeEventListener("pagehide", stop);
  };
}
