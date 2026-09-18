#!/usr/bin/env tsx
/**
 * Unit-test stand-in for lib/recurring-tasks.ts
 * (plan/FocusOS-v2-Connected-Flow-Plan.md §4.1/§4.3) — same pattern as scripts/verify-routine.ts,
 * since this repo has no test runner.
 */
import { dateKeysInRange, isTemplateDueOn, recurringTaskInstanceId } from "../lib/recurring-tasks";
import type { RecurringTaskTemplate } from "../types";

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

if (failures.length > 0) {
  console.error(`verify-recurring-tasks: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("verify-recurring-tasks: all lib/recurring-tasks.ts checks passed.");
