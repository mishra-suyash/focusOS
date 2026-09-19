import { createSlot, minutesFromTime, minutesToTime, sortedSlots, validateSlots } from "@/lib/schedule";
import type { Category, ScheduleSlot, ScheduleSlotType, Task } from "@/types";

/**
 * Pure geometry/parsing helpers for the Plan — Day drag-and-drop timeline
 * (plan/FocusOS-v2-Plan-Day-Timeline.md §7.2, DP0). `lib/schedule.ts` stays the single source of
 * truth for "is this array of slots valid" (`validateSlots`, used by Save day) — these functions
 * are new capability for the grid (gap-finding, ripple, lane layout) that validateSlots never
 * needed, not a re-implementation of it.
 */

export const MINUTES_PER_DAY = 1440;

export function minutesToPx(minutes: number, pxPerHour: number): number {
  return (minutes / 60) * pxPerHour;
}

export function pxToMinutes(px: number, pxPerHour: number): number {
  return (px / pxPerHour) * 60;
}

/** Rounds to the nearest `snapTo`-minute increment (D4's default is 15). */
export function snapMinutes(minutes: number, snapTo = 15): number {
  return Math.round(minutes / snapTo) * snapTo;
}

/** Clamps to a valid time-of-day: 00:00 (0) through 24:00 (1440) inclusive — D1 allows "24:00" as a valid end, but no block may extend past it (no cross-date blocks). */
export function clampToDay(minutes: number): number {
  return Math.min(MINUTES_PER_DAY, Math.max(0, minutes));
}

/**
 * §4.2 "edge magnetism" — when a dragged edge comes within `thresholdMinutes` of a neighbor's
 * edge, snaps to it exactly, so two blocks can end up back-to-back with no gap. Falls back to the
 * ordinary grid snap when nothing is close enough. Checked before the regular snap in DP2's
 * pointer handlers, not instead of it — magnetism wins only inside the threshold.
 */
export function magnetize(minutes: number, neighborEdges: number[], snapTo = 15, thresholdMinutes = 10): number {
  let nearestEdge: number | null = null;
  let nearestDistance = Infinity;
  for (const edge of neighborEdges) {
    const distance = Math.abs(edge - minutes);
    if (distance <= thresholdMinutes && distance < nearestDistance) {
      nearestEdge = edge;
      nearestDistance = distance;
    }
  }
  return nearestEdge ?? snapMinutes(minutes, snapTo);
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** True if `[startMinutes, endMinutes)` would overlap any slot in `slots`, other than `excludeId` (the slot being moved/resized). */
export function rangeOverlapsSlots(startMinutes: number, endMinutes: number, slots: ScheduleSlot[], excludeId?: string): boolean {
  return slots.some(
    (slot) => slot.id !== excludeId && rangesOverlap(startMinutes, endMinutes, minutesFromTime(slot.startTime), minutesFromTime(slot.endTime))
  );
}

/**
 * §5.1 option B ("snap to nearest free gap that fits, else refuse") — the gap of at least
 * `durationMinutes` closest to `desiredStartMinutes`, searched outward in both directions at
 * `stepMinutes` granularity. Returns null if the day has no gap that fits. On a tie, the later gap
 * wins — closer to "push later" than "pull earlier" when the desired spot is equally near both.
 */
export function nearestFreeGap(
  slots: ScheduleSlot[],
  desiredStartMinutes: number,
  durationMinutes: number,
  stepMinutes = 15,
  excludeId?: string
): number | null {
  const relevant = slots.filter((slot) => slot.id !== excludeId);
  const fits = (start: number) => start >= 0 && start + durationMinutes <= MINUTES_PER_DAY && !rangeOverlapsSlots(start, start + durationMinutes, relevant);

  const desired = clampToDay(snapMinutes(desiredStartMinutes, stepMinutes));
  if (fits(desired)) return desired;

  for (let delta = stepMinutes; delta <= MINUTES_PER_DAY; delta += stepMinutes) {
    const later = desired + delta;
    if (later <= MINUTES_PER_DAY - durationMinutes && fits(later)) return later;
    const earlier = desired - delta;
    if (earlier >= 0 && fits(earlier)) return earlier;
  }
  return null;
}

/**
 * §13 S1 ("Running late? Shift rest of day") / §5.1 option C — shifts every slot starting at or
 * after `afterMinutes` by `shiftByMinutes` (negative = earlier), skipping any slot whose id is in
 * `lockedIds` (class blocks, per D2 — locked in DP2). A slot that would run past 00:00/24:00 has
 * its own shift capped at whatever leaves it flush against that boundary, rather than clamping
 * start and end independently — clamping independently can walk them both to the same clock
 * minute and collapse the block's duration to zero, which then fails `lib/schedule.ts`'s
 * `validateSlots` (acceptance criterion #6). Capping means a block can stop moving before the
 * rest of the ripple does, but it never loses duration or wraps to the next day.
 *
 * One consequence: because each slot caps independently, a large enough shift can let an earlier
 * block (more room to the boundary) move past a later one that caps sooner, producing an overlap
 * or a reordering the array itself doesn't sort out. That's still strictly safer than the old
 * zero-duration bug — it's the same "overlap exists" state `laneLayout` already renders safely —
 * but whichever call site DP5 builds for S1 ("Shift rest of day") should decide whether a shift
 * that would cap any slot gets refused outright rather than partially committed.
 */
export function rippleShift(slots: ScheduleSlot[], afterMinutes: number, shiftByMinutes: number, lockedIds: Set<string> = new Set()): ScheduleSlot[] {
  return slots.map((slot) => {
    const start = minutesFromTime(slot.startTime);
    if (start < afterMinutes || lockedIds.has(slot.id)) return slot;
    const duration = minutesFromTime(slot.endTime) - start;
    let effectiveShift = shiftByMinutes;
    if (effectiveShift > 0) {
      effectiveShift = Math.min(effectiveShift, Math.max(0, MINUTES_PER_DAY - duration - start));
    } else if (effectiveShift < 0) {
      effectiveShift = Math.max(effectiveShift, -start);
    }
    const newStart = start + effectiveShift;
    const newEnd = newStart + duration;
    return { ...slot, startTime: minutesToTime(newStart), endTime: minutesToTime(newEnd) };
  });
}

type LaneableSlot = Pick<ScheduleSlot, "id" | "startTime" | "endTime">;

export interface LanedSlot<T extends LaneableSlot = ScheduleSlot> {
  slot: T;
  lane: number;
  laneCount: number;
}

/**
 * §4.2 ("legacy overlaps laid out side-by-side in lanes") — greedy interval coloring: each slot
 * takes the lowest-numbered lane free at its start time (this part alone is already globally
 * consistent: a lane index is only reused once every slot previously in it has ended, so two
 * slots that overlap in time always land in different lanes).
 *
 * `laneCount` must still be scoped per *connected component* of transitively overlapping slots,
 * not per slot's own direct overlaps — those can disagree. Four blocks A 09:00–10:00, B
 * 09:30–11:30, C 10:00–11:00, D 10:30–11:00 are one connected cluster (A-B-C-D chain via
 * B overlapping all three), but A and D never directly overlap each other. Scoping A's laneCount
 * to {A, B} (2) and B's to {A, B, C, D} (3) puts A at [0%, 50%] and B at [33%, 67%] — since A and
 * B DO overlap in time, those horizontal ranges intersecting means one draws over the other,
 * defeating the entire point of lane layout. Every slot in one connected component must share the
 * same laneCount so lane fractions partition the width consistently across the whole cluster.
 * Components are found with a standard sorted interval-merge sweep: walking slots in start order
 * while tracking the running max end time — a new slot starts a new component only when its start
 * is at or after that running max (matches `rangesOverlap`'s strict `<`, so back-to-back slots
 * don't join a component just for touching).
 *
 * A zero-duration slot (start === end — shouldn't happen via this app's own writers, but this
 * function's job is rendering *legacy* data safely, acceptance criterion #4) still gets a sane
 * `lane: 0, laneCount: 1` when nothing else is around it: it starts its own single-slot component
 * via the same sweep, not via an overlap check that would otherwise miss it entirely.
 */
export function laneLayout<T extends LaneableSlot>(slots: T[]): LanedSlot<T>[] {
  const ordered = [...slots].sort((a, b) => minutesFromTime(a.startTime) - minutesFromTime(b.startTime));
  const laneEnds: number[] = [];
  const laneOf = new Map<string, number>();
  const componentOf = new Map<string, number>();
  const componentMaxLane = new Map<number, number>();

  let componentIndex = -1;
  let componentEnd = -Infinity;

  for (const slot of ordered) {
    const start = minutesFromTime(slot.startTime);
    const end = minutesFromTime(slot.endTime);

    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    laneOf.set(slot.id, lane);

    if (start >= componentEnd) {
      componentIndex += 1;
      componentEnd = end;
    } else {
      componentEnd = Math.max(componentEnd, end);
    }
    componentOf.set(slot.id, componentIndex);
    componentMaxLane.set(componentIndex, Math.max(componentMaxLane.get(componentIndex) ?? 0, lane));
  }

  return ordered.map((slot) => ({
    slot,
    lane: laneOf.get(slot.id) ?? 0,
    laneCount: (componentMaxLane.get(componentOf.get(slot.id) ?? 0) ?? 0) + 1
  }));
}

/**
 * Parses a typed time — "9", "930", "9:30", "9:30pm" — into "HH:mm", or null if unparseable. A
 * bare hour/time with no am/pm is read literally on the 24h clock, so "12" is noon (§12: "✅
 * (noon; document it)"), not midnight. "24" / "24:00" is accepted as the one valid end-of-day
 * value (D1); nothing past it parses.
 */
export function parseTypedTime(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  const match = trimmed.match(/^(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3];
  if (minutes > 59) return null;

  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = meridiem === "am" ? (hours === 12 ? 0 : hours) : hours === 12 ? 12 : hours + 12;
  } else if (hours > 24 || (hours === 24 && minutes > 0)) {
    return null;
  }

  if (hours === 24) return "24:00";
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** §4.4 tray — "Tasks to schedule" dropped on empty grid: `estimatedPomodoros x work length`, min 25min (a task with no estimate defaults to 1 pomodoro). */
export function taskBlockMinutes(task: Pick<Task, "estimatedPomodoros">, workMinutes: number): number {
  return Math.max(25, (task.estimatedPomodoros ?? 1) * workMinutes);
}

const CATEGORY_SLOT_TYPE: Record<Category, ScheduleSlotType> = {
  research: "deep_work",
  coding: "deep_work",
  writing: "deep_work",
  reading: "reading",
  admin: "admin",
  personal: "custom"
};

/** A dropped-in task has no `ScheduleSlotType` of its own — this picks a reasonable default from its `Category` so the new block's color/icon aren't just "custom" by default. */
export function slotTypeForCategory(category: Category): ScheduleSlotType {
  return CATEGORY_SLOT_TYPE[category];
}

export interface QuickBlockPreset {
  type: ScheduleSlotType;
  label: string;
  minutes: number;
}

/** §4.4 tray — "one chip per common type with a default duration". */
export const QUICK_BLOCK_PRESETS: QuickBlockPreset[] = [
  { type: "deep_work", label: "Deep work", minutes: 90 },
  { type: "reading", label: "Reading", minutes: 45 },
  { type: "admin", label: "Admin", minutes: 30 },
  { type: "break", label: "Break", minutes: 15 },
  { type: "meal", label: "Meal", minutes: 60 }
];

/**
 * §5.1 option C / DP3's "Shift ripple" — the `Shift`-drag modifier for moving a single block
 * forward in time: if the new position would overlap the next unlocked block, that block (and,
 * via `rippleShift`, everything after it) gets pushed later by exactly enough to clear the
 * overlap, instead of the move being refused. Deliberately narrow in scope (matching the plan's
 * own framing — "only via explicit `Shift`-drag ... never default"):
 *
 * - Only engages when the block is moving *later* (`newStart` at/after its current start). A
 *   Shift-drag earlier falls back to ordinary refuse behaviour — "running late, push the rest of
 *   the day out" has no equivalent mental model in reverse.
 * - Never pushes through a class block: if the new position directly overlaps one, or the
 *   cascade would need to, this returns `null` (refuse) rather than silently colliding with a
 *   locked block or leaving it in place while overlapping it (see plan §11 "Course edit
 *   regenerates future class blocks").
 * - Verifies its own output with `validateSlots` before returning it, so a caller never has to
 *   trust the ripple math in isolation — any residual overlap (e.g. a second locked block further
 *   down the cascade) refuses the whole gesture rather than committing a partially-fixed day.
 */
export function rippleMove(slots: ScheduleSlot[], movedId: string, newStart: number, newEnd: number): ScheduleSlot[] | null {
  const moved = slots.find((slot) => slot.id === movedId);
  if (!moved) return null;
  const originalStart = minutesFromTime(moved.startTime);
  if (newStart < originalStart) return null;

  const others = slots.filter((slot) => slot.id !== movedId);
  const movedSlot: ScheduleSlot = { ...moved, startTime: minutesToTime(newStart), endTime: minutesToTime(newEnd) };

  const blocking = sortedSlots(others).find(
    (slot) => minutesFromTime(slot.startTime) >= newStart && minutesFromTime(slot.startTime) < newEnd
  );

  let shifted = others;
  if (blocking) {
    if (blocking.type === "class") return null; // can't ripple through a locked block
    const lockedIds = new Set(others.filter((slot) => slot.type === "class").map((slot) => slot.id));
    const pushBy = newEnd - minutesFromTime(blocking.startTime);
    shifted = rippleShift(others, minutesFromTime(blocking.startTime), pushBy, lockedIds);
  }

  const candidate = sortedSlots([...shifted, movedSlot]);
  return validateSlots(candidate).length === 0 ? candidate : null;
}

/**
 * §4.4 tray — "Fill gaps only" template mode (S6): applies every template slot that doesn't
 * overlap the existing day (checked against both the existing slots and whichever template slots
 * were already accepted earlier in this same pass, so two template slots that overlap each other
 * don't both get let through). Slots that don't fit are silently skipped, never partially
 * resized/trimmed to fit — DP3's exit criterion is "Fill gaps never overlaps", not "Fill gaps
 * always applies everything".
 */
export function fillGaps(existing: ScheduleSlot[], templateSlots: ScheduleSlot[]): ScheduleSlot[] {
  const accepted: ScheduleSlot[] = [];
  for (const slot of sortedSlots(templateSlots)) {
    const start = minutesFromTime(slot.startTime);
    const end = minutesFromTime(slot.endTime);
    if (!rangeOverlapsSlots(start, end, existing) && !rangeOverlapsSlots(start, end, accepted)) {
      accepted.push(slot);
    }
  }
  return sortedSlots([...existing, ...accepted]);
}

/** A template's slots, re-issued with fresh ids at drag/apply time — matches `scheduleFromTemplate`'s own `{ ...slot, id: crypto.randomUUID(), status: "upcoming" }`, so a tray-driven apply and the old editor's template apply produce identical slot content modulo ids (DP3 exit criterion: "Template apply equals old behaviour in Replace mode"). */
export function freshTemplateSlots(slots: ScheduleSlot[]): ScheduleSlot[] {
  return sortedSlots(slots).map((slot) => ({ ...slot, id: crypto.randomUUID(), status: "upcoming" }));
}

/** Builds the new block a task-drop creates — factored out so `TimeGrid`'s drop handler and any non-drag equivalent size/type it identically. */
export function createTaskBlock(task: Task, workMinutes: number, startMinutes: number): ScheduleSlot {
  const duration = taskBlockMinutes(task, workMinutes);
  return createSlot({
    title: task.title,
    type: slotTypeForCategory(task.category),
    startTime: minutesToTime(startMinutes),
    endTime: minutesToTime(startMinutes + duration),
    assignedTaskIds: [task.id]
  });
}

const SLOT_TYPE_CATEGORY: Record<ScheduleSlotType, Category> = {
  deep_work: "research",
  reading: "reading",
  admin: "admin",
  class: "admin",
  // A locked, externally-scheduled block, same reasoning as "class" above — starting a focus
  // session from an imported Google Calendar event has no better category to default to.
  external: "admin",
  custom: "personal",
  meal: "personal",
  free: "personal",
  break: "personal",
  commute: "personal",
  sleep: "personal",
  gym: "personal"
};

/** S4 ("Start focus session from a block") — the inverse of `slotTypeForCategory`, for pre-filling the focus timer's category from whichever block it was started from. */
export function categoryForSlotType(type: ScheduleSlotType): Category {
  return SLOT_TYPE_CATEGORY[type];
}

/**
 * S1 ("Running late? Shift rest of day") — the strict call site `rippleShift`'s own doc comment
 * asked DP5 to build: shifts every unlocked (non-class) slot at or after `afterMinutes` by exactly
 * `shiftByMinutes`, but refuses the *entire* action (returns `null`) rather than silently applying
 * a partial shift when either:
 *
 * - any slot that should have moved got capped short of the full amount (`rippleShift`'s own
 *   24:00/00:00 boundary protection — see its doc comment), or
 * - the result contains any overlap at all (`validateSlots`), which catches a shifted block
 *   landing on a class block that correctly never moved.
 *
 * "Running late" should either cleanly clear the rest of the day out of the way, or visibly do
 * nothing so the user knows to resolve it by hand — never leave some blocks shifted and others not.
 */
export function shiftRestOfDay(slots: ScheduleSlot[], afterMinutes: number, shiftByMinutes: number): ScheduleSlot[] | null {
  const lockedIds = new Set(slots.filter((slot) => slot.type === "class").map((slot) => slot.id));
  const shifted = rippleShift(slots, afterMinutes, shiftByMinutes, lockedIds);

  const fullyShifted = slots.every((original) => {
    if (lockedIds.has(original.id) || minutesFromTime(original.startTime) < afterMinutes) return true;
    const after = shifted.find((slot) => slot.id === original.id)!;
    return minutesFromTime(after.startTime) - minutesFromTime(original.startTime) === shiftByMinutes;
  });
  if (!fullyShifted) return null;

  const sorted = sortedSlots(shifted);
  return validateSlots(sorted).length === 0 ? sorted : null;
}
