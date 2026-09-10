import { adminDb } from "@/lib/firebase-admin";
import { uploadPdfToAnthropic } from "@/lib/ai/anthropic-files";
import type { FileRef, Paper } from "@/types";

export async function getPaperForUser(uid: string, paperId: string): Promise<Paper | null> {
  const snapshot = await adminDb().collection("users").doc(uid).collection("papers").doc(paperId).get();
  return snapshot.exists ? ({ id: snapshot.id, ...snapshot.data() } as Paper) : null;
}

export async function getPaperNoteBodies(uid: string, paperId: string): Promise<string[]> {
  const snapshot = await adminDb().collection("users").doc(uid).collection("papers").doc(paperId).collection("notes").get();
  return snapshot.docs.map((doc) => doc.data().body as string).filter(Boolean);
}

/**
 * Uploads the paper's attached PDF to Anthropic's Files API once and caches
 * the resulting `file_id` on the paper doc (plan §8.6) — every later
 * paper.layeredNotes/paper.highlightCandidates call reuses it instead of
 * re-uploading the bytes.
 */
export async function ensureAnthropicFileId(uid: string, paper: Paper): Promise<string> {
  if (paper.anthropicFileId) return paper.anthropicFileId;
  if (!paper.fileId) throw new Error("This paper has no attached PDF yet — attach one first.");

  const fileDoc = await adminDb().collection("users").doc(uid).collection("files").doc(paper.fileId).get();
  if (!fileDoc.exists) throw new Error("The attached PDF's file record is missing.");
  const file = fileDoc.data() as FileRef;

  const anthropicFileId = await uploadPdfToAnthropic(file.url, `${paper.title || "paper"}.pdf`);
  await adminDb()
    .collection("users")
    .doc(uid)
    .collection("papers")
    .doc(paper.id)
    .set({ anthropicFileId, updatedAt: new Date().toISOString() }, { merge: true });
  return anthropicFileId;
}
