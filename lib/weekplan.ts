import { getDay, parseISO } from "date-fns";
import { minutesFromTime, minutesToTime } from "@/lib/schedule";
import type { ReadingHabit, ScheduleSlot, ScheduleSlotType, SlotObjectiveRef, TaskBucket, UserSettings } from "@/types";

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
 * The moment planning is measured from. A week being planned on its own Monday at 07:21 cannot use
 * 05:30–07:21 of that Monday, nor any earlier day — counting them made the meter promise hours that
 * were already gone, and the placement search proposed sittings into the past. Absent = no floor
 * (a future week, and every pure-function test that predates this).
 */
export type NowFloor = { dateKey: string; minutes: number };

/** The part of the working window on `dateKey` that is still usable: the whole window on a future
 *  date, the window from the next 15-minute mark on today, `null` on a past date or once today's
 *  window has run out. Says nothing about `daysOfWeek` or days off — callers decide those. */
export function usableWindow(workingWindow: WorkingWindow, dateKey: string, now?: NowFloor): { start: number; end: number } | null {
  const end = minutesFromTime(workingWindow.endTime);
  let start = minutesFromTime(workingWindow.startTime);
  if (now) {
    if (dateKey < now.dateKey) return null;
    if (dateKey === now.dateKey) start = Math.max(start, Math.ceil(now.minutes / 15) * 15);
  }
  return end > start ? { start, end } : null;
}

/**
 * Free minutes on one day: the usable window minus whatever of `slots` falls inside it, overlaps
 * merged. The one definition of "free" — the capacity meter sums it over the week with the locked
 * layer, the week grid shows it per day with the proposals added — so the two can only differ by
 * what they were asked to subtract, never by how they count.
 */
export function freeMinutesOnDay(
  workingWindow: WorkingWindow,
  dateKey: string,
  slots: Pick<ScheduleSlot, "startTime" | "endTime">[],
  opts: { offDateKeys?: ReadonlySet<string>; now?: NowFloor } = {}
): number {
  if (!workingWindow.daysOfWeek.includes(getDay(parseISO(dateKey)))) return 0;
  if (opts.offDateKeys?.has(dateKey)) return 0;
  const window = usableWindow(workingWindow, dateKey, opts.now);
  if (!window) return 0;
  return Math.max(0, window.end - window.start - coveredMinutesInWindow(window.start, window.end, slots));
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
  /** Hours already behind you this week are not free. */
  now?: NowFloor;
}): { freeMinutes: number; committedMinutes: number } {
  const { workingWindow, weekDateKeys, claimedSlotsByDate, committedMinutes, offDateKeys, now } = params;
  const freeMinutes = weekDateKeys.reduce(
    (sum, dateKey) => sum + freeMinutesOnDay(workingWindow, dateKey, claimedSlotsByDate[dateKey] ?? [], { offDateKeys, now }),
    0
  );

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
  /** The title before `sittingTitle` numbered it, for a sitting whose title carries its number —
   *  what lets `renumberSittings` rewrite "(1 of 3)" when the sitting is moved. */
  sittingBase?: string;
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
  /** plan/17 §6.3 — the spread rule: candidates sharing a `spreadGroup` go to the day holding the
   *  fewest of the group (counting what's already on the calendar with the same slot `type`) before
   *  any day gets a second — "at most one reading sitting per day until every working day has one".
   *  A habit is built by frequency, not by one big block. Soft: when the emptiest days have no room,
   *  the next level is used. */
  spreadGroup?: ScheduleSlotType;
  /** plan/17 §6.1 — a preferred part of the day, minutes from midnight. Tried first on each day,
   *  then the whole usable window. */
  preferredWindow?: { start: number; end: number };
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

const INDEXED_KEY = /^(.*):(\d+)$/;
const DATED_KEY = /\d{4}-\d{2}-\d{2}$/;

/**
 * Anything keyed by proposal key (the week grid's drag positions and their notes), carried across
 * an Accept or a Dismiss. A family's keys are `<family>:<index>` over sittings that are regenerated
 * from what is still owed, so removing `:0` of three makes the next render's `:0` the old `:1`. Left
 * as they were, an accepted sitting's position would land on whichever sitting inherited its key —
 * on top of the block just saved — and every later one would sit one sitting off.
 *
 * Removed keys are dropped and the later ones in the same family shift down. A key whose last part
 * is a date (lead-time spreads, `task:<id>:<index>:<dateKey>`) or has no index (`task:<id>:fixed`)
 * is only dropped if removed; nothing else in that family is renumbered by this.
 */
export function keyedAfterRemoval<T>(byKey: Record<string, T>, removedKeys: string[]): Record<string, T> {
  const removed = new Set(removedKeys);
  const indexed = (key: string) => (DATED_KEY.test(key) ? null : INDEXED_KEY.exec(key));
  const removedByFamily = new Map<string, number[]>();
  for (const key of removedKeys) {
    const match = indexed(key);
    if (match) removedByFamily.set(match[1], [...(removedByFamily.get(match[1]) ?? []), Number(match[2])]);
  }
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(byKey)) {
    if (removed.has(key)) continue;
    const match = indexed(key);
    const familyRemoved = match ? removedByFamily.get(match[1]) : undefined;
    if (!match || !familyRemoved) {
      next[key] = value;
      continue;
    }
    const index = Number(match[2]);
    next[`${match[1]}:${index - familyRemoved.filter((i) => i < index).length}`] = value;
  }
  return next;
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
  claimedSlotsByDate: Record<string, (Pick<ScheduleSlot, "startTime" | "endTime"> & { type?: ScheduleSlotType })[]>,
  workingWindow: WorkingWindow,
  offDateKeys: ReadonlySet<string> = new Set(),
  now?: NowFloor
): WeekProposal[] {
  const workingDates = weekDateKeys.filter(
    (d) => workingWindow.daysOfWeek.includes(getDay(parseISO(d))) && !offDateKeys.has(d) && usableWindow(workingWindow, d, now) !== null
  );
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
  // plan/17 §6.3 — per spread group, how many of its blocks each day holds: seeded from the calendar
  // (a reading sitting already accepted on Tuesday counts), then bumped as candidates land.
  const spreadCount: Record<string, number> = {}; // keyed by `${spreadGroup}|${dateKey}`
  for (const group of new Set(candidates.flatMap((c) => (c.spreadGroup ? [c.spreadGroup] : [])))) {
    for (const d of weekDateKeys) {
      spreadCount[`${group}|${d}`] = (claimedSlotsByDate[d] ?? []).filter((slot) => slot.type === group).length;
    }
  }

  function tryPlace(dateKey: string, durationMinutes: number, preferredWindow?: { start: number; end: number }): number | null {
    const window = usableWindow(workingWindow, dateKey, now);
    if (!window) return null;
    if (preferredWindow) {
      const start = Math.max(window.start, preferredWindow.start);
      const end = Math.min(window.end, preferredWindow.end);
      if (end > start) {
        const inPreferred = placeInWindow(simulated[dateKey] ?? [], start, end, durationMinutes);
        if (inPreferred !== null) return inPreferred;
      }
    }
    return placeInWindow(simulated[dateKey] ?? [], window.start, window.end, durationMinutes);
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
      const window = usableWindow(workingWindow, candidate.dateKey, now);
      const occupied = (simulated[candidate.dateKey] ?? []).some(
        (slot) => start < minutesFromTime(slot.endTime) && minutesFromTime(slot.startTime) < end
      );
      // A pinned time that has already passed is refused like an occupied one: proposing a sitting
      // into the past is a block that can only ever be missed.
      const passed = !window || start < window.start;
      if (!occupied && !passed) {
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
    let order = [...preferred, ...fallback];
    const spread = candidate.spreadGroup;
    if (spread) {
      // Stable sort: fewest of the group first; preference and load still order days within a level.
      order = order.map((d, i) => ({ d, i, n: spreadCount[`${spread}|${d}`] ?? 0 })).sort((a, b) => a.n - b.n || a.i - b.i).map((x) => x.d);
    }

    for (const dateKey of order) {
      const start = tryPlace(dateKey, candidate.durationMinutes, candidate.preferredWindow);
      if (start !== null) {
        const slot = commit(dateKey, start, candidate.durationMinutes, capGroup);
        if (spread) spreadCount[`${spread}|${dateKey}`] = (spreadCount[`${spread}|${dateKey}`] ?? 0) + 1;
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
    /** Today's elapsed part of the window is not a place a sitting can start. */
    now?: NowFloor;
  }
): { placement: { dateKey: string; startMinutes: number; durationMinutes: number }; notes: string[] } {
  const windowStart = usableWindow(context.workingWindow, requested.dateKey, context.now)?.start ?? minutesFromTime(context.workingWindow.startTime);
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

/** plan/17 §6.1 — the part of the day each time-of-day preference means, minutes from midnight. */
export const TIME_OF_DAY_WINDOWS: Record<NonNullable<ReadingHabit["timeOfDay"]>, { start: number; end: number }> = {
  morning: { start: 0, end: 12 * 60 },
  afternoon: { start: 12 * 60, end: 17 * 60 },
  evening: { start: 17 * 60, end: 24 * 60 }
};

export interface OwedPass {
  paperId: string;
  title: string;
  passNo: 1 | 2 | 3;
  /** What's left of the pass's estimate — its calibrated length less what's already logged. */
  minutes: number;
}

export interface ReadingHabitPlan {
  /** Sittings × minutes — what the week asks. */
  ask: number;
  /** Reading sittings on the calendar this week, open or pinned to any paper (cut-off applied). */
  placed: number;
  dismissed: number;
  /** Sittings still to place that are pinned to a paper owed a pass, in the order they're owed. */
  pinned: { paper: OwedPass; minutes: number[] }[];
  /** Sittings still to place with no paper — picked when they start. */
  open: number[];
  /** Owed passes the target has no sittings left for — listed, never proposed. */
  alsoOwed: OwedPass[];
  /** The sitting length actually used: the habit's, held under the sitting cap. */
  sittingMinutes: number;
  /** Minutes still owed but too few for a sitting of their own — not proposed. */
  shortfall: number;
}

/**
 * plan/17 §6.2 — the reading row of the week. Reading is a habit with a target, so the row exists
 * whenever the target does, whether or not any paper is ready (the root cause of F1 was the opposite:
 * no eligible paper, no row, no reading planned at all).
 *
 * Pass demand doesn't *create* the row, it shapes it: each owed pass, in order, pins as many of the
 * still-to-place sittings as it needs (`ceil(minutes left / sitting length)`); the rest stay open.
 * Owed passes beyond the target don't inflate the ask — they come back as `alsoOwed`.
 *
 * Everything is minutes against the calendar, the same rule as every other family: what's placed (an
 * open sitting, or a sitting pinned to any paper) and what's dismissed (`readingHabit` or any
 * `paper:<id>` family) come off the ask; a paper's own placed and dismissed minutes come off what it
 * still needs pinned.
 */
export function readingHabitPlan(params: {
  target: Pick<ReadingHabit, "sittings" | "minutes">;
  owed: OwedPass[];
  placedOpen: number;
  placedByPaper: Record<string, number>;
  dismissedMinutes: Record<string, number>;
  maxChunkMinutes: number;
  minChunkMinutes: number;
}): ReadingHabitPlan {
  const { target, owed, placedOpen, placedByPaper, dismissedMinutes, maxChunkMinutes, minChunkMinutes } = params;
  const sittingMinutes = Math.max(minChunkMinutes, Math.min(Math.round(target.minutes), maxChunkMinutes));
  const ask = Math.max(0, Math.round(target.sittings)) * sittingMinutes;
  const placed = placedOpen + Object.values(placedByPaper).reduce((sum, minutes) => sum + minutes, 0);
  const dismissed = Object.entries(dismissedMinutes)
    .filter(([family]) => family === "readingHabit" || family.startsWith("paper:"))
    .reduce((sum, [, minutes]) => sum + minutes, 0);
  const remaining = Math.max(0, ask - placed - dismissed);

  // Whole sittings at the habit's length. A remainder too short to sit with on its own (a past sitting
  // that got 20 of its 30 minutes leaves 10) isn't proposed — it's reported as `shortfall` so the row's
  // arithmetic still adds up.
  const pool: number[] = [];
  let left = remaining;
  while (left >= sittingMinutes) {
    pool.push(sittingMinutes);
    left -= sittingMinutes;
  }
  if (left >= minChunkMinutes) {
    pool.push(left);
    left = 0;
  }
  const shortfall = left;

  const pinned: ReadingHabitPlan["pinned"] = [];
  const alsoOwed: OwedPass[] = [];
  for (const paper of owed) {
    const family = `paper:${paper.paperId}`;
    const need = Math.max(0, paper.minutes - (placedByPaper[paper.paperId] ?? 0) - (dismissedMinutes[family] ?? 0));
    if (need <= 0) continue;
    const wanted = Math.ceil(need / sittingMinutes);
    const take = Math.min(wanted, pool.length);
    if (take === 0) {
      alsoOwed.push({ ...paper, minutes: need });
      continue;
    }
    pinned.push({ paper, minutes: pool.splice(0, take) });
  }
  return { ask, placed, dismissed, pinned, open: pool, alsoOwed, sittingMinutes, shortfall };
}

// ---- plan/17 §7 — replanning a week ----

/**
 * plan/17 §7.3 — whether weekly planning put this slot on its day. Read off the markers an accepted
 * proposal carries: an `objectiveRef`; a sitting `chunk` whose group is the planner's own
 * deterministic `…:<weekStart>` id (a split made by hand on /plan/day gets a random uuid instead); or a
 * course bucket with no task (a task dropped on a day by hand always carries its task). A single
 * task sitting with no chunk is ambiguous between the planner and "Schedule it", so it counts as yours.
 */
export function isPlannerMade(slot: Pick<ScheduleSlot, "objectiveRef" | "chunk" | "courseId" | "bucket" | "assignedTaskIds">, weekStart: string): boolean {
  if (slot.objectiveRef) return true;
  if (slot.chunk?.groupId.endsWith(`:${weekStart}`)) return true;
  return Boolean(slot.courseId && slot.bucket && !slot.assignedTaskIds?.length);
}

/** The accounting family a slot's minutes belong to — the same keys the planner's candidates use. */
export function slotFamily(slot: Pick<ScheduleSlot, "objectiveRef" | "courseId" | "bucket" | "assignedTaskIds">, dateKey: string): string | null {
  const ref = slot.objectiveRef;
  if (ref?.kind === "paper") return `paper:${ref.id}`;
  if (ref?.kind === "readingHabit") return "readingHabit";
  if (ref?.kind === "checkpoint") return `checkpoint:${ref.id}`;
  if (ref?.kind === "revisionQueue") return `revisionQueue:${dateKey}`;
  if (ref?.kind === "goal") return `milestone:${ref.id}:${ref.milestoneId ?? ""}`;
  if (slot.assignedTaskIds?.length) return `task:${slot.assignedTaskIds[0]}`;
  if (slot.courseId && slot.bucket) return `${slot.bucket}:${slot.courseId}`;
  return null;
}

export interface ReleasedSlot {
  dateKey: string;
  slot: ScheduleSlot;
  family: string | null;
}

/**
 * plan/17 §7.3 — what a replan takes back off the calendar to lay out again: every sitting the planner
 * placed from now on this week that nobody has started. All of these must hold:
 *
 * - on today with its start still ahead, or a later day of the week;
 * - planner-made (`isPlannerMade`);
 * - not locked, not a class, an external calendar event, a commitment or the weekly-planning anchor;
 * - no logged minutes against it (sessions filtered to its own date — recurring ids repeat);
 * - status `upcoming`.
 *
 * Never touched: blocks you added by hand, the locked layer, anything worked or running, anything on a
 * day behind you.
 */
export function releasableSlots(params: {
  schedules: { dateKey: string; slots: ScheduleSlot[] }[];
  weekDateKeys: string[];
  weekStart: string;
  todayKey: string;
  nowMinutes: number;
  sessions: { slotId?: string; mode: string; minutes: number; completedAt: string }[];
}): ReleasedSlot[] {
  const { schedules, weekDateKeys, weekStart, todayKey, nowMinutes, sessions } = params;
  const released: ReleasedSlot[] = [];
  for (const schedule of schedules) {
    const dateKey = schedule.dateKey;
    if (!weekDateKeys.includes(dateKey) || dateKey < todayKey) continue;
    for (const slot of schedule.slots) {
      if (dateKey === todayKey && minutesFromTime(slot.startTime) < nowMinutes) continue;
      if (slot.locked || slot.type === "class" || slot.type === "external" || slot.sourceGoogleEventId) continue;
      if (slot.id.startsWith("commitment-") || slot.id === "weekly-planning") continue;
      if (slot.status !== "upcoming") continue;
      if (!isPlannerMade(slot, weekStart)) continue;
      const worked = sessions.some((session) => session.mode === "work" && session.slotId === slot.id && session.completedAt.startsWith(dateKey) && session.minutes > 0);
      if (worked) continue;
      released.push({ dateKey, slot, family: slotFamily(slot, dateKey) });
    }
  }
  return released;
}

export interface ReplanDiff {
  /** A released sitting and where its family's work lands now. */
  moved: { from: ReleasedSlot; to: WeekProposal }[];
  /** Proposals that don't continue any released sitting — newly owed work. */
  added: WeekProposal[];
  /** Released sittings whose work isn't proposed again (it's no longer owed, or was dismissed). */
  dropped: ReleasedSlot[];
  /** Proposals with no room anywhere — listed under "Didn't fit". */
  unplaced: WeekProposal[];
}

/**
 * plan/17 §7.4 — the replan as a diff: each released sitting is matched to a proposal of the same
 * family (in time order on both sides), so the preview can say "moved Tue 10:00 → Wed 14:00" rather
 * than "removed 4, added 4".
 */
export function replanDiff(released: ReleasedSlot[], proposals: WeekProposal[]): ReplanDiff {
  const byTime = <T,>(at: (item: T) => string) => (a: T, b: T) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0);
  const placed = proposals.filter((p) => p.fits).sort(byTime((p) => `${p.dateKey} ${p.startTime}`));
  const unplaced = proposals.filter((p) => !p.fits);
  const used = new Set<string>();
  const moved: ReplanDiff["moved"] = [];
  const dropped: ReleasedSlot[] = [];
  const sameFamily = (from: ReleasedSlot, p: WeekProposal) => !used.has(p.key) && (p.family ?? p.key) === from.family;
  // A sitting offered back at its own time is "kept", whatever the order — pair those first, so the
  // rest pair up in time order without claiming a kept sitting's proposal.
  const exact = new Map<ReleasedSlot, WeekProposal>();
  for (const from of released) {
    const to = from.family ? placed.find((p) => sameFamily(from, p) && p.dateKey === from.dateKey && p.startTime === from.slot.startTime) : undefined;
    if (to) {
      used.add(to.key);
      exact.set(from, to);
    }
  }
  for (const from of [...released].sort(byTime((r) => `${r.dateKey} ${r.slot.startTime}`))) {
    const kept = exact.get(from);
    if (kept) {
      moved.push({ from, to: kept });
      continue;
    }
    const to = from.family ? placed.find((p) => sameFamily(from, p)) : undefined;
    if (to) {
      used.add(to.key);
      moved.push({ from, to });
    } else {
      dropped.push(from);
    }
  }
  return { moved, added: placed.filter((p) => !used.has(p.key)), dropped, unplaced };
}
