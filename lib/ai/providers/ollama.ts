import { getOllamaConfig, recordOllamaHealth, withOllamaConcurrencySlot, type OllamaConfig } from "@/lib/admin-ollama-settings";
import type { ProviderCallInput, ProviderCallResult } from "@/lib/ai/providers/claude";

const HEALTH_CACHE_MS = 60_000;
let healthCache: { at: number; healthy: boolean } | null = null;

/**
 * `OLLAMA_TOKEN` is checked by a reverse proxy/app-level auth in front of the
 * box (plan §2.4/§9.2). `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` are a
 * separate, additive layer for when the box sits behind a Cloudflare Access
 * application (Zero Trust → Access → Service Auth) — Access rejects requests
 * before they ever reach the tunnel/origin unless these two headers carry a
 * valid service token. Both can be set at once; neither depends on the other.
 */
function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = process.env.OLLAMA_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const cfClientId = process.env.CF_ACCESS_CLIENT_ID;
  const cfClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (cfClientId && cfClientSecret) {
    headers["CF-Access-Client-Id"] = cfClientId;
    headers["CF-Access-Client-Secret"] = cfClientSecret;
  }

  return headers;
}

async function probeHealth(config: OllamaConfig): Promise<boolean> {
  if (!config.enabled || !config.baseUrl) return false;
  if (healthCache && Date.now() - healthCache.at < HEALTH_CACHE_MS) return healthCache.healthy;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch(`${config.baseUrl}/api/tags`, { headers: authHeaders(), signal: controller.signal, redirect: "manual" });
    clearTimeout(timeout);
    const healthy = response.ok;
    healthCache = { at: Date.now(), healthy };
    await recordOllamaHealth(healthy, healthy ? undefined : `probe returned ${response.status}`);
    return healthy;
  } catch (error) {
    healthCache = { at: Date.now(), healthy: false };
    await recordOllamaHealth(false, error instanceof Error ? error.message : "probe failed");
    return false;
  }
}

/** Never throws for "the box is off" — that's an expected state, not a caller-facing error (plan §9.2.2). */
export async function isOllamaAvailable(): Promise<{ available: boolean; config: OllamaConfig }> {
  const config = await getOllamaConfig();
  const available = await probeHealth(config);
  return { available, config };
}

export interface OllamaTestResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  models: string[];
  error?: string;
}

/**
 * Uncached, on-demand probe for /admin/ollama's "Test connection" button
 * (admin panel §4.5) — unlike probeHealth (used by the provider chain, cached
 * 60s) this always hits the box fresh and returns the model list so the
 * screen's model picker can populate from a live response, never a free-text
 * field a typo could break at 2am inside a cron.
 */
export async function testOllamaConnection(baseUrl: string): Promise<OllamaTestResult> {
  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const response = await fetch(`${baseUrl}/api/tags`, { headers: authHeaders(), signal: controller.signal, redirect: "manual" });
    clearTimeout(timeout);
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) return { ok: false, status: response.status, latencyMs, models: [], error: `Returned HTTP ${response.status}` };
    const data = (await response.json()) as { models?: { name: string }[] };
    return { ok: true, status: response.status, latencyMs, models: (data.models ?? []).map((m) => m.name) };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, models: [], error: error instanceof Error ? error.message : "Request failed." };
  }
}

export async function callOllama({ system, prompt }: ProviderCallInput): Promise<ProviderCallResult> {
  const { available, config } = await isOllamaAvailable();
  if (!available || !config.baseUrl || !config.model) throw new Error("Ollama is not available.");

  return withOllamaConcurrencySlot(config.maxConcurrent, async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, 240_000));
    try {
      const response = await fetch(`${config.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        redirect: "manual",
        signal: controller.signal,
        body: JSON.stringify({
          model: config.model,
          stream: false,
          messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }]
        })
      });
      if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
      const data = (await response.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
      await recordOllamaHealth(true);
      return {
        text: data.message?.content ?? "",
        model: config.model!,
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0
      };
    } catch (error) {
      await recordOllamaHealth(false, error instanceof Error ? error.message : "chat call failed");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  });
}
