import { NextResponse } from "next/server";
import { evaluateAndSaveAlerts } from "@/lib/admin-alerts";
import { fetchInsightData, saveInsight } from "@/lib/admin-firestore";
import { getAdminSettings } from "@/lib/admin-settings";
import { recordCronRun } from "@/lib/admin-cron-log";
import { getActiveUids } from "@/lib/admin-users";
import { buildInsightFallback, buildInsightPrompt } from "@/lib/ai/prompt";
import type { InsightDailyOutput } from "@/lib/ai/schemas";
import { runAiTask } from "@/lib/ai/run";
import { todayKey } from "@/lib/dates";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const settings = await getAdminSettings();
  if (!settings.cronEnabled) {
    return NextResponse.json({ skipped: "cronEnabled is off in admin/settings" });
  }

  const date = todayKey();
  const uids = await getActiveUids();
  const results = await Promise.all(
    uids.map(async (uid) => {
      try {
        const data = await fetchInsightData(uid);
        const fallback = buildInsightFallback(data);
        const { output, meta } = await runAiTask(uid, "insight.daily", {
          prompt: buildInsightPrompt(data),
          fallbackSummary: fallback.summary,
          fallbackSuggestions: fallback.suggestions
        });
        const result = output as InsightDailyOutput;
        await saveInsight(uid, {
          date,
          provider: meta.provider,
          summary: result.summary,
          suggestions: result.suggestions,
          generatedAt: new Date().toISOString(),
          source: "cron",
          degraded: meta.degraded
        });
        const alerts = await evaluateAndSaveAlerts(uid).catch(() => []);
        return { uid, ok: true, degraded: meta.degraded, alertCount: alerts.length };
      } catch (error) {
        return { uid, ok: false, error: error instanceof Error ? error.message : "unknown error" };
      }
    })
  );

  await recordCronRun("daily-insight", { ok: results.every((r) => r.ok), detail: { processed: results.length } });
  return NextResponse.json({ date, results });
}
