import { logAiRun } from "@/lib/ai/aiRuns";
import { checkBudget, recordAiUsage } from "@/lib/ai/budget";
import { breakerSnapshot, isBreakerOpen, recordFailure, recordSuccess } from "@/lib/ai/circuit-breaker";
import { estimateCostUsd } from "@/lib/ai/pricing";
import { claudeConfigured, callClaude } from "@/lib/ai/providers/claude";
import { geminiConfigured, callGemini } from "@/lib/ai/providers/gemini";
import { callOllama, isOllamaAvailable } from "@/lib/ai/providers/ollama";
import { AI_TASKS, type AnyAiTaskDef } from "@/lib/ai/tasks";
import { resolveUserTier } from "@/lib/admin-tiers";
import { getAdminSettings } from "@/lib/admin-settings";
import type { AiProvider, AiTaskId } from "@/types";

export interface RunAiTaskResult<Output> {
  output: Output;
  meta: {
    provider: AiProvider;
    model?: string;
    degraded: boolean;
    reason?: "budget_exceeded" | "no_provider_available" | "ai_disabled";
  };
}

export class NoFallbackAvailableError extends Error {
  constructor(task: AiTaskId) {
    super(`No AI provider is available for "${task}" and this task has no fallback.`);
  }
}

async function attemptProvider(
  uid: string,
  task: AnyAiTaskDef,
  provider: "claude" | "gemini" | "ollama",
  prompt: { system?: string; prompt: string; fileId?: string }
): Promise<{ text: string; model?: string } | null> {
  if (isBreakerOpen(provider)) return null;
  const startedAt = Date.now();
  try {
    const result =
      provider === "claude"
        ? await callClaude({ ...prompt, maxTokens: task.maxTokens, tier: task.tier })
        : provider === "gemini"
          ? await callGemini({ ...prompt, maxTokens: task.maxTokens, tier: task.tier })
          : await callOllama({ ...prompt, maxTokens: task.maxTokens, tier: task.tier });
    const latencyMs = Date.now() - startedAt;
    const costUsd = provider === "ollama" ? 0 : estimateCostUsd(provider, task.tier, result.inputTokens, result.outputTokens);
    recordSuccess(provider);
    await Promise.all([
      logAiRun(uid, {
        task: task.id,
        provider,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd,
        latencyMs,
        ok: true
      }),
      costUsd > 0
        ? recordAiUsage(uid, { task: task.id, provider, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd })
        : Promise.resolve()
    ]);
    return { text: result.text, model: result.model };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    recordFailure(provider);
    await logAiRun(uid, {
      task: task.id,
      provider,
      latencyMs,
      ok: false,
      error: error instanceof Error ? error.message : "unknown error"
    });
    return null;
  }
}

function safeJsonParse(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * The provider chain (plan §9.2): local Ollama (if preferLocal and healthy) →
 * Claude → Gemini → the task's deterministic fallback. Every attempt is logged
 * to aiRuns; a parsed-but-schema-invalid response counts as that provider's
 * failure, never rendered raw. Payload/output are intentionally `unknown` here
 * — callers know the shape from the task's own Payload/Output types in
 * lib/ai/tasks.ts and lib/ai/schemas.ts and cast at the call site.
 */
export async function runAiTask(uid: string, taskId: AiTaskId, payload: unknown): Promise<RunAiTaskResult<unknown>> {
  const task = AI_TASKS[taskId] as AnyAiTaskDef;
  const promptInput = task.buildPrompt(payload as never);

  const runFallback = async (reason: RunAiTaskResult<unknown>["meta"]["reason"]) => {
    if (!task.fallback) throw new NoFallbackAvailableError(taskId);
    const output = task.fallback(payload as never);
    await logAiRun(uid, { task: taskId, provider: "fallback", latencyMs: 0, ok: true, error: reason });
    return { output, meta: { provider: "fallback" as const, degraded: true, reason } };
  };

  const adminSettings = await getAdminSettings();
  if (!adminSettings.aiGloballyEnabled) return runFallback("ai_disabled");

  const { allowedModels, aiEnabled, effectiveBudgetUsd } = await resolveUserTier(uid);
  if (!aiEnabled) return runFallback("ai_disabled");

  const budget = await checkBudget(uid, effectiveBudgetUsd);
  if (budget.exceeded) return runFallback("budget_exceeded");

  // Local Ollama is a shared, free accelerator — not gated by a per-user AI budget or
  // model allowlist, since it costs nothing and its absence is meant to be invisible.
  if (task.preferLocal && adminSettings.chainOrder.includes("local")) {
    const { available } = await isOllamaAvailable();
    if (available) {
      const result = await attemptProvider(uid, task, "ollama", promptInput);
      const parsed = result ? task.schema.safeParse(safeJsonParse(result.text)) : null;
      if (parsed?.success) return { output: parsed.data, meta: { provider: "ollama", model: result?.model, degraded: false } };
    }
  }

  const chainCloudOrder = adminSettings.chainOrder.filter((p): p is "claude" | "gemini" => p === "claude" || p === "gemini");
  let cloudProviders: ("claude" | "gemini")[] = chainCloudOrder.filter(
    (provider) => allowedModels.includes(provider) && (provider === "claude" ? claudeConfigured() : geminiConfigured())
  );
  // Gemini/Ollama have no equivalent to an Anthropic file_id — attempting one
  // here would either error or, worse, silently ignore the reference and
  // return a hallucinated-but-schema-valid response as if it had read the PDF.
  if (task.requiresAnthropicFile) cloudProviders = cloudProviders.filter((provider) => provider === "claude");

  for (const provider of cloudProviders) {
    const result = await attemptProvider(uid, task, provider, promptInput);
    if (!result) continue;
    const parsed = task.schema.safeParse(safeJsonParse(result.text));
    if (parsed.success) return { output: parsed.data, meta: { provider, model: result.model, degraded: false } };
    // Unparsable structured output is that provider's failure, not something to render raw.
    recordFailure(provider);
    await logAiRun(uid, { task: taskId, provider, model: result.model, latencyMs: 0, ok: false, error: "schema validation failed" });
  }

  return runFallback("no_provider_available");
}

export async function aiHealthSnapshot(uid: string) {
  const { effectiveBudgetUsd } = await resolveUserTier(uid);
  const [budget, ollama] = await Promise.all([
    checkBudget(uid, effectiveBudgetUsd),
    isOllamaAvailable().catch(() => ({ available: false, config: { enabled: false } as { enabled: boolean } }))
  ]);
  return {
    providers: {
      claude: { configured: claudeConfigured(), ...breakerSnapshot("claude") },
      gemini: { configured: geminiConfigured(), ...breakerSnapshot("gemini") },
      ollama: { enabled: ollama.config.enabled, available: ollama.available }
    },
    budget
  };
}
