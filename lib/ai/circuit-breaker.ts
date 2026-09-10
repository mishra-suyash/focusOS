import type { AiProvider } from "@/types";

/**
 * In-memory, per-warm-instance circuit breaker. Vercel functions are short-lived
 * and stateless across cold starts, so this resets on every cold start — that's
 * an accepted simplification (§9.2 of the plan doesn't mandate cross-instance
 * persistence, and a Firestore-backed breaker would spend writes on every
 * failure just to track something that self-heals in 10 minutes anyway).
 */
const FAILURE_THRESHOLD = 3;
const OPEN_MS = 10 * 60 * 1000;

interface BreakerState {
  consecutiveFailures: number;
  openUntil: number | null;
}

const state = new Map<AiProvider, BreakerState>();

function get(provider: AiProvider): BreakerState {
  let entry = state.get(provider);
  if (!entry) {
    entry = { consecutiveFailures: 0, openUntil: null };
    state.set(provider, entry);
  }
  return entry;
}

export function isBreakerOpen(provider: AiProvider): boolean {
  const entry = get(provider);
  if (entry.openUntil === null) return false;
  if (Date.now() >= entry.openUntil) {
    entry.consecutiveFailures = 0;
    entry.openUntil = null;
    return false;
  }
  return true;
}

export function recordSuccess(provider: AiProvider): void {
  const entry = get(provider);
  entry.consecutiveFailures = 0;
  entry.openUntil = null;
}

export function recordFailure(provider: AiProvider): void {
  const entry = get(provider);
  entry.consecutiveFailures += 1;
  if (entry.consecutiveFailures >= FAILURE_THRESHOLD) {
    entry.openUntil = Date.now() + OPEN_MS;
  }
}

export function breakerSnapshot(provider: AiProvider) {
  const entry = get(provider);
  return { consecutiveFailures: entry.consecutiveFailures, open: isBreakerOpen(provider) };
}
