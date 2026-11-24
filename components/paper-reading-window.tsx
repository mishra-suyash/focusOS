"use client";

import {
  BookOpenCheck,
  ChevronLeft,
  ChevronRight,
  Download,
  Hand,
  HelpCircle,
  Pause,
  Play,
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
import { useFocusSession } from "@/components/focus-session-provider";
import { PaperNotesPanel } from "@/components/paper-notes-panel";
import { PaperPassSection } from "@/components/paper-pass-section";
import { OPEN_PASS_PANEL_EVENT } from "@/components/reading-check-in";
import { useReadingSitting } from "@/components/reading-sitting";
import { ReminderBanner } from "@/components/reminder-banner";
import { SoundscapeButton } from "@/components/soundscape-mixer";
import { useToast } from "@/components/toast-host";
import { generateHighlightCandidates } from "@/lib/ai/client";
import { createAnnotation, createAnnotationsBatch, deleteAnnotation, subscribeAnnotations, updateAnnotation } from "@/lib/firestore";
import {
  documentTextIndex,
  getPageTextIndex,
  loadPdfDocument,
  matchHighlightCandidates,
  mergeLineQuads,
  normalizeForMatch,
  pdfRectToViewport,
  quadFromItem,
  type PageTextIndex,
  type PdfDocumentProxy,
  type PdfTextItem
} from "@/lib/pdf-annotate";
import { buildAnnotatedPdfBytes, downloadPdfBytes } from "@/lib/pdf-export";
import { extractPdfOutlineTree, hasTextLayer, type OutlineNode } from "@/lib/pdf-outline";
import { nextReadingPass, PASS_LABELS, READER_PAGE_STORAGE_PREFIX, runningPass as runningPassOf } from "@/lib/papers";
import type { Annotation, FileRef, HighlightCategory, HighlightQuad, NewAnnotation, Paper, PomodoroSession } from "@/types";


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
/** Thumbnails are drawn about twice their on-screen width, so they stay sharp on a high-density display. */
const THUMB_WIDTH = 280;
const VIEW_MODE_STORAGE_KEY = "focusos-reading-view-mode";
const ZOOM_STORAGE_KEY = "focusos-reading-zoom";
const EMPTY_ANNOTATIONS: Annotation[] = [];

type ZoomMode = "fit-width" | "fit-page" | number;
type SidebarTab = "pass" | "outline" | "thumbnails" | "annotations" | "notes";
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

const SHORTCUTS: [string, string][] = [
  ["Space / Shift+Space", "Scroll a screen; at the page's end, turn it"],
  ["PgDn / PgUp", "Next / previous page"],
  ["Home / End", "First / last page"],
  ["Ctrl/Cmd+F or /", "Find"],
  ["Ctrl/Cmd + / − / 0", "Zoom in / out / 100%"],
  ["1–6", "Highlight colour (the open draft's, if any)"],
  ["S / H", "Select / hand tool"],
  ["Esc", "Cancel a draft, close find, then leave"]
];

const categoryLabel = (category: HighlightCategory) => category.charAt(0).toUpperCase() + category.slice(1);

let measureContext: CanvasRenderingContext2D | null = null;

/** How wide the browser draws `text` in the text layer's font, to stretch each span to the width the PDF gives it. */
function measuredTextWidth(text: string, fontSize: number): number {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return 0;
  measureContext.font = `${fontSize}px sans-serif`;
  return measureContext.measureText(text).width;
}

/**
 * The part of a text item's box that characters `from`..`to` are drawn in. Cut by measured width, not by character
 * count, since the text layer's span is the measured text stretched evenly to the item's width.
 */
function itemQuadBetween(item: PdfTextItem, from: number, to: number): HighlightQuad {
  const quad = quadFromItem(item);
  const whole = measuredTextWidth(item.str, 100);
  const at = (chars: number) => (whole > 0 ? measuredTextWidth(item.str.slice(0, chars), 100) / whole : chars / Math.max(1, item.str.length));
  const left = at(from);
  return { ...quad, x: quad.x + quad.width * left, width: quad.width * (at(to) - left) };
}

/**
 * Shared by the single-page and continuous-scroll paths: given a page's overlay element and its text index, turns the current window selection into a quote + merged highlight quads, or null if nothing selectable was touched.
 * A text item the selection starts or ends inside is cut at the selected characters (in proportion to its width), so a highlight
 * covers what was selected rather than the whole run of text pdf.js put in that item.
 */
function computeSelectionFromOverlay(overlay: HTMLDivElement, pageIndex: PageTextIndex): { quote: string; quads: HighlightQuad[] } | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;
  const text = selection.toString().trim();
  if (text.length < 6) return null;

  const range = selection.getRangeAt(0);
  const spans = Array.from(overlay.querySelectorAll<HTMLElement>("[data-item-index]")).filter((span) => range.intersectsNode(span));
  const entries = spans.flatMap((span) => {
    const itemIndex = Number(span.dataset.itemIndex);
    const item = pageIndex.items[itemIndex];
    const line = pageIndex.ranges.find((r) => r.itemIndex === itemIndex);
    if (!item || !line) return [];
    const length = item.str.length;
    const textNode = span.firstChild;
    const from = textNode && range.startContainer === textNode ? range.startOffset : 0;
    const to = textNode && range.endContainer === textNode ? range.endOffset : length;
    if (to <= from || length === 0) return [];
    return [{ lineIndex: line.lineIndex, text: item.str.slice(from, to), endsLine: item.hasEOL, quad: itemQuadBetween(item, from, to) }];
  });
  if (entries.length === 0) return null;

  // The text layer's spans sit side by side with nothing between lines, so the browser's own selection text runs
  // the last word of one line into the first of the next. Rebuilt from the items instead: a line break becomes a
  // space, or joins a word hyphenated across it.
  const quote = entries
    .reduce((joined, entry, i) => {
      const previous = entries[i - 1];
      if (!previous || !(previous.endsLine || previous.lineIndex !== entry.lineIndex)) return joined + entry.text;
      return joined.endsWith("-") ? joined.slice(0, -1) + entry.text : `${joined} ${entry.text}`;
    }, "")
    .replace(/\s+/g, " ")
    .trim();

  return { quote: quote.length >= text.length / 2 ? quote : text, quads: mergeLineQuads(entries) };
}

export function PaperReadingWindow({
  paper,
  pdfUrl,
  file,
  sessions = [],
  library = []
}: {
  paper: Paper;
  pdfUrl: string;
  file?: FileRef | null;
  sessions?: PomodoroSession[];
  library?: Paper[];
}) {
  const router = useRouter();
  const { user } = useAuth();
  const toast = useToast();
  const focus = useFocusSession();
  const { startSitting } = useReadingSitting();
  const [sittingMessage, setSittingMessage] = useState("");

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
  // A highlight picked in the sidebar: its page is scrolled to it and it's outlined for a moment. `seq` makes a
  // second click on the same card scroll again.
  const [focusedAnnotation, setFocusedAnnotation] = useState<{ id: string; seq: number } | null>(null);
  const focusSeqRef = useRef(0);

  const [viewMode, setViewModeState] = useState<ViewMode>("single");
  const [zoom, setZoomState] = useState<ZoomMode>("fit-width");
  const [scale, setScale] = useState(1);
  const [jumpInput, setJumpInput] = useState("1");
  const [tool, setTool] = useState<"select" | "hand">("select");
  const [activeCategory, setActiveCategory] = useState<HighlightCategory>("claim");

  const [sidebarOpen, setSidebarOpen] = useState(true);
  // plan/17 F10 — a pass can be finished here; open on it when one is under way.
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(() => (runningPassOf(paper) ? "pass" : "annotations"));

  const [outline, setOutline] = useState<OutlineNode[] | null>(null);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMatches, setFindMatches] = useState<FindMatch[]>([]);
  const [findActiveIndex, setFindActiveIndex] = useState(0);
  const [findLoading, setFindLoading] = useState(false);
  const docTextIndexRef = useRef<Promise<PageTextIndex[]> | null>(null);
  // Each keystroke starts a search; only the latest one may write its results.
  const findRunRef = useRef(0);
  // Bumped by every find step (a new search, Enter, the arrows), so a step always scrolls to its match, even when
  // it lands on the one already selected: with a single match, Enter is how you get back to it.
  const [findStep, setFindStep] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const docRef = useRef<PdfDocumentProxy | null>(null);
  const destroyRef = useRef<(() => Promise<void>) | null>(null);
  const panRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  const pageElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const visibilityRef = useRef<Map<number, number>>(new Map());
  const pageNumRef = useRef(pageNum);
  // The page is saved for the next visit only once the last visit's page has been read back, so opening the reader
  // doesn't overwrite it with page 1 first.
  const pageRestoredRef = useRef(false);
  const thumbsDrawnRef = useRef<Set<number>>(new Set());
  const activeThumbRef = useRef<HTMLButtonElement>(null);
  const shortcutsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    pageNumRef.current = pageNum;
  }, [pageNum]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
      if (stored === "single" || stored === "continuous") setViewModeState(stored);
      const storedZoom = localStorage.getItem(ZOOM_STORAGE_KEY);
      if (storedZoom === "fit-width" || storedZoom === "fit-page") setZoomState(storedZoom);
      else if (storedZoom && Number(storedZoom) >= 0.25 && Number(storedZoom) <= 3) setZoomState(Number(storedZoom));
    } catch {
      // Private-browsing/storage-blocked contexts just keep the default — not worth surfacing.
    }
  }, []);

  function setViewMode(mode: ViewMode) {
    setViewModeState(mode);
    // Out of continuous mode, the scroll offset belonged to the whole stack: start the one page at its top.
    if (mode === "single") requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0 }));
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // Same as above — a failed preference save shouldn't block switching modes.
    }
  }

  const setZoom = useCallback((update: ZoomMode | ((current: ZoomMode) => ZoomMode)) => {
    setZoomState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      try {
        localStorage.setItem(ZOOM_STORAGE_KEY, String(next));
      } catch {
        // A zoom that isn't remembered still applies.
      }
      return next;
    });
  }, []);

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
          // Open where the last visit left off.
          let lastPage = 1;
          try {
            lastPage = Number(window.localStorage.getItem(`${READER_PAGE_STORAGE_PREFIX}${paper.id}`)) || 1;
          } catch {
            // Storage blocked — start at the first page.
          }
          pageRestoredRef.current = true;
          setPageNum(Math.min(doc.numPages, Math.max(1, Math.floor(lastPage))));
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
    // paper.id is read once, for the page to open on; a different paper comes with a different pdfUrl.
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

  function scrollToPage(n: number, behavior: ScrollBehavior = "smooth") {
    const el = pageElsRef.current.get(n);
    const container = scrollRef.current;
    if (!el || !container) return;
    const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    container.scrollTo({ top: Math.max(0, top - 8), behavior });
  }

  // Puts continuous mode back on the current page whenever its page stack is laid out afresh: on switching into
  // the mode, once the document has loaded (the page the last visit ended on), and after a zoom, which moves
  // every page. Deliberately not on pageNum: that changes while the reader scrolls, and following it would fight them.
  useEffect(() => {
    if (viewMode !== "continuous" || !pdfDoc) return;
    const id = requestAnimationFrame(() => scrollToPage(pageNumRef.current, "auto"));
    return () => cancelAnimationFrame(id);
  }, [viewMode, pdfDoc, scale]);

  /** `at: "end"` lands on the bottom of the page — for paging backwards through a page taller than the screen. */
  const goToPage = useCallback(
    (n: number, at: "start" | "end" = "start") => {
      const clamped = Math.min(numPages, Math.max(1, n));
      setPageNum(clamped);
      setPending(null);
      if (viewMode === "continuous") requestAnimationFrame(() => scrollToPage(clamped));
      // Single-page mode swaps one page for another in the same box, so its scroll position has to be reset
      // by hand, or the next page opens wherever the last one was left: usually its bottom.
      else scrollRef.current?.scrollTo({ top: at === "end" ? scrollRef.current.scrollHeight : 0 });
    },
    [numPages, viewMode]
  );

  /** Space: a screen further down the page, and onto the next page from its end. Shift+Space goes back the same way. */
  function pageBySpace(back: boolean) {
    const container = scrollRef.current;
    if (!container) return;
    const step = container.clientHeight * 0.85;
    if (viewMode === "continuous") {
      container.scrollBy({ top: back ? -step : step, behavior: "smooth" });
      return;
    }
    const atEnd = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
    const atStart = container.scrollTop <= 4;
    if (!back && atEnd) {
      if (pageNumRef.current < numPages) goToPage(pageNumRef.current + 1);
    } else if (back && atStart) {
      if (pageNumRef.current > 1) goToPage(pageNumRef.current - 1, "end");
    } else container.scrollBy({ top: back ? -step : step, behavior: "smooth" });
  }

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

  /** The document's text, read once off the loaded document and shared by find and highlight matching. */
  function textIndex(): Promise<PageTextIndex[]> {
    if (!docRef.current) return Promise.reject(new Error("The PDF is still loading."));
    docTextIndexRef.current ??= documentTextIndex(docRef.current).catch((err) => {
      docTextIndexRef.current = null;
      throw err;
    });
    return docTextIndexRef.current;
  }

  async function saveManualHighlight() {
    if (!user || !pending) return;
    try {
      await createAnnotation(user.uid, paper.id, {
        page: pending.page,
        quads: pending.quads,
        quote: pending.quote,
        category: pendingCategory,
        note: pendingNote.trim() || undefined,
        source: "manual",
        matched: true
      });
    } catch (err) {
      toast({ message: `Couldn't save the highlight: ${err instanceof Error ? err.message : "try again."}`, tone: "error" });
      return;
    }
    setActiveCategory(pendingCategory);
    setPending(null);
    window.getSelection()?.removeAllRanges();
  }

  function cancelPending() {
    setPending(null);
    window.getSelection()?.removeAllRanges();
  }

  async function generateHighlights() {
    if (!user) return;
    setGenerating(true);
    setError("");
    try {
      const candidates = await generateHighlightCandidates(user, paper.id);
      // A second run asks again and mostly gets the same quotes back: keep only the ones not already here.
      const have = new Set(annotations.map((a) => normalizeForMatch(a.quote)));
      const fresh = candidates.filter((c) => !have.has(normalizeForMatch(c.quote)));
      if (fresh.length === 0) {
        toast({ message: candidates.length === 0 ? "No passages came back for this paper." : "Nothing new: every suggested passage is already highlighted." });
        return;
      }
      const { matched, unmatched } = matchHighlightCandidates(await textIndex(), fresh);
      const unmatchedAsAnnotations: NewAnnotation[] = unmatched.map((c) => ({
        quote: c.quote,
        category: c.category,
        note: c.note,
        layer: c.layer,
        source: "ai",
        matched: false
      }));
      await createAnnotationsBatch(user.uid, paper.id, [...matched, ...unmatchedAsAnnotations]);
      openSidebarTab("annotations");
      toast({
        message:
          unmatched.length === 0
            ? `Added ${matched.length} highlight${matched.length === 1 ? "" : "s"}.`
            : `Added ${matched.length} highlight${matched.length === 1 ? "" : "s"}. ${unmatched.length} passage${unmatched.length === 1 ? "" : "s"} couldn't be found in the PDF's text and ${unmatched.length === 1 ? "is" : "are"} listed at the end of Highlights.`
      });
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

  async function removeAnnotation(annotation: Annotation) {
    if (!user) return;
    const uid = user.uid;
    try {
      await deleteAnnotation(uid, paper.id, annotation.id);
    } catch (err) {
      toast({ message: `Couldn't remove the highlight: ${err instanceof Error ? err.message : "try again."}`, tone: "error" });
      return;
    }
    const { id, createdAt, ...rest } = annotation;
    toast({
      message: "Highlight removed.",
      action: {
        label: "Undo",
        onClick: () => {
          createAnnotation(uid, paper.id, rest).catch(() => toast({ message: "Couldn't bring the highlight back.", tone: "error" }));
        }
      }
    });
  }

  async function editAnnotation(annotation: Annotation, patch: Pick<Partial<Annotation>, "category" | "note">) {
    if (!user) return;
    try {
      // An emptied note is removed with an empty string: `updateAnnotation` drops undefined fields rather than deleting them.
      await updateAnnotation(user.uid, paper.id, annotation.id, patch);
    } catch (err) {
      toast({ message: `Couldn't change the highlight: ${err instanceof Error ? err.message : "try again."}`, tone: "error" });
    }
  }

  function showAnnotation(annotation: Annotation) {
    if (!annotation.page) return;
    if (annotation.page !== pageNum) goToPage(annotation.page);
    focusSeqRef.current += 1;
    setFocusedAnnotation({ id: annotation.id, seq: focusSeqRef.current });
  }

  useEffect(() => {
    if (!focusedAnnotation) return;
    const id = window.setTimeout(() => setFocusedAnnotation(null), 2000);
    return () => window.clearTimeout(id);
  }, [focusedAnnotation]);

  /** A typed page goes there (clamped to the document); anything unusable puts the box back to the page you're on. */
  function commitJump() {
    const typed = Number(jumpInput);
    if (typed >= 1 && typed !== pageNum) goToPage(typed);
    else setJumpInput(String(pageNum));
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
    const run = ++findRunRef.current;
    if (!query.trim()) {
      setFindMatches([]);
      setFindLoading(false);
      return;
    }
    setFindLoading(true);
    try {
      const pages = await textIndex();
      if (run !== findRunRef.current) return;
      const normalizedQuery = normalizeForMatch(query);
      const matches: FindMatch[] = [];
      pages.forEach((page) => {
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
      setFindStep((n) => n + 1);
      if (matches.length > 0) goToPage(matches[0].page);
    } finally {
      setFindLoading(false);
    }
  }
  function findNext() {
    if (findMatches.length === 0) return;
    const next = (findActiveIndex + 1) % findMatches.length;
    setFindActiveIndex(next);
    setFindStep((n) => n + 1);
    goToPage(findMatches[next].page);
  }
  function findPrev() {
    if (findMatches.length === 0) return;
    const prev = (findActiveIndex - 1 + findMatches.length) % findMatches.length;
    setFindActiveIndex(prev);
    setFindStep((n) => n + 1);
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

  // Draws the page thumbnails one after another while the Pages tab is open. Which pages are done lives in a ref,
  // not in the effect's dependencies: depending on the thumbnails themselves restarted (and cancelled) the run
  // after every page, and the grid stopped at the second one.
  useEffect(() => {
    if (sidebarTab !== "thumbnails" || !pdfDoc) return;
    let cancelled = false;
    (async () => {
      for (let n = 1; n <= numPages; n += 1) {
        if (cancelled) return;
        if (thumbsDrawnRef.current.has(n)) continue;
        try {
          const page = await pdfDoc.getPage(n);
          const thumbViewport = page.getViewport({ scale: THUMB_WIDTH / page.getViewport({ scale: 1 }).width });
          const offscreen = document.createElement("canvas");
          offscreen.width = thumbViewport.width;
          offscreen.height = thumbViewport.height;
          const ctx = offscreen.getContext("2d");
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport: thumbViewport, canvas: offscreen }).promise;
          const dataUrl = offscreen.toDataURL("image/png");
          thumbsDrawnRef.current.add(n);
          setThumbnails((prev) => ({ ...prev, [n]: dataUrl }));
        } catch {
          // Skip a page that fails to render a thumbnail rather than failing the whole grid.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sidebarTab, pdfDoc, numPages]);

  // The shortcuts card closes on a click anywhere outside it, as well as on Esc.
  useEffect(() => {
    if (!shortcutsOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (!shortcutsRef.current?.contains(e.target as Node)) setShortcutsOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [shortcutsOpen]);

  // Opening the Pages tab shows the page you're on, not the top of the grid.
  useEffect(() => {
    if (sidebarTab === "thumbnails" && sidebarOpen) activeThumbRef.current?.scrollIntoView({ block: "nearest" });
  }, [sidebarTab, sidebarOpen]);

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
      // One step back per press: a highlight draft, then the shortcuts card, then find, and only then out of the reader.
      if (e.key === "Escape") {
        if (pending) {
          cancelPending();
          return;
        }
        if (shortcutsOpen) {
          setShortcutsOpen(false);
          return;
        }
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
      // The single-key shortcuts below belong to the reader alone: Cmd+S, Ctrl+1 and the like are the browser's.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        openFind();
        return;
      }
      // Paging would silently discard an in-progress highlight draft (the
      // popup's category/note form) via goToPage's setPending(null) — block it
      // until the draft is saved or explicitly cancelled.
      if (!pending) {
        if (e.key === " ") {
          e.preventDefault();
          pageBySpace(e.shiftKey);
          return;
        }
        if (e.key === "PageDown") {
          e.preventDefault();
          if (pageNumRef.current < numPages) goToPage(pageNumRef.current + 1);
          return;
        }
        if (e.key === "PageUp") {
          e.preventDefault();
          if (pageNumRef.current > 1) goToPage(pageNumRef.current - 1);
          return;
        }
        if (e.key === "Home") {
          e.preventDefault();
          goToPage(1);
          return;
        }
        if (e.key === "End") {
          e.preventDefault();
          goToPage(numPages);
          return;
        }
      }
      if (/^[1-6]$/.test(e.key)) {
        const category = CATEGORIES[Number(e.key) - 1];
        if (pending) setPendingCategory(category);
        else setActiveCategory(category);
        return;
      }
      if (pending && e.key === "Enter") {
        e.preventDefault();
        void saveManualHighlight();
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
  }, [findOpen, shortcutsOpen, numPages, paper.id, router, pending, pendingCategory, pendingNote, goToPage]);

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

  const passHere = runningPassOf(paper) ?? nextReadingPass(paper);

  // plan/17 §5.5 — the reader no longer runs a clock of its own. It used to log a "free reading"
  // session for however long the window was open (idle tab included) whenever no pass was running,
  // a third clock beside the pass timer and the focus timer. Reading here is now a focus sitting,
  // started from the toolbar or from wherever the sitting began; this window just shows it.

  // plan/17 §5.4 — "Yes, this pass is done" in the end-of-sitting check-in opens the pass's endings here.
  useEffect(() => {
    function openPass() {
      setSidebarOpen(true);
      setSidebarTab("pass");
    }
    window.addEventListener(OPEN_PASS_PANEL_EVENT, openPass);
    return () => window.removeEventListener(OPEN_PASS_PANEL_EVENT, openPass);
  }, []);

  // The end-of-sitting check-in prefills "where did you get to?" from the page you're on, and the next visit opens on it.
  useEffect(() => {
    if (!pageRestoredRef.current) return;
    try {
      window.localStorage.setItem(`${READER_PAGE_STORAGE_PREFIX}${paper.id}`, String(pageNum));
    } catch {
      // Storage blocked — the check-in just asks without a prefill.
    }
  }, [paper.id, pageNum]);

  const annotationsByPageMap = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    annotations
      .filter((a) => a.matched && a.page)
      .forEach((a) => map.set(a.page!, [...(map.get(a.page!) ?? []), a]));
    return map;
  }, [annotations]);
  // Top of the page first within a page (PDF y grows upwards), so the list reads in the order the paper does.
  const annotationsByPage = useMemo(
    () =>
      Array.from(annotationsByPageMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([page, list]) => [page, [...list].sort((a, b) => (b.quads?.[0]?.y ?? 0) - (a.quads?.[0]?.y ?? 0))] as const),
    [annotationsByPageMap]
  );
  const unmatchedAnnotations = annotations.filter((a) => !a.matched);

  const activeFindMatch = findMatches[findActiveIndex] ?? null;
  // One object per find step, so the page's scroll-to-match effect fires when the reader moves through matches and
  // not on every render.
  const activeFindTarget = useMemo(
    () => (activeFindMatch ? { query: findQuery, index: activeFindMatch.index } : null),
    [activeFindMatch, findStep]
  );
  const pageList = viewMode === "continuous" ? Array.from({ length: numPages }, (_, i) => i + 1) : [pageNum];

  return (
    <div className="flex h-screen w-screen flex-col bg-white text-ink-900 dark:bg-ink-950 dark:text-ink-50">
      {/* plan/18 §5.3 — the reader is outside the app shell, so it shows the shell's reminder banner itself. */}
      <ReminderBanner />
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-ink-50 px-3 py-2 dark:border-ink-800 dark:bg-ink-900">
        <div className="flex min-w-0 items-center gap-2">
          <button className="btn-secondary px-2 py-1.5" onClick={() => router.push(`/papers/${paper.id}`)} aria-label="Close reading window">
            <X className="h-4 w-4" />
          </button>
          <span className="max-w-[16rem] truncate text-sm font-medium sm:max-w-[24rem]" title={paper.title}>
            {paper.title}
          </span>
          <SittingReadout
            paper={paper}
            focus={focus}
            onStart={async () => {
              setSittingMessage("");
              const result = await startSitting({ paper, library, sessions, navigate: false });
              if (result === "busy") setSittingMessage("Another focus session is running");
              if (result === "needsGoal") {
                setSittingMessage("Pick a reading goal first");
                openSidebarTab("pass");
              }
            }}
            message={sittingMessage}
          />
        </div>

        <div className="ml-auto flex items-center gap-2 text-sm">
          <SoundscapeButton />
          <button className="btn-secondary px-2" onClick={() => goToPage(pageNum - 1)} disabled={pageNum <= 1} aria-label="Previous page">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <input
            className="input w-12 py-1 text-center text-xs"
            inputMode="numeric"
            aria-label="Page number"
            value={jumpInput}
            onChange={(e) => setJumpInput(e.target.value.replace(/\D/g, ""))}
            onBlur={commitJump}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
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
            aria-label="Zoom"
            value={typeof zoom === "number" ? String(zoom) : zoom}
            onChange={(e) => setZoom(e.target.value === "fit-width" || e.target.value === "fit-page" ? (e.target.value as ZoomMode) : Number(e.target.value))}
          >
            <option value="fit-width">Fit width</option>
            <option value="fit-page">Fit page</option>
            {/* Ctrl/Cmd +/− can land between the listed steps; the menu still has to show where it is. */}
            {(typeof zoom === "number" && !ZOOM_STEPS.includes(zoom) ? [...ZOOM_STEPS, zoom].sort((a, b) => a - b) : ZOOM_STEPS).map((p) => (
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
              title={`${categoryLabel(category)} (${i + 1})`}
              aria-label={`Highlight as ${category}`}
              aria-pressed={activeCategory === category}
            />
          ))}
          <span className="hidden w-16 text-xs text-ink-500 xl:inline">{categoryLabel(activeCategory)}</span>
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
          <div className="relative" ref={shortcutsRef}>
            <button
              className={`btn-secondary px-2 ${shortcutsOpen ? "ring-2 ring-moss-500" : ""}`}
              onClick={() => setShortcutsOpen((open) => !open)}
              aria-label="Keyboard shortcuts"
              aria-expanded={shortcutsOpen}
              title="Keyboard shortcuts"
            >
              <HelpCircle className="h-3.5 w-3.5" />
            </button>
            {shortcutsOpen ? (
              <div className="absolute right-0 top-full z-30 mt-2 w-80 rounded-md border border-ink-200 bg-white p-3 text-xs shadow-soft dark:border-ink-700 dark:bg-ink-900">
                <p className="label mb-2">Keyboard shortcuts</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                  {SHORTCUTS.map(([keys, action]) => (
                    <div key={keys} className="contents">
                      <dt className="whitespace-nowrap font-mono text-ink-700 dark:text-ink-200">{keys}</dt>
                      <dd className="text-ink-500">{action}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {findOpen ? (
        <div className="flex items-center gap-2 border-b border-ink-200 bg-white px-3 py-2 text-sm dark:border-ink-800 dark:bg-ink-900">
          <input
            ref={findInputRef}
            className="input max-w-xs py-1 text-xs"
            placeholder="Find in document..."
            aria-label="Find in document"
            value={findQuery}
            onChange={(e) => runFind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.shiftKey ? findPrev() : findNext());
            }}
          />
          <button className="btn-secondary px-2 py-1" onClick={findPrev} disabled={findMatches.length === 0} aria-label="Previous match" title="Previous match (Shift+Enter)">
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button className="btn-secondary px-2 py-1" onClick={findNext} disabled={findMatches.length === 0} aria-label="Next match" title="Next match (Enter)">
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <span className="text-xs text-ink-500" aria-live="polite">
            {findLoading
              ? "Searching..."
              : !findQuery.trim()
                ? ""
                : findMatches.length === 0
                  ? "No matches"
                  : `${findActiveIndex + 1} of ${findMatches.length} · page ${findMatches[findActiveIndex].page}`}
          </span>
          <button className="ml-auto btn-secondary px-2 py-1" onClick={closeFind} aria-label="Close find">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 border-b border-ink-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-ink-800 dark:bg-red-950 dark:text-red-200">
          <p className="flex-1">{error}</p>
          <button onClick={() => setError("")} aria-label="Dismiss" className="shrink-0 hover:opacity-70">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
      {textLayerOk === false ? (
        <p className="border-b border-ink-200 bg-ink-50 px-3 py-1.5 text-xs text-ink-500 dark:border-ink-800 dark:bg-ink-900">
          This PDF has no extractable text layer (it looks scanned) — you can still read and navigate it, but selecting text to highlight won&apos;t work.
        </p>
      ) : null}

      {/* Body — the PDF itself always renders; only text-selection-based highlighting depends on a text layer. */}
      <div className="flex min-h-0 flex-1">
        {/* The highlight draft sits beside the scroller, not in it, so it stays on screen however far the page is scrolled. */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
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
                  activeFindMatch={activeFindMatch?.page === p ? activeFindTarget : null}
                  focusedAnnotation={focusedAnnotation}
                  onSelect={handlePageSelect}
                  onVisibilityChange={reportVisibility}
                  registerEl={registerPageEl}
                />
              ))}
            </div>
          )}
        </div>

          {pending ? (
            <div className="absolute bottom-4 left-1/2 z-20 w-[min(30rem,calc(100%-2rem))] -translate-x-1/2 space-y-2 rounded-md border border-ink-200 bg-white p-3 text-sm shadow-soft dark:border-ink-700 dark:bg-ink-900">
              <p className="line-clamp-2 text-xs text-ink-500">
                Page {pending.page} · &ldquo;{pending.quote}&rdquo;
              </p>
              <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Highlight category">
                {CATEGORIES.map((category, i) => (
                  <button
                    key={category}
                    role="radio"
                    aria-checked={pendingCategory === category}
                    className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
                      pendingCategory === category ? "border-moss-600 ring-1 ring-moss-500" : "border-ink-200 text-ink-600 dark:border-ink-700 dark:text-ink-300"
                    }`}
                    onClick={() => setPendingCategory(category)}
                    title={`${categoryLabel(category)} (${i + 1})`}
                  >
                    <span className="h-3 w-3 rounded-sm" style={{ background: CATEGORY_COLORS[category] }} />
                    {categoryLabel(category)}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  className="input flex-1 py-1 text-xs"
                  placeholder="Note (optional)"
                  aria-label="Highlight note"
                  value={pendingNote}
                  onChange={(e) => setPendingNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveManualHighlight();
                    if (e.key === "Escape") cancelPending();
                  }}
                />
                <button className="btn-secondary px-2 py-1 text-xs" onClick={cancelPending} title="Cancel (Esc)">
                  Cancel
                </button>
                <button className="btn-primary px-2 py-1 text-xs" onClick={saveManualHighlight} title="Save (Enter)">
                  Save highlight
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {sidebarOpen ? (
          <aside className="flex w-full max-w-xs shrink-0 flex-col border-l border-ink-200 dark:border-ink-800">
            <div className="flex border-b border-ink-200 text-xs dark:border-ink-800">
              <SidebarTabButton active={sidebarTab === "pass"} onClick={() => openSidebarTab("pass")} icon={<BookOpenCheck className="h-3.5 w-3.5" />} label="Pass" />
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
              {sidebarTab === "pass" ? (
                passHere ? (
                  <div className="space-y-2">
                    <p className="label">{PASS_LABELS[passHere]}</p>
                    <PaperPassSection paper={paper} passNo={passHere} file={file ?? null} sessions={sessions} library={library} compact />
                  </div>
                ) : (
                  <p className="text-xs text-ink-500">No pass is owed on this paper right now — its page has the details.</p>
                )
              ) : null}
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
                      ref={n === pageNum ? activeThumbRef : undefined}
                      aria-label={`Go to page ${n}`}
                      aria-current={n === pageNum ? "page" : undefined}
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
                    <p className="text-xs text-ink-500">
                      No highlights yet. Select text on the page to add one, or use Generate in the toolbar to have passages suggested.
                    </p>
                  ) : (
                    annotationsByPage.map(([page, list]) => (
                      <div key={page}>
                        <button className="label mb-1 hover:text-moss-700 dark:hover:text-moss-400" onClick={() => goToPage(page)}>
                          Page {page}
                        </button>
                        <div className="space-y-1.5">
                          {list.map((annotation) => (
                            <HighlightCard
                              key={annotation.id}
                              annotation={annotation}
                              focused={focusedAnnotation?.id === annotation.id}
                              onShow={() => showAnnotation(annotation)}
                              onEdit={(patch) => editAnnotation(annotation, patch)}
                              onRemove={() => removeAnnotation(annotation)}
                            />
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                  {unmatchedAnnotations.length > 0 ? (
                    <div className="space-y-1.5 pt-2">
                      <p className="label">Not found in the PDF&apos;s text</p>
                      <p className="text-[11px] text-ink-500">Suggested passages that couldn&apos;t be placed on a page, often because of maths, tables or rewrapped lines.</p>
                      {unmatchedAnnotations.map((annotation) => (
                        <HighlightCard
                          key={annotation.id}
                          annotation={annotation}
                          focused={false}
                          onEdit={(patch) => editAnnotation(annotation, patch)}
                          onRemove={() => removeAnnotation(annotation)}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {sidebarTab === "notes" ? <PaperNotesPanel paperId={paper.id} anchor={{ page: pageNum, quote: pending?.quote }} onJump={goToPage} onAdded={pending ? cancelPending : undefined} compact /> : null}
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
  focusedAnnotation,
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
  focusedAnnotation: { id: string; seq: number } | null;
  onSelect: (page: number, quote: string, quads: HighlightQuad[]) => void;
  onVisibilityChange: (page: number, ratio: number) => void;
  registerEl: (page: number, el: HTMLDivElement | null) => void;
}) {
  const [active, setActive] = useState(forceActive);
  const [pageIndex, setPageIndex] = useState<PageTextIndex | null>(null);
  const [viewport, setViewport] = useState<{ width: number; height: number; convertToViewportPoint: (x: number, y: number) => number[] } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const findMarkRef = useRef<HTMLDivElement>(null);

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

  /**
   * plan/17 F9 — the in-flight render on this page's canvas. The page first renders at the provisional
   * scale (1) and is re-rendered a moment later at the fit-width scale; without cancelling the first
   * render, the second resized the canvas underneath it and started another render on the same
   * canvas — pdf.js's "Cannot use the same canvas during multiple render() operations", and a page
   * drawn mirrored, upside down and at thumbnail size until the zoom was changed by hand.
   */
  const renderTaskRef = useRef<{ cancel: () => void; promise: Promise<unknown> } | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    (async () => {
      // Let the previous render finish cancelling (cleanup below already called cancel) before this
      // one touches the canvas — resizing a canvas mid-render is what corrupted it.
      const previous = renderTaskRef.current;
      if (previous) {
        previous.cancel();
        await previous.promise.catch(() => undefined);
      }
      if (cancelled) return;
      const page = await doc.getPage(pageNum);
      const pageViewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;
      // Drawn at the display's pixel density and shown at CSS size, or text is soft on a high-density screen.
      // Capped so a large zoom on a 3x display doesn't ask for a canvas the browser refuses to allocate.
      const density = Math.min(window.devicePixelRatio || 1, Math.sqrt(16_000_000 / (pageViewport.width * pageViewport.height)), 3);
      canvas.width = Math.floor(pageViewport.width * density);
      canvas.height = Math.floor(pageViewport.height * density);
      canvas.style.width = `${pageViewport.width}px`;
      canvas.style.height = `${pageViewport.height}px`;
      const task = page.render({ canvas, viewport: pageViewport, transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0] });
      renderTaskRef.current = task;
      try {
        await task.promise;
      } catch (err) {
        // A cancelled render is the expected end of a superseded one, not a failure.
        if (err instanceof Error && err.name === "RenderingCancelledException") return;
        throw err;
      } finally {
        if (renderTaskRef.current === task) renderTaskRef.current = null;
      }
      if (cancelled) return;
      setViewport(pageViewport);
      setPageIndex(await getPageTextIndex(doc, pageNum));
    })();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
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
    const start = activeFindMatch.index;
    const end = start + normalizedQuery.length;
    // Only the matched characters of the first and last items, as with a selection. The match offset is into the
    // whitespace-collapsed text, so on a page with runs of spaces this can sit a character or two off.
    return mergeLineQuads(
      pageIndex.ranges
        .filter((r) => r.start < end && r.end > start)
        .map((r) => {
          const item = pageIndex.items[r.itemIndex];
          const from = Math.max(0, start - r.start);
          const to = Math.min(item.str.length, end - r.start);
          return { lineIndex: r.lineIndex, quad: to > from ? itemQuadBetween(item, from, to) : quadFromItem(item) };
        })
    );
  }, [activeFindMatch, pageIndex]);

  // The match the find bar is on is brought into view once this page has placed it: turning to its page alone
  // left it wherever the page's scroll position happened to be. Once per match: the page redraws (and recomputes
  // its quads) on zoom, on a sidebar toggle and on scrolling back into range, and none of those should pull the
  // reader back to a match they've already seen and moved on from.
  const scrolledToMatchRef = useRef<{ query: string; index: number } | null>(null);
  useEffect(() => {
    if (findQuads.length === 0 || scrolledToMatchRef.current === activeFindMatch) return;
    scrolledToMatchRef.current = activeFindMatch;
    findMarkRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [findQuads, activeFindMatch]);

  useEffect(() => {
    if (!focusedAnnotation || !viewport) return;
    overlayRef.current?.querySelector(`[data-annotation-id="${CSS.escape(focusedAnnotation.id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusedAnnotation, viewport]);

  // The invisible text that selection runs over. Each run of text is stretched to the width the PDF gives it, so
  // what you select lines up with the printed words under it. Memoised: continuous mode re-renders every page as
  // you scroll, and a page can carry a few thousand of these.
  const textSpans = useMemo(() => {
    if (!viewport || !pageIndex) return null;
    return pageIndex.items.map((item, itemIndex) => {
      if (!item.str.trim()) return null;
      const rect = pdfRectToViewport(viewport, { x: item.transform[4], y: item.transform[5], width: item.width, height: item.height });
      const natural = measuredTextWidth(item.str, rect.height);
      return (
        <span
          key={itemIndex}
          data-item-index={itemIndex}
          style={{
            position: "absolute",
            left: rect.left,
            top: rect.top,
            fontSize: rect.height,
            fontFamily: "sans-serif",
            lineHeight: 1,
            color: "transparent",
            whiteSpace: "pre",
            cursor: "text",
            userSelect: "text",
            transformOrigin: "0 0",
            transform: natural > 0 && rect.width > 0 ? `scaleX(${rect.width / natural})` : undefined
          }}
        >
          {item.str}
        </span>
      );
    });
  }, [viewport, pageIndex]);

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
      <div ref={overlayRef} className="pdf-text-layer absolute inset-0 overflow-clip" style={{ pointerEvents: tool === "hand" ? "none" : "auto" }}>
        {textSpans}
        {matchedAnnotations.map((annotation) =>
          (annotation.quads ?? []).map((quad, i) => {
            const rect = pdfRectToViewport(viewport, quad);
            const focused = focusedAnnotation?.id === annotation.id;
            return (
              <div
                key={`${annotation.id}-${i}`}
                data-annotation-id={i === 0 ? annotation.id : undefined}
                style={{
                  position: "absolute",
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                  background: CATEGORY_COLORS[annotation.category],
                  // Multiplied onto the page like a marker, so the words under a highlight stay black.
                  mixBlendMode: "multiply",
                  outline: focused ? "2px solid rgb(22, 101, 52)" : undefined,
                  outlineOffset: 1,
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
              ref={i === 0 ? findMarkRef : undefined}
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

/** One highlight in the sidebar: its passage (click to see it on the page), its category and note, both editable in place. */
function HighlightCard({
  annotation,
  focused,
  onShow,
  onEdit,
  onRemove
}: {
  annotation: Annotation;
  focused: boolean;
  onShow?: () => void;
  onEdit: (patch: Pick<Partial<Annotation>, "category" | "note">) => void;
  onRemove: () => void;
}) {
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(annotation.note ?? "");
  // Esc closes the box without saving, whether or not the browser also reports a blur as it goes.
  const discardRef = useRef(false);

  function saveNote() {
    setEditingNote(false);
    if (discardRef.current) {
      discardRef.current = false;
      return;
    }
    const next = noteDraft.trim();
    if (next !== (annotation.note ?? "")) onEdit({ note: next });
  }

  return (
    <div className={`card space-y-1.5 p-2 text-xs ${annotation.matched ? "" : "border-dashed"} ${focused ? "ring-2 ring-moss-500" : ""}`}>
      <div className="flex items-center gap-1.5">
        <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: CATEGORY_COLORS[annotation.category] }} />
        <select
          className="min-w-0 flex-1 cursor-pointer appearance-none border-0 bg-transparent p-0 text-xs font-medium focus:ring-0"
          value={annotation.category}
          onChange={(e) => onEdit({ category: e.target.value as HighlightCategory })}
          aria-label="Highlight category"
        >
          {CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {categoryLabel(category)}
            </option>
          ))}
        </select>
        {annotation.source === "ai" ? <span className="text-[10px] text-ink-400">suggested</span> : null}
        <button className="text-ink-400 hover:text-red-600" onClick={onRemove} aria-label="Remove highlight" title="Remove highlight">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {onShow ? (
        <button className="block w-full text-left text-ink-600 hover:text-moss-700 dark:text-ink-300 dark:hover:text-moss-400" onClick={onShow} title="Show on the page">
          <span className="line-clamp-4 break-words">&ldquo;{annotation.quote}&rdquo;</span>
        </button>
      ) : (
        <p className="line-clamp-4 break-words text-ink-600 dark:text-ink-300">&ldquo;{annotation.quote}&rdquo;</p>
      )}
      {editingNote ? (
        <textarea
          className="input min-h-[3.5rem] py-1 text-xs"
          autoFocus
          value={noteDraft}
          placeholder="A note on this passage"
          onChange={(e) => setNoteDraft(e.target.value)}
          onBlur={saveNote}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              discardRef.current = true;
              e.currentTarget.blur();
            }
          }}
        />
      ) : annotation.note ? (
        <button
          className="block w-full whitespace-pre-wrap break-words rounded bg-ink-50 px-1.5 py-1 text-left text-ink-700 hover:bg-ink-100 dark:bg-ink-800 dark:text-ink-200 dark:hover:bg-ink-700"
          onClick={() => {
            setNoteDraft(annotation.note ?? "");
            setEditingNote(true);
          }}
          title="Edit note"
        >
          {annotation.note}
        </button>
      ) : (
        <button
          className="text-ink-400 hover:text-moss-700 dark:hover:text-moss-400"
          onClick={() => {
            setNoteDraft("");
            setEditingNote(true);
          }}
        >
          Add a note
        </button>
      )}
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

/**
 * plan/17 §5.4 step 2 — the one timer, in the reader's toolbar: the running focus sitting with pause
 * and finish when it's on this paper, otherwise a button that starts one (and the pass it owes).
 * Replaces the pass's wall-clock `PassTimer`, which counted from when the pass first started.
 */
function SittingReadout({
  paper,
  focus,
  onStart,
  message
}: {
  paper: Paper;
  focus: ReturnType<typeof useFocusSession>;
  onStart: () => void;
  message: string;
}) {
  const here = focus.focusInProgress && focus.paperId === paper.id;
  if (here) {
    const minutes = Math.floor(focus.secondsLeft / 60);
    const seconds = focus.secondsLeft % 60;
    return (
      <div className="flex items-center gap-1.5 rounded-md bg-moss-600/10 px-2 py-1 text-xs">
        <span className="font-medium text-moss-700 dark:text-moss-400">{focus.passNo ? PASS_LABELS[focus.passNo] : "Reading"}</span>
        <span className="font-mono tabular-nums">
          {minutes}:{String(seconds).padStart(2, "0")}
        </span>
        <button className="btn-secondary px-1.5 py-0.5" onClick={focus.toggleRunning} aria-label={focus.running ? "Pause sitting" : "Resume sitting"}>
          {focus.running ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
        </button>
        <button className="btn-secondary px-2 py-0.5 text-xs" onClick={focus.finishNow}>
          Finish
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <button className="btn-primary px-2 py-1 text-xs" onClick={onStart} disabled={focus.focusInProgress} title={focus.focusInProgress ? "Another focus session is in progress" : undefined}>
        <Play className="h-3 w-3" />
        Start a sitting
      </button>
      {message ? <span className="text-xs text-amber-700 dark:text-amber-400">{message}</span> : null}
    </div>
  );
}
