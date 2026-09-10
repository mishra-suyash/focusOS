"use client";

import type { HighlightCandidate, HighlightQuad, NewAnnotation } from "@/types";

/**
 * The PDF-annotation matching pipeline (plan §8.7): render each page's text
 * layer with pdf.js, normalize it into one searchable string per page, find
 * each AI-returned quote in it (exact first, then a bounded fuzzy match), and
 * map the matched character range back to on-page rects. This is deliberately
 * an approximation, not typographically exact — the plan itself expects
 * 5-15% of quotes to fail matching (rewrapped text, math, tables), which is
 * why unmatched candidates are returned separately rather than dropped.
 */

const LIGATURES: Record<string, string> = { "ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff", "ﬃ": "ffi", "ﬄ": "ffl" };

function foldLigaturesAndHyphens(text: string): string {
  let result = text;
  for (const [ligature, plain] of Object.entries(LIGATURES)) result = result.split(ligature).join(plain);
  return result.replace(/­/g, ""); // strip soft hyphens
}

/**
 * Mirrors pdfjs-dist's `TextItem` shape (not re-exported from its public
 * entrypoint, so declared locally rather than reaching into an internal path).
 * `transform`/`width`/`height` are in the PDF's base, unscaled user-space
 * coordinates regardless of any render viewport — exactly why they're safe to
 * store directly and convert per-viewport later via `convertToViewportRectangle`.
 */
export interface PdfTextItem {
  str: string;
  hasEOL: boolean;
  transform: number[];
  width: number;
  height: number;
}

export interface ItemRange {
  itemIndex: number;
  lineIndex: number;
  start: number;
  end: number;
}

export interface PageTextIndex {
  page: number;
  text: string;
  ranges: ItemRange[];
  items: PdfTextItem[];
}

/**
 * Concatenates a page's text items into one reading-order string, dehyphenating
 * a line-final "-" and joining directly to the next item, and inserting a
 * single space at every other item boundary. This occasionally introduces a
 * spurious space mid-word (when pdf.js splits a word across items with no real
 * space between them) — the fuzzy-match pass absorbs that noise; exact matches
 * simply skip those rare quotes and fall through to it.
 */
function buildPageIndex(page: number, items: PdfTextItem[]): PageTextIndex {
  let text = "";
  const ranges: ItemRange[] = [];
  let lineIndex = 0;

  items.forEach((item, itemIndex) => {
    if (!item.str) return;
    const piece = foldLigaturesAndHyphens(item.str);
    const start = text.length;
    text += piece;
    ranges.push({ itemIndex, lineIndex, start, end: text.length });

    if (item.hasEOL) {
      if (text.endsWith("-")) {
        text = text.slice(0, -1);
        ranges[ranges.length - 1].end -= 1;
      } else {
        text += " ";
      }
      lineIndex += 1;
    } else {
      text += " ";
    }
  });

  return { page, text, ranges, items };
}

/** A loaded pdf.js document proxy — typed loosely (dynamic import + a fast-moving internal API) rather than fighting pdfjs-dist's type exports, matching lib/pdf-outline.ts's existing pragmatic approach. */
type PdfjsModule = typeof import("pdfjs-dist");
export type PdfDocumentProxy = Awaited<ReturnType<PdfjsModule["getDocument"]>["promise"]>;

/** `destroy` releases the underlying loading task — callers that keep `doc` around across page navigations (the annotation viewer) should call it once on unmount; one-shot callers (buildDocumentTextIndex) call it immediately after use. */
export async function loadPdfDocument(pdfUrl: string): Promise<{ doc: PdfDocumentProxy; destroy: () => Promise<void> }> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();
  const loadingTask = pdfjsLib.getDocument({ url: pdfUrl });
  const doc = await loadingTask.promise;
  return { doc, destroy: () => loadingTask.destroy() };
}

export async function getPageTextIndex(doc: PdfDocumentProxy, pageNum: number): Promise<PageTextIndex> {
  const page = await doc.getPage(pageNum);
  const content = await page.getTextContent();
  const items = content.items as unknown as PdfTextItem[];
  return buildPageIndex(pageNum, items);
}

export async function buildDocumentTextIndex(pdfUrl: string): Promise<PageTextIndex[]> {
  const { doc, destroy } = await loadPdfDocument(pdfUrl);
  try {
    const pages: PageTextIndex[] = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
      pages.push(await getPageTextIndex(doc, pageNum));
    }
    return pages;
  } finally {
    await destroy();
  }
}

function normalizeForMatch(text: string): string {
  return foldLigaturesAndHyphens(text)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = current;
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length, 1);
}

/** Distinctive anchor words (>=5 chars, alphabetic) used to cheaply narrow down candidate positions before running Levenshtein — without this, a full sliding-window fuzzy search is far too slow to run synchronously in a browser tab. */
function anchorWords(normalizedQuote: string): string[] {
  const words = normalizedQuote.match(/[a-z]{5,}/g) ?? [];
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 4);
}

interface MatchResult {
  pageIndex: number;
  start: number;
  end: number;
  exact: boolean;
  score: number;
}

const FUZZY_THRESHOLD = 0.9;

function findQuoteInDocument(pages: { normalizedText: string; index: PageTextIndex }[], quote: string): MatchResult | null {
  const normalizedQuote = normalizeForMatch(quote);
  if (!normalizedQuote) return null;

  // Exact pass, cheapest — try every page.
  for (const { normalizedText, index } of pages) {
    const at = normalizedText.indexOf(normalizedQuote);
    if (at !== -1) return { pageIndex: index.page, start: at, end: at + normalizedQuote.length, exact: true, score: 1 };
  }

  // Fuzzy pass: use the quote's distinctive words as anchors so we only run
  // Levenshtein around plausible positions, not a full sliding window.
  const anchors = anchorWords(normalizedQuote);
  if (anchors.length === 0) return null;

  let best: MatchResult | null = null;
  for (const { normalizedText, index } of pages) {
    for (const anchor of anchors) {
      let searchFrom = 0;
      for (;;) {
        const anchorAt = normalizedText.indexOf(anchor, searchFrom);
        if (anchorAt === -1) break;
        searchFrom = anchorAt + 1;

        // Try a window roughly centered so the anchor sits where it does within the quote.
        const anchorOffsetInQuote = normalizedQuote.indexOf(anchor);
        const windowStart = Math.max(0, anchorAt - anchorOffsetInQuote - 10);
        for (const lengthFactor of [0.9, 1, 1.1]) {
          const windowLength = Math.round(normalizedQuote.length * lengthFactor);
          const windowEnd = Math.min(normalizedText.length, windowStart + windowLength);
          const window = normalizedText.slice(windowStart, windowEnd);
          const score = similarity(normalizedQuote, window);
          if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) {
            best = { pageIndex: index.page, start: windowStart, end: windowEnd, exact: false, score };
          }
        }
      }
    }
  }

  return best;
}

function rangesOverlapping(ranges: ItemRange[], start: number, end: number): ItemRange[] {
  return ranges.filter((range) => range.start < end && range.end > start);
}

export function quadFromItem(item: PdfTextItem): HighlightQuad {
  // transform[4]/[5] are the item's origin in unscaled PDF user space (points,
  // y-up, origin bottom-left); width/height approximate its glyph box. This is
  // a deliberate approximation — exact sub-glyph cropping at a quote's partial
  // boundary items isn't attempted, matching items are included in full.
  return { x: item.transform[4], y: item.transform[5], width: item.width, height: item.height };
}

export function mergeQuadsByLine(matchedRanges: ItemRange[], items: PdfTextItem[]): HighlightQuad[] {
  const byLine = new Map<number, ItemRange[]>();
  matchedRanges.forEach((range) => {
    const bucket = byLine.get(range.lineIndex) ?? [];
    bucket.push(range);
    byLine.set(range.lineIndex, bucket);
  });

  return Array.from(byLine.values()).map((rangesInLine) => {
    const quads = rangesInLine.map((range) => quadFromItem(items[range.itemIndex]));
    const x = Math.min(...quads.map((q) => q.x));
    const y = Math.min(...quads.map((q) => q.y));
    const right = Math.max(...quads.map((q) => q.x + q.width));
    const top = Math.max(...quads.map((q) => q.y + q.height));
    return { x, y, width: right - x, height: top - y };
  });
}

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Converts a stored PDF-space quad into on-screen CSS pixels for the current viewport — this version of pdf.js exposes only point-level `convertToViewportPoint`, not a rectangle helper, so both corners are converted and re-sorted (the Y axis flips between PDF's bottom-left origin and the DOM's top-left one). */
export function pdfRectToViewport(viewport: { convertToViewportPoint: (x: number, y: number) => number[] }, quad: HighlightQuad): ViewportRect {
  const [x1, y1] = viewport.convertToViewportPoint(quad.x, quad.y);
  const [x2, y2] = viewport.convertToViewportPoint(quad.x + quad.width, quad.y + quad.height);
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

export interface MatchHighlightsResult {
  matched: NewAnnotation[];
  unmatched: HighlightCandidate[];
}

export function matchHighlightCandidates(pages: PageTextIndex[], candidates: HighlightCandidate[]): MatchHighlightsResult {
  const normalizedPages = pages.map((index) => ({ normalizedText: normalizeForMatch(index.text), index }));

  const matched: NewAnnotation[] = [];
  const unmatched: HighlightCandidate[] = [];

  for (const candidate of candidates) {
    const result = findQuoteInDocument(normalizedPages, candidate.quote);
    if (!result) {
      unmatched.push(candidate);
      continue;
    }
    const pageIndex = pages.find((p) => p.page === result.pageIndex)!;
    const overlapping = rangesOverlapping(pageIndex.ranges, result.start, result.end);
    if (overlapping.length === 0) {
      unmatched.push(candidate);
      continue;
    }
    const quads = mergeQuadsByLine(overlapping, pageIndex.items);
    matched.push({
      page: result.pageIndex,
      quads,
      quote: candidate.quote,
      category: candidate.category,
      note: candidate.note,
      layer: candidate.layer,
      source: "ai",
      matched: true
    });
  }

  return { matched, unmatched };
}

export { normalizeForMatch };
