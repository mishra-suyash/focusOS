#!/usr/bin/env tsx
/**
 * Unit-test stand-in for lib/timeline.ts (plan/FocusOS-v2-Plan-Day-Timeline.md DP0 exit
 * criterion "timeline tests green") — same pattern as scripts/verify-templates.ts, since this
 * repo has no test runner.
 */
import { minutesFromTime, scheduleFromTemplate, validateSlots } from "../lib/schedule";
import {
  categoryForSlotType,
  clampToDay,
  createTaskBlock,
  fillGaps,
  freshTemplateSlots,
  laneLayout,
  magnetize,
  MINUTES_PER_DAY,
  minutesToPx,
  nearestFreeGap,
  parseTypedTime,
  pxToMinutes,
  QUICK_BLOCK_PRESETS,
  rangeOverlapsSlots,
  rippleMove,
  rippleShift,
  shiftRestOfDay,
  slotTypeForCategory,
  snapMinutes,
  taskBlockMinutes
} from "../lib/timeline";
import type { DayTemplate, ScheduleSlot, Task } from "../types";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures.push(detail ? `${label}: ${detail}` : label);
}

function slot(id: string, startTime: string, endTime: string, type: ScheduleSlot["type"] = "deep_work"): ScheduleSlot {
  return { id, title: id, type, startTime, endTime, status: "upcoming" };
}

function task(id: string, category: Task["category"], estimatedPomodoros?: number): Task {
  return {
    id,
    title: id,
    status: "todo",
    priority: "medium",
    category,
    estimatedPomodoros,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

// --- minutes <-> px ---
check("minutesToPx: 60min @ 64px/h = 64px", minutesToPx(60, 64) === 64);
check("minutesToPx: 90min @ 64px/h = 96px", minutesToPx(90, 64) === 96);
check("pxToMinutes: inverse of minutesToPx", pxToMinutes(minutesToPx(37, 48), 48) === 37);

// --- snap ---
check("snapMinutes: rounds down within half-step", snapMinutes(97, 15) === 90);
check("snapMinutes: rounds up within half-step", snapMinutes(98, 15) === 105);
check("snapMinutes: exact multiple unchanged", snapMinutes(120, 15) === 120);

// --- clamp ---
check("clampToDay: negative clamps to 0", clampToDay(-30) === 0);
check("clampToDay: over 1440 clamps to 1440", clampToDay(1500) === MINUTES_PER_DAY);
check("clampToDay: mid-day unchanged", clampToDay(600) === 600);

// --- magnetize ---
check("magnetize: within threshold snaps to the neighbor edge exactly", magnetize(597, [600], 15, 10) === 600);
check("magnetize: outside threshold falls back to the regular grid snap", magnetize(560, [600], 15, 10) === 555);
check("magnetize: picks the nearest of several edges within threshold", magnetize(603, [600, 610], 15, 10) === 600);
check("magnetize: no neighbors at all falls back to grid snap", magnetize(97, [], 15, 10) === 90);

// --- rangeOverlapsSlots ---
{
  const slots = [slot("a", "09:00", "10:00"), slot("b", "12:00", "13:00")];
  check("rangeOverlapsSlots: true for an overlapping range", rangeOverlapsSlots(minutesFromTime("09:30"), minutesFromTime("10:30"), slots));
  check("rangeOverlapsSlots: false for a free range", !rangeOverlapsSlots(minutesFromTime("10:00"), minutesFromTime("11:00"), slots));
  check("rangeOverlapsSlots: excludeId skips the slot being moved", !rangeOverlapsSlots(minutesFromTime("09:00"), minutesFromTime("10:00"), slots, "a"));
}

// --- nearestFreeGap ---
{
  const slots = [slot("a", "09:00", "10:00")];
  check("nearestFreeGap: desired spot already free", nearestFreeGap(slots, minutesFromTime("11:00"), 30) === minutesFromTime("11:00"));
  check(
    "nearestFreeGap: desired spot occupied, finds nearest fit",
    nearestFreeGap(slots, minutesFromTime("09:15"), 30, 15) === minutesFromTime("10:00")
  );
}
{
  // A day with no gap anywhere for a 30-minute block returns null.
  const packed = [slot("a", "00:00", "24:00")];
  check("nearestFreeGap: no fit anywhere returns null", nearestFreeGap(packed, minutesFromTime("12:00"), 30) === null);
}

// --- rippleShift ---
{
  const slots = [slot("a", "09:00", "10:00"), slot("b", "10:00", "11:00"), slot("locked", "14:00", "15:00")];
  const shifted = rippleShift(slots, minutesFromTime("09:30"), 30, new Set(["locked"]));
  const byId = new Map(shifted.map((s) => [s.id, s]));
  check("rippleShift: leaves slots before `after` untouched", byId.get("a")!.startTime === "09:00");
  check("rippleShift: shifts slots at/after `after`", byId.get("b")!.startTime === "10:30" && byId.get("b")!.endTime === "11:30");
  check("rippleShift: skips locked slots even if after the cutoff", byId.get("locked")!.startTime === "14:00");
}
{
  // A slot flush against the end of the day can't move further right without losing duration
  // (start and end would both clamp to 1440) — it should stay put, not collapse to zero-length.
  const slots = [slot("late", "23:45", "24:00")];
  const shifted = rippleShift(slots, 0, 30);
  check("rippleShift: caps the shift rather than collapsing duration at the boundary", shifted[0].startTime === "23:45" && shifted[0].endTime === "24:00");
}
{
  // A slot with room to move gets shifted in full even near the boundary, as long as it still fits.
  const slots = [slot("a", "23:00", "23:30")];
  const shifted = rippleShift(slots, 0, 15);
  check("rippleShift: shifts in full when the result still fits before 24:00", shifted[0].startTime === "23:15" && shifted[0].endTime === "23:45");
}
{
  // Symmetric case shifting earlier: capped at 00:00 instead of collapsing duration there either.
  const slots = [slot("early", "00:00", "00:15")];
  const shifted = rippleShift(slots, 0, -30);
  check("rippleShift: caps a negative shift at 00:00 rather than collapsing duration", shifted[0].startTime === "00:00" && shifted[0].endTime === "00:15");
}

// --- laneLayout ---
{
  const slots = [slot("a", "09:00", "10:00"), slot("b", "11:00", "12:00")];
  const laned = laneLayout(slots);
  check("laneLayout: non-overlapping slots all get lane 0 / count 1", laned.every((item) => item.lane === 0 && item.laneCount === 1));
}
{
  const slots = [slot("a", "09:00", "10:30"), slot("b", "10:00", "11:00"), slot("c", "12:00", "13:00")];
  const laned = laneLayout(slots);
  const byId = new Map(laned.map((item) => [item.slot.id, item]));
  check("laneLayout: overlapping pair gets distinct lanes", byId.get("a")!.lane !== byId.get("b")!.lane);
  check("laneLayout: overlapping pair's laneCount is 2", byId.get("a")!.laneCount === 2 && byId.get("b")!.laneCount === 2);
  check("laneLayout: unrelated slot elsewhere stays lane 0 / count 1", byId.get("c")!.lane === 0 && byId.get("c")!.laneCount === 1);
}
{
  // Legacy data can contain a zero-duration slot (start === end) that never should have been
  // written — laneLayout's job is to render it without crashing, not to reject it.
  const slots = [slot("zero", "10:00", "10:00")];
  const laned = laneLayout(slots);
  check("laneLayout: a zero-duration slot with nothing else around it gets a sane lane/count", laned[0].lane === 0 && laned[0].laneCount === 1);
}
{
  // A-B-C-D form one connected, transitively-overlapping cluster (A overlaps only B; D overlaps
  // only C; B and C are the bridge), but no two of them are ALL pairwise-overlapping. laneCount
  // must still be shared across the whole cluster, not just each slot's direct overlaps — a
  // per-slot count lets two blocks that genuinely overlap in time (e.g. A and B) end up in
  // horizontal ranges that intersect, which is the exact bug lane layout exists to prevent.
  const slots = [slot("a", "09:00", "10:00"), slot("b", "09:30", "11:30"), slot("c", "10:00", "11:00"), slot("d", "10:30", "11:00")];
  const laned = laneLayout(slots);
  const byId = new Map(laned.map((item) => [item.slot.id, item]));
  const counts = new Set(laned.map((item) => item.laneCount));
  check("laneLayout: one connected cluster shares a single laneCount", counts.size === 1);

  function horizontalRange(id: string): [number, number] {
    const item = byId.get(id)!;
    return [item.lane / item.laneCount, (item.lane + 1) / item.laneCount];
  }
  function rangesIntersect([aStart, aEnd]: [number, number], [bStart, bEnd]: [number, number]): boolean {
    return aStart < bEnd && bStart < aEnd;
  }
  const ids: ("a" | "b" | "c" | "d")[] = ["a", "b", "c", "d"];
  let anyTimeOverlapDrawsOverAnother = false;
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const left = slots.find((s) => s.id === ids[i])!;
      const right = slots.find((s) => s.id === ids[j])!;
      const timeOverlaps = minutesFromTime(left.startTime) < minutesFromTime(right.endTime) && minutesFromTime(right.startTime) < minutesFromTime(left.endTime);
      if (timeOverlaps && rangesIntersect(horizontalRange(ids[i]), horizontalRange(ids[j]))) anyTimeOverlapDrawsOverAnother = true;
    }
  }
  check("laneLayout: no two time-overlapping slots get intersecting horizontal ranges", !anyTimeOverlapDrawsOverAnother);
}

// --- parseTypedTime ---
check('parseTypedTime: "930" -> "09:30"', parseTypedTime("930") === "09:30");
check('parseTypedTime: "9:30" -> "09:30"', parseTypedTime("9:30") === "09:30");
check('parseTypedTime: "9:30pm" -> "21:30"', parseTypedTime("9:30pm") === "21:30");
check('parseTypedTime: "9:30am" -> "09:30"', parseTypedTime("9:30am") === "09:30");
check('parseTypedTime: "12" -> "12:00" (noon, not midnight)', parseTypedTime("12") === "12:00");
check('parseTypedTime: "12am" -> "00:00"', parseTypedTime("12am") === "00:00");
check('parseTypedTime: "12pm" -> "12:00"', parseTypedTime("12pm") === "12:00");
check('parseTypedTime: "24" -> "24:00" (D1\'s valid end-of-day)', parseTypedTime("24") === "24:00");
check('parseTypedTime: "25" -> null', parseTypedTime("25") === null);
check('parseTypedTime: "13pm" -> null', parseTypedTime("13pm") === null);
check('parseTypedTime: "9:70" -> null', parseTypedTime("9:70") === null);
check('parseTypedTime: "not a time" -> null', parseTypedTime("not a time") === null);

// --- taskBlockMinutes / slotTypeForCategory / createTaskBlock (DP3) ---
check("taskBlockMinutes: estimate x work length", taskBlockMinutes({ estimatedPomodoros: 3 }, 25) === 75);
check("taskBlockMinutes: no estimate defaults to 1 pomodoro", taskBlockMinutes({}, 25) === 25);
check("taskBlockMinutes: floors at 25min even for a short work length", taskBlockMinutes({ estimatedPomodoros: 1 }, 10) === 25);
check("slotTypeForCategory: research -> deep_work", slotTypeForCategory("research") === "deep_work");
check("slotTypeForCategory: reading -> reading", slotTypeForCategory("reading") === "reading");
check("slotTypeForCategory: personal -> custom", slotTypeForCategory("personal") === "custom");
{
  const t = task("t1", "reading", 2);
  const block = createTaskBlock(t, 25, minutesFromTime("09:00"));
  check("createTaskBlock: sized from estimate x work length", block.startTime === "09:00" && block.endTime === "09:50");
  check("createTaskBlock: type derived from category", block.type === "reading");
  check("createTaskBlock: assigns the dropped task", block.assignedTaskIds?.includes("t1") === true);
}
check("QUICK_BLOCK_PRESETS: one chip per plan-listed type", QUICK_BLOCK_PRESETS.map((p) => p.type).join(",") === "deep_work,reading,admin,break,meal");

// --- rippleMove (DP3 Shift-drag) ---
{
  const slots = [slot("moved", "09:00", "10:00"), slot("blocker", "10:15", "11:00")];
  const result = rippleMove(slots, "moved", minutesFromTime("09:30"), minutesFromTime("10:30"));
  const byId = new Map((result ?? []).map((s) => [s.id, s]));
  check("rippleMove: moved block lands at the requested time", byId.get("moved")?.startTime === "09:30" && byId.get("moved")?.endTime === "10:30");
  check("rippleMove: pushes the blocking slot out by exactly the overlap", byId.get("blocker")?.startTime === "10:30" && byId.get("blocker")?.endTime === "11:15");
}
{
  // No blocking slot in the way -> ripple is a no-op beyond moving the dragged block itself.
  const slots = [slot("moved", "09:00", "09:30"), slot("far", "14:00", "15:00")];
  const result = rippleMove(slots, "moved", minutesFromTime("09:30"), minutesFromTime("10:00"));
  const byId = new Map((result ?? []).map((s) => [s.id, s]));
  check("rippleMove: no blocker -> untouched slot stays put", byId.get("far")?.startTime === "14:00");
}
{
  // Dragging earlier is out of scope for the ripple modifier -> refuse (null), not a silent no-op move.
  const slots = [slot("moved", "10:00", "10:30")];
  check("rippleMove: refuses a backward drag", rippleMove(slots, "moved", minutesFromTime("09:00"), minutesFromTime("09:30")) === null);
}
{
  // A locked class block directly in the way can't be rippled through.
  const slots = [slot("moved", "09:00", "10:00"), slot("locked", "10:15", "11:00", "class")];
  check("rippleMove: refuses when the next block in the way is a locked class block", rippleMove(slots, "moved", minutesFromTime("09:30"), minutesFromTime("10:30")) === null);
}
{
  // The cascade is capped by validateSlots: a class block further down the chain still refuses
  // the whole move, even though the *directly* blocking slot is unlocked.
  const slots = [
    slot("moved", "09:00", "10:00"),
    slot("blocker", "10:15", "10:30"),
    slot("locked", "10:35", "11:00", "class")
  ];
  check(
    "rippleMove: refuses when the cascade would push an unlocked slot into a locked one further down",
    rippleMove(slots, "moved", minutesFromTime("09:30"), minutesFromTime("10:30")) === null
  );
}

// --- fillGaps (DP3 "Fill gaps only" template mode) ---
{
  const existing = [slot("class", "09:00", "10:00")];
  const template = [slot("t1", "09:30", "10:30"), slot("t2", "11:00", "12:00")];
  const result = fillGaps(existing, template);
  const ids = result.map((s) => s.id);
  check("fillGaps: skips a template slot that overlaps the existing day", !ids.includes("t1"));
  check("fillGaps: keeps a template slot that fits", ids.includes("t2"));
  check("fillGaps: never produces an overlap", validateSlots(result).length === 0);
}
{
  // Two template slots that overlap each other: only the first (in time order) is accepted.
  const template = [slot("t1", "09:00", "10:00"), slot("t2", "09:30", "10:30")];
  const result = fillGaps([], template);
  const ids = result.map((s) => s.id);
  check("fillGaps: template slots overlapping each other -> only the earlier one is kept", ids.length === 1 && ids[0] === "t1");
}

// --- freshTemplateSlots (DP3 exit criterion: "Template apply equals old behaviour in Replace mode") ---
{
  const template: DayTemplate = {
    id: "tmpl-1",
    name: "Fixture",
    slots: [slot("b", "13:00", "14:00"), slot("a", "09:00", "10:00", "reading")],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  const viaOldEditor = scheduleFromTemplate(template, "2026-09-15").slots;
  const viaTray = freshTemplateSlots(template.slots);
  const strip = (s: ScheduleSlot[]) => s.map(({ id, ...rest }) => rest).sort((x, y) => x.startTime.localeCompare(y.startTime));
  check(
    "freshTemplateSlots: same title/type/times/status as the old editor's scheduleFromTemplate (ids aside)",
    JSON.stringify(strip(viaOldEditor)) === JSON.stringify(strip(viaTray))
  );
  check("freshTemplateSlots: mints fresh, distinct ids (never reuses the template doc's own)", new Set(viaTray.map((s) => s.id)).size === viaTray.length && viaTray.every((s) => s.id !== "a" && s.id !== "b"));
}

// --- categoryForSlotType (DP5 S4) ---
check("categoryForSlotType: deep_work -> research", categoryForSlotType("deep_work") === "research");
check("categoryForSlotType: reading -> reading", categoryForSlotType("reading") === "reading");
check("categoryForSlotType: class -> admin", categoryForSlotType("class") === "admin");
check("categoryForSlotType: meal -> personal", categoryForSlotType("meal") === "personal");

// --- shiftRestOfDay (DP5 S1 "Running late? Shift rest of day") ---
{
  const slots = [slot("morning", "09:00", "10:00"), slot("later", "11:00", "12:00")];
  const result = shiftRestOfDay(slots, minutesFromTime("10:30"), 30);
  const byId = new Map((result ?? []).map((s) => [s.id, s]));
  check("shiftRestOfDay: leaves slots entirely before `after` untouched", byId.get("morning")?.startTime === "09:00");
  check("shiftRestOfDay: shifts slots at/after `after` by the full amount", byId.get("later")?.startTime === "11:30" && byId.get("later")?.endTime === "12:30");
}
{
  // A slot flush against 24:00 would get capped by rippleShift's own boundary protection rather
  // than shifted the full amount -> shiftRestOfDay must refuse the whole action, not apply it partially.
  const slots = [slot("late", "23:45", "24:00")];
  check("shiftRestOfDay: refuses when any slot would be capped short of the full shift", shiftRestOfDay(slots, 0, 30) === null);
}
{
  // A locked class block never moves (rippleShift skips it) — shifting everything else into it
  // produces an overlap, which shiftRestOfDay must catch via validateSlots and refuse.
  const slots = [slot("moving", "09:00", "10:00"), slot("locked", "10:15", "11:00", "class")];
  check("shiftRestOfDay: refuses when the shift would overlap a locked class block", shiftRestOfDay(slots, minutesFromTime("09:00"), 30) === null);
}
{
  // A negative shift ("running early"?) is mechanically supported by the same full-amount check —
  // not a scenario the plan names, but nothing here assumes the shift is positive.
  const slots = [slot("a", "10:00", "11:00"), slot("b", "12:00", "13:00")];
  const result = shiftRestOfDay(slots, minutesFromTime("10:00"), -30);
  const byId = new Map((result ?? []).map((s) => [s.id, s]));
  check("shiftRestOfDay: a clean negative shift also applies in full", byId.get("a")?.startTime === "09:30" && byId.get("b")?.startTime === "11:30");
}

if (failures.length > 0) {
  console.error(`verify-timeline: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("verify-timeline: all lib/timeline.ts checks passed.");
