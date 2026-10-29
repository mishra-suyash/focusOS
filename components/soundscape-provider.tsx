"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useFocusSession } from "@/components/focus-session-provider";
import { useUserSettings } from "@/hooks/use-user-settings";
import {
  levelsForStorage,
  mixIsEmpty,
  mixVolumes,
  resolveSoundscape,
  sameLevels,
  soundscapeActive,
  STARTER_MIX,
  type ResolvedSoundscape,
  type SoundscapeLevels,
  type SoundscapeTrackId
} from "@/lib/soundscape";
import { AUDIO_UNLOCKED_EVENT, audioReady, setMix, stopMix, unlockAudio } from "@/lib/sounds";

/**
 * The background-sound mixer's state, above every route (root layout) so the top bar, the reader's
 * toolbar and the floating widget all drive one mix.
 *
 * - The mix (levels, master, "play while focusing", the saved "My mix") is a synced setting. Slider drags apply to the
 *   sound at once and are written to Firestore once the drag settles, not on every tick.
 * - Play/pause is per device: pressing play on a laptop shouldn't start rain on a phone. It lives in
 *   localStorage, so every tab on this device agrees on it (the `storage` event).
 * - Exactly one tab sounds. Every tab would otherwise play its own copy of the same loops; the
 *   `focusos-soundscape` Web Lock elects one, and the rest queue to take over if it closes. A tab
 *   only queues once it may play audio, or a silent tab could win the lock.
 */

const STATE_STORAGE_KEY = "focusos-soundscape";
const WRITE_DELAY_MS = 600;

interface PlayState {
  playing: boolean;
  /** The focus countdown during which the user paused an auto-playing mix — quiet for that one only. */
  mutedRunId?: string;
}

interface SoundscapeContextValue {
  mix: ResolvedSoundscape;
  /** The mix is sounding (or would be, once this device has had a click). */
  active: boolean;
  setLevel: (id: SoundscapeTrackId, level: number) => void;
  setMaster: (level: number) => void;
  setAutoFocus: (on: boolean) => void;
  clear: () => void;
  /** Replaces every level with `levels` (a preset, or "My mix") and plays it. */
  applyLevels: (levels: SoundscapeLevels) => void;
  /** Keeps the current levels as "My mix". */
  saveCustom: () => void;
  /** Play when quiet, pause when sounding — the one button in the top bar and the floating widget. */
  toggle: () => void;
}

const SoundscapeContext = createContext<SoundscapeContextValue | null>(null);

function readPlayState(): PlayState {
  try {
    const raw = window.localStorage.getItem(STATE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PlayState) : { playing: false };
  } catch {
    return { playing: false };
  }
}

export function SoundscapeProvider({ children }: { children: React.ReactNode }) {
  const { settings, loaded, update } = useUserSettings();
  const { focusRunning, runId } = useFocusSession();
  const saved = useMemo(() => resolveSoundscape(settings), [settings]);
  // A drag in progress: applied to the sound immediately, written once it settles.
  const [draft, setDraft] = useState<ResolvedSoundscape | null>(null);
  const mix = draft ?? saved;
  const writeTimer = useRef<number | null>(null);
  const [playState, setPlayState] = useState<PlayState>({ playing: false });

  useEffect(() => {
    setPlayState(readPlayState());
    function onStorage(event: StorageEvent) {
      if (event.key === STATE_STORAGE_KEY) setPlayState(readPlayState());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const writePlayState = useCallback((next: PlayState) => {
    setPlayState(next);
    try {
      window.localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // This tab still follows it; other tabs just won't.
    }
  }, []);

  const commit = useCallback(
    (next: ResolvedSoundscape) => {
      setDraft(next);
      if (writeTimer.current) window.clearTimeout(writeTimer.current);
      writeTimer.current = window.setTimeout(() => {
        update({
          soundscape: {
            levels: levelsForStorage(next.levels),
            master: next.master,
            autoFocus: next.autoFocus,
            ...(next.custom ? { custom: levelsForStorage(next.custom) } : {})
          }
        });
        writeTimer.current = null;
      }, WRITE_DELAY_MS);
    },
    [update]
  );

  // Once the saved settings catch up with the written draft, follow them again (so another tab's or
  // device's change shows here).
  useEffect(() => {
    if (draft && !writeTimer.current && sameMix(draft, saved)) setDraft(null);
  }, [draft, saved]);

  const active =
    loaded &&
    soundscapeActive({ mix, playing: playState.playing, focusRunning, runId, mutedRunId: playState.mutedRunId });

  const volumes = useMemo(() => mixVolumes(mix).map(({ track, volume }) => ({ file: track.file, volume })), [mix]);
  useSoundscapePlayer(active, volumes);

  const value = useMemo<SoundscapeContextValue>(
    () => ({
      mix,
      active,
      setLevel: (id, level) => commit({ ...mix, levels: { ...mix.levels, [id]: Math.max(0, Math.min(1, level)) } }),
      setMaster: (level) => commit({ ...mix, master: Math.max(0, Math.min(1, level)) }),
      setAutoFocus: (on) => commit({ ...mix, autoFocus: on }),
      clear: () => commit({ ...mix, levels: {} }),
      applyLevels: (levels) => {
        unlockAudio();
        commit({ ...mix, levels, master: mix.master > 0 ? mix.master : 1 });
        writePlayState({ playing: true });
      },
      saveCustom: () => {
        if (!mixIsEmpty(mix.levels)) commit({ ...mix, custom: mix.levels });
      },
      toggle: () => {
        unlockAudio();
        if (active) {
          // Paused during an auto-playing focus countdown: stay quiet for the rest of this one.
          writePlayState({ playing: false, mutedRunId: mix.autoFocus && focusRunning ? runId : undefined });
          return;
        }
        if (mixIsEmpty(mix.levels)) commit({ ...mix, levels: STARTER_MIX, master: mix.master > 0 ? mix.master : 1 });
        writePlayState({ playing: true });
      }
    }),
    [mix, active, commit, writePlayState, focusRunning, runId]
  );

  return <SoundscapeContext.Provider value={value}>{children}</SoundscapeContext.Provider>;
}

/** Plays `volumes` from this tab while it holds the `focusos-soundscape` lock and `active` holds. */
function useSoundscapePlayer(active: boolean, volumes: { file: string; volume: number }[]) {
  const latest = useRef(volumes);
  const [leader, setLeader] = useState(false);

  useEffect(() => {
    latest.current = volumes;
    if (leader) setMix(volumes);
  }, [volumes, leader]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let release: (() => void) | null = null;
    const controller = new AbortController();

    function join() {
      if (!audioReady()) return false;
      if (typeof navigator === "undefined" || !navigator.locks) {
        setMix(latest.current);
        setLeader(true);
        release = () => {
          stopMix();
          setLeader(false);
        };
        return true;
      }
      navigator.locks
        .request("focusos-soundscape", { signal: controller.signal }, () =>
          new Promise<void>((resolve) => {
            if (cancelled) return resolve();
            setMix(latest.current);
            setLeader(true);
            release = () => {
              stopMix();
              setLeader(false);
              resolve();
            };
          })
        )
        .catch(() => undefined); // AbortError when torn down while still queued.
      return true;
    }

    function onUnlock() {
      if (join()) window.removeEventListener(AUDIO_UNLOCKED_EVENT, onUnlock);
    }
    if (!join()) window.addEventListener(AUDIO_UNLOCKED_EVENT, onUnlock);

    return () => {
      cancelled = true;
      controller.abort();
      window.removeEventListener(AUDIO_UNLOCKED_EVENT, onUnlock);
      release?.();
    };
  }, [active]);
}

/** Key order and explicit zeros differ between a draft and what Firestore hands back, so compare track by track. */
function sameMix(a: ResolvedSoundscape, b: ResolvedSoundscape) {
  if (a.master !== b.master || a.autoFocus !== b.autoFocus) return false;
  if (!sameLevels(a.levels, b.levels)) return false;
  return a.custom && b.custom ? sameLevels(a.custom, b.custom) : !a.custom && !b.custom;
}

export function useSoundscape() {
  const ctx = useContext(SoundscapeContext);
  if (!ctx) throw new Error("useSoundscape must be used within SoundscapeProvider");
  return ctx;
}
