import { GoogleGenerativeAI } from "@google/generative-ai";
import { modelForTier } from "@/lib/ai/pricing";
import type { ProviderCallInput, ProviderCallResult } from "@/lib/ai/providers/claude";

export function geminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

export async function callGemini({ system, prompt, tier }: ProviderCallInput): Promise<ProviderCallResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set.");
  const model = modelForTier("gemini", tier);
  const client = new GoogleGenerativeAI(apiKey);
  const generativeModel = client.getGenerativeModel({ model, systemInstruction: system });
  const result = await generativeModel.generateContent(prompt);
  const usage = result.response.usageMetadata;
  return {
    text: result.response.text(),
    model,
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0
  };
}
