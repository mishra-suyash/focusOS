"use client";

import { clsx } from "clsx";
import { PictureInPicture2 } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FloatingWidgetContent } from "@/components/floating-widget-content";

const MIN_WIDTH = 240;
const MIN_HEIGHT = 200;
// The browser's own title bar (origin + close button) is fixed-height chrome we can't resize or
// hide — Document PiP reserves it as real space, not a hover overlay like video PiP (see
// WICG/document-picture-in-picture#32, unresolved). Sized to comfortably fit all four widget
// cards (timer, current focus, hydration nudge, Load Index) at their default on state.
const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 420;
const SIZE_STORAGE_KEY = "focusos-pip-size";

/** Per-device window placement, not a synced preference — see plan doc §4/§6: the PiP window's own size is the OS window manager's business, not something to fight by round-tripping through Firestore. */
function readStoredSize(): { width: number; height: number } {
  try {
    const raw = window.localStorage.getItem(SIZE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { width?: number; height?: number };
      if (typeof parsed.width === "number" && typeof parsed.height === "number") {
        return { width: Math.max(MIN_WIDTH, parsed.width), height: Math.max(MIN_HEIGHT, parsed.height) };
      }
    }
  } catch {
    // localStorage can be unavailable (private browsing) — fall through to the default size.
  }
  return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

function writeStoredSize(width: number, height: number) {
  try {
    window.localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify({ width, height }));
  } catch {
    // Not fatal — the window still closes fine, it just reopens at the default size next time.
  }
}

/** The PiP window starts with a blank document — no stylesheet, no dark-mode class. Clone both
 * (Next.js injects `<style>` tags in dev and `<link rel=stylesheet>` in prod, so both are copied)
 * and mirror `document.documentElement`'s "dark" class before the portal's first paint, or the
 * widget briefly renders unstyled/light regardless of the main window's theme. */
function primePipDocument(target: Document) {
  document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
    target.head.append(node.cloneNode(true));
  });
  target.documentElement.classList.toggle("dark", document.documentElement.classList.contains("dark"));
  target.documentElement.style.height = "100%";
  target.body.style.height = "100%";
  target.body.style.margin = "0";
}

/** Entry point for the floating focus widget — feature-detects the Document Picture-in-Picture
 * API (Chromium only) and renders nothing when it's unsupported, rather than offering a fake
 * in-page "floating" fallback that wouldn't survive a tab switch (plan doc §1.2). */
export function FloatingWidgetButton() {
  const [supported, setSupported] = useState(false);
  const [pipWindow, setPipWindow] = useState<Window | null>(null);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && "documentPictureInPicture" in window);
  }, []);

  useEffect(() => {
    if (!pipWindow) return;
    function handlePagehide() {
      writeStoredSize(pipWindow!.innerWidth, pipWindow!.innerHeight);
      setPipWindow(null);
    }
    pipWindow.addEventListener("pagehide", handlePagehide);
    return () => pipWindow.removeEventListener("pagehide", handlePagehide);
  }, [pipWindow]);

  async function openOrFocus() {
    if (!window.documentPictureInPicture) return;
    if (pipWindow) {
      pipWindow.focus();
      return;
    }
    // `disallowReturnToOpener` hides the browser's "back to tab" arrow (Chrome 124+; older
    // Chromium versions just ignore the unrecognized option). The origin/title text and the
    // window's own close button are NOT hideable through this API at all — Chromium always shows
    // them on every Document PiP window, from every site, as an anti-spoofing measure so a user
    // can never be tricked about which page is controlling a floating window. A small close
    // control is added in the body below as a themed-looking convenience, not a replacement.
    const next = await window.documentPictureInPicture.requestWindow({ ...readStoredSize(), disallowReturnToOpener: true });
    primePipDocument(next.document);
    setPipWindow(next);
  }

  if (!supported) return null;

  return (
    <>
      <button
        className="btn-secondary px-2"
        onClick={openOrFocus}
        aria-label={pipWindow ? "Bring floating widget forward" : "Float focus widget"}
        title={pipWindow ? "Bring floating widget forward" : "Float focus widget"}
      >
        <PictureInPicture2 className={clsx("h-4 w-4", pipWindow && "text-moss-600")} />
      </button>
      {pipWindow ? createPortal(<FloatingWidgetContent onClose={() => pipWindow.close()} />, pipWindow.document.body) : null}
    </>
  );
}
