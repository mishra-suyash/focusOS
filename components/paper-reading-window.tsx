"use client";

import {
  ChevronLeft,
  ChevronRight,
  Download,
  Hand,
  HelpCircle,
  List,
  MousePointer2,
  PanelRight,
  Search,
  Sparkles,
  StickyNote,
  Trash2,
  X
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { PassTimer } from "@/components/pass-timer";
import { PaperNotesPanel } from "@/components/paper-notes-panel";
import { generateHighlightCandidates } from "@/lib/ai/client";
import { createAnnotation, createAnnotationsBatch, deleteAnnotation, subscribeAnnotations } from "@/lib/firestore";
import {
  buildDocumentTextIndex,
  getPageTextIndex,
  loadPdfDocument,
  matchHighlightCandidates,
  mergeQuadsByLine,
  normalizeForMatch,
  pdfRectToViewport,
  type ItemRange,
  type PageTextIndex,
  type PdfDocumentProxy
} from "@/lib/pdf-annotate";
import { buildAnnotatedPdfBytes, downloadPdfBytes } from "@/lib/pdf-export";
import { extractPdfOutlineTree, hasTextLayer, type OutlineNode } from "@/lib/pdf-outline";
import { PASS_SEED_MINUTES } from "@/lib/papers";
import type { Annotation, HighlightCategory, NewAnnotation, Paper } from "@/types";

const CATEGORY_COLORS: Record<HighlightCategory, string> = {
  claim: "rgba(250, 204, 21, 0.4)",
  method: "rgba(56, 189, 248, 0.35)",
  result: "rgba(74, 222, 128, 0.35)",
  limitation: "rgba(251, 113, 133, 0.35)",
  definition: "rgba(196, 181, 253, 0.4)",
  weakness: "rgba(251, 146, 60, 0.4)"
};

const CATEGORIES: HighlightCategory[] = ["claim", "method", "result", "limitation", "definition", "weakness"];
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const THUMB_SCALE = 0.2;

type ZoomMode = "fit-width" | "fit-page" | number;
type SidebarTab = "outline" | "thumbnails" | "annotations" | "notes";

interface PendingSelection {
  quote: string;
  ranges: ItemRange[];
}

interface FindMatch {
  page: number;
  index: number;
}

const SHORTCUTS_HELP = [
  "Space / Shift+Space, PgDn/PgUp — next/previous page",
  "Home / End — first/last page",
  "Ctrl/Cmd+F or / — find",
  "Ctrl/Cmd +/-/0 — zoom in/out/reset",
  "1-6 — set annotation category",
  "S / H — select / hand tool",
  "Esc — close find, or exit"
].join("\n");

export function PaperReadingWindow({ paper, pdfUrl }: { paper: Paper; pdfUrl: string }) {
  const router = useRouter();
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

  const [zoom, setZoom] = useState<ZoomMode>("fit-width");
  const [scaleActual, setScaleActual] = useState(1);
  const [jumpInput, setJumpInput] = useState("1");
  const [tool, setTool] = useState<"select" | "hand">("select");
  const [activeCategory, setActiveCategory] = useState<HighlightCategory>("claim");

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("annotations");

  const [outline, setOutline] = useState<OutlineNode[] | null>(null);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});
  const [thumbnailsLoading, setThumbnailsLoading] = useState(false);

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMatches, setFindMatches] = useState<FindMatch[]>([]);
  const [findActiveIndex, setFindActiveIndex] = useState(0);
  const [findLoading, setFindLoading] = useState(false);
  const docTextIndexRef = useRef<PageTextIndex[] | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const docRef = useRef<PdfDocumentProxy | null>(null);
  const destroyRef = useRef<(() => Promise<void>) | null>(null);
  const panRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);

  useEffect(() => {
    if (!user) return;
    return subscribeAnnotations(user.uid, paper.id, setAnnotations);
  }, [user, paper.id]);

  useEffect(() => {
    let cancelled = false;
    hasTextLayer(pdfUrl)
      .then((ok) => !cancelled && setTextLayerOk(ok))
      .catch(() => !cancelled && setTextLayerOk(false));
    return () => {
      cancelled = true;
    };
  }, [pdfUrl]);

  useEffect(() => {
    setJumpInput(String(pageNum));
  }, [pageNum]);

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
        const unscaled = page.getViewport({ scale: 1 });

        let scale: number;
        if (zoom === "fit-width") {
          const width = (scrollRef.current?.clientWidth ?? 900) - 32;
          scale = Math.max(0.25, width / unscaled.width);
        } else if (zoom === "fit-page") {
          const width = (scrollRef.current?.clientWidth ?? 900) - 32;
          const height = (scrollRef.current?.clientHeight ?? 700) - 32;
          scale = Math.max(0.25, Math.min(width / unscaled.width, height / unscaled.height));
        } else {
          scale = zoom;
        }
        setScaleActual(scale);

        const pageViewport = page.getViewport({ scale });
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
    [pdfUrl, zoom]
  );

  useEffect(() => {
    renderPage(pageNum);
  }, [pageNum, renderPage]);

  useEffect(() => {
    if (zoom !== "fit-width" && zoom !== "fit-page") return;
    function onResize() {
      renderPage(pageNum);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [zoom, pageNum, renderPage]);

  useEffect(
    () => () => {
      destroyRef.current?.();
    },
    []
  );

  const goToPage = useCallback(
    (n: number) => {
      const clamped = Math.min(numPages, Math.max(1, n));
      setPageNum(clamped);
      setPending(null);
    },
    [numPages]
  );

  function zoomIn() {
    setZoom((z) => {
      const base = typeof z === "number" ? z : scaleActual;
      const next = ZOOM_STEPS.find((s) => s > base + 0.001) ?? Math.min(3, base + 0.25);
      return next;
    });
  }
  function zoomOut() {
    setZoom((z) => {
      const base = typeof z === "number" ? z : scaleActual;
      const next = [...ZOOM_STEPS].reverse().find((s) => s < base - 0.001) ?? Math.max(0.25, base - 0.25);
      return next;
    });
  }
  function zoomReset() {
    setZoom(1);
  }

  function handleMouseUp() {
    if (tool === "hand") return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !pageIndex) return;
    const text = selection.toString().trim();
    if (text.length < 6) return;

    const range = selection.getRangeAt(0);
    const overlay = overlayRef.current;
    if (!overlay) return;
    const spans = Array.from(overlay.querySelectorAll<HTMLElement>("[data-item-index]"));
    const touchedIndices = new Set(spans.filter((span) => range.intersectsNode(span)).map((span) => Number(span.dataset.itemIndex)));
    const touchedRanges = pageIndex.ranges.filter((r) => touchedIndices.has(r.itemIndex));
    if (touchedRanges.length === 0) return;

    setPending({ quote: text, ranges: touchedRanges });
    setPendingCategory(activeCategory);
    setPendingNote("");
  }

  async function saveManualHighlight() {
    if (!user || !pending || !pageIndex) return;
    const quads = mergeQuadsByLine(pending.ranges, pageIndex.items);
    await createAnnotation(user.uid, paper.id, {
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
      const candidates = await generateHighlightCandidates(user, paper.id);
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
      await createAnnotationsBatch(user.uid, paper.id, [...matched, ...unmatchedAsAnnotations]);
      if (matched.length === 0 && unmatched.length > 0) {
        setError(`Found ${unmatched.length} candidate quote(s), but none matched the extracted PDF text — see the Annotations tab.`);
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
      downloadPdfBytes(outBytes, `${paper.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "paper"}-annotated.pdf`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export PDF.");
    } finally {
      setExporting(false);
    }
  }

  async function removeAnnotation(id: string) {
    if (!user) return;
    await deleteAnnotation(user.uid, paper.id, id);
  }

  function openSidebarTab(tab: SidebarTab) {
    setSidebarOpen(true);
    setSidebarTab(tab);
  }

  function openFind() {
    setFindOpen(true);
    requestAnimationFrame(() => findInputRef.current?.focus());
  }
  function closeFind() {
    setFindOpen(false);
    setFindMatches([]);
    setFindQuery("");
  }

  async function runFind(query: string) {
    setFindQuery(query);
    if (!query.trim()) {
      setFindMatches([]);
      return;
    }
    setFindLoading(true);
    try {
      if (!docTextIndexRef.current) {
        docTextIndexRef.current = await buildDocumentTextIndex(pdfUrl);
      }
      const normalizedQuery = normalizeForMatch(query);
      const matches: FindMatch[] = [];
      docTextIndexRef.current.forEach((page) => {
        const normalizedText = normalizeForMatch(page.text);
        let from = 0;
        for (;;) {
          const at = normalizedText.indexOf(normalizedQuery, from);
          if (at === -1) break;
          matches.push({ page: page.page, index: at });
          from = at + normalizedQuery.length;
        }
      });
      setFindMatches(matches);
      setFindActiveIndex(0);
      if (matches.length > 0) goToPage(matches[0].page);
    } finally {
      setFindLoading(false);
    }
  }
  function findNext() {
    if (findMatches.length === 0) return;
    const next = (findActiveIndex + 1) % findMatches.length;
    setFindActiveIndex(next);
    goToPage(findMatches[next].page);
  }
  function findPrev() {
    if (findMatches.length === 0) return;
    const prev = (findActiveIndex - 1 + findMatches.length) % findMatches.length;
    setFindActiveIndex(prev);
    goToPage(findMatches[prev].page);
  }

  const activeFindQuads = useMemo(() => {
    if (!viewport || !pageIndex) return [];
    const match = findMatches[findActiveIndex];
    if (!match || match.page !== pageNum) return [];
    const normalizedQuery = normalizeForMatch(findQuery);
    if (!normalizedQuery) return [];
    const end = match.index + normalizedQuery.length;
    const overlapping = pageIndex.ranges.filter((r) => r.start < end && r.end > match.index);
    return mergeQuadsByLine(overlapping, pageIndex.items);
  }, [viewport, pageIndex, findMatches, findActiveIndex, pageNum, findQuery]);

  useEffect(() => {
    if (sidebarTab !== "outline" || outline !== null || outlineLoading) return;
    setOutlineLoading(true);
    extractPdfOutlineTree(pdfUrl)
      .then(setOutline)
      .catch(() => setOutline([]))
      .finally(() => setOutlineLoading(false));
  }, [sidebarTab, outline, outlineLoading, pdfUrl]);

  useEffect(() => {
    if (sidebarTab !== "thumbnails" || thumbnailsLoading || !docRef.current) return;
    const missing = Array.from({ length: numPages }, (_, i) => i + 1).filter((n) => !thumbnails[n]);
    if (missing.length === 0) return;
    let cancelled = false;
    setThumbnailsLoading(true);
    (async () => {
      const doc = docRef.current!;
      for (const n of missing) {
        if (cancelled) break;
        try {
          const page = await doc.getPage(n);
          const thumbViewport = page.getViewport({ scale: THUMB_SCALE });
          const offscreen = document.createElement("canvas");
          offscreen.width = thumbViewport.width;
          offscreen.height = thumbViewport.height;
          const ctx = offscreen.getContext("2d");
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport: thumbViewport, canvas: offscreen }).promise;
          const dataUrl = offscreen.toDataURL("image/png");
          if (!cancelled) setThumbnails((prev) => ({ ...prev, [n]: dataUrl }));
        } catch {
          // Skip a page that fails to render a thumbnail rather than failing the whole grid.
        }
      }
      if (!cancelled) setThumbnailsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [sidebarTab, numPages, thumbnails, thumbnailsLoading]);

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false;
      return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
    }
    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) {
        // Esc cancels out of the field (jump-to-page, find, a highlight/note draft)
        // without closing the whole reading window out from under an in-progress edit.
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        return;
      }
      if (e.key === "Escape") {
        if (findOpen) {
          closeFind();
          return;
        }
        router.push(`/papers/${paper.id}`);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openFind();
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        openFind();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "+" || e.key === "=")) {
        e.preventDefault();
        zoomIn();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "-") {
        e.preventDefault();
        zoomOut();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "0") {
        e.preventDefault();
        zoomReset();
        return;
      }
      // Paging would silently discard an in-progress highlight draft (the
      // popup's category/note form) via goToPage's setPending(null) — block it
      // until the draft is saved or explicitly cancelled.
      if (!pending) {
        if (e.key === " ") {
          e.preventDefault();
          goToPage(e.shiftKey ? pageNum - 1 : pageNum + 1);
          return;
        }
        if (e.key === "PageDown") {
          goToPage(pageNum + 1);
          return;
        }
        if (e.key === "PageUp") {
          goToPage(pageNum - 1);
          return;
        }
        if (e.key === "Home") {
          goToPage(1);
          return;
        }
        if (e.key === "End") {
          goToPage(numPages);
          return;
        }
      }
      if (/^[1-6]$/.test(e.key)) {
        setActiveCategory(CATEGORIES[Number(e.key) - 1]);
        return;
      }
      if (e.key.toLowerCase() === "s") {
        setTool("select");
        return;
      }
      if (e.key.toLowerCase() === "h") {
        setTool("hand");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [findOpen, pageNum, numPages, paper.id, router, pending]);

  function onContainerMouseDown(e: React.MouseEvent) {
    if (tool !== "hand" || !scrollRef.current) return;
    panRef.current = { x: e.clientX, y: e.clientY, scrollLeft: scrollRef.current.scrollLeft, scrollTop: scrollRef.current.scrollTop };
  }
  function onContainerMouseMove(e: React.MouseEvent) {
    if (!panRef.current || !scrollRef.current) return;
    scrollRef.current.scrollLeft = panRef.current.scrollLeft - (e.clientX - panRef.current.x);
    scrollRef.current.scrollTop = panRef.current.scrollTop - (e.clientY - panRef.current.y);
  }
  function onContainerMouseUp() {
    panRef.current = null;
  }

  const runningPass = ([1, 2, 3] as const)
    .map((n) => ({ n, state: n === 1 ? paper.pass1 : n === 2 ? paper.pass2 : paper.pass3 }))
    .find((p) => p.state?.status === "in_progress");

  const pageAnnotations = annotations.filter((a) => a.matched && a.page === pageNum);
  const annotationsByPage = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    annotations
      .filter((a) => a.matched && a.page)
      .forEach((a) => map.set(a.page!, [...(map.get(a.page!) ?? []), a]));
    return Array.from(map.entries()).sort(([a], [b]) => a - b);
  }, [annotations]);
  const unmatchedAnnotations = annotations.filter((a) => !a.matched);

  return (
    <div className="flex h-screen w-screen flex-col bg-white text-ink-900 dark:bg-ink-950 dark:text-ink-50">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-ink-50 px-3 py-2 dark:border-ink-800 dark:bg-ink-900">
        <div className="flex min-w-0 items-center gap-2">
          <button className="btn-secondary px-2 py-1.5" onClick={() => router.push(`/papers/${paper.id}`)} aria-label="Close reading window">
            <X className="h-4 w-4" />
          </button>
          <span className="max-w-[16rem] truncate text-sm font-medium sm:max-w-[24rem]" title={paper.title}>
            {paper.title}
          </span>
          {runningPass ? (
            <div className="hidden items-center gap-2 md:flex">
              <span className="label">{{ 1: "Skim", 2: "Read", 3: "Deep dive" }[runningPass.n]}</span>
              <PassTimer startedAt={runningPass.state!.startedAt!} seedMinutes={PASS_SEED_MINUTES[runningPass.n]} />
            </div>
          ) : null}
        </div>

        <div className="ml-auto flex items-center gap-2 text-sm">
          <button className="btn-secondary px-2" onClick={() => goToPage(pageNum - 1)} disabled={pageNum <= 1} aria-label="Previous page">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <input
            className="input w-12 py-1 text-center text-xs"
            value={jumpInput}
            onChange={(e) => setJumpInput(e.target.value)}
            onBlur={() => goToPage(Number(jumpInput) || pageNum)}
            onKeyDown={(e) => e.key === "Enter" && goToPage(Number(jumpInput) || pageNum)}
          />
          <span className="text-xs text-ink-500">/ {numPages}</span>
          <button className="btn-secondary px-2" onClick={() => goToPage(pageNum + 1)} disabled={pageNum >= numPages} aria-label="Next page">
            <ChevronRight className="h-4 w-4" />
          </button>
          <select
            className="input w-auto py-1 text-xs"
            value={typeof zoom === "number" ? String(zoom) : zoom}
            onChange={(e) => setZoom(e.target.value === "fit-width" || e.target.value === "fit-page" ? (e.target.value as ZoomMode) : Number(e.target.value))}
          >
            <option value="fit-width">Fit width</option>
            <option value="fit-page">Fit page</option>
            {[0.75, 1, 1.25, 1.5, 2].map((p) => (
              <option key={p} value={p}>
                {Math.round(p * 100)}%
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <button
            className={`btn-secondary px-2 ${tool === "select" ? "ring-2 ring-moss-500" : ""}`}
            onClick={() => setTool("select")}
            aria-label="Select tool"
            title="Select tool (S)"
          >
            <MousePointer2 className="h-3.5 w-3.5" />
          </button>
          <button
            className={`btn-secondary px-2 ${tool === "hand" ? "ring-2 ring-moss-500" : ""}`}
            onClick={() => setTool("hand")}
            aria-label="Hand tool"
            title="Hand tool (H)"
          >
            <Hand className="h-3.5 w-3.5" />
          </button>
          <button className="btn-secondary px-2" onClick={openFind} aria-label="Find in document" title="Find (Ctrl/Cmd+F)">
            <Search className="h-3.5 w-3.5" />
          </button>
          {CATEGORIES.map((category, i) => (
            <button
              key={category}
              className={`h-6 w-6 rounded-md border text-[10px] font-semibold uppercase ${
                activeCategory === category ? "border-moss-600 ring-2 ring-moss-500" : "border-ink-200 dark:border-ink-700"
              }`}
              style={{ background: CATEGORY_COLORS[category] }}
              onClick={() => setActiveCategory(category)}
              title={`${category} (${i + 1})`}
              aria-label={`Set annotation category to ${category}`}
            />
          ))}
          <button className="btn-secondary px-2 py-1.5" onClick={generateHighlights} disabled={generating} title="Generate highlights">
            <Sparkles className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">{generating ? "Finding..." : "Generate"}</span>
          </button>
          <button
            className="btn-secondary px-2 py-1.5"
            onClick={exportPdf}
            disabled={exporting || annotations.every((a) => !a.matched)}
            title="Export annotated PDF"
          >
            <Download className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">{exporting ? "Exporting..." : "Export"}</span>
          </button>
          <button className="btn-secondary px-2" onClick={() => setSidebarOpen((v) => !v)} aria-label="Toggle sidebar" title="Toggle sidebar">
            <PanelRight className="h-3.5 w-3.5" />
          </button>
          <button className="btn-secondary px-2" title={SHORTCUTS_HELP} aria-label="Keyboard shortcuts">
            <HelpCircle className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {findOpen ? (
        <div className="flex items-center gap-2 border-b border-ink-200 bg-white px-3 py-2 text-sm dark:border-ink-800 dark:bg-ink-900">
          <input
            ref={findInputRef}
            className="input max-w-xs py-1 text-xs"
            placeholder="Find in document..."
            value={findQuery}
            onChange={(e) => runFind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.shiftKey ? findPrev() : findNext());
            }}
          />
          <button className="btn-secondary px-2 py-1" onClick={findPrev} disabled={findMatches.length === 0}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button className="btn-secondary px-2 py-1" onClick={findNext} disabled={findMatches.length === 0}>
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <span className="text-xs text-ink-500">
            {findLoading ? "Searching..." : findQuery ? `${findMatches.length === 0 ? 0 : findActiveIndex + 1} of ${findMatches.length}` : ""}
          </span>
          <button className="ml-auto btn-secondary px-2 py-1" onClick={closeFind} aria-label="Close find">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {error ? <p className="border-b border-ink-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-ink-800 dark:bg-red-950 dark:text-red-200">{error}</p> : null}
      {textLayerOk === false ? (
        <p className="border-b border-ink-200 bg-ink-50 px-3 py-1.5 text-xs text-ink-500 dark:border-ink-800 dark:bg-ink-900">
          This PDF has no extractable text layer (it looks scanned) — you can still read and navigate it, but selecting text to highlight won&apos;t work.
        </p>
      ) : null}

      {/* Body — the PDF itself always renders; only text-selection-based highlighting depends on a text layer. */}
      <div className="flex min-h-0 flex-1">
        <>
            <div
              ref={scrollRef}
              className={`relative min-h-0 flex-1 overflow-auto p-4 ${tool === "hand" ? "cursor-grab active:cursor-grabbing" : ""}`}
              onMouseDown={onContainerMouseDown}
              onMouseMove={onContainerMouseMove}
              onMouseUp={() => {
                onContainerMouseUp();
                handleMouseUp();
              }}
              onMouseLeave={onContainerMouseUp}
            >
              <div className="relative inline-block">
                <canvas ref={canvasRef} className="block shadow-soft" />
                <div ref={overlayRef} className="absolute inset-0" style={{ pointerEvents: tool === "hand" ? "none" : "auto" }}>
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
                  {activeFindQuads.map((quad, i) => {
                    if (!viewport) return null;
                    const rect = pdfRectToViewport(viewport, quad);
                    return (
                      <div
                        key={`find-${i}`}
                        style={{
                          position: "absolute",
                          left: rect.left,
                          top: rect.top,
                          width: rect.width,
                          height: rect.height,
                          outline: "2px solid rgb(234, 88, 12)",
                          background: "rgba(234, 88, 12, 0.25)",
                          pointerEvents: "none"
                        }}
                      />
                    );
                  })}
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
            </div>

            {sidebarOpen ? (
              <aside className="flex w-full max-w-xs shrink-0 flex-col border-l border-ink-200 dark:border-ink-800">
                <div className="flex border-b border-ink-200 text-xs dark:border-ink-800">
                  <SidebarTabButton active={sidebarTab === "outline"} onClick={() => openSidebarTab("outline")} icon={<List className="h-3.5 w-3.5" />} label="Outline" />
                  <SidebarTabButton
                    active={sidebarTab === "thumbnails"}
                    onClick={() => openSidebarTab("thumbnails")}
                    icon={<span className="block h-3.5 w-3.5 rounded-sm border border-current" />}
                    label="Pages"
                  />
                  <SidebarTabButton
                    active={sidebarTab === "annotations"}
                    onClick={() => openSidebarTab("annotations")}
                    icon={<Sparkles className="h-3.5 w-3.5" />}
                    label="Highlights"
                  />
                  <SidebarTabButton
                    active={sidebarTab === "notes"}
                    onClick={() => openSidebarTab("notes")}
                    icon={<StickyNote className="h-3.5 w-3.5" />}
                    label="Notes"
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-3">
                  {sidebarTab === "outline" ? (
                    outlineLoading ? (
                      <p className="text-xs text-ink-500">Loading outline...</p>
                    ) : !outline || outline.length === 0 ? (
                      <p className="text-xs text-ink-500">This PDF has no bookmark outline.</p>
                    ) : (
                      <OutlineTree nodes={outline} onJump={goToPage} />
                    )
                  ) : null}

                  {sidebarTab === "thumbnails" ? (
                    <div className="grid grid-cols-2 gap-2">
                      {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => (
                        <button
                          key={n}
                          className={`overflow-hidden rounded-md border text-left ${n === pageNum ? "border-moss-600 ring-2 ring-moss-500" : "border-ink-200 dark:border-ink-700"}`}
                          onClick={() => goToPage(n)}
                        >
                          {thumbnails[n] ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={thumbnails[n]} alt={`Page ${n}`} className="w-full" />
                          ) : (
                            <div className="flex aspect-[3/4] w-full items-center justify-center bg-ink-50 text-[10px] text-ink-400 dark:bg-ink-800">{n}</div>
                          )}
                          <span className="block px-1 py-0.5 text-center text-[10px] text-ink-500">{n}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {sidebarTab === "annotations" ? (
                    <div className="space-y-3">
                      {annotationsByPage.length === 0 ? (
                        <p className="text-xs text-ink-500">No highlights yet — select text to add one, or generate highlights above.</p>
                      ) : (
                        annotationsByPage.map(([page, list]) => (
                          <div key={page}>
                            <button className="label mb-1 hover:text-moss-700 dark:hover:text-moss-400" onClick={() => goToPage(page)}>
                              Page {page}
                            </button>
                            <div className="space-y-1">
                              {list.map((annotation) => (
                                <div key={annotation.id} className="card space-y-1 p-2 text-xs">
                                  <p className="font-medium capitalize">{annotation.category}</p>
                                  <p className="break-words text-ink-500">{annotation.note || annotation.quote}</p>
                                  <button className="text-red-600 hover:underline dark:text-red-400" onClick={() => removeAnnotation(annotation.id)}>
                                    <Trash2 className="mr-1 inline h-3 w-3" />
                                    Remove
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))
                      )}
                      {unmatchedAnnotations.length > 0 ? (
                        <>
                          <p className="label pt-2">Unmatched AI quotes</p>
                          {unmatchedAnnotations.map((annotation) => (
                            <div key={annotation.id} className="card space-y-1 border-dashed p-2 text-xs">
                              <p className="font-medium capitalize">{annotation.category}</p>
                              <p className="break-words text-ink-500">&ldquo;{annotation.quote}&rdquo;</p>
                              <button className="text-red-600 hover:underline dark:text-red-400" onClick={() => removeAnnotation(annotation.id)}>
                                <Trash2 className="mr-1 inline h-3 w-3" />
                                Remove
                              </button>
                            </div>
                          ))}
                        </>
                      ) : null}
                    </div>
                  ) : null}

                  {sidebarTab === "notes" ? (
                    <PaperNotesPanel paperId={paper.id} anchor={{ page: pageNum, quote: pending?.quote }} onJump={goToPage} />
                  ) : null}
                </div>
              </aside>
            ) : null}
        </>
      </div>
    </div>
  );
}

function SidebarTabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      className={`flex flex-1 flex-col items-center gap-0.5 py-2 ${active ? "border-b-2 border-moss-600 text-moss-700 dark:text-moss-400" : "text-ink-500"}`}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

function OutlineTree({ nodes, onJump, depth = 0 }: { nodes: OutlineNode[]; onJump: (page: number) => void; depth?: number }) {
  return (
    <ul className={depth > 0 ? "ml-3 border-l border-ink-100 pl-2 dark:border-ink-800" : ""}>
      {nodes.map((node, i) => (
        <li key={i}>
          <button
            className="block w-full truncate py-1 text-left text-xs hover:text-moss-700 disabled:text-ink-400 dark:hover:text-moss-400"
            onClick={() => node.page && onJump(node.page)}
            disabled={!node.page}
            title={node.title}
          >
            {node.title}
          </button>
          {node.items.length > 0 ? <OutlineTree nodes={node.items} onJump={onJump} depth={depth + 1} /> : null}
        </li>
      ))}
    </ul>
  );
}
