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

/**
 * Mirrors pdfjs-dist's outline node shape loosely (not re-exported from its public
 * entrypoint, matching the pragmatic local-interface approach lib/pdf-annotate.ts
 * already uses for `PdfTextItem`). `dest` is either an explicit destination array
 * (`[ref, ...]`) or a named destination string that needs `doc.getDestination`
 * to resolve — both forms occur in the wild.
 */
interface RawOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: RawOutlineNode[];
}

export interface OutlineNode {
  title: string;
  /** 1-based page number, or null when the destination couldn't be resolved (rare, but not worth failing the whole outline over). */
  page: number | null;
  items: OutlineNode[];
}

/**
 * Same underlying data as `extractPdfOutline`, but keeping each node's page
 * destination and nesting instead of flattening to titles only — what the
 * reading window's Outline sidebar tab (plan/12.FocusOS-v2-Paper-Reading-Window-Plan.md §7)
 * needs to render a clickable, jump-to-page tree. Kept as a separate export
 * rather than changing `extractPdfOutline`'s signature so paper-pass-section.tsx's
 * existing `string[]` call site keeps working unchanged.
 */
export async function extractPdfOutlineTree(url: string): Promise<OutlineNode[]> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();

  const loadingTask = pdfjsLib.getDocument({ url });
  try {
    const doc = await loadingTask.promise;
    const outline = (await doc.getOutline()) as RawOutlineNode[] | null;
    if (!outline || outline.length === 0) return [];

    async function resolvePage(dest: RawOutlineNode["dest"]): Promise<number | null> {
      if (!dest) return null;
      try {
        const explicitDest = typeof dest === "string" ? await doc.getDestination(dest) : dest;
        const ref = explicitDest?.[0];
        if (!ref) return null;
        return (await doc.getPageIndex(ref)) + 1;
      } catch {
        return null;
      }
    }

    async function resolveNodes(nodes: RawOutlineNode[]): Promise<OutlineNode[]> {
      const resolved: OutlineNode[] = [];
      for (const node of nodes) {
        resolved.push({
          title: node.title,
          page: await resolvePage(node.dest),
          items: node.items?.length ? await resolveNodes(node.items) : []
        });
      }
      return resolved;
    }

    return await resolveNodes(outline);
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
