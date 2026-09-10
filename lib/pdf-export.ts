"use client";

import { PDFDocument, PDFString } from "pdf-lib";
import type { Annotation, HighlightCategory } from "@/types";

/**
 * Real PDF `/Subtype /Highlight` markup annotations (plan §8.7 step 7) — not
 * drawn rectangles baked into the page content, so Acrobat/Preview render them
 * as native, removable/editable highlights with their note in the popup.
 * pdf-lib has no high-level "add highlight" helper, so this builds the
 * annotation dictionary directly via its low-level object API.
 */

const CATEGORY_COLORS: Record<HighlightCategory, [number, number, number]> = {
  claim: [1, 0.92, 0.4],
  method: [0.6, 0.85, 1],
  result: [0.65, 0.95, 0.65],
  limitation: [1, 0.7, 0.7],
  definition: [0.85, 0.75, 1],
  weakness: [1, 0.8, 0.5]
};

export async function buildAnnotatedPdfBytes(pdfBytes: ArrayBuffer, annotations: Annotation[]): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const context = pdfDoc.context;

  for (const annotation of annotations) {
    if (!annotation.matched || !annotation.page || !annotation.quads || annotation.quads.length === 0) continue;
    const page = pdfDoc.getPage(annotation.page - 1);
    if (!page) continue;

    const color = CATEGORY_COLORS[annotation.category] ?? [1, 1, 0.4];
    const quadPoints = annotation.quads.flatMap((quad) => {
      const x1 = quad.x;
      const x2 = quad.x + quad.width;
      const yTop = quad.y + quad.height;
      const yBottom = quad.y;
      // PDF QuadPoints order per quad: top-left, top-right, bottom-left, bottom-right.
      return [x1, yTop, x2, yTop, x1, yBottom, x2, yBottom];
    });
    const minX = Math.min(...annotation.quads.map((q) => q.x));
    const minY = Math.min(...annotation.quads.map((q) => q.y));
    const maxX = Math.max(...annotation.quads.map((q) => q.x + q.width));
    const maxY = Math.max(...annotation.quads.map((q) => q.y + q.height));

    const annotDict = context.obj({
      Type: "Annot",
      Subtype: "Highlight",
      Rect: [minX, minY, maxX, maxY],
      QuadPoints: quadPoints,
      C: color,
      CA: 0.45,
      Contents: PDFString.of(annotation.note ?? annotation.quote),
      T: PDFString.of("FocusOS")
    });
    const annotRef = context.register(annotDict);
    page.node.addAnnot(annotRef);
  }

  return pdfDoc.save();
}

export function downloadPdfBytes(bytes: Uint8Array, filename: string) {
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
