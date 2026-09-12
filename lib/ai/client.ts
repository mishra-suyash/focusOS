"use client";

import type { AiJob, AiProvider, AiTaskId, HighlightCandidate, LayeredNotes } from "@/types";
import type { GenerateDayTemplateOutput } from "@/lib/ai/schemas";
import type { GenerateDayTemplatePayload } from "@/lib/ai/tasks";

export interface AiTaskCallResult<Output> {
  output: Output;
  meta: { provider: AiProvider; model?: string; degraded: boolean; reason?: string };
}

/** Thin fetch wrapper shared by every client component that calls an AI task — handles the ID-token header and error unwrapping once. */
export async function callAiTask<Output>(user: { getIdToken: () => Promise<string> }, task: AiTaskId, payload: unknown): Promise<AiTaskCallResult<Output>> {
  const token = await user.getIdToken();
  const response = await fetch("/api/ai/run", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ task, payload })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "AI request failed.");
  return body as AiTaskCallResult<Output>;
}

export async function startAiJob(user: { getIdToken: () => Promise<string> }, task: AiTaskId, payload: unknown, refId?: string): Promise<string> {
  const token = await user.getIdToken();
  const response = await fetch("/api/ai/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ task, payload, refId })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "AI job failed to start.");
  return body.jobId as string;
}

/**
 * paper.layeredNotes and paper.highlightCandidates go through their own
 * paperId-scoped routes rather than the generic /api/ai/run — resolving the
 * Anthropic file_id needs the Admin SDK (to read the paper's attached file
 * and cache the result), which the client can't do itself.
 */
export async function generateLayeredNotes(user: { getIdToken: () => Promise<string> }, paperId: string): Promise<LayeredNotes> {
  const token = await user.getIdToken();
  const response = await fetch(`/api/ai/papers/${paperId}/layered-notes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Failed to generate layered notes.");
  return body.layeredNotes as LayeredNotes;
}

export async function generateHighlightCandidates(user: { getIdToken: () => Promise<string> }, paperId: string): Promise<HighlightCandidate[]> {
  const token = await user.getIdToken();
  const response = await fetch(`/api/ai/papers/${paperId}/highlights`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Failed to generate highlight candidates.");
  return body.quotes as HighlightCandidate[];
}

/**
 * plan/FocusOS-v2-Routine-Blocks-and-AI-Templates.md §3.2 — no dedicated route: unlike
 * layeredNotes/highlightCandidates, this task never touches a file, so the generic
 * `callAiTask`/`/api/ai/run` already covers it.
 */
export async function generateDayTemplate(
  user: { getIdToken: () => Promise<string> },
  payload: GenerateDayTemplatePayload
): Promise<AiTaskCallResult<GenerateDayTemplateOutput>> {
  return callAiTask<GenerateDayTemplateOutput>(user, "plan.generateDayTemplate", payload);
}

export type { AiJob };
