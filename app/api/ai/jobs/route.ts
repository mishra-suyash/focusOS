import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { verifyActiveUser } from "@/lib/api-auth";
import { AI_TASKS } from "@/lib/ai/tasks";
import { NoFallbackAvailableError, runAiTask } from "@/lib/ai/run";
import type { AiJob, AiTaskId } from "@/types";

/**
 * A generic single-step "job" wrapper over runAiTask (plan §9.6). Vercel Hobby
 * has no background workers, so a "job" here is a synchronous request whose
 * progress is written to Firestore as it goes and whose doc the client
 * subscribes to directly — this is enough for today's one real long-task
 * consumer (group.synthesis over several papers); the `steps` array is ready
 * for a genuinely multi-step task once Phase 5 needs one.
 */
export async function POST(request: Request) {
  const auth = await verifyActiveUser(request);
  if ("error" in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const task = body?.task as AiTaskId | undefined;
  if (!task || !(task in AI_TASKS)) {
    return NextResponse.json({ error: `Unknown task. Expected one of: ${Object.keys(AI_TASKS).join(", ")}` }, { status: 400 });
  }

  const jobsRef = adminDb().collection("users").doc(auth.uid).collection("aiJobs");
  const jobRef = jobsRef.doc();
  const startedAt = new Date().toISOString();
  const baseJob: Omit<AiJob, "id"> = {
    task,
    refId: body?.refId,
    status: "running",
    steps: [{ name: "generate", status: "running" }],
    startedAt,
    updatedAt: startedAt
  };
  await jobRef.set(baseJob);

  try {
    const result = await runAiTask(auth.uid, task, body?.payload);
    await jobRef.set(
      {
        status: "done",
        steps: [{ name: "generate", status: "done", output: result.output }],
        provider: result.meta.provider,
        output: result.output,
        updatedAt: new Date().toISOString()
      },
      { merge: true }
    );
    return NextResponse.json({ jobId: jobRef.id });
  } catch (error) {
    const message = error instanceof NoFallbackAvailableError || error instanceof Error ? error.message : "AI job failed.";
    await jobRef.set({ status: "failed", steps: [{ name: "generate", status: "failed" }], error: message, updatedAt: new Date().toISOString() }, { merge: true });
    return NextResponse.json({ jobId: jobRef.id, error: message }, { status: error instanceof NoFallbackAvailableError ? 503 : 500 });
  }
}
