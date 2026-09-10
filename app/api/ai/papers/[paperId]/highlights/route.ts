import { NextResponse } from "next/server";
import { verifyActiveUser } from "@/lib/api-auth";
import { ensureAnthropicFileId, getPaperForUser } from "@/lib/admin-papers";
import { NoFallbackAvailableError, runAiTask } from "@/lib/ai/run";
import type { HighlightCandidatesPayload } from "@/lib/ai/tasks";
import type { HighlightCandidatesOutput } from "@/lib/ai/schemas";

/**
 * Returns raw quote candidates only — matching them against the rendered PDF
 * (lib/pdf-annotate.ts) and persisting Annotation docs both happen client-side,
 * since that's where pdf.js's rendered text layer lives.
 */
export async function POST(request: Request, { params }: { params: Promise<{ paperId: string }> }) {
  const auth = await verifyActiveUser(request);
  if ("error" in auth) return auth.error;

  const { paperId } = await params;
  const paper = await getPaperForUser(auth.uid, paperId);
  if (!paper) return NextResponse.json({ error: "Paper not found." }, { status: 404 });
  if (!paper.fileId) return NextResponse.json({ error: "Attach a PDF to this paper first." }, { status: 400 });

  try {
    const fileId = await ensureAnthropicFileId(auth.uid, paper);
    const payload: HighlightCandidatesPayload = { fileId, title: paper.title };
    const { output } = await runAiTask(auth.uid, "paper.highlightCandidates", payload);
    return NextResponse.json({ quotes: (output as HighlightCandidatesOutput).quotes });
  } catch (error) {
    if (error instanceof NoFallbackAvailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to generate highlight candidates." }, { status: 500 });
  }
}
