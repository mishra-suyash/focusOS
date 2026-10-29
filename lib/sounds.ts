import type { CueName } from "@/lib/cues";

/**
 * plan/18 §5.2 — every sound FocusOS makes: the cues, and the background-sound mixer's loops. Each
 * one is a public-domain or CC-BY recording in `public/sounds/` (sources and licences in
 * `public/sounds/CREDITS.md`) — downloaded files, never synthesised. Cues play through a plain
 * `<audio>` element, Ogg where the browser plays it, otherwise the AAC copy beside it (Safari). The
 * mixer's loops are AAC, played through Web Audio: an `<audio loop>` re-seeks the file on every pass
 * and leaves a short gap at the seam, while a looping decoded buffer repeats sample for sample.
 *
 * Every file is kept in this browser's Cache Storage after its first download (`fetchSound`), so a
 * cue or a loop is never fetched from the server again — until `SOUND_CACHE` changes.
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

/**
 * Cache Storage name. Bump it whenever a file in `public/sounds/` is replaced: browsers keep serving
 * their stored copy of a URL until this changes (older `focusos-sounds-*` caches are deleted).
 */
const SOUND_CACHE = "focusos-sounds-v2";
let cacheOpening: Promise<Cache | null> | null = null;

function soundCache(): Promise<Cache | null> {
  cacheOpening ??= (async () => {
    // Cache Storage only exists on https and localhost.
    if (typeof caches === "undefined") return null;
    try {
      for (const name of await caches.keys()) {
        if (name.startsWith("focusos-sounds-") && name !== SOUND_CACHE) void caches.delete(name);
      }
      return await caches.open(SOUND_CACHE);
    } catch {
      return null;
    }
  })();
  return cacheOpening;
}

/** The file from this browser's cache, or fetched once and kept. A whole-file fetch (status 200), so it can be stored. */
async function fetchSound(url: string): Promise<Response> {
  const cache = await soundCache();
  const hit = await cache?.match(url).catch(() => undefined);
  if (hit) return hit;
  const response = await fetch(url);
  if (response.ok && cache) await cache.put(url, response.clone()).catch(() => undefined);
  return response;
}

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
  // Safari only lets a suspended (or "interrupted") context start inside a gesture — every one is a chance.
  if (context && context.state !== "running" && mixTracks.size > 0) void context.resume().catch(() => undefined);
  const first = !gestured;
  gestured = true;
  if (!first) return;
  audioContext();
  for (const cue of Object.keys(CUE_FILES) as CueName[]) {
    if (cueElements.has(cue)) continue;
    const element = new Audio();
    element.preload = "auto";
    cueElements.set(cue, element);
    const url = soundUrl(CUE_FILES[cue]);
    void fetchSound(url)
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        element.src = blob ? URL.createObjectURL(blob) : url;
      })
      .catch(() => {
        element.src = url;
      });
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
  // A fresh element per play, so a cue can overlap itself. The preloaded one holds the cached file;
  // until that has loaded, play straight from the server.
  const preloaded = cueElements.get(cue);
  const element = preloaded?.src ? (preloaded.cloneNode() as HTMLAudioElement) : new Audio(soundUrl(CUE_FILES[cue]));
  element.volume = Math.max(0, Math.min(1, volume));
  void element.play().catch(() => undefined);
  return true;
}

/* ── The background-sound mixer (lib/soundscape.ts) ──────────────────────────────────────────── */

const FADE_IN_MS = 1200;
const FADE_OUT_MS = 500;
const LEVEL_FADE_MS = 150;
/** Samples quieter than this at a buffer's ends are decoder padding, not sound. */
const PADDING_LEVEL = 1e-4;

interface MixTrack {
  gain: GainNode;
  source: AudioBufferSourceNode | null;
  /** The level asked for, applied once the file has loaded. */
  volume: number;
}

let context: AudioContext | null = null;
let suspendTimer: number | null = null;
/** One track per sounding file, keyed by its file. Replaced (never reused) when a file is re-added. */
const mixTracks = new Map<string, MixTrack>();
/** Decoded loops, kept only while their track is in the mix — a 100 s stereo loop is ~35 MB decoded. */
const buffers = new Map<string, Promise<AudioBuffer | null>>();

function audioContext(): AudioContext | null {
  if (context || typeof window === "undefined") return context;
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;
  try {
    // The loops are 44.1 kHz; decoding at the hardware's 48 kHz would only make them bigger.
    context = new Context({ sampleRate: 44100 });
  } catch {
    try {
      context = new Context();
    } catch {
      return null;
    }
  }
  return context;
}

function loadBuffer(ctx: AudioContext, file: string): Promise<AudioBuffer | null> {
  let pending = buffers.get(file);
  if (!pending) {
    pending = fetchSound(soundUrl(file))
      .then((response) => {
        if (!response.ok) throw new Error(`${file}: ${response.status}`);
        return response.arrayBuffer();
      })
      .then((bytes) => ctx.decodeAudioData(bytes))
      .catch(() => null);
    buffers.set(file, pending);
  }
  return pending;
}

/**
 * The part of `buffer` to loop, in seconds. Chrome's decoder already drops AAC's encoder padding
 * (the loops decode to their exact length), so this is normally the whole buffer; a decoder that
 * left the near-silent padding in would otherwise put the gap right back at the seam.
 */
function loopSpan(buffer: AudioBuffer): [number, number] {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const quiet = (i: number) => channels.every((data) => Math.abs(data[i]) < PADDING_LEVEL);
  const limit = Math.min(8192, Math.floor(buffer.length / 4));
  let head = 0;
  while (head < limit && quiet(head)) head++;
  let tail = 0;
  while (tail < limit && quiet(buffer.length - 1 - tail)) tail++;
  // A short run of near-zero samples happens in real sound; padding is hundreds of samples.
  return [head >= 64 ? head / buffer.sampleRate : 0, (tail >= 64 ? buffer.length - tail : buffer.length) / buffer.sampleRate];
}

/** Moves `gain` to `to` over `ms` on the audio clock, which keeps time in a hidden tab (timers don't). */
function rampTo(gain: GainNode, to: number, ms: number) {
  const now = gain.context.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(Math.max(0, Math.min(1, to)), now + ms / 1000);
}

function startTrack(ctx: AudioContext, file: string, volume: number) {
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);
  const track: MixTrack = { gain, source: null, volume };
  mixTracks.set(file, track);
  void loadBuffer(ctx, file).then((buffer) => {
    // Removed (or stopped and re-added) while it loaded: this track is no longer the one that should sound.
    if (!buffer || mixTracks.get(file) !== track) return;
    const [loopStart, loopEnd] = loopSpan(buffer);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = loopStart;
    source.loopEnd = loopEnd;
    source.connect(gain);
    source.start(0, loopStart);
    track.source = source;
    rampTo(gain, track.volume, FADE_IN_MS);
  });
}

function release(file: string, track: MixTrack) {
  rampTo(track.gain, 0, FADE_OUT_MS);
  const source = track.source;
  if (source) {
    source.onended = () => track.gain.disconnect();
    source.stop(track.gain.context.currentTime + FADE_OUT_MS / 1000);
  } else {
    track.gain.disconnect();
  }
  buffers.delete(file);
}

/** With nothing left in the mix, let the audio device sleep once the last fade-out is done. */
function suspendWhenIdle() {
  if (suspendTimer != null) window.clearTimeout(suspendTimer);
  suspendTimer = window.setTimeout(() => {
    suspendTimer = null;
    if (mixTracks.size === 0 && context?.state === "running") void context.suspend().catch(() => undefined);
  }, FADE_OUT_MS + 250);
}

/**
 * Makes the mixer sound exactly `mix`: files to their volumes (0–1), starting new tracks with a fade
 * in and fading out any track no longer in it. Each file is only loaded once its slider is up. False
 * when this document can't play audio yet.
 */
export function setMix(mix: { file: string; volume: number }[]): boolean {
  if (typeof window === "undefined" || !audioReady()) return false;
  const ctx = audioContext();
  if (!ctx) return false;
  const wanted = new Map(mix.filter((item) => item.volume > 0).map((item) => [item.file, item.volume]));
  for (const [file, track] of mixTracks) {
    if (!wanted.has(file)) {
      mixTracks.delete(file);
      release(file, track);
    }
  }
  for (const [file, volume] of wanted) {
    const existing = mixTracks.get(file);
    if (!existing) {
      startTrack(ctx, file, volume);
    } else if (existing.volume !== volume) {
      existing.volume = volume;
      if (existing.source) rampTo(existing.gain, volume, LEVEL_FADE_MS);
    }
  }
  if (mixTracks.size === 0) {
    suspendWhenIdle();
  } else if (ctx.state !== "running") {
    // Allowed without a gesture once the page has had one (Chrome, Firefox); Safari waits for the next click.
    void ctx.resume().catch(() => undefined);
  }
  return true;
}

export function stopMix() {
  for (const [file, track] of mixTracks) {
    mixTracks.delete(file);
    release(file, track);
  }
  suspendWhenIdle();
}
