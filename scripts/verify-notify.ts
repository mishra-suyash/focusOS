#!/usr/bin/env tsx
/**
 * Unit-test stand-in for plan/18's pure rules (lib/cues.ts) — the cross-tab claim and which cues are
 * on. Same pattern as scripts/verify-tracking.ts, since this repo has no test runner. Everything about
 * actual delivery (audio unlocking, notifications, two real tabs) is only provable in the browser.
 */
import {
  blockStartNotificationsOn,
  claimInStore,
  CUE_MEMORY_MS,
  cueEnabled,
  cueKeys,
  reminderClaimWindowMs,
  resolveSounds
} from "../lib/cues";
import {
  levelsForStorage,
  mixIsEmpty,
  mixVolumes,
  resolveSoundscape,
  sameLevels,
  soundscapeActive,
  SOUNDSCAPE_PRESETS,
  SOUNDSCAPE_TRACKS
} from "../lib/soundscape";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures.push(detail ? `${label}: ${detail}` : label);
}

// Keys: a recurring slot id on two dates must give two keys.
check("slot keys carry the date", cueKeys.sittingLead("2026-10-27", "course-x-1") !== cueKeys.sittingLead("2026-10-28", "course-x-1"));
check("block-start keys carry the date", cueKeys.blockStart("2026-10-27", "s") !== cueKeys.blockStart("2026-10-28", "s"));
check("lead key keeps plan/16's shape", cueKeys.sittingLead("2026-10-27", "s") === "2026-10-27:s:lead");

// Claims: two tabs sharing one store — exactly one wins.
{
  let store: Record<string, number> = {};
  const tabA = claimInStore(store, "timer:run1", 1000);
  store = tabA.next;
  const tabB = claimInStore(store, "timer:run1", 1005);
  check("first tab claims a timer cue", tabA.claimed);
  check("second tab is refused the same timer cue", !tabB.claimed);
  check("a different run is claimable", claimInStore(store, "timer:run2", 1010).claimed);
}

// A recurring reminder: refused inside its window, claimable once the window has passed.
{
  const window = reminderClaimWindowMs(60);
  check("reminder window is half the interval", window === 30 * 60_000, String(window));
  check("reminder window never drops under a minute", reminderClaimWindowMs(1) === 60_000);
  let store: Record<string, number> = {};
  const key = cueKeys.reminder("hydration", "2026-10-27");
  store = claimInStore(store, key, 0, window).next;
  check("other tab's out-of-step tick is refused", !claimInStore(store, key, 25_000, window).claimed);
  check("next reminder an interval later is claimed", claimInStore(store, key, 60 * 60_000, window).claimed);
}

// Old entries are pruned so the shared map can't grow without bound.
{
  const pruned = claimInStore({ old: 0, recent: CUE_MEMORY_MS }, "new", CUE_MEMORY_MS + 10).next;
  check("entries older than the memory are dropped", !("old" in pruned) && "recent" in pruned && "new" in pruned, JSON.stringify(pruned));
}

// Cue resolution (plan/18 §6 D1).
{
  const defaults = resolveSounds(undefined);
  check("absent settings: sounds on", defaults.enabled);
  check("absent settings: the two timer chimes on", defaults.cues.sessionEnd && defaults.cues.breakEnd);
  check("absent settings: every other cue off", !defaults.cues.headsUp && !defaults.cues.reminder && !defaults.cues.blockClosed);
  const muted = resolveSounds({ enabled: false, volume: 1, cues: { reminder: true } });
  check("master switch off silences everything", !cueEnabled(muted, "sessionEnd") && !cueEnabled(muted, "reminder"));
  const all = resolveSounds({ enabled: true, volume: 2, cues: { headsUp: true, reminder: true, blockClosed: true } });
  check("volume is clamped to 1", all.volume === 1, String(all.volume));
  check("a day off silences the planned-day cues", !cueEnabled(all, "headsUp", { dayOff: true }) && !cueEnabled(all, "reminder", { dayOff: true }));
  check("a day off keeps the timer chimes", cueEnabled(all, "sessionEnd", { dayOff: true }) && cueEnabled(all, "breakEnd", { dayOff: true }));
}

// The background-sound mixer (lib/soundscape.ts).
{
  const empty = resolveSoundscape({});
  check("no mixer settings: empty mix, plays while focusing", mixIsEmpty(empty.levels) && empty.autoFocus && empty.master === 1);
  const legacy = resolveSoundscape({ sounds: { enabled: true, volume: 0.6, ambient: { enabled: true, kind: "brown", volume: 0.3 } } });
  check("the old noise switch carries over as the mix", legacy.levels.brown === 0.3 && legacy.autoFocus, JSON.stringify(legacy));
  const legacyPink = resolveSoundscape({ sounds: { enabled: true, volume: 0.6, ambient: { enabled: true, kind: "pink" as never, volume: 0.3 } } });
  check("a stored pink choice becomes grey", legacyPink.levels.grey === 0.3, JSON.stringify(legacyPink));
  const saved = resolveSoundscape({ soundscape: { levels: { rain: 0.6, fire: 0, bogus: 0.5, cafe: 3 }, master: 0.5, autoFocus: false } });
  check("unknown ids and zero levels are dropped, levels clamped", saved.levels.rain === 0.6 && !("fire" in saved.levels) && !("bogus" in saved.levels) && saved.levels.cafe === 1, JSON.stringify(saved));
  const volumes = mixVolumes(saved);
  check("track volume = level x master x gain", volumes.find((v) => v.track.id === "rain")?.volume === 0.3, JSON.stringify(volumes.map((v) => [v.track.id, v.volume])));
  const grey = mixVolumes({ levels: { grey: 1 }, master: 1, autoFocus: true, custom: null });
  check("grey noise is evened out by its gain", grey[0]?.volume === 0.33);
  check("every track has a credit with a licence", SOUNDSCAPE_TRACKS.every((t) => t.credit.license && t.credit.url && t.credit.author));

  const mix = { levels: { rain: 0.5 }, master: 1, autoFocus: true, custom: null };
  check("play button plays", soundscapeActive({ mix, playing: true, focusRunning: false, runId: "a" }));
  check("auto-plays while focusing", soundscapeActive({ mix, playing: false, focusRunning: true, runId: "a" }));
  check("paused during a countdown stays quiet for that countdown", !soundscapeActive({ mix, playing: false, focusRunning: true, runId: "a", mutedRunId: "a" }));
  check("…and auto-plays again for the next one", soundscapeActive({ mix, playing: false, focusRunning: true, runId: "b", mutedRunId: "a" }));
  check("no auto-play when switched off", !soundscapeActive({ mix: { ...mix, autoFocus: false }, playing: false, focusRunning: true, runId: "a" }));
  check("an empty mix never plays", !soundscapeActive({ mix: { ...mix, levels: {} }, playing: true, focusRunning: true, runId: "a" }));
  check("master at zero never plays", !soundscapeActive({ mix: { ...mix, master: 0 }, playing: true, focusRunning: false, runId: "a" }));

  // Presets and "My mix".
  const trackIds = new Set(SOUNDSCAPE_TRACKS.map((track) => track.id));
  check("four premixes", SOUNDSCAPE_PRESETS.length === 4);
  check(
    "every premix uses known tracks at levels in 0-1",
    SOUNDSCAPE_PRESETS.every((preset) => !mixIsEmpty(preset.levels) && Object.entries(preset.levels).every(([id, level]) => trackIds.has(id as never) && level! > 0 && level! <= 1))
  );
  check("premix ids are unique", new Set(SOUNDSCAPE_PRESETS.map((preset) => preset.id)).size === SOUNDSCAPE_PRESETS.length);
  const withCustom = resolveSoundscape({ soundscape: { levels: { rain: 0.5 }, master: 1, autoFocus: true, custom: { fire: 0.4, rain: 0, bogus: 1 } } });
  check("a saved mix resolves, silent and unknown tracks dropped", withCustom.custom?.fire === 0.4 && !("rain" in (withCustom.custom ?? {})) && !("bogus" in (withCustom.custom ?? {})), JSON.stringify(withCustom.custom));
  check("no saved mix resolves to null", resolveSoundscape({ soundscape: { levels: {}, master: 1, autoFocus: true } }).custom === null);
  check("an all-zero saved mix counts as none", resolveSoundscape({ soundscape: { levels: {}, master: 1, autoFocus: true, custom: { rain: 0 } } }).custom === null);

  // Firestore deep-merges maps, so every write must name every track.
  const stored = levelsForStorage({ cafe: 0.5 });
  check("stored levels name every track, silent ones as 0", Object.keys(stored).length === SOUNDSCAPE_TRACKS.length && stored.cafe === 0.5 && stored.rain === 0, JSON.stringify(stored));
  const merged = resolveSoundscape({ soundscape: { levels: { ...levelsForStorage({ fire: 0.5, birds: 0.3 }), ...levelsForStorage(SOUNDSCAPE_PRESETS[0].levels) }, master: 1, autoFocus: true } });
  check("a preset written over another mix leaves none of the old tracks", sameLevels(merged.levels, SOUNDSCAPE_PRESETS[0].levels), JSON.stringify(merged.levels));
  check("sameLevels ignores explicit zeros", sameLevels({ rain: 0.5 }, { rain: 0.5, fire: 0 }) && !sameLevels({ rain: 0.5 }, { rain: 0.5, fire: 0.1 }));
}

// N3 keeps its pre-setting behaviour.
check("block-start notifications: absent = on", blockStartNotificationsOn({}));
check("block-start notifications: explicit off", !blockStartNotificationsOn({ notifications: { blockStart: false } }));

if (failures.length > 0) {
  console.error(`verify-notify: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("verify-notify: all plan/18 cue and claim checks passed.");
