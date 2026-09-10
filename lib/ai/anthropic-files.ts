import Anthropic, { toFile } from "@anthropic-ai/sdk";

/**
 * Uploads a PDF (already sitting in Vercel Blob) to Anthropic's Files API once,
 * so later calls reference it by `file_id` instead of re-encoding the bytes
 * into every request (plan §2.3, §8.6). No `expires_after` is set, so the file
 * persists until explicitly deleted — matching the caching intent of
 * `Paper.anthropicFileId`. This is Claude-only: Gemini/Ollama have no
 * equivalent file-reference mechanism (see lib/ai/tasks.ts's
 * `requiresAnthropicFile` flag).
 */
export async function uploadPdfToAnthropic(pdfUrl: string, filename: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set — this feature needs Claude specifically, there's no Gemini/Ollama equivalent.");
  }

  const response = await fetch(pdfUrl);
  if (!response.ok) throw new Error(`Failed to fetch the PDF for upload (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());

  const client = new Anthropic({ apiKey });
  const file = await client.files.upload({ file: await toFile(bytes, filename, { type: "application/pdf" }) });
  return file.id;
}
