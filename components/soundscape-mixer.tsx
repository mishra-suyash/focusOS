"use client";

import { clsx } from "clsx";
import {
  AudioWaveform,
  Bird,
  CloudLightning,
  CloudRain,
  CloudRainWind,
  Coffee,
  Droplets,
  Flame,
  Headphones,
  Keyboard,
  Library,
  Pause,
  Play,
  TrainFront,
  Volume2,
  Waves,
  Wind,
  type LucideIcon
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSoundscape } from "@/components/soundscape-provider";
import { SOUNDSCAPE_GROUPS, SOUNDSCAPE_TRACKS, type SoundscapeTrackId } from "@/lib/soundscape";

const TRACK_ICONS: Record<SoundscapeTrackId, LucideIcon> = {
  rain: CloudRain,
  heavyRain: CloudRainWind,
  thunder: CloudLightning,
  wind: Wind,
  fire: Flame,
  birds: Bird,
  waves: Waves,
  stream: Droplets,
  cafe: Coffee,
  library: Library,
  keyboard: Keyboard,
  train: TrainFront,
  brown: AudioWaveform,
  grey: AudioWaveform,
  white: AudioWaveform
};

/** Level a track jumps to when its icon is tapped from off. */
const TAP_ON_LEVEL = 0.5;

/**
 * The top-bar mixer: one button that opens a panel of per-sound sliders (rain at 60%, fire at 30%…),
 * a master volume, play/pause, and "play while focusing". Mounted in the app shell's header and the
 * reader's toolbar; both drive the one mix in `SoundscapeProvider`.
 */
export function SoundscapeButton() {
  const { active } = useSoundscape();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className={clsx("btn-secondary relative px-2", active && "text-moss-600 ring-1 ring-moss-500/60")}
        onClick={() => setOpen((current) => !current)}
        aria-label="Background sounds"
        aria-expanded={open}
        title="Background sounds"
      >
        <Headphones className="h-4 w-4" />
        {active ? <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-moss-500" aria-hidden /> : null}
      </button>
      {open ? <MixerPanel /> : null}
    </div>
  );
}

function MixerPanel() {
  const { mix, active, setLevel, setMaster, setAutoFocus, clear, toggle } = useSoundscape();

  return (
    <div
      className="absolute right-0 top-full z-40 mt-2 max-h-[75vh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-ink-200 bg-white p-3 text-sm shadow-xl dark:border-ink-700 dark:bg-ink-900"
      role="dialog"
      aria-label="Background sounds mixer"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold">Background sounds</p>
        <button type="button" className={clsx(active ? "btn-secondary" : "btn-primary", "px-2.5 py-1 text-xs")} onClick={toggle}>
          {active ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {active ? "Pause" : "Play"}
        </button>
      </div>

      <label className="mt-3 flex items-center gap-2">
        <Volume2 className="h-4 w-4 shrink-0 text-ink-500" />
        <span className="sr-only">Master volume</span>
        <input
          type="range"
          className="w-full accent-moss-600"
          min={0}
          max={1}
          step={0.02}
          value={mix.master}
          onChange={(e) => setMaster(Number(e.target.value))}
          aria-label="Master volume"
        />
      </label>
      <label className="mt-2 flex items-center gap-2 text-xs text-ink-600 dark:text-ink-300">
        <input type="checkbox" className="h-3.5 w-3.5" checked={mix.autoFocus} onChange={(e) => setAutoFocus(e.target.checked)} />
        Also play while a focus session runs
      </label>

      {SOUNDSCAPE_GROUPS.map((group) => (
        <div key={group} className="mt-3">
          <p className="label mb-1">{group}</p>
          <div className="space-y-1">
            {SOUNDSCAPE_TRACKS.filter((track) => track.group === group).map((track) => {
              const level = mix.levels[track.id] ?? 0;
              const Icon = TRACK_ICONS[track.id];
              const on = level > 0;
              return (
                <div key={track.id} className={clsx("flex items-center gap-2 rounded-md px-1.5 py-1", on && "bg-moss-600/10")}>
                  <button
                    type="button"
                    className={clsx("flex w-28 shrink-0 items-center gap-1.5 text-left", on ? "font-medium text-moss-700 dark:text-moss-400" : "text-ink-600 dark:text-ink-300")}
                    onClick={() => setLevel(track.id, on ? 0 : TAP_ON_LEVEL)}
                    aria-pressed={on}
                    title={on ? `Turn ${track.label.toLowerCase()} off` : `Add ${track.label.toLowerCase()}`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{track.label}</span>
                  </button>
                  <input
                    type="range"
                    className="w-full accent-moss-600"
                    min={0}
                    max={1}
                    step={0.02}
                    value={level}
                    onChange={(e) => setLevel(track.id, Number(e.target.value))}
                    aria-label={`${track.label} volume`}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="mt-3 flex items-center justify-between border-t border-ink-100 pt-2 text-xs dark:border-ink-800">
        <button type="button" className="text-ink-500 hover:text-ink-900 hover:underline dark:hover:text-ink-100" onClick={clear}>
          Turn all off
        </button>
        <span className="text-ink-500">Plays from one tab at a time</span>
      </div>
      <details className="mt-2 text-xs text-ink-500">
        <summary className="cursor-pointer">Sound credits</summary>
        <ul className="mt-1 space-y-1">
          {SOUNDSCAPE_TRACKS.map((track) => (
            <li key={track.id}>
              {track.label}:{" "}
              <a className="underline" href={track.credit.url} target="_blank" rel="noreferrer">
                “{track.credit.title}”
              </a>{" "}
              by {track.credit.author}, {track.credit.license}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/**
 * The floating widget's one-tap control for the same mix, in the corner the close button used to
 * take (the PiP window has its own close button in its title bar). Only flips play/pause; the sound
 * itself always comes from the main document, never the PiP.
 */
export function SoundscapeToggle({ className }: { className?: string }) {
  const { active, toggle } = useSoundscape();
  const label = active ? "Pause background sounds" : "Play background sounds";
  return (
    <button type="button" className={clsx(className, active && "text-moss-600")} onClick={toggle} aria-label={label} aria-pressed={active} title={label}>
      {active ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
    </button>
  );
}
