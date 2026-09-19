import { getDay, parseISO } from "date-fns";
import { minutesFromTime, sortedSlots } from "@/lib/schedule";
import { rangeOverlapsSlots } from "@/lib/timeline";
import type { RoutineBlock, ScheduleSlot } from "@/types";

/**
 * plan/07.FocusOS-v2-Routine-Blocks-and-AI-Templates.md §2.2 — ships as the fallback whenever a
 * user's own `UserSettings.routineBlocks` is unset, exactly like `hooks/use-user-settings.ts`'s
 * own `DEFAULTS` constant: nothing gets written to Firestore just because a default exists.
 * Gym defaults off (something to opt into); the rest default on (things everyone already does).
 */
export const DEFAULT_ROUTINE_BLOCKS: RoutineBlock[] = [
  { id: "sleep", label: "Sleep", type: "sleep", startTime: "23:00", endTime: "07:00", enabled: true },
  { id: "breakfast", label: "Breakfast", type: "meal", startTime: "07:30", endTime: "08:00", enabled: true },
  { id: "lunch", label: "Lunch", type: "meal", startTime: "12:30", endTime: "13:15", enabled: true },
  { id: "dinner", label: "Dinner", type: "meal", startTime: "19:00", endTime: "19:45", enabled: true },
  { id: "gym", label: "Gym", type: "gym", startTime: "17:30", endTime: "18:30", enabled: false }
];

/**
 * Turns this date's enabled routine blocks into locked `ScheduleSlot`s. Mirrors
 * `lib/courses.ts`'s `courseSlotsForDate` in shape and in being a pure function of plain data —
 * no Firestore import here, so this stays safe to call from a server-side AI task fallback too.
 *
 * A block whose `endTime` is strictly before `startTime` crosses midnight (Sleep 23:00→07:00) —
 * the `ScheduleSlot` model has no cross-midnight representation (`validateSlots` rejects
 * `end <= start` outright), so it splits into two same-day locked slots instead, the way a
 * calendar splits an overnight event across two day-cells: `"00:00"`→`endTime` and
 * `startTime`→`"24:00"` (the grid's own hour axis already renders through the 24:00 boundary, and
 * `minutesToTime(1440)`/`minutesFromTime` round-trip it cleanly). A block whose `endTime` exactly
 * equals `startTime` (zero duration — a data-entry mistake, not a real overnight span) is skipped
 * entirely rather than treated as crossing midnight, which would otherwise black out the whole day.
 *
 * Two enabled blocks that overlap each other resolve by array order — first-listed wins, the
 * later one silently skipped for that date — the same "accepted so far" policy `fillGaps` already
 * uses for two overlapping template slots.
 */
export function routineSlotsForDate(blocks: RoutineBlock[], dateKey: string): ScheduleSlot[] {
  const dayOfWeek = getDay(parseISO(dateKey));
  const accepted: ScheduleSlot[] = [];

  function tryAccept(id: string, title: string, type: RoutineBlock["type"], startTime: string, endTime: string) {
    const start = minutesFromTime(startTime);
    const end = minutesFromTime(endTime);
    if (rangeOverlapsSlots(start, end, accepted)) return;
    accepted.push({ id, title, type, startTime, endTime, status: "upcoming", locked: true });
  }

  for (const block of blocks) {
    if (!block.enabled) continue;
    if (block.daysOfWeek && !block.daysOfWeek.includes(dayOfWeek)) continue;
    const startMinutes = minutesFromTime(block.startTime);
    const endMinutes = minutesFromTime(block.endTime);
    // A block with identical start/end is a data-entry mistake, not "crosses midnight" — treating
    // it as the latter would black out the entire day with two undeletable locked slots. Skip it
    // silently instead (effectively the same as disabled) rather than materializing a near-24h block.
    if (startMinutes === endMinutes) continue;
    const crossesMidnight = endMinutes < startMinutes;
    if (crossesMidnight) {
      tryAccept(`routine-${block.id}-wake`, block.label, block.type, "00:00", block.endTime);
      tryAccept(`routine-${block.id}-bed`, block.label, block.type, block.startTime, "24:00");
    } else {
      tryAccept(`routine-${block.id}`, block.label, block.type, block.startTime, block.endTime);
    }
  }

  return sortedSlots(accepted);
}
