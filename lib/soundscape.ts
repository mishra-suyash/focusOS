import type { UserSettings } from "@/types";

/**
 * The background-sound mixer's catalogue and its pure rules: what each track is, where it came
 * from, and how the saved mix turns into per-track volumes. No DOM here (`scripts/verify-notify.ts`
 * checks it); playback is `lib/sounds.ts`, state is `components/soundscape-provider.tsx`.
 *
 * Every recording is public domain or CC-BY, trimmed to a seamless loop and level-matched (about
 * −26 dBFS RMS) before it was added. CC-BY needs credit, which `credit` carries and the mixer
 * shows; `public/sounds/CREDITS.md` has the same list.
 */

export type SoundscapeTrackId =
  | "rain"
  | "thunder"
  | "wind"
  | "fire"
  | "birds"
  | "waves"
  | "stream"
  | "cafe"
  | "library"
  | "keyboard"
  | "train"
  | "brown"
  | "grey"
  | "white";

export type SoundscapeGroup = "Weather" | "Nature" | "Places" | "Noise";

export interface SoundscapeTrack {
  id: SoundscapeTrackId;
  label: string;
  group: SoundscapeGroup;
  /** Path under `/sounds/`, without extension resolution — `.m4a` loops, or a base name `lib/sounds.ts` resolves. */
  file: string;
  /** Evens out the few files not level-matched at encode time (the grey-noise recording is ~3× louder). */
  gain: number;
  credit: { title: string; author: string; license: string; url: string };
}

const commons = (file: string) => `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file.replace(/ /g, "_"))}`;

export const SOUNDSCAPE_TRACKS: SoundscapeTrack[] = [
  { id: "rain", label: "Rain", group: "Weather", file: "scape/rain.m4a", gain: 1, credit: { title: "Rain against the window", author: "cori", license: "Public domain", url: commons("Rain against the window.ogg") } },
  { id: "thunder", label: "Thunder", group: "Weather", file: "scape/thunder.m4a", gain: 1, credit: { title: "Thunderstorm after hot summer day (part 2 of 4)", author: "stephan", license: "Public domain", url: commons("Thunderstorm after hot summer day 17 minutes 02 of 04.ogg") } },
  { id: "wind", label: "Wind", group: "Weather", file: "scape/wind.m4a", gain: 1, credit: { title: "Wind in forest", author: "Gravity Sound", license: "CC BY 4.0", url: commons("Wind in forest (Gravity Sound).wav") } },
  { id: "fire", label: "Fire", group: "Places", file: "scape/fire.m4a", gain: 1, credit: { title: "Campfire sound ambience", author: "Glaneur de sons", license: "CC BY 3.0", url: commons("Campfire sound ambience.ogg") } },
  { id: "birds", label: "Birds", group: "Nature", file: "scape/birds.m4a", gain: 1, credit: { title: "Birds, Perungalathur Reserved Forest", author: "Mk170101", license: "CC BY 4.0", url: commons("Birds Perungalathur Reserved Forest.wav") } },
  { id: "waves", label: "Waves", group: "Nature", file: "scape/waves.m4a", gain: 1, credit: { title: "Ocean Waves on a Tropical Beach", author: "Jarrod Stanley", license: "CC0", url: commons("Ocean Waves on a Tropical Beach.ogg") } },
  { id: "stream", label: "Stream", group: "Nature", file: "scape/stream.m4a", gain: 1, credit: { title: "Stream, river water up close", author: "jackthemurray", license: "CC0", url: commons("433589 jackthemurray stream-river-water-up-close.wav") } },
  { id: "cafe", label: "Café", group: "Places", file: "scape/cafe.m4a", gain: 1, credit: { title: "Restaurant ambience", author: "stephan", license: "Public domain", url: commons("Restaurant ambience.ogg") } },
  { id: "library", label: "Library", group: "Places", file: "scape/library.m4a", gain: 1, credit: { title: "TU Delft Library, quiet study room", author: "el_mar", license: "CC BY 3.0", url: commons("20121112 TU Delft Library, quiet study room - general ambience - SoundCloud - el mar.ogg") } },
  { id: "keyboard", label: "Keyboard", group: "Places", file: "scape/keyboard.m4a", gain: 1, credit: { title: "Typing medium speed", author: "teto_yasha", license: "Public domain", url: commons("Typing medium speed.ogg") } },
  { id: "train", label: "Train", group: "Places", file: "scape/train.m4a", gain: 1, credit: { title: "Taiwan railways EP727 train cars", author: "Jidanni", license: "CC0", url: commons("Taiwan railways EP727 train cars sounds.ogg") } },
  { id: "brown", label: "Brown noise", group: "Noise", file: "noise-brown", gain: 1, credit: { title: "Brownnoise", author: "Wikimedia Commons", license: "Public domain", url: commons("Brownnoise.ogg") } },
  { id: "grey", label: "Grey noise", group: "Noise", file: "noise-grey", gain: 0.33, credit: { title: "Gray noise", author: "Omegatron", license: "Public domain", url: commons("Gray noise.ogg") } },
  { id: "white", label: "White noise", group: "Noise", file: "noise-white", gain: 1, credit: { title: "White noise", author: "Wikimedia Commons", license: "Public domain", url: commons("White noise.ogg") } }
];

export const SOUNDSCAPE_GROUPS: SoundscapeGroup[] = ["Weather", "Nature", "Places", "Noise"];

const TRACK_IDS = new Set(SOUNDSCAPE_TRACKS.map((track) => track.id));

export interface ResolvedSoundscape {
  levels: Partial<Record<SoundscapeTrackId, number>>;
  master: number;
  /** Also play the mix whenever a focus countdown is running. */
  autoFocus: boolean;
}

/** What the play button falls back to when the mix is empty, so it never does nothing. */
export const STARTER_MIX: Partial<Record<SoundscapeTrackId, number>> = { rain: 0.6 };

/**
 * The saved mix, with every value clamped and unknown ids dropped. An account that only ever used
 * the earlier single "background noise" switch (plan/18 Phase 5, `sounds.ambient`) gets that noise
 * as its mix, at its old volume, still playing while focusing — nothing it had set goes away.
 */
export function resolveSoundscape(settings: Pick<UserSettings, "soundscape" | "sounds">): ResolvedSoundscape {
  const saved = settings.soundscape;
  if (saved) {
    const levels: Partial<Record<SoundscapeTrackId, number>> = {};
    for (const [id, level] of Object.entries(saved.levels ?? {})) {
      if (TRACK_IDS.has(id as SoundscapeTrackId) && clamp01(level ?? 0) > 0) levels[id as SoundscapeTrackId] = clamp01(level ?? 0);
    }
    return { levels, master: clamp01(saved.master ?? 1), autoFocus: saved.autoFocus ?? true };
  }
  const legacy = settings.sounds?.ambient;
  if (legacy?.enabled) {
    const kind = (legacy.kind as string) === "pink" ? "grey" : legacy.kind;
    return { levels: { [kind]: clamp01(legacy.volume) }, master: 1, autoFocus: true };
  }
  return { levels: {}, master: 1, autoFocus: true };
}

export function mixIsEmpty(levels: Partial<Record<SoundscapeTrackId, number>>): boolean {
  return !Object.values(levels).some((level) => (level ?? 0) > 0);
}

/** Per-track playback volume (0–1): the track's slider × the master slider × the track's own gain. Silent tracks are left out. */
export function mixVolumes(mix: ResolvedSoundscape): { track: SoundscapeTrack; volume: number }[] {
  return SOUNDSCAPE_TRACKS.flatMap((track) => {
    const volume = clamp01((mix.levels[track.id] ?? 0) * mix.master * track.gain);
    return volume > 0 ? [{ track, volume }] : [];
  });
}

/**
 * Whether the mix should be sounding. `playing` is the play/pause button (per device, shared by its
 * tabs). With `autoFocus`, a running focus countdown also plays it — unless the user paused the
 * mix during that very countdown (`mutedRunId`), which holds for that countdown only.
 */
export function soundscapeActive(input: {
  mix: ResolvedSoundscape;
  playing: boolean;
  focusRunning: boolean;
  runId: string;
  mutedRunId?: string;
}): boolean {
  if (mixIsEmpty(input.mix.levels) || input.mix.master <= 0) return false;
  if (input.playing) return true;
  return input.mix.autoFocus && input.focusRunning && input.mutedRunId !== input.runId;
}

function clamp01(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
