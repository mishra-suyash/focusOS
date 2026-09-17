import Anthropic from "@anthropic-ai/sdk";
import { modelForTier } from "@/lib/ai/pricing";
import type { AiTaskTier } from "@/types";

export interface ProviderCallInput {
  system?: string;
  prompt: string;
  maxTokens: number;
  tier: AiTaskTier;
  /** An Anthropic Files API id (see lib/ai/anthropic-files.ts) — Claude-only, see lib/ai/tasks.ts's `requiresAnthropicFile`. Gemini/Ollama ignore this field entirely since they have no equivalent. */
  fileId?: string;
}

export interface ProviderCallResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export function claudeConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function callClaude({ system, prompt, maxTokens, tier, fileId }: ProviderCallInput): Promise<ProviderCallResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
  const model = modelForTier("claude", tier);
  const client = new Anthropic({ apiKey });
  // Streamed rather than a single blocking `create()` call: a large `maxTokens` (e.g. the
  // ~11k tokens a dense paper's layered notes can need) makes the Anthropic SDK itself refuse a
  // non-streaming request ("Streaming is required for operations that may take longer than 10
  // minutes"), and capping `maxTokens` low enough to dodge that just truncates the response into
  // invalid JSON instead — streaming has no such ceiling and lets generation run to its natural end.
  const message = await client.messages.stream({
    model,
    max_tokens: maxTokens,
    system,
    messages: [
      {
        role: "user",
        content: fileId
          ? [{ type: "document", source: { type: "file", file_id: fileId } }, { type: "text", text: prompt }]
          : prompt
      }
    ]
  }).finalMessage();
  if (message.stop_reason === "max_tokens") {
    // Distinct from a generic parse/schema failure so it's diagnosable from the aiRuns log alone
    // instead of looking identical to a malformed (but complete) response.
    throw new Error(`Claude response was truncated at the ${maxTokens}-token limit before finishing.`);
  }
  const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  return {
    text,
    model,
    inputTokens: message.usage?.input_tokens ?? 0,
    outputTokens: message.usage?.output_tokens ?? 0
  };
}
