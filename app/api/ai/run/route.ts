import { NextResponse } from "next/server";
import { verifyActiveUser } from "@/lib/api-auth";
import { AI_TASKS } from "@/lib/ai/tasks";
import { NoFallbackAvailableError, runAiTask } from "@/lib/ai/run";
import type { AiTaskId } from "@/types";

export async function POST(request: Request) {
  const auth = await verifyActiveUser(request);
  if ("error" in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const task = body?.task as AiTaskId | undefined;
  if (!task || !(task in AI_TASKS)) {
    return NextResponse.json({ error: `Unknown task. Expected one of: ${Object.keys(AI_TASKS).join(", ")}` }, { status: 400 });
  }

  try {
    const result = await runAiTask(auth.uid, task, body?.payload);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof NoFallbackAvailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "AI task failed." }, { status: 500 });
  }
}
