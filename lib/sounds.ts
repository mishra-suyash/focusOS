import type { CueName } from "@/lib/cues";

/**
 * plan/18 §5.2 — every sound FocusOS makes: the cues, and the background-sound mixer's loops. Each
 * one is a public-domain or CC-BY recording in `public/sounds/` (sources and licences in
 * `public/sounds/CREDITS.md`), played through a plain `<audio>` element. Cues are Ogg where the
 * browser plays it, otherwise the AAC copy beside it (Safari); the mixer's loops are AAC only.
 *
 * Browsers refuse to play audio until the page has had a user gesture. `installAudioUnlock` notes the
 * first pointer or key press, and `audioReady()` is what every caller checks before competing to
 * play: a tab that can't play yet would win the cross-tab claim and then play nothing (plan/18 C1).
 *
 * Never played from inside the Picture-in-Picture document — sound comes from the main document,
 * the same rule as notifications (plan/16 §5.7). The PiP only forwards its clicks to `unlockAudio`.
 */

/** Fired on `window` the first time this document may play audio, so a cue waiting on a gesture can retry. */
export const AUDIO_UNLOCKED_EVENT = "focusos-audio-unlocked";

const CUE_FILES: Record<CueName, string> = {
  sessionEnd: "session-end",
  breakEnd: "break-end",
  headsUp: "heads-up",
  reminder: "reminder",
  blockClosed: "block-closed"
};

let extension: "ogg" | "m4a" | null = null;
let gestured = false;
const cueElements = new Map<CueName, HTMLAudioElement>();

/** `name` with an extension is used as is (the mixer's `.m4a` loops); a bare name gets `.ogg` or its `.m4a` copy. */
function soundUrl(name: string) {
  if (/\.\w+$/.test(name)) return `/sounds/${name}`;
  if (!extension) extension = new Audio().canPlayType('audio/ogg; codecs="vorbis"') ? "ogg" : "m4a";
  return `/sounds/${name}.${extension}`;
}

/** True once this document has had a gesture — the browser's own record where it keeps one. */
export function audioReady(): boolean {
  if (typeof navigator === "undefined") return false;
  return navigator.userActivation ? navigator.userActivation.hasBeenActive || gestured : gestured;
}

/** Call from inside a user gesture. Safe to call repeatedly. Also preloads the cue files. */
export function unlockAudio() {
  if (typeof window === "undefined") return;
  const first = !gestured;
  gestured = true;
  if (!first) return;
  for (const cue of Object.keys(CUE_FILES) as CueName[]) {
    if (cueElements.has(cue)) continue;
    const element = new Audio(soundUrl(CUE_FILES[cue]));
    element.preload = "auto";
    cueElements.set(cue, element);
  }
  window.dispatchEvent(new Event(AUDIO_UNLOCKED_EVENT));
}

/** Notes the first gesture in `target` (the main document, or the PiP's). Returns a cleanup. */
export function installAudioUnlock(target: Document): () => void {
  const onGesture = () => unlockAudio();
  target.addEventListener("pointerdown", onGesture, true);
  target.addEventListener("keydown", onGesture, true);
  return () => {
    target.removeEventListener("pointerdown", onGesture, true);
    target.removeEventListener("keydown", onGesture, true);
  };
}

/** Plays `cue` now at `volume` (0–1). False when this document can't play audio yet — the caller's fallback is the OS notification. */
export function playCue(cue: CueName, volume: number): boolean {
  if (typeof window === "undefined" || !audioReady() || volume <= 0) return false;
  // A fresh element per play, so a cue can overlap itself; the preloaded one keeps the file cached.
  const element = (cueElements.get(cue)?.cloneNode() as HTMLAudioElement | undefined) ?? new Audio(soundUrl(CUE_FILES[cue]));
  element.volume = Math.max(0, Math.min(1, volume));
  void element.play().catch(() => undefined);
  return true;
}

/* ── The background-sound mixer (lib/soundscape.ts) ──────────────────────────────────────────── */

const FADE_IN_MS = 1200;
const FADE_OUT_MS = 500;
const LEVEL_FADE_MS = 150;
const FADE_STEP_MS = 50;

interface MixTrack {
  element: HTMLAudioElement;
  fade: number | null;
}

/** One looping element per sounding track, keyed by its file. */
const mixTracks = new Map<string, MixTrack>();

function fadeTo(target: MixTrack, to: number, ms: number, done?: () => void) {
  if (target.fade != null) window.clearInterval(target.fade);
  const from = target.element.volume;
  const steps = Math.max(1, Math.round(ms / FADE_STEP_MS));
  let step = 0;
  target.fade = window.setInterval(() => {
    step++;
    target.element.volume = Math.max(0, Math.min(1, from + ((to - from) * step) / steps));
    if (step >= steps) {
      window.clearInterval(target.fade!);
      target.fade = null;
      done?.();
    }
  }, FADE_STEP_MS);
}

function release(track: MixTrack) {
  fadeTo(track, 0, FADE_OUT_MS, () => {
    track.element.pause();
    track.element.removeAttribute("src");
    track.element.load();
  });
}

/**
 * Makes the mixer sound exactly `mix`: files to their volumes (0–1), starting new tracks with a fade
 * in and fading out any track no longer in it. Each file is only fetched once its slider is up. False
 * when this document can't play audio yet.
 */
export function setMix(mix: { file: string; volume: number }[]): boolean {
  if (typeof window === "undefined" || !audioReady()) return false;
  const wanted = new Map(mix.filter((item) => item.volume > 0).map((item) => [item.file, item.volume]));
  for (const [file, track] of mixTracks) {
    if (!wanted.has(file)) {
      mixTracks.delete(file);
      release(track);
    }
  }
  for (const [file, volume] of wanted) {
    const existing = mixTracks.get(file);
    if (existing) {
      fadeTo(existing, volume, LEVEL_FADE_MS);
      continue;
    }
    const element = new Audio(soundUrl(file));
    element.loop = true;
    element.volume = 0;
    void element.play().catch(() => undefined);
    const track: MixTrack = { element, fade: null };
    mixTracks.set(file, track);
    fadeTo(track, volume, FADE_IN_MS);
  }
  return true;
}

export function stopMix() {
  for (const track of mixTracks.values()) release(track);
  mixTracks.clear();
}
