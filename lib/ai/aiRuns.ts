import { adminDb } from "@/lib/firebase-admin";
import type { AiProvider, AiTaskId } from "@/types";

export interface AiRunLog {
  task: AiTaskId;
  provider: AiProvider;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
}

/** users/{uid}/aiRuns/{runId} — an audit entry for every provider attempt, success or failure (plan §9.1: "every run is logged"). */
export async function logAiRun(uid: string, log: AiRunLog): Promise<void> {
  await adminDb()
    .collection("users")
    .doc(uid)
    .collection("aiRuns")
    .add({ ...log, at: new Date().toISOString() });
}
