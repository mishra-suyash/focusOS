"use client";

import { collection, doc, increment, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";

/**
 * Lightweight client-side Firestore usage tracking. Every read/write in
 * lib/firestore.ts reports here; this module debounces a flush into
 * `users/{uid}/usage/{yyyy-MM}` and exposes an in-memory session total for
 * the dev-only overlay (see components/usage-overlay.tsx). Best-effort only —
 * a failed flush never blocks or throws for the caller that triggered it.
 */

let uid: string | null = null;
let pendingReads = 0;
let pendingWrites = 0;
let flushHandle: ReturnType<typeof setTimeout> | null = null;
let sessionReads = 0;
let sessionWrites = 0;
const listeners = new Set<() => void>();

export function setUsageUid(nextUid: string | null) {
  uid = nextUid;
}

export function trackRead(count = 1) {
  if (count <= 0) return;
  pendingReads += count;
  sessionReads += count;
  notify();
  scheduleFlush();
}

export function trackWrite(count = 1) {
  if (count <= 0) return;
  pendingWrites += count;
  sessionWrites += count;
  notify();
  scheduleFlush();
}

export function getSessionUsage() {
  return { reads: sessionReads, writes: sessionWrites };
}

export function subscribeUsage(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify() {
  listeners.forEach((listener) => listener());
}

function scheduleFlush() {
  if (flushHandle !== null || typeof window === "undefined") return;
  flushHandle = setTimeout(flush, 20_000);
}

async function flush() {
  flushHandle = null;
  if (!db || !uid || (pendingReads === 0 && pendingWrites === 0)) return;
  const reads = pendingReads;
  const writes = pendingWrites;
  pendingReads = 0;
  pendingWrites = 0;
  const month = new Date().toISOString().slice(0, 7);
  try {
    await setDoc(
      doc(collection(db, "users", uid, "usage"), month),
      { month, reads: increment(reads), writes: increment(writes) },
      { merge: true }
    );
  } catch {
    pendingReads += reads;
    pendingWrites += writes;
  }
}
