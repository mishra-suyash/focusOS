import { NextResponse } from "next/server";
import { verifyActiveUser } from "@/lib/api-auth";
import { evaluateAndSaveAlerts } from "@/lib/admin-alerts";
import { fetchInsightData, saveInsight } from "@/lib/admin-firestore";
import { buildInsightFallback, buildInsightPrompt } from "@/lib/ai/prompt";
import type { InsightDailyOutput } from "@/lib/ai/schemas";
import { runAiTask } from "@/lib/ai/run";
import { todayKey } from "@/lib/dates";

export async function POST(request: Request) {
  const auth = await verifyActiveUser(request);
  if ("error" in auth) return auth.error;

  try {
    const data = await fetchInsightData(auth.uid);
    const fallback = buildInsightFallback(data);
    const { output, meta } = await runAiTask(auth.uid, "insight.daily", {
      prompt: buildInsightPrompt(data),
      fallbackSummary: fallback.summary,
      fallbackSuggestions: fallback.suggestions
    });
    const result = output as InsightDailyOutput;
    const insight = {
      date: todayKey(),
      provider: meta.provider,
      summary: result.summary,
      suggestions: result.suggestions,
      generatedAt: new Date().toISOString(),
      source: "manual" as const,
      degraded: meta.degraded
    };
    await saveInsight(auth.uid, insight);
    await evaluateAndSaveAlerts(auth.uid).catch(() => undefined);
    return NextResponse.json(insight);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to generate insight." }, { status: 500 });
  }
}
