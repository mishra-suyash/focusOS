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
  type PageTextIndex,
  type PdfDocumentProxy
} from "@/lib/pdf-annotate";
import { buildAnnotatedPdfBytes, downloadPdfBytes } from "@/lib/pdf-export";
import { extractPdfOutlineTree, hasTextLayer, type OutlineNode } from "@/lib/pdf-outline";
import { PASS_SEED_MINUTES } from "@/lib/papers";
import type { Annotation, HighlightCategory, HighlightQuad, NewAnnotation, Paper } from "@/types";

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
const VIEW_MODE_STORAGE_KEY = "focusos-reading-view-mode";
const EMPTY_ANNOTATIONS: Annotation[] = [];

type ZoomMode = "fit-width" | "fit-page" | number;
type SidebarTab = "outline" | "thumbnails" | "annotations" | "notes";
type ViewMode = "single" | "continuous";

interface PendingSelection {
  page: number;
  quote: string;
  quads: HighlightQuad[];
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

/** Shared by the single-page and continuous-scroll paths: given a page's overlay element and its text index, turns the current window selection into a quote + merged highlight quads, or null if nothing selectable was touched. */
function computeSelectionFromOverlay(overlay: HTMLDivElement, pageIndex: PageTextIndex): { quote: string; quads: HighlightQuad[] } | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;
  const text = selection.toString().trim();
  if (text.length < 6) return null;

  const range = selection.getRangeAt(0);
  const spans = Array.from(overlay.querySelectorAll<HTMLElement>("[data-item-index]"));
  const touchedIndices = new Set(spans.filter((span) => range.intersectsNode(span)).map((span) => Number(span.dataset.itemIndex)));
  const touchedRanges = pageIndex.ranges.filter((r) => touchedIndices.has(r.itemIndex));
  if (touchedRanges.length === 0) return null;

  return { quote: text, quads: mergeQuadsByLine(touchedRanges, pageIndex.items) };
}

export function PaperReadingWindow({ paper, pdfUrl }: { paper: Paper; pdfUrl: string }) {
  const router = useRouter();
  const { user } = useAuth();

  const [textLayerOk, setTextLayerOk] = useState<boolean | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(1);
  const [pdfDoc, setPdfDoc] = useState<PdfDocumentProxy | null>(null);
  const [basePageSize, setBasePageSize] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [pendingCategory, setPendingCategory] = useState<HighlightCategory>("claim");
  const [pendingNote, setPendingNote] = useState("");

  const [viewMode, setViewModeState] = useState<ViewMode>("single");
  const [zoom, setZoom] = useState<ZoomMode>("fit-width");
  const [scale, setScale] = useState(1);
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

  const scrollRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const docRef = useRef<PdfDocumentProxy | null>(null);
  const destroyRef = useRef<(() => Promise<void>) | null>(null);
  const panRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  const pageElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const visibilityRef = useRef<Map<number, number>>(new Map());
  const pageNumRef = useRef(pageNum);

  useEffect(() => {
    pageNumRef.current = pageNum;
  }, [pageNum]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
      if (stored === "single" || stored === "continuous") setViewModeState(stored);
    } catch {
      // Private-browsing/storage-blocked contexts just keep the default — not worth surfacing.
    }
  }, []);

  function setViewMode(mode: ViewMode) {
    setViewModeState(mode);
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // Same as above — a failed preference save shouldn't block switching modes.
    }
  }

  useEffect(() => {
    if (!user) return;
    return subscribeAnnotations(user.uid, paper.id, setAnnotations);
  }, [user, paper.id]);

  useEffect(() => {
    let cancelled = false;
    hasTextLayer(pdfUrl)
      .then((ok) => !cancelled && setTextLayerOk(ok))
      .catch((err) => {
        // The check itself failing (network hiccup, a malformed-but-still-
        // renderable PDF, a pdf.js edge case) is not the same as confirming
        // there's no text layer — defaulting to "false" here would tell the
        // user a perfectly normal, text-bearing paper "looks scanned," which
        // is a worse failure mode than just letting the highlighting UI show
        // and harmlessly find nothing selectable if that assumption is wrong.
        console.error("hasTextLayer check failed, assuming the PDF has text:", err);
        if (!cancelled) setTextLayerOk(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pdfUrl]);

  useEffect(() => {
    setJumpInput(String(pageNum));
  }, [pageNum]);

  // Loads the pdf.js document once, independent of view mode — both the
  // single-page and continuous paths render pages off this same `docRef`.
  useEffect(() => {
    let cancelled = false;
    loadPdfDocument(pdfUrl)
      .then(async ({ doc, destroy }) => {
        if (cancelled) {
          await destroy();
          return;
        }
        docRef.current = doc;
        destroyRef.current = destroy;
        setNumPages(doc.numPages);
        const page1 = await doc.getPage(1);
        const unscaled = page1.getViewport({ scale: 1 });
        if (!cancelled) {
          setBasePageSize({ width: unscaled.width, height: unscaled.height });
          setPdfDoc(doc);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load PDF.");
      });
    return () => {
      cancelled = true;
    };
  }, [pdfUrl]);

  useEffect(
    () => () => {
      destroyRef.current?.();
    },
    []
  );

  // Single scale shared by both modes — assumes a uniform page size (true for
  // the overwhelming majority of academic PDFs), computed from page 1.
  useEffect(() => {
    if (!basePageSize) return;
    function recompute() {
      const width = (scrollRef.current?.clientWidth ?? 900) - 32;
      const height = (scrollRef.current?.clientHeight ?? 700) - 32;
      let next: number;
      if (zoom === "fit-width") next = Math.max(0.25, width / basePageSize!.width);
      else if (zoom === "fit-page") next = Math.max(0.25, Math.min(width / basePageSize!.width, height / basePageSize!.height));
      else next = zoom;
      setScale(next);
    }
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, [zoom, basePageSize, sidebarOpen]);

  function scrollToPage(n: number) {
    const el = pageElsRef.current.get(n);
    const container = scrollRef.current;
    if (!el || !container) return;
    const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    container.scrollTo({ top: Math.max(0, top - 8), behavior: "smooth" });
  }

  // Restores scroll position to the current page once continuous mode's page
  // list has actually mounted — runs once per switch into continuous mode.
  useEffect(() => {
    if (viewMode !== "continuous") return;
    const id = requestAnimationFrame(() => scrollToPage(pageNum));
    return () => cancelAnimationFrame(id);
    // Deliberately only [viewMode]: this restores scroll position once per
    // mode switch, and must NOT re-fire on every pageNum change while the
    // user is scrolling continuous mode themselves — that would fight them.
  }, [viewMode]);

  const goToPage = useCallback(
    (n: number) => {
      const clamped = Math.min(numPages, Math.max(1, n));
      setPageNum(clamped);
      setPending(null);
      if (viewMode === "continuous") requestAnimationFrame(() => scrollToPage(clamped));
    },
    [numPages, viewMode]
  );

  // Stable identities (useCallback, empty deps — both only touch refs) so
  // PdfPage's effects that depend on them don't tear down and recreate their
  // IntersectionObservers on every parent re-render (which happens on every
  // page-visibility update while the user free-scrolls in continuous mode).
  const reportVisibility = useCallback((page: number, ratio: number) => {
    if (ratio > 0) visibilityRef.current.set(page, ratio);
    else visibilityRef.current.delete(page);
    let bestPage = page;
    let bestRatio = -1;
    visibilityRef.current.forEach((r, p) => {
      if (r > bestRatio) {
        bestRatio = r;
        bestPage = p;
      }
    });
    if (bestRatio > 0) setPageNum((prev) => (prev !== bestPage ? bestPage : prev));
  }, []);

  const registerPageEl = useCallback((page: number, el: HTMLDivElement | null) => {
    if (el) pageElsRef.current.set(page, el);
    else pageElsRef.current.delete(page);
  }, []);

  function zoomIn() {
    setZoom((z) => {
      const base = typeof z === "number" ? z : scale;
      return ZOOM_STEPS.find((s) => s > base + 0.001) ?? Math.min(3, base + 0.25);
    });
  }
  function zoomOut() {
    setZoom((z) => {
      const base = typeof z === "number" ? z : scale;
      return [...ZOOM_STEPS].reverse().find((s) => s < base - 0.001) ?? Math.max(0.25, base - 0.25);
    });
  }
  function zoomReset() {
    setZoom(1);
  }

  function handlePageSelect(page: number, quote: string, quads: HighlightQuad[]) {
    setPending({ page, quote, quads });
    setPendingCategory(activeCategory);
    setPendingNote("");
  }

  async function saveManualHighlight() {
    if (!user || !pending) return;
    await createAnnotation(user.uid, paper.id, {
      page: pending.page,
      quads: pending.quads,
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
          goToPage(e.shiftKey ? pageNumRef.current - 1 : pageNumRef.current + 1);
          return;
        }
        if (e.key === "PageDown") {
          goToPage(pageNumRef.current + 1);
          return;
        }
        if (e.key === "PageUp") {
          goToPage(pageNumRef.current - 1);
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
    // pageNum deliberately excluded — read via pageNumRef instead, so this
    // listener isn't torn down and re-added on every visibility update while
    // scrolling continuous mode (pageNum otherwise changes continuously then).
  }, [findOpen, numPages, paper.id, router, pending, goToPage]);

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

  const annotationsByPageMap = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    annotations
      .filter((a) => a.matched && a.page)
      .forEach((a) => map.set(a.page!, [...(map.get(a.page!) ?? []), a]));
    return map;
  }, [annotations]);
  const annotationsByPage = useMemo(
    () => Array.from(annotationsByPageMap.entries()).sort(([a], [b]) => a - b),
    [annotationsByPageMap]
  );
  const unmatchedAnnotations = annotations.filter((a) => !a.matched);

  const activeFindMatch = findMatches[findActiveIndex] ?? null;
  const pageList = viewMode === "continuous" ? Array.from({ length: numPages }, (_, i) => i + 1) : [pageNum];

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
          <select className="input w-auto py-1 text-xs" value={viewMode} onChange={(e) => setViewMode(e.target.value as ViewMode)} title="Reading mode">
            <option value="single">Single page</option>
            <option value="continuous">Continuous scroll</option>
          </select>
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
        <div
          ref={scrollRef}
          className={`relative min-h-0 flex-1 overflow-auto p-4 ${tool === "hand" ? "cursor-grab active:cursor-grabbing" : ""}`}
          onMouseDown={onContainerMouseDown}
          onMouseMove={onContainerMouseMove}
          onMouseUp={onContainerMouseUp}
          onMouseLeave={onContainerMouseUp}
        >
          {!pdfDoc || !basePageSize ? (
            <p className="p-6 text-sm text-ink-500">Loading PDF...</p>
          ) : (
            <div className="flex flex-col items-center gap-4">
              {pageList.map((p) => (
                <PdfPage
                  key={p}
                  doc={pdfDoc}
                  pageNum={p}
                  scale={scale}
                  tool={tool}
                  basePageSize={basePageSize}
                  forceActive={viewMode === "single"}
                  trackVisibility={viewMode === "continuous"}
                  scrollRootRef={scrollRef}
                  matchedAnnotations={annotationsByPageMap.get(p) ?? EMPTY_ANNOTATIONS}
                  activeFindMatch={activeFindMatch?.page === p ? { query: findQuery, index: activeFindMatch.index } : null}
                  onSelect={handlePageSelect}
                  onVisibilityChange={reportVisibility}
                  registerEl={registerPageEl}
                />
              ))}
            </div>
          )}

          {pending ? (
            <div className="absolute bottom-4 left-1/2 z-10 w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 space-y-2 rounded-md border border-ink-200 bg-white p-3 text-sm shadow-soft dark:border-ink-700 dark:bg-ink-900">
              <p className="line-clamp-2 text-xs text-ink-500">
                Page {pending.page} · &ldquo;{pending.quote}&rdquo;
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <select className="input py-1 text-xs" value={pendingCategory} onChange={(e) => setPendingCategory(e.target.value as HighlightCategory)}>
                  {CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
                <input className="input flex-1 py-1 text-xs" placeholder="Note (optional)" value={pendingNote} onChange={(e) => setPendingNote(e.target.value)} />
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
              <SidebarTabButton active={sidebarTab === "notes"} onClick={() => openSidebarTab("notes")} icon={<StickyNote className="h-3.5 w-3.5" />} label="Notes" />
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

              {sidebarTab === "notes" ? <PaperNotesPanel paperId={paper.id} anchor={{ page: pageNum, quote: pending?.quote }} onJump={goToPage} /> : null}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Renders one PDF page and is used identically by both view modes: single-page
 * mode mounts exactly one instance with `forceActive` (always renders, no
 * lazy-mount observer); continuous mode mounts one per page in a vertical
 * stack, each deciding for itself whether to actually render its canvas
 * (`forceActive` false) based on an IntersectionObserver with a generous
 * margin — real virtualization, not "render all N pages' canvases at once,"
 * which would be a real memory/perf problem on longer papers. A second,
 * narrow-band observer (only active when `trackVisibility` is set) reports
 * this page's visibility ratio up so the parent can track "current page"
 * while the user free-scrolls, the way scroll-spy navigation usually works.
 */
function PdfPage({
  doc,
  pageNum,
  scale,
  tool,
  basePageSize,
  forceActive,
  trackVisibility,
  scrollRootRef,
  matchedAnnotations,
  activeFindMatch,
  onSelect,
  onVisibilityChange,
  registerEl
}: {
  doc: PdfDocumentProxy;
  pageNum: number;
  scale: number;
  tool: "select" | "hand";
  basePageSize: { width: number; height: number };
  forceActive: boolean;
  trackVisibility: boolean;
  scrollRootRef: React.RefObject<HTMLDivElement | null>;
  matchedAnnotations: Annotation[];
  activeFindMatch: { query: string; index: number } | null;
  onSelect: (page: number, quote: string, quads: HighlightQuad[]) => void;
  onVisibilityChange: (page: number, ratio: number) => void;
  registerEl: (page: number, el: HTMLDivElement | null) => void;
}) {
  const [active, setActive] = useState(forceActive);
  const [pageIndex, setPageIndex] = useState<PageTextIndex | null>(null);
  const [viewport, setViewport] = useState<{ convertToViewportPoint: (x: number, y: number) => number[] } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    registerEl(pageNum, wrapperRef.current);
    return () => registerEl(pageNum, null);
  }, [pageNum, registerEl]);

  useEffect(() => {
    if (forceActive) {
      setActive(true);
      return;
    }
    const el = wrapperRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setActive(entry.isIntersecting), { rootMargin: "1000px 0px 1000px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [forceActive]);

  useEffect(() => {
    if (!trackVisibility) return;
    const el = wrapperRef.current;
    if (!el) return;
    // Read at effect time, not during render — `scrollRootRef.current` is
    // guaranteed attached by the time this runs (effects fire after the whole
    // tree commits, ref assignment included).
    const observer = new IntersectionObserver(([entry]) => onVisibilityChange(pageNum, entry.intersectionRatio), {
      root: scrollRootRef.current,
      rootMargin: "-45% 0px -45% 0px",
      threshold: [0, 0.25, 0.5, 0.75, 1]
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      // A page that scrolls out of the (much wider) render band never gets a
      // final ratio-0 callback from this observer — it just disconnects —
      // which would otherwise leave a stale nonzero entry in the parent's
      // visibility map forever, able to win the "current page" comparison.
      onVisibilityChange(pageNum, 0);
    };
  }, [trackVisibility, scrollRootRef, pageNum, onVisibilityChange]);

  // Invalidate the last render's overlay data whenever this page goes inactive
  // (so reactivating it later doesn't briefly show text/annotation positions
  // from a stale scale) and whenever scale itself changes (so an in-flight
  // zoom doesn't leave the old overlay showing until the async re-render
  // below resolves and repopulates it).
  useEffect(() => {
    setViewport(null);
    setPageIndex(null);
  }, [active, scale]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(pageNum);
      const pageViewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;
      canvas.width = pageViewport.width;
      canvas.height = pageViewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      await page.render({ canvasContext: ctx, viewport: pageViewport, canvas }).promise;
      if (cancelled) return;
      setViewport(pageViewport);
      setPageIndex(await getPageTextIndex(doc, pageNum));
    })();
    return () => {
      cancelled = true;
    };
  }, [active, doc, pageNum, scale]);

  function handleMouseUp() {
    if (tool === "hand" || !overlayRef.current || !pageIndex) return;
    const result = computeSelectionFromOverlay(overlayRef.current, pageIndex);
    if (result) onSelect(pageNum, result.quote, result.quads);
  }

  const findQuads = useMemo(() => {
    if (!activeFindMatch || !pageIndex) return [];
    const normalizedQuery = normalizeForMatch(activeFindMatch.query);
    if (!normalizedQuery) return [];
    const end = activeFindMatch.index + normalizedQuery.length;
    const overlapping = pageIndex.ranges.filter((r) => r.start < end && r.end > activeFindMatch.index);
    return mergeQuadsByLine(overlapping, pageIndex.items);
  }, [activeFindMatch, pageIndex]);

  const placeholderWidth = basePageSize.width * scale;
  const placeholderHeight = basePageSize.height * scale;

  if (!active) {
    return (
      <div
        ref={wrapperRef}
        data-page-num={pageNum}
        className="flex shrink-0 items-center justify-center border border-ink-100 bg-ink-50 text-xs text-ink-400 dark:border-ink-800 dark:bg-ink-900"
        style={{ width: placeholderWidth, height: placeholderHeight }}
      >
        {pageNum}
      </div>
    );
  }

  // The canvas must already be in the DOM (this branch, not the placeholder
  // one above) before the render effect's `canvasRef.current` lookup can
  // succeed — that's why this only gates on `active`, not `active && viewport`.
  // The text/annotation/find overlay is the part that waits on `viewport`.
  return (
    <div
      ref={wrapperRef}
      data-page-num={pageNum}
      className="relative inline-block shrink-0"
      style={!viewport ? { width: placeholderWidth, height: placeholderHeight } : undefined}
      onMouseUp={handleMouseUp}
    >
      <canvas ref={canvasRef} className="block shadow-soft" />
      {viewport ? (
      <div ref={overlayRef} className="absolute inset-0" style={{ pointerEvents: tool === "hand" ? "none" : "auto" }}>
        {pageIndex?.items.map((item, itemIndex) => {
          if (!item.str.trim()) return null;
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
        {matchedAnnotations.map((annotation) =>
          (annotation.quads ?? []).map((quad, i) => {
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
        {findQuads.map((quad, i) => {
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
      ) : null}
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
