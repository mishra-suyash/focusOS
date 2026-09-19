#!/usr/bin/env tsx
/**
 * Unit-test stand-in for lib/recurring-tasks.ts
 * (plan/10.FocusOS-v2-Connected-Flow-Plan.md §4.1/§4.3) — same pattern as scripts/verify-routine.ts,
 * since this repo has no test runner.
 */
import { dateKeysInRange, isTemplateDueOn, planRevisionTemplateSync, recurringTaskInstanceId } from "../lib/recurring-tasks";
import type { Course, RecurringTaskTemplate } from "../types";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures.push(detail ? `${label}: ${detail}` : label);
}

function template(partial: Partial<RecurringTaskTemplate> & Pick<RecurringTaskTemplate, "daysOfWeek" | "cadence">): RecurringTaskTemplate {
  return {
    id: "t1",
    title: "Test commitment",
    category: "admin",
    priority: "medium",
    active: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...partial
  };
}

// A run of Tuesdays/Wednesdays in September 2026, so daysOfWeek/cadence has something to bite on.
const TUE_1 = "2026-09-01"; // week 1
const WED_2 = "2026-09-09"; // week 2
const TUE_3 = "2026-09-15"; // week 3
const WED_4 = "2026-09-23"; // week 4
const SUNDAY = "2026-09-06";

{
  const t = template({ daysOfWeek: [2], cadence: "weekly" }); // Tuesday
  check("weekly: due on a matching weekday", isTemplateDueOn(t, TUE_1));
  check("weekly: not due on a non-matching weekday", !isTemplateDueOn(t, SUNDAY));
  check("weekly: due every week, no parity gate", isTemplateDueOn(t, TUE_3));
}

{
  const t = template({ daysOfWeek: [2], cadence: "weekly", active: false });
  check("inactive template is never due", !isTemplateDueOn(t, TUE_1));
}

{
  const t = template({ daysOfWeek: [2], cadence: "weekly", startDate: "2026-09-10" });
  check("before startDate is not due", !isTemplateDueOn(t, TUE_1));
  check("on/after startDate is due", isTemplateDueOn(t, TUE_3));
}

{
  const t = template({ daysOfWeek: [2], cadence: "weekly", endDate: "2026-09-10" });
  check("on/before endDate is due", isTemplateDueOn(t, TUE_1));
  check("after endDate is not due", !isTemplateDueOn(t, TUE_3));
}

{
  // Anchored on the Tuesday of week 1 — same week is due, next week off, two weeks later back on.
  const t = template({ daysOfWeek: [2, 3], cadence: "biweekly", anchorDate: TUE_1 });
  check("biweekly: the anchor's own week is due", isTemplateDueOn(t, TUE_1));
  check("biweekly: the following week is skipped", !isTemplateDueOn(t, WED_2));
  check("biweekly: two weeks after the anchor is due again", isTemplateDueOn(t, TUE_3));
  check("biweekly: three weeks after the anchor is skipped", !isTemplateDueOn(t, WED_4));
}

{
  check("recurringTaskInstanceId is deterministic and includes both ids", recurringTaskInstanceId("abc", "2026-09-17") === "rec-abc-2026-09-17");
}

{
  const keys = dateKeysInRange("2026-09-17", "2026-09-20");
  check("dateKeysInRange is inclusive on both ends", keys[0] === "2026-09-17" && keys[keys.length - 1] === "2026-09-20");
  check("dateKeysInRange has the right count", keys.length === 4, `got ${keys.length}: ${keys.join(",")}`);
  const single = dateKeysInRange("2026-09-17", "2026-09-17");
  check("dateKeysInRange handles a single-day range", single.length === 1 && single[0] === "2026-09-17");
}

function course(partial: Partial<Course> & Pick<Course, "id" | "name">): Pick<Course, "id" | "name" | "targetMinutesPerWeek" | "startDate" | "endDate"> {
  return { targetMinutesPerWeek: undefined, startDate: undefined, endDate: undefined, ...partial };
}

{
  const plan = planRevisionTemplateSync(course({ id: "c1", name: "CS201" }), undefined, 25);
  check("no hours, no existing template: nothing to do", plan.action === "none");
}

{
  const plan = planRevisionTemplateSync(course({ id: "c1", name: "CS201", targetMinutesPerWeek: 90 }), undefined, 25);
  check("hours set, nothing exists yet: creates a weekly template", plan.action === "create");
  if (plan.action === "create") {
    check("created template is linked to the course", plan.template.courseId === "c1");
    check("created template is marked auto-generated", plan.template.generatedFrom === "courseRevisionTarget");
    check("90min / 25min-per-pomodoro rounds to 4 pomodoros", plan.template.estimatedPomodoros === 4, `got ${plan.template.estimatedPomodoros}`);
    check("created template defaults to Sunday", plan.template.daysOfWeek.length === 1 && plan.template.daysOfWeek[0] === 0);
    // The whole reason "create" carries a deterministic templateId (revisionTemplateId) rather
    // than letting addDoc hand out a random one: two racing "Save" clicks that both see no
    // `existing` template must still land on the SAME document instead of creating a duplicate.
    check("create carries the course's deterministic template id", plan.templateId === "revision-c1", `got ${plan.templateId}`);
    const secondClick = planRevisionTemplateSync(course({ id: "c1", name: "CS201", targetMinutesPerWeek: 90 }), undefined, 25);
    check(
      "a second concurrent create (still no existing template) targets the same id, not a new one",
      secondClick.action === "create" && secondClick.templateId === plan.templateId
    );
  }
}

{
  const minimalMinutes = course({ id: "c1", name: "CS201", targetMinutesPerWeek: 5 });
  const plan = planRevisionTemplateSync(minimalMinutes, undefined, 25);
  check("a small target never rounds down to 0 pomodoros", plan.action === "create" && plan.template.estimatedPomodoros === 1);
}

{
  const existing = template({ id: "auto1", daysOfWeek: [0], cadence: "weekly", estimatedPomodoros: 2, generatedFrom: "courseRevisionTarget" });
  const plan = planRevisionTemplateSync(course({ id: "c1", name: "CS201", targetMinutesPerWeek: 150 }), existing, 25);
  check("hours raised on an existing template: resizes it", plan.action === "update");
  if (plan.action === "update") check("resize targets the existing template's id", plan.templateId === "auto1");
}

{
  const existing = template({ id: "auto1", daysOfWeek: [0], cadence: "weekly", estimatedPomodoros: 4, generatedFrom: "courseRevisionTarget" });
  const plan = planRevisionTemplateSync(course({ id: "c1", name: "CS201", targetMinutesPerWeek: 100 }), existing, 25);
  check("same pomodoro count after rounding: no-op, not a spurious write", plan.action === "none");
}

{
  const existing = template({ id: "auto1", daysOfWeek: [0], cadence: "weekly", active: true, generatedFrom: "courseRevisionTarget" });
  const plan = planRevisionTemplateSync(course({ id: "c1", name: "CS201", targetMinutesPerWeek: 0 }), existing, 25);
  check("hours cleared on an active template: pauses it", plan.action === "pause");
}

{
  const existing = template({ id: "auto1", daysOfWeek: [0], cadence: "weekly", active: false, generatedFrom: "courseRevisionTarget" });
  const plan = planRevisionTemplateSync(course({ id: "c1", name: "CS201", targetMinutesPerWeek: 0 }), existing, 25);
  check("hours cleared on an already-paused template: nothing left to do", plan.action === "none");
}

{
  // The user paused it by hand from the course card; raising the hours again must not silently flip it back on.
  const existing = template({ id: "auto1", daysOfWeek: [0], cadence: "weekly", active: false, estimatedPomodoros: 1, generatedFrom: "courseRevisionTarget" });
  const plan = planRevisionTemplateSync(course({ id: "c1", name: "CS201", targetMinutesPerWeek: 120 }), existing, 25);
  check("a manual pause is never force-reactivated by an hours edit", plan.action !== "pause");
  if (plan.action === "update") check("...only resized, active untouched", !("active" in plan.patch));
}

if (failures.length > 0) {
  console.error(`verify-recurring-tasks: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("verify-recurring-tasks: all lib/recurring-tasks.ts checks passed.");
