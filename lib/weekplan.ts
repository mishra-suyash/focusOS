import { getDay, parseISO } from "date-fns";
import { minutesFromTime, minutesToTime } from "@/lib/schedule";
import type { ScheduleSlot, ScheduleSlotType, SlotObjectiveRef, TaskBucket, UserSettings } from "@/types";

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
  /** plan/16 §5.2 — what this candidate is FOR, in the one shape that survives being accepted onto
   *  a day. `refType`/`refId` above are kept for the `14`-era callers and the stored `WeekPlan`
   *  shape; this is what `acceptProposals` actually copies onto the slot. */
  objectiveRef?: SlotObjectiveRef;
  /** plan/16 §5.1 — set when this candidate is one sitting of a split piece of work. Every sibling
   *  sitting of the same split shares `groupId`; `index`/`total` are 1-based, for display only. */
  chunk?: { groupId: string; index: number; total: number };
  /** plan/16 §5.1 — minutes this sitting is planned to contribute. Normally equal to
   *  `durationMinutes`; carried separately so a later resize on the timeline can't rewrite what the
   *  week was understood to have committed. */
  plannedMinutes?: number;
  /** plan/16 §5.1 — an exact clock time this candidate must land at, not merely an exact day
   *  (`dateKey`). Set from `Task.fixedTime`: a 14:00 TA meeting is at 14:00 or it does not happen,
   *  so unlike every other candidate there is nothing for the gap search to decide. Requires
   *  `dateKey`; if the pinned range is already occupied the candidate comes back `fits: false`
   *  rather than being quietly moved, because moving it would discard the one fact that mattered. */
  fixedStartTime?: string;
  /** plan/16 §5.3 — a stable identity for this candidate, minted by its generator from what the
   *  candidate is *about* (`task:<id>:2`, `revision:<courseId>:0`, `paper:<id>:1`) rather than from
   *  where it landed in the array. Absent = the array index, which is what every pre-`16` caller
   *  got and what `verify-weekplan.ts` still pins.
   *
   *  This exists because plan/16 §8 Q2's "mostly moot" stopped being true once the week grid landed
   *  (§5.3). An index key silently re-targets whenever the candidate list shifts — accept a "What's
   *  coming" row (which appends candidates), add a course, mark a day off, or log a session that
   *  zeroes a task's outstanding minutes, and every stored drag position and accept/dismiss decision
   *  now applies to a different proposal than the one it was made about. Latent as a wrong row in a
   *  list; unusable as "I dragged this block and another one moved". */
  key?: string;
  /** plan/16 — which *family* of work this candidate belongs to (`revision:<courseId>`,
   *  `checkpoint:<id>`, `paper:<id>`, `task:<id>`, `revisionQueue:<dateKey>`). Dismissals are recorded
   *  against the family in minutes, not against the candidate: a family's candidates are
   *  interchangeable sittings of one piece of work, regenerated at whatever length the remaining
   *  minutes call for, so there is no individual candidate for a decision to belong to. */
  family?: string;
  /** plan/15 §5.2's cap, revised — which pool this candidate's per-day allowance is computed
   *  against. Candidates sharing a `capGroup` compete for one shared cap; every candidate that
   *  omits it falls into one implicit shared pool instead (the original behavior, before this
   *  field existed). The caller sets this per generation batch — e.g. `revision:<courseId>` — so
   *  a course's revision minutes are capped relative to *that course's own* weekly total, not the
   *  whole week's floating volume. Without it, a heavy week (several courses, big targets) could
   *  inflate one global cap number so far that a single preferred day legally absorbed an entire
   *  bucket's worth of work before tripping it — see plan/15 §2.2's bug, recurring in live use. */
  capGroup?: string;
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
 *
 * The cap is scoped per `capGroup` (candidates that omit it all share one implicit pool), not to
 * the week's total floating minutes — an earlier version used one cap for everything, which meant
 * a heavy week (several courses, big weekly targets) inflated that single number so far that one
 * course's revision bucket, preferring its one lecture day, could legally dump its *entire* week's
 * revision there before the cap ever tripped (found live: 12 chunks, one course, one day, 06:00 to
 * 17:10). Scoping the cap to each candidate's own pool means a course's revision minutes are capped
 * relative to that course's own fair share; once its preferred day is reasonably full, the rest
 * spills to the general least-loaded search exactly like any other candidate.
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

  const DEFAULT_CAP_GROUP = "__default__";
  const floatingByGroup: Record<string, number> = {};
  for (const c of candidates) {
    if (c.dateKey) continue;
    const key = c.capGroup ?? DEFAULT_CAP_GROUP;
    floatingByGroup[key] = (floatingByGroup[key] ?? 0) + c.durationMinutes;
  }
  const capByGroup: Record<string, number> = {};
  for (const key of Object.keys(floatingByGroup)) {
    capByGroup[key] = workingDates.length > 0 ? Math.ceil((floatingByGroup[key] / workingDates.length) * 1.5) : Infinity;
  }
  const newlyProposedMinutes: Record<string, number> = {}; // keyed by `${capGroup}|${dateKey}`
  const cappedGroupDays = new Set<string>();

  function tryPlace(dateKey: string, durationMinutes: number): number | null {
    return placeInWindow(simulated[dateKey] ?? [], windowStart, windowEnd, durationMinutes);
  }

  function commit(dateKey: string, start: number, durationMinutes: number, capGroup: string | null) {
    const slot = { startTime: minutesToTime(start), endTime: minutesToTime(start + durationMinutes) };
    simulated[dateKey].push(slot);
    if (capGroup) {
      const groupDayKey = `${capGroup}|${dateKey}`;
      newlyProposedMinutes[groupDayKey] = (newlyProposedMinutes[groupDayKey] ?? 0) + durationMinutes;
      if (newlyProposedMinutes[groupDayKey] >= (capByGroup[capGroup] ?? Infinity)) cappedGroupDays.add(groupDayKey);
    }
    return slot;
  }

  return candidates.map((candidate, index) => {
    // plan/16 §5.3 — the generator's own stable key where it minted one, the array index otherwise.
    const key = candidate.key ?? `${index}`;

    if (candidate.dateKey && candidate.fixedStartTime) {
      // plan/16 §5.1 — an exact-time pin: the only question is whether that exact range is free.
      const start = minutesFromTime(candidate.fixedStartTime);
      const end = start + candidate.durationMinutes;
      const occupied = (simulated[candidate.dateKey] ?? []).some(
        (slot) => start < minutesFromTime(slot.endTime) && minutesFromTime(slot.startTime) < end
      );
      if (!occupied) {
        const slot = commit(candidate.dateKey, start, candidate.durationMinutes, null);
        return { ...candidate, key, dateKey: candidate.dateKey, ...slot, fits: true };
      }
      return { ...candidate, key, dateKey: candidate.dateKey, startTime: candidate.fixedStartTime, endTime: minutesToTime(end), fits: false };
    }

    if (candidate.dateKey) {
      const start = tryPlace(candidate.dateKey, candidate.durationMinutes);
      if (start !== null) {
        const slot = commit(candidate.dateKey, start, candidate.durationMinutes, null);
        return { ...candidate, key, dateKey: candidate.dateKey, ...slot, fits: true };
      }
      return { ...candidate, key, dateKey: candidate.dateKey, startTime: "00:00", endTime: "00:00", fits: false };
    }

    const capGroup = candidate.capGroup ?? DEFAULT_CAP_GROUP;
    const isCapped = (d: string) => cappedGroupDays.has(`${capGroup}|${d}`);
    const preferred = (candidate.preferredDateKeys ?? []).filter((d) => workingDates.includes(d) && !isCapped(d));
    const fallback = [...workingDates]
      .filter((d) => !isCapped(d) && !preferred.includes(d))
      .sort((a, b) => totalClaimedMinutes(simulated[a]) - totalClaimedMinutes(simulated[b]));

    for (const dateKey of [...preferred, ...fallback]) {
      const start = tryPlace(dateKey, candidate.durationMinutes);
      if (start !== null) {
        const slot = commit(dateKey, start, candidate.durationMinutes, capGroup);
        return { ...candidate, key, dateKey, ...slot, fits: true };
      }
    }
    return { ...candidate, key, dateKey: candidate.preferredDateKeys?.[0] ?? workingDates[0] ?? weekDateKeys[0], startTime: "00:00", endTime: "00:00", fits: false };
  });
}

/**
 * plan/16 §5.3 — resolves a requested placement (a drag's drop position, or a typed day/time/
 * duration) into one the rest of the app can actually honor, and says what it had to change.
 *
 * Pure, and deliberately not left inside the page: a typed duration reaches much further than its
 * own block, and every one of those consequences is a rule worth pinning in a test rather than
 * re-deriving in a component.
 *
 * - **The sitting cap is not advisory.** `startFocus` clamps the armed timer to `maxChunkMinutes`,
 *   so a 120-minute block arms a 50-minute timer; 50 of 120 is 42%, under `slotAutoStatus`'s 60%
 *   threshold, so the block can never auto-close however well it is worked — and `computeDayScore`
 *   then counts it unfinished *and* divides its coverage by the inflated 120. A block over the cap
 *   is unfinishable by construction, so permitting one isn't flexibility, it's a trap.
 * - **`plannedMinutes` is read by next week's planner** (`plannedMinutesThisWeek`), which subtracts
 *   it before deciding how much to propose. Inflating it quietly tells the planner more is planned
 *   than the work needs, and the difference stops rolling forward.
 * - **The locked layer cannot move.** Growth stops at whatever is next on the day. Other proposals
 *   could in principle be pushed aside, but silently reflowing a block the user placed on purpose is
 *   worse than stopping short and saying why.
 */
export function resolvePlacement(
  requested: { dateKey: string; startMinutes: number; durationMinutes: number },
  context: {
    /** Start/end of every immovable thing and every other standing proposal on that date. */
    occupied: { startTime: string; endTime: string; title: string }[];
    workingWindow: WorkingWindow;
    maxChunkMinutes: number;
    minChunkMinutes: number;
  }
): { placement: { dateKey: string; startMinutes: number; durationMinutes: number }; notes: string[] } {
  const windowStart = minutesFromTime(context.workingWindow.startTime);
  const windowEnd = minutesFromTime(context.workingWindow.endTime);
  const max = Math.max(1, context.maxChunkMinutes);
  const min = Math.max(1, Math.min(context.minChunkMinutes, max));
  const notes: string[] = [];

  let durationMinutes = Math.round(requested.durationMinutes);
  if (durationMinutes > max) {
    durationMinutes = max;
    notes.push(`Capped at ${max} min — that's your longest sitting. Add a second sitting for more.`);
  } else if (durationMinutes < min) {
    durationMinutes = min;
    notes.push(`Raised to ${min} min — that's your shortest sitting.`);
  }

  const startMinutes = Math.max(windowStart, Math.min(Math.round(requested.startMinutes), Math.max(windowStart, windowEnd - min)));

  const next = context.occupied
    .map((item) => ({ start: minutesFromTime(item.startTime), title: item.title }))
    .filter((item) => item.start > startMinutes)
    .sort((a, b) => a.start - b.start)[0];
  const ceiling = Math.min(windowEnd, next?.start ?? windowEnd);
  const room = ceiling - startMinutes;

  if (durationMinutes > room) {
    if (room >= min) {
      notes.push(
        next && next.start <= windowEnd
          ? `Trimmed to ${room} min — "${next.title}" starts at ${minutesToTime(next.start)}.`
          : `Trimmed to ${room} min — your working window ends at ${context.workingWindow.endTime}.`
      );
      durationMinutes = room;
    } else {
      // Left at the requested length on purpose: the caller's own overlap check then reports it as
      // unacceptable where it stands, which is more useful than shrinking it to a stub that fits.
      notes.push("There's no room to grow it here — move it to a freer slot first.");
    }
  }

  return { placement: { dateKey: requested.dateKey, startMinutes, durationMinutes }, notes };
}
