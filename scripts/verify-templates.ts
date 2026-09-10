#!/usr/bin/env tsx
/**
 * Runs the entire built-in template catalog through the shared zod schemas
 * and `lib/schedule.ts`'s overlap/ordering validation (U1 acceptance
 * criteria in plan/FocusOS-v2-Essentials-and-Templates-Plan.md §6.5), plus a
 * few pure-function checks for `shiftTemplateSlots`. The repo has no test
 * runner, so this stands in for "unit tests" on template data — run it in
 * CI or before publishing a new built-in template.
 */
import { minutesFromTime, shiftTemplateSlots, sortedSlots } from "../lib/schedule";
import { validateDayTemplate, goalPayloadSchema, readingGoalPayloadSchema, taskPackPayloadSchema, timerPayloadSchema } from "../lib/templates/schema";
import { BUILTIN_DAY_TEMPLATES } from "../lib/templates/builtin/day-templates";
import { BUILTIN_GOAL_TEMPLATES } from "../lib/templates/builtin/goal-templates";
import { BUILTIN_READING_GOAL_PRESETS } from "../lib/templates/builtin/reading-goal-presets";
import { BUILTIN_TASK_PACKS } from "../lib/templates/builtin/task-packs";
import { BUILTIN_TIMER_PRESETS } from "../lib/templates/builtin/timer-presets";
import type { ScheduleSlot } from "../types";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures.push(detail ? `${label}: ${detail}` : label);
}

// --- Day templates: schema + overlap validation ---
for (const template of BUILTIN_DAY_TEMPLATES) {
  const result = validateDayTemplate(template);
  check(`day template "${template.id}"`, result.ok, result.ok ? undefined : result.errors.join("; "));
}

// A guardrail check from §6.2: keep deep-work-typed minutes <= 4h for the three default workday templates.
for (const id of ["research-day", "writing-day"]) {
  const template = BUILTIN_DAY_TEMPLATES.find((item) => item.id === id)!;
  const deepWorkMinutes = template.slots
    .filter((slot) => slot.type === "deep_work")
    .reduce((sum, slot) => sum + (minutesFromTime(slot.endTime) - minutesFromTime(slot.startTime)), 0);
  check(`"${id}" deep-work minutes within 2.5h-4h guardrail`, deepWorkMinutes <= 240, `got ${deepWorkMinutes} minutes`);
}

// --- Task packs / goal templates / reading-goal presets / timer presets: schema only ---
for (const pack of BUILTIN_TASK_PACKS) {
  const result = taskPackPayloadSchema.safeParse(pack);
  check(`task pack "${pack.id}"`, result.success, result.success ? undefined : result.error.issues.map((i) => i.message).join("; "));
}
for (const template of BUILTIN_GOAL_TEMPLATES) {
  const result = goalPayloadSchema.safeParse(template);
  check(`goal template "${template.id}"`, result.success, result.success ? undefined : result.error.issues.map((i) => i.message).join("; "));
}
for (const preset of Object.values(BUILTIN_READING_GOAL_PRESETS)) {
  const result = readingGoalPayloadSchema.safeParse(preset);
  check(`reading-goal preset "${preset.id}"`, result.success, result.success ? undefined : result.error.issues.map((i) => i.message).join("; "));
}
for (const preset of Object.values(BUILTIN_TIMER_PRESETS)) {
  const result = timerPayloadSchema.safeParse(preset);
  check(`timer preset "${preset.id}"`, result.success, result.success ? undefined : result.error.issues.map((i) => i.message).join("; "));
}

// --- shiftTemplateSlots: normal shift, midnight crossing rejected, order preserved ---
function slot(id: string, startTime: string, endTime: string): ScheduleSlot {
  return { id, title: id, type: "deep_work", startTime, endTime, status: "upcoming" };
}

{
  const slots = [slot("a", "09:00", "10:00"), slot("b", "10:00", "11:00")];
  const shifted = shiftTemplateSlots(slots, "10:00");
  check("shiftTemplateSlots: normal shift", shifted !== null && shifted[0].startTime === "10:00" && shifted[1].startTime === "11:00");
}
{
  const slots = [slot("a", "23:00", "23:59")];
  const shifted = shiftTemplateSlots(slots, "23:30");
  check("shiftTemplateSlots: rejects a shift that crosses midnight", shifted === null);
}
{
  const slots = [slot("b", "10:00", "11:00"), slot("a", "09:00", "10:00")];
  const shifted = shiftTemplateSlots(slots, "08:00");
  const orderedIds = shifted ? sortedSlots(shifted).map((s) => s.id) : [];
  check("shiftTemplateSlots: order preserved after shift", orderedIds.join(",") === "a,b");
}

if (failures.length > 0) {
  console.error(`verify-templates: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const totalChecked = BUILTIN_DAY_TEMPLATES.length + BUILTIN_TASK_PACKS.length + BUILTIN_GOAL_TEMPLATES.length + Object.keys(BUILTIN_READING_GOAL_PRESETS).length + Object.keys(BUILTIN_TIMER_PRESETS).length;
console.log(`verify-templates: all ${totalChecked} catalog entries + shiftTemplateSlots checks passed.`);
