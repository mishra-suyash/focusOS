"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { saveDailySchedule } from "@/lib/firestore";
import { auth } from "@/lib/firebase";
import type { ScheduleSlot } from "@/types";

export type SaveStatus = "idle" | "saving" | "saved" | "offline" | "error";

const DEBOUNCE_MS = 1000;

// Module-level, not a ref: a full push takes seconds and autosaves can land roughly a second apart,
// so without this, back-to-back saves fire overlapping pushes that read the same `GoogleCalendarLink`
// snapshot and race on the same docs (worst case, a stale-event 404 mid-update aborts one sync while
// another is already mutating the same links). One in-flight push at a time, with at most one more
// queued to catch whatever changed while it ran — same shape as this file's own `savingRef`/`pendingRef`
// debounce-coalescing, just for the push instead of the save.
let pushInFlight = false;
let pushPending = false;

/**
 * plan/11.FocusOS-v2-Google-Calendar-Sync-Plan.md §13 — the near-real-time half of "auto sync" for
 * /plan/day blocks. Deliberately hangs off `writeNow`'s own success path rather than adding a
 * second debounce layer: `scheduleSave`'s 1s timer already is "after the committed gesture settles,"
 * so a push fired here happens once per autosave, never from inside a drag handler (this hook's own
 * "zero writes during drag" guarantee extends to this call for the same reason). Best-effort and
 * silent — a user with the integration off or disconnected just gets a fast, harmless 401/500 here,
 * and any real failure is still visible next time they open Settings or the daily cron catches it.
 */
function triggerGoogleCalendarPush() {
  if (pushInFlight) {
    pushPending = true;
    return;
  }
  const user = auth?.currentUser;
  if (!user) return;
  pushInFlight = true;
  void user
    .getIdToken()
    .then((token) => fetch("/api/integrations/google-calendar/sync-now", { method: "POST", headers: { Authorization: `Bearer ${token}` } }))
    .catch(() => undefined)
    .finally(() => {
      pushInFlight = false;
      if (pushPending) {
        pushPending = false;
        triggerGoogleCalendarPush();
      }
    });
}

/**
 * plan/05.FocusOS-v2-Plan-Day-Timeline.md §6, DP2 — option B (autosave per committed gesture,
 * debounced) + option C (flush on tab-hide/unmount) + the two-tab `updatedAt` guard. Deliberately
 * has no opinion about drag, undo, or which component owns `slots` — it only owns the save
 * mechanics, so it's the one DP2 piece verifiable by reading rather than by dragging something:
 * `scheduleSave` is the only path that can write, and nothing calls it from inside a pointermove
 * handler (checked in `TimeGrid`/`DayTimelineEditor` — writes only happen from pointerup/blur).
 */
export function useDayAutosave({ uid, dateKey, templateId, remoteUpdatedAt }: { uid: string; dateKey: string; templateId?: string; remoteUpdatedAt?: string }) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [conflict, setConflict] = useState(false);

  const timeoutRef = useRef<number | null>(null);
  const pendingRef = useRef<ScheduleSlot[] | null>(null);
  const savingRef = useRef(false);
  // The `updatedAt` this tab considers already accounted for — either what it loaded initially or
  // what it last wrote itself. Only set from `remoteUpdatedAt` on the very first render (React's
  // `useRef(x)` guarantee), since later renders' `remoteUpdatedAt` may just be this tab's own
  // write echoing back through the snapshot listener.
  const baselineUpdatedAtRef = useRef<string | undefined>(remoteUpdatedAt);

  const writeNow = useCallback(
    async (slots: ScheduleSlot[]) => {
      savingRef.current = true;
      setStatus("saving");
      try {
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          // A newer edit may already be queued in `pendingRef` (made while this write was in
          // flight) — never stomp it with this call's older `slots`.
          if (pendingRef.current === null) pendingRef.current = slots;
          setStatus("offline");
          return;
        }
        const { updatedAt } = await saveDailySchedule(uid, { dateKey, templateId, slots });
        baselineUpdatedAtRef.current = updatedAt;
        setStatus("saved");
        triggerGoogleCalendarPush();
      } catch {
        if (pendingRef.current === null) pendingRef.current = slots;
        setStatus("error");
      } finally {
        savingRef.current = false;
      }
    },
    [uid, dateKey, templateId]
  );

  const flush = useCallback(() => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending || savingRef.current) return;
    pendingRef.current = null;
    void writeNow(pending);
  }, [writeNow]);

  /** Call after every committed gesture (drop, resize end, inspector blur) — debounced, never called from a drag-in-progress handler. */
  const scheduleSave = useCallback(
    (slots: ScheduleSlot[]) => {
      pendingRef.current = slots;
      setStatus("saving");
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(flush, DEBOUNCE_MS);
    },
    [flush]
  );

  /** "Keep mine" on the two-tab conflict prompt — writes immediately, accepts the remote version as overtaken, and clears the prompt. */
  const forceSave = useCallback(
    async (slots: ScheduleSlot[]) => {
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      pendingRef.current = null;
      setConflict(false);
      await writeNow(slots);
    },
    [writeNow]
  );

  /** "Reload" on the conflict prompt — the caller resets its own local state from the remote value; this just accepts that version as the new baseline and clears the prompt. */
  const dismissConflict = useCallback(() => {
    baselineUpdatedAtRef.current = remoteUpdatedAt;
    setConflict(false);
  }, [remoteUpdatedAt]);

  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === "hidden") flush();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", flush);
      flush();
    };
  }, [flush]);

  useEffect(() => {
    if (remoteUpdatedAt === undefined) return;
    const baseline = baselineUpdatedAtRef.current;
    if (remoteUpdatedAt === baseline) return; // our own write echoing back, or no real change
    if (baseline !== undefined && remoteUpdatedAt < baseline) return; // an out-of-order/stale snapshot
    setConflict(true);
  }, [remoteUpdatedAt]);

  return { status, scheduleSave, flush, conflict, forceSave, dismissConflict };
}
