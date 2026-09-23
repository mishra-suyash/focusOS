#!/usr/bin/env tsx
/**
 * Unit-test stand-in for lib/google-calendar.ts
 * (plan/11.FocusOS-v2-Google-Calendar-Sync-Plan.md §4.5/§6/§6.3) — same pattern as
 * scripts/verify-recurring-tasks.ts, since this repo has no test runner.
 */
import {
  DEFAULT_PUSH_ENABLED,
  checkpointEventDraft,
  checkpointRefKey,
  courseSessionEventDraft,
  courseSessionRefKey,
  firstOccurrenceOnOrAfter,
  googleEventIdForRefKey,
  hashEventDraft,
  planBlockEventDraft,
  planBlockRefKey,
  planBlockRefKeyDateKey,
  planPushDiff,
  recurringTemplateRefKey,
  resolvePushEnabled,
  taskEventDraft,
  taskRefKey,
  timedRecurringTemplateEventDraft,
  type GoogleCalendarLinkRecord,
  type GoogleEventDraft
} from "../lib/google-calendar";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures.push(detail ? `${label}: ${detail}` : label);
}

// A run of real September 2026 dates, so weekday math has something concrete to check against.
const TUE_1 = "2026-09-01"; // Tuesday
const WED_2 = "2026-09-02"; // Wednesday
const SUN = "2026-09-06"; // Sunday

{
  check("resolvePushEnabled fills in every default when nothing is stored", JSON.stringify(resolvePushEnabled(undefined)) === JSON.stringify(DEFAULT_PUSH_ENABLED));
  check(
    "resolvePushEnabled keeps an explicit override, defaults the rest",
    resolvePushEnabled({ ...DEFAULT_PUSH_ENABLED, tasksWithDueDate: true }).tasksWithDueDate === true &&
      resolvePushEnabled({ ...DEFAULT_PUSH_ENABLED, tasksWithDueDate: true }).courseSessions === true
  );
}

{
  check("courseSessionRefKey is stable across a session's own id, keyed on day+time instead", courseSessionRefKey("c1", 2, "09:00") === "courseSession:c1:2:09:00");
  check("checkpointRefKey", checkpointRefKey("ckpt1") === "checkpoint:ckpt1");
  check("recurringTemplateRefKey", recurringTemplateRefKey("t1") === "recurringTemplate:t1");
  check("taskRefKey", taskRefKey("task1") === "task:task1");
  check("planBlockRefKey embeds date and slot id", planBlockRefKey("2026-09-10", "slot1") === "planBlock:2026-09-10:slot1");
  check("planBlockRefKeyDateKey round-trips the date out of a planBlock ref key", planBlockRefKeyDateKey(planBlockRefKey("2026-09-10", "slot1")) === "2026-09-10");
  check("planBlockRefKeyDateKey returns undefined for any other category's ref key", planBlockRefKeyDateKey(checkpointRefKey("ckpt1")) === undefined);
}

{
  check("firstOccurrenceOnOrAfter returns the same date when it's already the target weekday", firstOccurrenceOnOrAfter(TUE_1, 2) === TUE_1);
  check("firstOccurrenceOnOrAfter rolls forward to the next matching weekday", firstOccurrenceOnOrAfter(SUN, 2) === "2026-09-08");
  check("firstOccurrenceOnOrAfter wraps a full week when the target weekday just passed", firstOccurrenceOnOrAfter(WED_2, 2) === "2026-09-08");
}

{
  const draft = courseSessionEventDraft({
    courseId: "c1",
    courseLabel: "CS 201 · Algorithms",
    dayOfWeek: 2,
    startTime: "09:00",
    endTime: "10:30",
    effectiveStartDate: SUN,
    timezone: "Asia/Kolkata"
  });
  check("course session draft carries the day+time ref key", draft.refKey === "courseSession:c1:2:09:00");
  check("course session draft anchors DTSTART on the first matching weekday on/after the course start", "dateTime" in draft.start && draft.start.dateTime === "2026-09-08T09:00:00");
  check("course session draft has no UNTIL — the push diff enforces the end date instead", draft.recurrence?.[0] === "RRULE:FREQ=WEEKLY;BYDAY=TU");
}

{
  const draft = checkpointEventDraft({ checkpointId: "ck1", title: "Midterm", typeLabel: "Midsem", courseLabel: "CS 201", dueAt: "2026-10-05" });
  check("checkpoint draft is all-day", "date" in draft.start && draft.start.date === "2026-10-05");
  check("checkpoint draft's all-day end is exclusive (start + 1 day)", "date" in draft.end && draft.end.date === "2026-10-06");
  check("checkpoint draft has no recurrence", draft.recurrence === undefined);
  check("checkpoint draft's title includes type, course, and title", draft.summary === "Midsem: CS 201 — Midterm");
}

{
  const weekly = timedRecurringTemplateEventDraft({
    templateId: "rt1",
    title: "TA office hours",
    daysOfWeek: [2, 3],
    startTime: "14:00",
    endTime: "15:00",
    cadence: "weekly",
    timezone: "Asia/Kolkata"
  });
  check("weekly template draft batches every day into one BYDAY list", weekly.recurrence?.[0] === "RRULE:FREQ=WEEKLY;BYDAY=TU,WE");

  const biweekly = timedRecurringTemplateEventDraft({
    templateId: "rt2",
    title: "TA meet",
    daysOfWeek: [2],
    startTime: "14:00",
    endTime: "15:00",
    cadence: "biweekly",
    anchorDate: TUE_1,
    timezone: "Asia/Kolkata"
  });
  check("biweekly template draft's DTSTART is pinned to the template's own anchorDate", "dateTime" in biweekly.start && biweekly.start.dateTime === `${TUE_1}T14:00:00`);
  check("biweekly template draft adds INTERVAL=2", biweekly.recurrence?.[0] === "RRULE:FREQ=WEEKLY;BYDAY=TU;INTERVAL=2");
}

{
  const draft = taskEventDraft({ taskId: "task1", title: "Renew visa", dueDate: "2026-11-01" });
  check("task draft is all-day with an exclusive end", "date" in draft.start && draft.start.date === "2026-11-01" && "date" in draft.end && draft.end.date === "2026-11-02");
}

{
  const draft = planBlockEventDraft({
    dateKey: "2026-09-10",
    slotId: "slot1",
    title: "Deep work — thesis ch.3",
    note: "focus block",
    startTime: "09:00",
    endTime: "11:00",
    timezone: "Asia/Kolkata"
  });
  check("plan block draft carries the date+slot ref key", draft.refKey === "planBlock:2026-09-10:slot1");
  check("plan block draft is a single timed event on its own date", "dateTime" in draft.start && draft.start.dateTime === "2026-09-10T09:00:00" && "dateTime" in draft.end && draft.end.dateTime === "2026-09-10T11:00:00");
  check("plan block draft has no recurrence — a plan day's blocks don't repeat", draft.recurrence === undefined);
  check("plan block draft carries the slot's note as its description", draft.description === "focus block");
}

{
  const a = checkpointEventDraft({ checkpointId: "ck1", title: "Midterm", typeLabel: "Midsem", courseLabel: "CS 201", dueAt: "2026-10-05" });
  const b = checkpointEventDraft({ checkpointId: "ck1", title: "Midterm", typeLabel: "Midsem", courseLabel: "CS 201", dueAt: "2026-10-05" });
  const c = checkpointEventDraft({ checkpointId: "ck1", title: "Midterm (rescheduled)", typeLabel: "Midsem", courseLabel: "CS 201", dueAt: "2026-10-05" });
  check("hashEventDraft is deterministic for identical content", hashEventDraft(a) === hashEventDraft(b));
  check("hashEventDraft changes when content changes", hashEventDraft(a) !== hashEventDraft(c));
}

{
  const desired: GoogleEventDraft[] = [
    checkpointEventDraft({ checkpointId: "ck1", title: "Midterm", typeLabel: "Midsem", courseLabel: "CS 201", dueAt: "2026-10-05" }),
    checkpointEventDraft({ checkpointId: "ck2", title: "Final", typeLabel: "Endsem", courseLabel: "CS 201", dueAt: "2026-12-01" })
  ];
  const existing: GoogleCalendarLinkRecord[] = [];
  const plan = planPushDiff(desired, existing);
  check("planPushDiff creates every desired item with nothing on file", plan.length === 2 && plan.every((item) => item.action === "create"));
}

{
  const unchanged = checkpointEventDraft({ checkpointId: "ck1", title: "Midterm", typeLabel: "Midsem", courseLabel: "CS 201", dueAt: "2026-10-05" });
  const changed = checkpointEventDraft({ checkpointId: "ck2", title: "Final", typeLabel: "Endsem", courseLabel: "CS 201", dueAt: "2026-12-15" });
  const desired = [unchanged, changed];
  const existing: GoogleCalendarLinkRecord[] = [
    { refKey: unchanged.refKey, googleEventId: "g1", contentHash: hashEventDraft(unchanged) },
    { refKey: changed.refKey, googleEventId: "g2", contentHash: hashEventDraft(checkpointEventDraft({ checkpointId: "ck2", title: "Final", typeLabel: "Endsem", courseLabel: "CS 201", dueAt: "2026-12-01" })) }
  ];
  const plan = planPushDiff(desired, existing);
  check("planPushDiff leaves an unchanged item alone (no spurious update)", !plan.some((item) => item.refKey === unchanged.refKey));
  check("planPushDiff updates an item whose content changed", plan.some((item) => item.action === "update" && item.refKey === changed.refKey));
}

{
  const stillDesired = checkpointEventDraft({ checkpointId: "ck1", title: "Midterm", typeLabel: "Midsem", courseLabel: "CS 201", dueAt: "2026-10-05" });
  const existing: GoogleCalendarLinkRecord[] = [
    { refKey: stillDesired.refKey, googleEventId: "g1", contentHash: hashEventDraft(stillDesired) },
    { refKey: "checkpoint:deleted-one", googleEventId: "g2", contentHash: "whatever" }
  ];
  const plan = planPushDiff([stillDesired], existing);
  check("planPushDiff deletes a link whose record no longer exists", plan.some((item) => item.action === "delete" && item.refKey === "checkpoint:deleted-one"));
  check("planPushDiff deletion plan carries the right Google event id to remove", plan.find((item) => item.action === "delete")?.googleEventId === "g2");
}

{
  const VALID_ID = /^[0-9a-v]{5,1024}$/;
  const idA = googleEventIdForRefKey("courseSession:c1:2:09:00");
  const idB = googleEventIdForRefKey("courseSession:c1:2:09:00");
  const idC = googleEventIdForRefKey("courseSession:c1:3:09:00");
  check("googleEventIdForRefKey is deterministic for the same ref key", idA === idB);
  check("googleEventIdForRefKey differs for a different ref key", idA !== idC);
  check("googleEventIdForRefKey only ever produces valid Google event-id characters", VALID_ID.test(idA), idA);
  // Firestore auto-ids mix upper/lowercase letters outside a-v (e.g. "x", "Z") and refKey itself
  // uses colons — exactly the characters a Google event id can't contain, which is the whole
  // reason this transform exists rather than reusing refKey (or a raw Firestore id) directly.
  check("googleEventIdForRefKey survives characters Google's event-id charset rejects", VALID_ID.test(googleEventIdForRefKey("checkpoint:AbcXZ-123_ok")));
}

if (failures.length > 0) {
  console.error(`verify-google-calendar: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("verify-google-calendar: all lib/google-calendar.ts checks passed.");
