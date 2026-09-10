import type { TimerPayload } from "@/lib/templates/schema";
import type { TimerPresetId } from "@/types";

/** Focus timer presets (plan §6.3). Applying one writes `workMinutes`/`shortBreakMinutes`/`longBreakMinutes` + `timerPresetId` to `meta/settings`. */
export const BUILTIN_TIMER_PRESETS: Record<Exclude<TimerPresetId, "custom">, TimerPayload> = {
  classic: {
    id: "classic",
    version: 1,
    name: "Classic",
    description: "25 minutes on, 5 short / 15 long.",
    workMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15
  },
  extended: {
    id: "extended",
    version: 1,
    name: "Extended",
    description: "50 minutes on, 10 short / 30 long — good for writing.",
    workMinutes: 50,
    shortBreakMinutes: 10,
    longBreakMinutes: 30
  },
  short: {
    id: "short",
    version: 1,
    name: "Short",
    description: "15 minutes on, 3 short / 10 long — for low-energy days.",
    workMinutes: 15,
    shortBreakMinutes: 3,
    longBreakMinutes: 10
  }
};
