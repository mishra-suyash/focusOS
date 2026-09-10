import { NextResponse } from "next/server";
import { verifyActiveUser } from "@/lib/api-auth";
import { ensureAnthropicFileId, getPaperForUser, getPaperNoteBodies } from "@/lib/admin-papers";
import { NoFallbackAvailableError, runAiTask } from "@/lib/ai/run";
import type { LayeredNotesPayload } from "@/lib/ai/tasks";
import type { LayeredNotesOutput } from "@/lib/ai/schemas";
import { adminDb } from "@/lib/firebase-admin";
import type { Pass1Output, Pass2Output } from "@/types";

function summarizePass1(output: Pass1Output | undefined): string | undefined {
  if (!output) return undefined;
  return [output.context, output.correctness, ...output.contributions].filter(Boolean).join(" ") || undefined;
}

function summarizePass2(output: Pass2Output | undefined): string | undefined {
  return output?.summary;
}

export async function POST(request: Request, { params }: { params: Promise<{ paperId: string }> }) {
  const auth = await verifyActiveUser(request);
  if ("error" in auth) return auth.error;

  const { paperId } = await params;
  const paper = await getPaperForUser(auth.uid, paperId);
  if (!paper) return NextResponse.json({ error: "Paper not found." }, { status: 404 });
  if (!paper.fileId) return NextResponse.json({ error: "Attach a PDF to this paper first." }, { status: 400 });

  try {
    const fileId = await ensureAnthropicFileId(auth.uid, paper);
    const notes = await getPaperNoteBodies(auth.uid, paperId);

    const payload: LayeredNotesPayload = {
      fileId,
      title: paper.title,
      goal: paper.goal,
      notes,
      pass1Summary: summarizePass1(paper.pass1?.output as Pass1Output | undefined),
      pass2Summary: summarizePass2(paper.pass2?.output as Pass2Output | undefined)
    };

    const { output, meta } = await runAiTask(auth.uid, "paper.layeredNotes", payload);
    const result = output as LayeredNotesOutput;

    const layeredNotes = {
      ...result,
      version: (paper.layeredNotes?.version ?? 0) + 1,
      generatedAt: new Date().toISOString(),
      provider: meta.provider,
      model: meta.model
    };

    await adminDb().collection("users").doc(auth.uid).collection("papers").doc(paperId).set({ layeredNotes, updatedAt: new Date().toISOString() }, { merge: true });

    return NextResponse.json({ layeredNotes });
  } catch (error) {
    if (error instanceof NoFallbackAvailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to generate layered notes." }, { status: 500 });
  }
}
