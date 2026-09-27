import { loadIndexBand } from "@/lib/loadindex";
import { minutesFromTime } from "@/lib/schedule";
import { sittingOutcome, slotCoverageMinutes } from "@/lib/tracking";
import type { LoadIndexBand, LoadIndexSnapshot, PomodoroSession, ScheduleSlot } from "@/types";

/**
 * plan/16 §5.6 — gamification as a *readout of what the app already measures*, never an economy.
 *
 * Everything below is derived from real logged data: `PomodoroSession.minutes` (the same field
 * plan/14 §6.4 made the basis of every course total), `slotAutoStatus`'s own 60%-coverage rule via
 * `sittingOutcome`, and the existing Load Index. There is no currency, no invented points, and no
 * stored source of truth — `Day.game` is a snapshot for history, recomputed for display whenever
 * it's missing.
 *
 * Which block types count: only blocks that represent *work* the user chose to do. A meal, a
 * commute, sleep, a break, and a free block are not achievements and their non-completion is not a
 * failure, so they're excluded from both the numerator and the denominator. A class block is
 * excluded too — attendance is already tracked by `ClassLog`/`classMinutesForWeek`, and folding it
 * in here would make a day of lectures score high without any focused work happening.
 */
const SCORED_SLOT_TYPES = new Set<ScheduleSlot["type"]>(["deep_work", "reading", "admin"]);

export function isScoredSitting(slot: Pick<ScheduleSlot, "type">): boolean {
  return SCORED_SLOT_TYPES.has(slot.type);
}

/** plan/16 §5.6 — the consistency term's contribution, by band. "On track" and "ahead" are the
 *  target; "light" is partial credit rather than zero (a light day that went to plan is not a
 *  failure); "behind" and "overrun" both score zero, the latter deliberately — consistently
 *  overshooting a plan is a planning problem, not a win. Reuses `loadIndexBand` so this can never
 *  disagree with the Workload figure shown beside it. */
const BAND_CREDIT: Record<LoadIndexBand, number> = {
  behind: 0,
  light: 0.5,
  on_track: 1,
  ahead: 1,
  overrun: 0
};

export interface DayScore {
  /** null — never 0 — for a day with nothing planned and for a day off. An unplanned day is not a
   *  failed one, the same distinction plan/15 §5.1 drew when `computeRequiredMinutes` started
   *  returning 0 for a day off rather than letting it read as "behind". */
  score: number | null;
  sittingsClosed: number;
  sittingsPlanned: number;
  minutesLogged: number;
  minutesPlanned: number;
}

/**
 * Three weighted terms, each already measured elsewhere:
 *
 * - **coverage (50)** — logged work minutes / planned work minutes, capped at 1. The honest core:
 *   did the day happen the way it was planned.
 * - **closure (30)** — sittings closed / sittings planned, by `sittingOutcome`. This is what makes
 *   a day of finished sittings score above a day of half-finished ones at identical logged minutes,
 *   which is the behavior actually worth rewarding.
 * - **consistency (20)** — the Load Index band's credit, so the score agrees with Workload.
 *
 * `classAttendedSlotIds` lets a caller mark class blocks attended; it only matters if a caller
 * widens `SCORED_SLOT_TYPES`, and is accepted here so `sittingOutcome`'s full contract is reachable
 * rather than half-wired.
 */
export function computeDayScore(input: {
  slots: Pick<ScheduleSlot, "id" | "type" | "startTime" | "endTime" | "plannedMinutes">[];
  sessions: Pick<PomodoroSession, "slotId" | "mode" | "minutes">[];
  loadIndex?: Pick<LoadIndexSnapshot, "value">;
  isDayOff?: boolean;
  classAttendedSlotIds?: ReadonlySet<string>;
}): DayScore {
  const { slots, sessions, loadIndex, isDayOff, classAttendedSlotIds } = input;
  const sittings = slots.filter(isScoredSitting);

  const minutesPlanned = sittings.reduce(
    (sum, slot) => sum + (slot.plannedMinutes ?? Math.max(0, minutesFromTime(slot.endTime) - minutesFromTime(slot.startTime))),
    0
  );
  const minutesLogged = sittings.reduce((sum, slot) => sum + slotCoverageMinutes(slot, sessions), 0);
  const sittingsClosed = sittings.filter(
    (slot) => sittingOutcome(slot, sessions, classAttendedSlotIds?.has(slot.id) ?? false) === "closed"
  ).length;

  const base: Omit<DayScore, "score"> = {
    sittingsClosed,
    sittingsPlanned: sittings.length,
    minutesLogged,
    minutesPlanned
  };

  if (isDayOff || sittings.length === 0 || minutesPlanned === 0) return { ...base, score: null };

  const coverage = Math.min(1, minutesLogged / minutesPlanned);
  const closure = sittingsClosed / sittings.length;
  const consistency = loadIndex ? BAND_CREDIT[loadIndexBand(loadIndex.value)] : coverage;

  return { ...base, score: Math.round(coverage * 50 + closure * 30 + consistency * 20) };
}

/**
 * plan/16 §5.6 — the day's one-line readout. Kept here rather than inline in each surface so the
 * dashboard, the week grid, Look back, and the PiP card can never word the same numbers differently
 * (plan/13's coherence rule).
 */
export function formatDayScoreLine(score: DayScore): string {
  if (score.sittingsPlanned === 0) return "Nothing planned";
  const sittings = `${score.sittingsClosed} of ${score.sittingsPlanned} sitting${score.sittingsPlanned === 1 ? "" : "s"} closed`;
  const minutes = `${score.minutesLogged} of ${score.minutesPlanned} min`;
  return score.score == null ? `${sittings} · ${minutes}` : `${sittings} · ${minutes} · score ${score.score}`;
}
