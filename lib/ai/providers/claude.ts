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
  const message = await client.messages.create({
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
  });
  const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  return {
    text,
    model,
    inputTokens: message.usage?.input_tokens ?? 0,
    outputTokens: message.usage?.output_tokens ?? 0
  };
}
