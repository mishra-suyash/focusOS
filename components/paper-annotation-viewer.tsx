"use client";

import { ChevronLeft, ChevronRight, Download, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { generateHighlightCandidates } from "@/lib/ai/client";
import { createAnnotation, createAnnotationsBatch, deleteAnnotation, subscribeAnnotations } from "@/lib/firestore";
import { hasTextLayer } from "@/lib/pdf-outline";
import { buildAnnotatedPdfBytes, downloadPdfBytes } from "@/lib/pdf-export";
import {
  buildDocumentTextIndex,
  getPageTextIndex,
  loadPdfDocument,
  matchHighlightCandidates,
  mergeQuadsByLine,
  pdfRectToViewport,
  type ItemRange,
  type PageTextIndex,
  type PdfDocumentProxy
} from "@/lib/pdf-annotate";
import type { Annotation, HighlightCategory, NewAnnotation } from "@/types";

const CATEGORY_COLORS: Record<HighlightCategory, string> = {
  claim: "rgba(250, 204, 21, 0.4)",
  method: "rgba(56, 189, 248, 0.35)",
  result: "rgba(74, 222, 128, 0.35)",
  limitation: "rgba(251, 113, 133, 0.35)",
  definition: "rgba(196, 181, 253, 0.4)",
  weakness: "rgba(251, 146, 60, 0.4)"
};

const CATEGORIES: HighlightCategory[] = ["claim", "method", "result", "limitation", "definition", "weakness"];

interface PendingSelection {
  quote: string;
  ranges: ItemRange[];
}

export function PaperAnnotationViewer({ paperId, title, pdfUrl }: { paperId: string; title: string; pdfUrl: string }) {
  const { user } = useAuth();
  const [textLayerOk, setTextLayerOk] = useState<boolean | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(1);
  const [pageIndex, setPageIndex] = useState<PageTextIndex | null>(null);
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [pendingCategory, setPendingCategory] = useState<HighlightCategory>("claim");
  const [pendingNote, setPendingNote] = useState("");
  const [viewport, setViewport] = useState<{ convertToViewportPoint: (x: number, y: number) => number[] } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PdfDocumentProxy | null>(null);
  const destroyRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!user) return;
    return subscribeAnnotations(user.uid, paperId, setAnnotations);
  }, [user, paperId]);

  useEffect(() => {
    let cancelled = false;
    hasTextLayer(pdfUrl)
      .then((ok) => !cancelled && setTextLayerOk(ok))
      .catch(() => !cancelled && setTextLayerOk(false));
    return () => {
      cancelled = true;
    };
  }, [pdfUrl]);

  const renderPage = useCallback(
    async (num: number) => {
      try {
        if (!docRef.current) {
          const { doc, destroy } = await loadPdfDocument(pdfUrl);
          docRef.current = doc;
          destroyRef.current = destroy;
          setNumPages(doc.numPages);
        }
        const doc = docRef.current;
        const page = await doc.getPage(num);
        const pageViewport = page.getViewport({ scale: 1.4 });
        setViewport(pageViewport);

        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = pageViewport.width;
        canvas.height = pageViewport.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        await page.render({ canvasContext: ctx, viewport: pageViewport, canvas }).promise;

        setPageIndex(await getPageTextIndex(doc, num));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to render page.");
      }
    },
    [pdfUrl]
  );

  useEffect(() => {
    if (textLayerOk) renderPage(pageNum);
  }, [pageNum, textLayerOk, renderPage]);

  useEffect(
    () => () => {
      destroyRef.current?.();
    },
    []
  );

  function handleMouseUp() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !pageIndex) return;
    const text = selection.toString().trim();
    if (text.length < 6) return;

    const range = selection.getRangeAt(0);
    const overlay = overlayRef.current;
    if (!overlay) return;
    const spans = Array.from(overlay.querySelectorAll<HTMLElement>("[data-item-index]"));
    const touchedIndices = new Set(
      spans.filter((span) => range.intersectsNode(span)).map((span) => Number(span.dataset.itemIndex))
    );
    const touchedRanges = pageIndex.ranges.filter((r) => touchedIndices.has(r.itemIndex));
    if (touchedRanges.length === 0) return;

    setPending({ quote: text, ranges: touchedRanges });
    setPendingCategory("claim");
    setPendingNote("");
  }

  async function saveManualHighlight() {
    if (!user || !pending || !pageIndex) return;
    const quads = mergeQuadsByLine(pending.ranges, pageIndex.items);
    await createAnnotation(user.uid, paperId, {
      page: pageNum,
      quads,
      quote: pending.quote,
      category: pendingCategory,
      note: pendingNote || undefined,
      source: "manual",
      matched: true
    });
    setPending(null);
    window.getSelection()?.removeAllRanges();
  }

  async function generateHighlights() {
    if (!user) return;
    setGenerating(true);
    setError("");
    try {
      const candidates = await generateHighlightCandidates(user, paperId);
      const pages = await buildDocumentTextIndex(pdfUrl);
      const { matched, unmatched } = matchHighlightCandidates(pages, candidates);
      const unmatchedAsAnnotations: NewAnnotation[] = unmatched.map((c) => ({
        quote: c.quote,
        category: c.category,
        note: c.note,
        layer: c.layer,
        source: "ai",
        matched: false
      }));
      await createAnnotationsBatch(user.uid, paperId, [...matched, ...unmatchedAsAnnotations]);
      if (matched.length === 0 && unmatched.length > 0) {
        setError(`Found ${unmatched.length} candidate quote(s), but none matched the extracted PDF text — see the sidebar.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate highlights.");
    } finally {
      setGenerating(false);
    }
  }

  async function exportPdf() {
    setExporting(true);
    setError("");
    try {
      const response = await fetch(pdfUrl);
      const bytes = await response.arrayBuffer();
      const outBytes = await buildAnnotatedPdfBytes(bytes, annotations.filter((a) => a.matched));
      downloadPdfBytes(outBytes, `${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "paper"}-annotated.pdf`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export PDF.");
    } finally {
      setExporting(false);
    }
  }

  async function removeAnnotation(id: string) {
    if (!user) return;
    await deleteAnnotation(user.uid, paperId, id);
  }

  if (textLayerOk === null) return <p className="text-sm text-ink-500">Checking PDF for extractable text...</p>;
  if (!textLayerOk) {
    return (
      <div className="card p-4 text-sm text-ink-600 dark:text-ink-300">
        This PDF has no extractable text layer (it looks scanned) — highlighting isn&apos;t available for it. OCR is out of scope.
      </div>
    );
  }

  const pageAnnotations = annotations.filter((a) => a.matched && a.page === pageNum);
  const unmatched = annotations.filter((a) => !a.matched);

  return (
    <div className="space-y-3">
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-secondary" onClick={generateHighlights} disabled={generating}>
          <Sparkles className="h-3.5 w-3.5" />
          {generating ? "Finding quotes..." : "Generate highlights"}
        </button>
        <button className="btn-secondary" onClick={exportPdf} disabled={exporting || annotations.every((a) => !a.matched)}>
          <Download className="h-3.5 w-3.5" />
          {exporting ? "Exporting..." : "Export annotated PDF"}
        </button>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <button className="btn-secondary px-2" onClick={() => setPageNum((n) => Math.max(1, n - 1))} disabled={pageNum <= 1} aria-label="Previous page">
            <ChevronLeft className="h-4 w-4" />
          </button>
          Page {pageNum} of {numPages}
          <button className="btn-secondary px-2" onClick={() => setPageNum((n) => Math.min(numPages, n + 1))} disabled={pageNum >= numPages} aria-label="Next page">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="relative inline-block max-w-full overflow-auto border border-ink-200 dark:border-ink-800" onMouseUp={handleMouseUp}>
          <canvas ref={canvasRef} className="block" />
          <div ref={overlayRef} className="absolute inset-0">
            {pageIndex?.items.map((item, itemIndex) => {
              if (!item.str.trim() || !viewport) return null;
              const rect = pdfRectToViewport(viewport, {
                x: item.transform[4],
                y: item.transform[5],
                width: item.width,
                height: item.height
              });
              return (
                <span
                  key={itemIndex}
                  data-item-index={itemIndex}
                  style={{
                    position: "absolute",
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                    fontSize: rect.height,
                    lineHeight: 1,
                    color: "transparent",
                    whiteSpace: "pre",
                    cursor: "text",
                    userSelect: "text"
                  }}
                >
                  {item.str}
                </span>
              );
            })}
            {pageAnnotations.map((annotation) =>
              (annotation.quads ?? []).map((quad, i) => {
                if (!viewport) return null;
                const rect = pdfRectToViewport(viewport, quad);
                return (
                  <div
                    key={`${annotation.id}-${i}`}
                    title={annotation.note || annotation.quote}
                    style={{
                      position: "absolute",
                      left: rect.left,
                      top: rect.top,
                      width: rect.width,
                      height: rect.height,
                      background: CATEGORY_COLORS[annotation.category],
                      pointerEvents: "none"
                    }}
                  />
                );
              })
            )}
          </div>

          {pending ? (
            <div className="absolute bottom-2 left-2 right-2 z-10 space-y-2 rounded-md border border-ink-200 bg-white p-3 text-sm shadow-soft dark:border-ink-700 dark:bg-ink-900">
              <p className="line-clamp-2 text-xs text-ink-500">&ldquo;{pending.quote}&rdquo;</p>
              <div className="flex flex-wrap items-center gap-2">
                <select className="input py-1 text-xs" value={pendingCategory} onChange={(e) => setPendingCategory(e.target.value as HighlightCategory)}>
                  {CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
                <input
                  className="input flex-1 py-1 text-xs"
                  placeholder="Note (optional)"
                  value={pendingNote}
                  onChange={(e) => setPendingNote(e.target.value)}
                />
                <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setPending(null)}>
                  Cancel
                </button>
                <button className="btn-primary px-2 py-1 text-xs" onClick={saveManualHighlight}>
                  Save highlight
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <aside className="w-full space-y-2 lg:w-64">
          <p className="label">This page&apos;s highlights</p>
          {pageAnnotations.length === 0 ? <p className="text-xs text-ink-500">None yet — select text to add one, or generate highlights above.</p> : null}
          {pageAnnotations.map((annotation) => (
            <div key={annotation.id} className="card space-y-1 p-2 text-xs">
              <p className="font-medium capitalize">{annotation.category}</p>
              <p className="text-ink-500">{annotation.note || annotation.quote}</p>
              <button className="text-red-600 hover:underline dark:text-red-400" onClick={() => removeAnnotation(annotation.id)}>
                <Trash2 className="mr-1 inline h-3 w-3" />
                Remove
              </button>
            </div>
          ))}

          {unmatched.length > 0 ? (
            <>
              <p className="label pt-2">Unmatched AI quotes</p>
              {unmatched.map((annotation) => (
                <div key={annotation.id} className="card space-y-1 border-dashed p-2 text-xs">
                  <p className="font-medium capitalize">{annotation.category}</p>
                  <p className="text-ink-500">&ldquo;{annotation.quote}&rdquo;</p>
                  <p className="text-ink-400">Couldn&apos;t locate this in the extracted text — add it manually if you spot it.</p>
                  <button className="text-red-600 hover:underline dark:text-red-400" onClick={() => removeAnnotation(annotation.id)}>
                    <Trash2 className="mr-1 inline h-3 w-3" />
                    Remove
                  </button>
                </div>
              ))}
            </>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
