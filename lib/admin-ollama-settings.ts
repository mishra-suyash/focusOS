import { adminDb } from "@/lib/firebase-admin";
import { validateOllamaBaseUrl } from "@/lib/ai/ollama-validate";

/**
 * `admin/settings` — a single server-only doc (Admin SDK only, no client
 * Firestore rule ever grants read/write on it). Holds the Ollama config per
 * plan §9.2.1: the address is a mutable non-secret that changes often, so it
 * lives here instead of an env var that would need a redeploy per change.
 * Until Phase 4.5 builds `/admin/ollama`, `scripts/manage-ai-settings.mjs` is
 * the only way to edit this doc.
 */
export interface OllamaHealth {
  lastOkAt?: string;
  lastFailAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  lastSeenAddress?: string;
}

export interface OllamaConfig {
  enabled: boolean;
  baseUrl?: string;
  model?: string;
  fallbackModels: string[];
  timeoutMs: number;
  maxConcurrent: number;
  health: OllamaHealth;
  updatedAt: string;
  updatedBy?: string;
}

export const DEFAULT_OLLAMA_CONFIG: OllamaConfig = {
  enabled: false,
  fallbackModels: [],
  timeoutMs: 90_000,
  maxConcurrent: 2,
  health: { consecutiveFailures: 0 },
  updatedAt: new Date(0).toISOString()
};

const ADMIN_SETTINGS_DOC = () => adminDb().collection("admin").doc("settings");

export async function getOllamaConfig(): Promise<OllamaConfig> {
  const snapshot = await ADMIN_SETTINGS_DOC().get();
  const data = snapshot.data();
  if (!data?.ollama) return DEFAULT_OLLAMA_CONFIG;
  return { ...DEFAULT_OLLAMA_CONFIG, ...data.ollama };
}

export async function updateOllamaConfig(
  patch: Partial<Pick<OllamaConfig, "enabled" | "baseUrl" | "model" | "fallbackModels" | "timeoutMs" | "maxConcurrent">>,
  updatedBy?: string
): Promise<OllamaConfig> {
  const current = await getOllamaConfig();
  const next: OllamaConfig = { ...current, ...patch, updatedAt: new Date().toISOString(), updatedBy };
  if (patch.baseUrl !== undefined) {
    next.baseUrl = patch.baseUrl ? validateOllamaBaseUrl(patch.baseUrl) : undefined;
  }
  await ADMIN_SETTINGS_DOC().set({ ollama: next }, { merge: true });
  return next;
}

/** Called only by the heartbeat route — skips the write entirely when the address hasn't changed, so a 5-minute heartbeat doesn't cost a write every tick. */
export async function reportOllamaHeartbeat(rawBaseUrl: string): Promise<{ changed: boolean; config: OllamaConfig }> {
  const validated = validateOllamaBaseUrl(rawBaseUrl);
  const current = await getOllamaConfig();
  if (current.baseUrl === validated) {
    return { changed: false, config: current };
  }
  const next: OllamaConfig = {
    ...current,
    baseUrl: validated,
    health: { ...current.health, lastSeenAddress: validated },
    updatedAt: new Date().toISOString(),
    updatedBy: "heartbeat"
  };
  await ADMIN_SETTINGS_DOC().set({ ollama: next }, { merge: true });
  return { changed: true, config: next };
}

export async function recordOllamaHealth(ok: boolean, error?: string): Promise<void> {
  const current = await getOllamaConfig();
  const now = new Date().toISOString();
  const health: OllamaHealth = ok
    ? { ...current.health, lastOkAt: now, consecutiveFailures: 0 }
    : { ...current.health, lastFailAt: now, lastError: error, consecutiveFailures: current.health.consecutiveFailures + 1 };
  await ADMIN_SETTINGS_DOC().set({ ollama: { ...current, health } }, { merge: true });
}

/**
 * A short-lived counter guarding `maxConcurrent` (plan §9.2.1): one box, many
 * autoscaling callers. Uses a Firestore transaction so the limit holds across
 * concurrent function instances, not just within one warm lambda.
 */
export async function withOllamaConcurrencySlot<T>(maxConcurrent: number, fn: () => Promise<T>): Promise<T> {
  const lockRef = adminDb().collection("admin").doc("locks").collection("ollama").doc("counter");
  const acquired = await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(lockRef);
    const count = (snap.data()?.count as number | undefined) ?? 0;
    if (count >= maxConcurrent) return false;
    tx.set(lockRef, { count: count + 1, updatedAt: new Date().toISOString() }, { merge: true });
    return true;
  });
  if (!acquired) throw new Error("ollama-concurrency-limit");
  try {
    return await fn();
  } finally {
    await adminDb().runTransaction(async (tx) => {
      const snap = await tx.get(lockRef);
      const count = (snap.data()?.count as number | undefined) ?? 1;
      tx.set(lockRef, { count: Math.max(0, count - 1), updatedAt: new Date().toISOString() }, { merge: true });
    });
  }
}
