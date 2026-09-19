import { addDays, getDay, parseISO } from "date-fns";
import { todayKey } from "@/lib/dates";
import type { GoogleCalendarConnection } from "@/types";

/**
 * plan/FocusOS-v2-Google-Calendar-Sync-Plan.md §4.1 — the app's long-standing implicit
 * single-timezone assumption (vercel.json's IST-offset cron schedules), made explicit here as the
 * fallback when `UserSettings.timezone` is unset, rather than left as an unstated assumption spread
 * across cron config comments.
 */
export const DEFAULT_TIMEZONE = "Asia/Kolkata";

export const DEFAULT_PUSH_ENABLED: NonNullable<GoogleCalendarConnection["pushEnabled"]> = {
  courseSessions: true,
  checkpoints: true,
  timedCommitments: true,
  tasksWithDueDate: false
};

/** §4.2 — never dereference `connection.pushEnabled.courseSessions` directly; always through this. */
export function resolvePushEnabled(pushEnabled: GoogleCalendarConnection["pushEnabled"]): typeof DEFAULT_PUSH_ENABLED {
  return { ...DEFAULT_PUSH_ENABLED, ...pushEnabled };
}

// §4.5 — deterministic ref keys, never random ids, so the push diff can always find "the Google
// event for this record" without a query.

/**
 * Deliberately `{courseId}:{dayOfWeek}:{startTime}`, not `{courseId}:{sessionId}` — see
 * plan §6.1's callout: `CourseSession.id` is re-minted on every sessions-editor save, which would
 * make this key churn (and the linked Google event get deleted-and-recreated) on unrelated edits.
 */
export function courseSessionRefKey(courseId: string, dayOfWeek: number, startTime: string): string {
  return `courseSession:${courseId}:${dayOfWeek}:${startTime}`;
}

export function checkpointRefKey(checkpointId: string): string {
  return `checkpoint:${checkpointId}`;
}

export function recurringTemplateRefKey(templateId: string): string {
  return `recurringTemplate:${templateId}`;
}

export function taskRefKey(taskId: string): string {
  return `task:${taskId}`;
}

/**
 * Google Calendar event ids must be lowercase base32hex (`0-9a-v`), 5–1024 chars — `refKey`'s own
 * format (colons, mixed-case Firestore ids) doesn't qualify, so this is a deterministic transform
 * into a valid one, not just a sanitizer. A plain FNV-1a hash (not cryptographic — collision risk
 * is negligible at the scale of one user's own refs, and this only needs to be stable, not secure).
 *
 * Making the *event id itself* deterministic (rather than trusting whatever id Google's
 * `events.insert` response happens to return) is what makes a create idempotent: if a sync crashes
 * between `events.insert` succeeding and the `GoogleCalendarLink` doc being written, the retried
 * insert on the next cycle computes this exact same id again and gets a `409 Conflict` — caught and
 * treated as "already created," instead of Google minting a second, duplicate event with a
 * different id that this app has no record of and no way to find again.
 */
export function googleEventIdForRefKey(refKey: string): string {
  // BigInt(...) calls rather than `123n` literals — this repo's tsconfig targets es2017, which
  // doesn't allow BigInt literal syntax even though the BigInt runtime itself is available.
  let hash = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  for (let index = 0; index < refKey.length; index += 1) {
    hash ^= BigInt(refKey.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return `fos${hash.toString(16).padStart(16, "0")}`;
}

/** 0 (Sun) – 6 (Sat), same convention as `CourseSession.dayOfWeek`/`RecurringTaskTemplate.daysOfWeek`. */
const RRULE_BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** The first date on or after `fromDateKey` that falls on `dayOfWeek` — used as a recurring
 * event's `DTSTART` so a `BYDAY` rule anchored there actually lines up with the intended weekday. */
export function firstOccurrenceOnOrAfter(fromDateKey: string, dayOfWeek: number): string {
  const from = parseISO(fromDateKey);
  const diff = (dayOfWeek - getDay(from) + 7) % 7;
  return todayKey(addDays(from, diff));
}

export type GoogleEventTime = { date: string } | { dateTime: string; timeZone: string };

/** The subset of Google Calendar API v3's Event resource this app needs — a local shape, not
 * imported from `googleapis`, so this file stays free of any SDK dependency and is safe to
 * unit-test in isolation (mirrors `lib/recurring-tasks.ts`'s "no Firestore import" rule). */
export interface GoogleEventDraft {
  refKey: string;
  summary: string;
  description?: string;
  location?: string;
  start: GoogleEventTime;
  end: GoogleEventTime;
  /** RRULE lines, e.g. `["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"]`. Absent = a single, non-recurring event. */
  recurrence?: string[];
}

/**
 * §6.1/§6.3 — a course's weekly class time. No `UNTIL` on the RRULE and no dependence on the
 * course's end date at all: the push diff (planPushDiff below) already deletes this event on the
 * cycle after the course stops being active, which sidesteps RRULE's `UNTIL` needing a UTC instant
 * (a real timezone-conversion subtlety across DST, not worth adding a timezone-math dependency for
 * a bound the reconciling diff already enforces one cron cycle later anyway).
 */
export function courseSessionEventDraft(params: {
  courseId: string;
  courseLabel: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  location?: string;
  effectiveStartDate?: string;
  timezone: string;
}): GoogleEventDraft {
  const { courseId, courseLabel, dayOfWeek, startTime, endTime, location, effectiveStartDate, timezone } = params;
  const anchorDate = firstOccurrenceOnOrAfter(effectiveStartDate ?? todayKey(), dayOfWeek);
  return {
    refKey: courseSessionRefKey(courseId, dayOfWeek, startTime),
    summary: courseLabel,
    location,
    start: { dateTime: `${anchorDate}T${startTime}:00`, timeZone: timezone },
    end: { dateTime: `${anchorDate}T${endTime}:00`, timeZone: timezone },
    recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${RRULE_BYDAY[dayOfWeek]}`]
  };
}

/** §6.1 — a checkpoint's due date. All-day, single, no recurrence: `Checkpoint.dueAt` has no
 * time-of-day in this app's model, so nothing here invents one. */
export function checkpointEventDraft(params: { checkpointId: string; title: string; typeLabel: string; courseLabel: string; dueAt: string }): GoogleEventDraft {
  const { checkpointId, title, typeLabel, courseLabel, dueAt } = params;
  const nextDay = todayKeyPlusOne(dueAt);
  return {
    refKey: checkpointRefKey(checkpointId),
    summary: `${typeLabel}: ${courseLabel} — ${title}`,
    // Google's all-day event `end.date` is exclusive (per the Events resource), so a one-day event
    // needs end = start + 1 day, not end = start.
    start: { date: dueAt },
    end: { date: nextDay }
  };
}

function todayKeyPlusOne(dateKey: string): string {
  return todayKey(addDays(parseISO(dateKey), 1));
}

/**
 * §6.1 — a recurring commitment with a clock time (a TA meeting, office hours). One event covers
 * every day in `daysOfWeek` sharing that one time-of-day, since `RecurringTaskTemplate.time` is a
 * single field for the whole template, not per-day. Biweekly parity matters here (unlike a course
 * session, which is always weekly): `DTSTART` is pinned to the template's own `anchorDate` so
 * `INTERVAL=2`'s parity matches `lib/recurring-tasks.ts`'s `isTemplateDueOn` exactly, rather than
 * an independently-computed anchor that could land on the wrong week.
 */
export function timedRecurringTemplateEventDraft(params: {
  templateId: string;
  title: string;
  location?: string;
  description?: string;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  cadence: "weekly" | "biweekly";
  anchorDate?: string;
  timezone: string;
}): GoogleEventDraft {
  const { templateId, title, location, description, daysOfWeek, startTime, endTime, cadence, anchorDate, timezone } = params;
  const byDay = [...daysOfWeek].sort().map((day) => RRULE_BYDAY[day]).join(",");
  // §3.2's own invariant, carried over: anchorDate is always set for a biweekly template at
  // creation time, so there's no "unset anchor" case to fall back on here either.
  const dtStartDate = cadence === "biweekly" ? anchorDate! : firstOccurrenceOnOrAfter(todayKey(), daysOfWeek[0]);
  const interval = cadence === "biweekly" ? ";INTERVAL=2" : "";
  return {
    refKey: recurringTemplateRefKey(templateId),
    summary: title,
    description,
    location,
    start: { dateTime: `${dtStartDate}T${startTime}:00`, timeZone: timezone },
    end: { dateTime: `${dtStartDate}T${endTime}:00`, timeZone: timezone },
    recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${byDay}${interval}`]
  };
}

/** §6.1 — a plain, hand-created task with a due date (opt-in, `tasksWithDueDate`). All-day, single. */
export function taskEventDraft(params: { taskId: string; title: string; dueDate: string }): GoogleEventDraft {
  const { taskId, title, dueDate } = params;
  return {
    refKey: taskRefKey(taskId),
    summary: title,
    start: { date: dueDate },
    end: { date: todayKeyPlusOne(dueDate) }
  };
}

/** A deterministic fingerprint of the fields that matter for "has this changed since we last
 * pushed it" — stored on the `GoogleCalendarLink` doc so `planPushDiff` can skip a no-op
 * `events.update` call instead of re-writing identical content every cron cycle. */
export function hashEventDraft(draft: GoogleEventDraft): string {
  return JSON.stringify({
    summary: draft.summary,
    description: draft.description,
    location: draft.location,
    start: draft.start,
    end: draft.end,
    recurrence: draft.recurrence
  });
}

export interface GoogleCalendarLinkRecord {
  refKey: string;
  googleEventId: string;
  contentHash?: string;
}

export type PushPlanItem =
  | { action: "create"; refKey: string; draft: GoogleEventDraft }
  | { action: "update"; refKey: string; googleEventId: string; draft: GoogleEventDraft }
  | { action: "delete"; refKey: string; googleEventId: string };

/**
 * §6.3 — the pure half of the push engine's idempotent diff. `desired` is "every event that should
 * exist right now" (built by the caller from current, enabled-category FocusOS data);
 * `existingLinks` is every `GoogleCalendarLink` doc currently on file. Safe to run every cron cycle
 * regardless of what changed in between, the same idempotent-reconciliation idea
 * `generateRecurringTaskInstances` already relies on.
 */
export function planPushDiff(desired: GoogleEventDraft[], existingLinks: GoogleCalendarLinkRecord[]): PushPlanItem[] {
  const plan: PushPlanItem[] = [];
  const existingByKey = new Map(existingLinks.map((link) => [link.refKey, link]));
  const desiredKeys = new Set(desired.map((draft) => draft.refKey));

  for (const draft of desired) {
    const existing = existingByKey.get(draft.refKey);
    if (!existing) {
      plan.push({ action: "create", refKey: draft.refKey, draft });
      continue;
    }
    const hash = hashEventDraft(draft);
    if (existing.contentHash !== hash) plan.push({ action: "update", refKey: draft.refKey, googleEventId: existing.googleEventId, draft });
  }

  for (const link of existingLinks) {
    if (!desiredKeys.has(link.refKey)) plan.push({ action: "delete", refKey: link.refKey, googleEventId: link.googleEventId });
  }

  return plan;
}
