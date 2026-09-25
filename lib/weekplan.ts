import { getDay, parseISO } from "date-fns";
import { minutesFromTime, minutesToTime } from "@/lib/schedule";
import type { ScheduleSlot, ScheduleSlotType, TaskBucket, UserSettings } from "@/types";

export type WorkingWindow = NonNullable<UserSettings["workingWindow"]>;

/** Mon–Sat, 09:00–18:00 — the default when `UserSettings.workingWindow` is unset (plan/14 §5.3). */
export const DEFAULT_WORKING_WINDOW: WorkingWindow = {
  startTime: "09:00",
  endTime: "18:00",
  daysOfWeek: [1, 2, 3, 4, 5, 6]
};

/**
 * plan/14 §5.6 — the fixed weekly-planning admin block, mirroring `routineSlotsForDate`/
 * `courseSlotsForDate` in shape: pure, no Firestore. Returns a locked slot with the stable id
 * `weekly-planning` when `dateKey`'s day-of-week matches the setting, else `null`. The stable id
 * lets `mergeMissingLockedSlots` treat it exactly like a routine block at each of its three call
 * sites (Start day, `/plan/day`, `/plan/calendar`).
 */
export function weeklyPlanningSlotForDate(setting: UserSettings["weeklyPlanning"], dateKey: string): ScheduleSlot | null {
  if (!setting?.enabled) return null;
  if (getDay(parseISO(dateKey)) !== setting.dayOfWeek) return null;
  return {
    id: "weekly-planning",
    title: "Weekly planning",
    type: "admin",
    startTime: setting.startTime,
    endTime: setting.endTime,
    status: "upcoming",
    locked: true
  };
}

/**
 * Minutes of `windowStart`–`windowEnd` (minute-of-day) covered by `slots`, clamping each slot to
 * the window and merging overlaps before summing — a slot that starts before the window or ends
 * after it only contributes the part that actually falls inside. A block wholly outside the window
 * (a 23:00 sleep block, an 08:00 commute against a 09:00–18:00 window) clamps to an empty interval
 * and contributes nothing, which is the property plan/14 AC #5 checks.
 */
function coveredMinutesInWindow(windowStart: number, windowEnd: number, slots: Pick<ScheduleSlot, "startTime" | "endTime">[]): number {
  const intervals = slots
    .map((slot): [number, number] => [Math.max(windowStart, minutesFromTime(slot.startTime)), Math.min(windowEnd, minutesFromTime(slot.endTime))])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);

  let covered = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [start, end] of intervals) {
    if (curEnd === -1) {
      curStart = start;
      curEnd = end;
    } else if (start <= curEnd) {
      curEnd = Math.max(curEnd, end);
    } else {
      covered += curEnd - curStart;
      curStart = start;
      curEnd = end;
    }
  }
  if (curEnd !== -1) covered += curEnd - curStart;
  return covered;
}

/**
 * plan/14 §5.3 — the capacity meter's `free`, deliberately not "the week minus what's booked" (that
 * formula counts 03:00 on a Tuesday as available and yields a number that tells the user they have
 * room to spare — the opposite of what this step exists to produce). `free` is the hours the user
 * intends to work, minus what those hours already contain: for each date in `weekDateKeys` whose
 * day-of-week is in `workingWindow.daysOfWeek`, the working window's length minus whatever of
 * `claimedSlotsByDate[dateKey]` (classes, routine blocks, recurring commitments, already-saved
 * schedule, Google Calendar imports — plan/14 §5.2's "week already contains" layers) falls inside
 * it. `committedMinutes` is passed through unchanged — it's the sum of what Step 3's bucket targets
 * plus checkpoint prep plus the revision queue ask for, which this function has no way to compute
 * on its own (targets are a Step-3 input, not a schedule fact).
 */
export function weekCapacity(params: {
  workingWindow: WorkingWindow;
  weekDateKeys: string[];
  claimedSlotsByDate: Record<string, Pick<ScheduleSlot, "startTime" | "endTime">[]>;
  committedMinutes: number;
  /** plan/15 §5.1 — dates marked off (`Day.dayOff`) contribute 0 to `freeMinutes` outright, the
   *  same as a date outside `workingWindow.daysOfWeek` — a day off isn't "fully claimed," it's not
   *  a working day at all for this week, and the distinction matters for the meter's own wording. */
  offDateKeys?: ReadonlySet<string>;
}): { freeMinutes: number; committedMinutes: number } {
  const { workingWindow, weekDateKeys, claimedSlotsByDate, committedMinutes, offDateKeys } = params;
  const windowStart = minutesFromTime(workingWindow.startTime);
  const windowEnd = minutesFromTime(workingWindow.endTime);
  const windowLength = Math.max(0, windowEnd - windowStart);

  const freeMinutes = weekDateKeys.reduce((sum, dateKey) => {
    if (!workingWindow.daysOfWeek.includes(getDay(parseISO(dateKey)))) return sum;
    if (offDateKeys?.has(dateKey)) return sum;
    const covered = coveredMinutesInWindow(windowStart, windowEnd, claimedSlotsByDate[dateKey] ?? []);
    return sum + Math.max(0, windowLength - covered);
  }, 0);

  return { freeMinutes, committedMinutes };
}

/**
 * plan/14 §5.4 — places a proposed block's `durationMinutes` inside `windowStart`–`windowEnd`
 * (minute-of-day) on a date whose existing + already-accepted `slots` are given, earliest fitting
 * gap first. Bounded to the same working-window bounds the capacity meter measures against, so the
 * meter can never promise room the planner then can't place a block in (plan/14 §5.4). Returns
 * `null` — never a partial or out-of-window placement — when nothing fits, so the caller can list
 * the proposal under "Didn't fit" instead of silently dropping it.
 */
export function placeInWindow(
  slots: Pick<ScheduleSlot, "startTime" | "endTime">[],
  windowStart: number,
  windowEnd: number,
  durationMinutes: number,
  stepMinutes = 15
): number | null {
  if (durationMinutes > windowEnd - windowStart) return null;
  // Deliberately not `rangeOverlapsSlots` (lib/timeline.ts) — that function's `excludeId` check
  // compares `slot.id !== excludeId`, which silently treats every slot as "excluded" (so no
  // overlap is ever detected) when both are `undefined`, exactly the shape a synthetic candidate
  // slot built for this placement search has. A plain range check has no such foot-gun.
  const overlaps = (start: number, end: number) =>
    slots.some((slot) => start < minutesFromTime(slot.endTime) && minutesFromTime(slot.startTime) < end);
  for (let start = windowStart; start + durationMinutes <= windowEnd; start += stepMinutes) {
    if (!overlaps(start, start + durationMinutes)) return start;
  }
  return null;
}

export interface WeekProposalCandidate {
  title: string;
  type: ScheduleSlotType;
  durationMinutes: number;
  /** Fixed day this candidate must land on (checkpoint prep, the revision queue) — the caller is
   *  responsible for never generating one of these against a date in `offDateKeys` (plan/15 §5.2's
   *  own note: a hard pin is a generation-time decision, not something `placeProposals` overrides). */
  dateKey?: string;
  /** plan/15 §5.2 — days to try, in order, before falling back to the general least-loaded search
   *  — unlike `dateKey`, never a hard requirement. Used for "this course's lecture days" (revision)
   *  and "the weekend" (backlog). Still subject to the day-off exclusion and the per-day cap, same
   *  as a floating candidate with no preference at all. */
  preferredDateKeys?: string[];
  courseId?: string;
  bucket?: TaskBucket;
  taskId?: string;
  refType?: "checkpoint" | "revision";
  refId?: string;
}

export interface WeekProposal extends WeekProposalCandidate {
  key: string;
  dateKey: string;
  startTime: string;
  endTime: string;
  fits: boolean;
}

function totalClaimedMinutes(slots: Pick<ScheduleSlot, "startTime" | "endTime">[]): number {
  return slots.reduce((sum, slot) => sum + Math.max(0, minutesFromTime(slot.endTime) - minutesFromTime(slot.startTime)), 0);
}

/**
 * plan/14 §5.4, redesigned by plan/15 §5.2 — places each candidate inside the working window.
 * Three tiers per candidate, tried in order: (1) a hard `dateKey` pin, unchanged from `14` and
 * exempt from the per-day cap below — checkpoint prep and the revision queue were never the
 * problem; (2) `preferredDateKeys`, in order; (3) every remaining working day, least-loaded first.
 * Day-off dates (`offDateKeys`) are removed from the working-day pool entirely before any of this
 * runs — not deprioritized, unreachable — which is what actually stops a day nobody intended to
 * work from winning the least-loaded search just because it looks emptiest.
 *
 * The per-day cap (plan/15 §5.2 #2) is the fix for the *other* half of the bug that exclusion alone
 * doesn't touch: an ordinary day that's merely emptier than its neighbors (nobody's planned it yet)
 * has the same magnet effect a holiday does. No more than 1.5x the even share of this pass's own
 * floating+preferred minutes may land newly on one day — generous enough that a genuinely lighter
 * day still takes more than its exact share, tight enough that one day can no longer absorb most of
 * the week. Once a day hits its cap it's removed from tiers 2/3 for the rest of this pass (not just
 * deprioritized — a later large candidate could otherwise push it well over). A candidate whose
 * every reachable day has no room, capped or not, comes back with `fits: false` — never silently
 * dropped, so the caller can list it under "Didn't fit".
 */
export function placeProposals(
  candidates: WeekProposalCandidate[],
  weekDateKeys: string[],
  claimedSlotsByDate: Record<string, Pick<ScheduleSlot, "startTime" | "endTime">[]>,
  workingWindow: WorkingWindow,
  offDateKeys: ReadonlySet<string> = new Set()
): WeekProposal[] {
  const windowStart = minutesFromTime(workingWindow.startTime);
  const windowEnd = minutesFromTime(workingWindow.endTime);
  const workingDates = weekDateKeys.filter((d) => workingWindow.daysOfWeek.includes(getDay(parseISO(d))) && !offDateKeys.has(d));
  const simulated: Record<string, { startTime: string; endTime: string }[]> = {};
  for (const d of weekDateKeys) simulated[d] = [...(claimedSlotsByDate[d] ?? [])];

  const floatingMinutes = candidates.filter((c) => !c.dateKey).reduce((sum, c) => sum + c.durationMinutes, 0);
  const perDayCap = workingDates.length > 0 ? Math.ceil((floatingMinutes / workingDates.length) * 1.5) : Infinity;
  const newlyProposedMinutes: Record<string, number> = {};
  for (const d of workingDates) newlyProposedMinutes[d] = 0;
  const cappedDays = new Set<string>();

  function tryPlace(dateKey: string, durationMinutes: number): number | null {
    return placeInWindow(simulated[dateKey] ?? [], windowStart, windowEnd, durationMinutes);
  }

  function commit(dateKey: string, start: number, durationMinutes: number, trackCap: boolean) {
    const slot = { startTime: minutesToTime(start), endTime: minutesToTime(start + durationMinutes) };
    simulated[dateKey].push(slot);
    if (trackCap) {
      newlyProposedMinutes[dateKey] = (newlyProposedMinutes[dateKey] ?? 0) + durationMinutes;
      if (newlyProposedMinutes[dateKey] >= perDayCap) cappedDays.add(dateKey);
    }
    return slot;
  }

  return candidates.map((candidate, index) => {
    const key = `${index}`;

    if (candidate.dateKey) {
      const start = tryPlace(candidate.dateKey, candidate.durationMinutes);
      if (start !== null) {
        const slot = commit(candidate.dateKey, start, candidate.durationMinutes, false);
        return { ...candidate, key, dateKey: candidate.dateKey, ...slot, fits: true };
      }
      return { ...candidate, key, dateKey: candidate.dateKey, startTime: "00:00", endTime: "00:00", fits: false };
    }

    const preferred = (candidate.preferredDateKeys ?? []).filter((d) => workingDates.includes(d) && !cappedDays.has(d));
    const fallback = [...workingDates]
      .filter((d) => !cappedDays.has(d) && !preferred.includes(d))
      .sort((a, b) => totalClaimedMinutes(simulated[a]) - totalClaimedMinutes(simulated[b]));

    for (const dateKey of [...preferred, ...fallback]) {
      const start = tryPlace(dateKey, candidate.durationMinutes);
      if (start !== null) {
        const slot = commit(dateKey, start, candidate.durationMinutes, true);
        return { ...candidate, key, dateKey, ...slot, fits: true };
      }
    }
    return { ...candidate, key, dateKey: candidate.preferredDateKeys?.[0] ?? workingDates[0] ?? weekDateKeys[0], startTime: "00:00", endTime: "00:00", fits: false };
  });
}
