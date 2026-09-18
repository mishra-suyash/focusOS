/** Chromium-only Document Picture-in-Picture API (Chrome/Edge/Arc/Dia ≥ 116) — not yet in TS's lib.dom.d.ts. Feature-detected at call sites via `"documentPictureInPicture" in window`. */
interface DocumentPictureInPicture extends EventTarget {
  requestWindow(options?: { width?: number; height?: number; disallowReturnToOpener?: boolean }): Promise<Window>;
  readonly window: Window | null;
}

interface Window {
  documentPictureInPicture?: DocumentPictureInPicture;
}
