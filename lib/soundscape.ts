import type { UserSettings } from "@/types";

/**
 * The background-sound mixer's catalogue and its pure rules: what each track is, where it came
 * from, and how the saved mix turns into per-track volumes. No DOM here (`scripts/verify-notify.ts`
 * checks it); playback is `lib/sounds.ts`, state is `components/soundscape-provider.tsx`.
 *
 * The loops come mostly from two open-source ambient-sound apps whose sounds are curated for
 * exactly this use — Blanket (GNOME; Freesound/SoundBible recordings edited to its ambience
 * guidelines, each with its licence) and Moodist (CC0 / Pixabay Content License) — trimmed to a
 * seamless loop and level-matched (about −27 dBFS RMS) before they were added. CC-BY needs credit,
 * which `credit` carries and the mixer shows; `public/sounds/CREDITS.md` has the same list.
 */

export type SoundscapeTrackId =
  | "rain"
  | "heavyRain"
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

const freesound = (user: string, id: number) => `https://freesound.org/people/${user}/sounds/${id}/`;
/** Moodist (MIT app) ships these as CC0 or Pixabay Content License sounds without naming each one's source;
 *  both licences allow use without attribution. Credited to the project that curated them. */
const MOODIST = { author: "via Moodist (remvze/moodist)", license: "CC0 / Pixabay Content License", url: "https://github.com/remvze/moodist" };
/** Blanket (GNOME) edits its sounds to its ambience guidelines; credit names the original recording. */
const viaBlanket = (author: string) => `${author}, edited for Blanket`;

export const SOUNDSCAPE_TRACKS: SoundscapeTrack[] = [
  { id: "rain", label: "Rain", group: "Weather", file: "scape/rain.m4a", gain: 1, credit: { title: "Rain", author: viaBlanket("alex36917"), license: "CC BY 4.0", url: freesound("alex36917", 524605) } },
  { id: "heavyRain", label: "Heavy rain", group: "Weather", file: "scape/heavy-rain.m4a", gain: 1, credit: { title: "Heavy Rain", ...MOODIST } },
  { id: "thunder", label: "Thunder", group: "Weather", file: "scape/thunder.m4a", gain: 1, credit: { title: "Storm", author: viaBlanket("digifishmusic"), license: "CC BY 4.0", url: freesound("digifishmusic", 41739) } },
  { id: "wind", label: "Wind", group: "Weather", file: "scape/wind.m4a", gain: 1, credit: { title: "Wind in Trees", ...MOODIST } },
  { id: "birds", label: "Birds", group: "Nature", file: "scape/birds.m4a", gain: 1, credit: { title: "Birds", author: viaBlanket("kvgarlic"), license: "CC0", url: freesound("kvgarlic", 156826) } },
  { id: "waves", label: "Waves", group: "Nature", file: "scape/waves.m4a", gain: 1, credit: { title: "Waves", author: viaBlanket("Luftrum"), license: "CC BY 4.0", url: freesound("Luftrum", 48412) } },
  { id: "stream", label: "Stream", group: "Nature", file: "scape/stream.m4a", gain: 1, credit: { title: "Stream", author: "gluckose (via Blanket)", license: "CC0", url: freesound("gluckose", 333987) } },
  { id: "fire", label: "Fire", group: "Places", file: "scape/fire.m4a", gain: 1, credit: { title: "Fireplace", author: "ezwa (via Blanket)", license: "Public domain", url: "https://soundbible.com/1543-Fireplace.html" } },
  { id: "cafe", label: "Café", group: "Places", file: "scape/cafe.m4a", gain: 1, credit: { title: "Cafe", ...MOODIST } },
  { id: "library", label: "Library", group: "Places", file: "scape/library.m4a", gain: 1, credit: { title: "TU Delft Library, quiet study room", author: "el_mar", license: "CC BY 3.0", url: commons("20121112 TU Delft Library, quiet study room - general ambience - SoundCloud - el mar.ogg") } },
  { id: "keyboard", label: "Keyboard", group: "Places", file: "scape/keyboard.m4a", gain: 1, credit: { title: "Keyboard", ...MOODIST } },
  { id: "train", label: "Train", group: "Places", file: "scape/train.m4a", gain: 1, credit: { title: "Inside a Train", ...MOODIST } },
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
