import type { AiProvider, AiTaskTier } from "@/types";

/**
 * Rough $/token rates for cost estimation only — not billing-accurate, just close
 * enough to keep the monthly budget guard honest. Update when a provider reprices.
 */
const RATES_PER_MILLION_TOKENS: Record<AiProvider, Record<AiTaskTier, { input: number; output: number }>> = {
  claude: {
    large: { input: 3, output: 15 },
    small: { input: 0.8, output: 4 }
  },
  gemini: {
    large: { input: 1.25, output: 5 },
    small: { input: 0.075, output: 0.3 }
  },
  ollama: {
    large: { input: 0, output: 0 },
    small: { input: 0, output: 0 }
  },
  fallback: {
    large: { input: 0, output: 0 },
    small: { input: 0, output: 0 }
  }
};

export function estimateCostUsd(provider: AiProvider, tier: AiTaskTier, inputTokens: number, outputTokens: number): number {
  const rate = RATES_PER_MILLION_TOKENS[provider][tier];
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

export function modelForTier(provider: "claude" | "gemini", tier: AiTaskTier): string {
  if (provider === "claude") {
    return tier === "large"
      ? process.env.AI_MODEL_LARGE || "claude-sonnet-5"
      : process.env.AI_MODEL_SMALL || "claude-haiku-4-5-20251001";
  }
  return tier === "large"
    ? process.env.GEMINI_MODEL_LARGE || "gemini-2.5-pro"
    : process.env.GEMINI_MODEL_SMALL || "gemini-2.5-flash";
}
