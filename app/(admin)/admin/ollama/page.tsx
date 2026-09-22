"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { adminFetch } from "@/lib/admin-client";
import { SectionHeader } from "@/components/section-header";

interface OllamaConfig {
  enabled: boolean;
  baseUrl?: string;
  model?: string;
  fallbackModels: string[];
  timeoutMs: number;
  maxConcurrent: number;
  health: { lastOkAt?: string; lastFailAt?: string; lastError?: string; consecutiveFailures: number; lastSeenAddress?: string };
}

interface TestResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  models: string[];
  error?: string;
}

export default function AdminOllamaPage() {
  const { user } = useAuth();
  const [config, setConfig] = useState<OllamaConfig | null>(null);
  const [available, setAvailable] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState("0");
  const [error, setError] = useState("");
  const [test, setTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const result = await adminFetch<{ config: OllamaConfig; available: boolean }>(user, "/api/admin/ollama");
      setConfig(result.config);
      setAvailable(result.available);
      setBaseUrl(result.config.baseUrl ?? "");
      setMaxConcurrent(String(result.config.maxConcurrent));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Ollama config.");
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  async function runTest() {
    if (!user) return;
    setTesting(true);
    setError("");
    try {
      const result = await adminFetch<TestResult>(user, "/api/admin/ollama/test", { method: "POST", body: { baseUrl } });
      setTest(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test failed.");
    } finally {
      setTesting(false);
    }
  }

  async function save(patch: Partial<OllamaConfig>) {
    if (!user) return;
    setSaving(true);
    setError("");
    try {
      const result = await adminFetch<{ config: OllamaConfig }>(user, "/api/admin/ollama", { method: "PUT", body: patch });
      setConfig(result.config);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  if (!config) return <p className="text-sm text-ink-500">Loading...</p>;

  return (
    <>
      <SectionHeader title="Ollama" eyebrow="Admin panel" />
      {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}

      <section className="card mb-4 p-5">
        <label className="mb-3 flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={config.enabled} disabled={saving} onChange={(e) => save({ enabled: e.target.checked })} />
          Enabled — off routes every task straight to Claude/Gemini
        </label>
        <p className="text-xs text-ink-500">
          {config.enabled ? (available ? "Reachable" : "Configured but unreachable") : "Disabled"}
          {config.health.lastOkAt ? ` · last seen ok ${new Date(config.health.lastOkAt).toLocaleString()}` : ""}
          {config.health.consecutiveFailures > 0 ? ` · ${config.health.consecutiveFailures} consecutive failures` : ""}
        </p>
      </section>

      <section className="card mb-4 space-y-3 p-5">
        <label className="block text-sm">
          Address (IP:port or hostname, reachable from the internet — a Vercel function can&apos;t reach a private network)
          <input className="input mt-1" placeholder="https://ollama.example.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={runTest} disabled={testing || !baseUrl}>
            {testing ? "Testing..." : "Test connection"}
          </button>
          <button className="btn-primary" onClick={() => save({ baseUrl })} disabled={saving || !baseUrl}>
            Save address
          </button>
        </div>
        {test ? (
          <div className={`rounded-md p-3 text-sm ${test.ok ? "bg-moss-600/10 text-moss-700 dark:text-moss-400" : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-200"}`}>
            {test.ok ? `Reachable in ${test.latencyMs}ms. Models: ${test.models.join(", ") || "(none)"}` : `Failed (${test.latencyMs}ms): ${test.error}`}
          </div>
        ) : null}
        <p className="text-sm">
          <span className="text-ink-500">Configured model: </span>
          <span className="font-medium">{config.model || "(none selected)"}</span>
        </p>
        {test?.ok && test.models.length > 0 ? (
          <label className="block text-sm">
            Change model (from the last test&apos;s results)
            <select className="input mt-1" value={config.model ?? ""} onChange={(e) => save({ model: e.target.value })}>
              <option value="">(none selected)</option>
              {test.models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </section>

      <section className="card p-5">
        <label className="block text-sm">
          Max concurrent calls
          <div className="mt-1 flex gap-2">
            <input
              className="input max-w-[120px]"
              type="number"
              value={maxConcurrent}
              onChange={(e) => setMaxConcurrent(e.target.value)}
            />
            <button
              className="btn-secondary py-1.5 text-xs"
              disabled={saving || Number(maxConcurrent) === config.maxConcurrent}
              onClick={() => save({ maxConcurrent: Number(maxConcurrent) })}
            >
              Save
            </button>
          </div>
        </label>
        <p className="mt-1 text-xs text-ink-500">Over the limit, calls skip straight to Claude rather than queueing.</p>
      </section>

      <p className="mt-4 text-xs text-ink-500">
        Self-registration heartbeat: <code>POST /api/admin/ollama/heartbeat</code> with <code>Authorization: Bearer OLLAMA_HEARTBEAT_SECRET</code> and{" "}
        <code>{`{"baseUrl": "..."}`}</code>. Skips the write when the address is unchanged.
      </p>
    </>
  );
}
