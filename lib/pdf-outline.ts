"use client";

/**
 * Client-side PDF outline extraction for the Pass 3 structure-recall gate
 * (§8.2 of the plan): "the actual structure ... extracted client-side from
 * the PDF outline or heading text". This only reads the PDF's bookmark
 * outline — it does not attempt heading detection from raw text, which needs
 * the fuzzy-matching pipeline Phase 5's annotation work builds. A paper with
 * no outline (most papers) returns an empty array, and the UI falls back to
 * asking you to type the actual structure yourself.
 */
export async function extractPdfOutline(url: string): Promise<string[]> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();

  const loadingTask = pdfjsLib.getDocument({ url });
  try {
    const doc = await loadingTask.promise;
    const outline = await doc.getOutline();
    if (!outline || outline.length === 0) return [];
    return outline.map((item) => item.title).filter(Boolean);
  } finally {
    await loadingTask.destroy();
  }
}

/** True when the PDF has no extractable text layer at all — used to disable annotation-dependent features with an explicit message rather than producing garbage. */
export async function hasTextLayer(url: string): Promise<boolean> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();

  const loadingTask = pdfjsLib.getDocument({ url });
  try {
    const doc = await loadingTask.promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    return content.items.length > 0;
  } finally {
    await loadingTask.destroy();
  }
}
