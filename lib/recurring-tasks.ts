import { differenceInCalendarWeeks, getDay, parseISO } from "date-fns";
import { addDaysToKey } from "@/lib/dates";
import { minutesFromTime, sortedSlots } from "@/lib/schedule";
import type { Course, NewRecurringTaskTemplate, RecurringTaskTemplate, ScheduleSlot, Task } from "@/types";

/**
 * plan/10.FocusOS-v2-Connected-Flow-Plan.md §4.1 — mirrors lib/routine.ts's routineSlotsForDate and
 * lib/courses.ts's courseSlotsForDate in shape: a pure function of plain data, no Firestore
 * import, safe to reuse from a cron route, an API route, or a test.
 */
export function isTemplateDueOn(template: RecurringTaskTemplate, dateKey: string): boolean {
  if (!template.active) return false;
  if (template.startDate && dateKey < template.startDate) return false;
  if (template.endDate && dateKey > template.endDate) return false;
  const dayOfWeek = getDay(parseISO(dateKey));
  if (!template.daysOfWeek.includes(dayOfWeek)) return false;
  if (template.cadence === "weekly") return true;
  // biweekly: same-parity calendar week as the anchor. §3.2 requires anchorDate to be set at
  // creation time for every biweekly template, so there's no "unset anchor" case to fall back on.
  // weekStartsOn: 1 (Monday) matches lib/dates.ts's weekStartKey — every other "which week is
  // this" calculation in the app already uses a Monday week start, so this one does too.
  const weeksSinceAnchor = differenceInCalendarWeeks(parseISO(dateKey), parseISO(template.anchorDate!), { weekStartsOn: 1 });
  return weeksSinceAnchor % 2 === 0;
}

/**
 * A commitment that happens at a clock time and isn't a share of a course's planned hours — a TA
 * meeting, a fixed office hour. It is fixed reality, like a lecture: it belongs on the calendar at
 * its time, not in the pool of work the planner places. A timed template *with* a `bucket` is
 * different — its minutes are counted in that bucket's weekly ledger, so it stays planned work.
 */
export function isFixedCommitment(template: Pick<RecurringTaskTemplate, "time" | "bucket">): boolean {
  return Boolean(template.time) && !template.bucket;
}

/**
 * This date's fixed commitments as locked blocks, the same shape and role as `courseSlotsForDate`'s
 * class blocks and `weeklyPlanningSlotForDate`'s anchor — derived from the template, so the block
 * exists whether or not the daily cron has generated the occurrence's task yet.
 *
 * Type `custom`, deliberately not `admin`: `admin` is a scored sitting (lib/gamify.ts), and a
 * meeting nobody runs a focus timer through would never reach `slotAutoStatus`'s 60% and would
 * count against the day. One id per template on every date, as class blocks do; each day's
 * schedule is its own document.
 *
 * `existing` is the day's saved slots: a commitment already there (by id), or already represented
 * by a block assigned to this occurrence's task — accepted from the planner before this block
 * existed — is not added a second time, which would overlap it and fail `validateSlots`.
 */
export function commitmentSlotsForDate(templates: RecurringTaskTemplate[], dateKey: string, existing: ScheduleSlot[] = []): ScheduleSlot[] {
  return templates
    .filter((template) => isFixedCommitment(template) && isTemplateDueOn(template, dateKey))
    .filter((template) => {
      const occurrence = recurringTaskInstanceId(template.id, dateKey);
      return !existing.some((slot) => slot.id === commitmentSlotId(template.id) || slot.assignedTaskIds?.includes(occurrence));
    })
    .map((template) => ({
      id: commitmentSlotId(template.id),
      title: template.title,
      type: "custom" as const,
      startTime: template.time!.startTime,
      endTime: template.time!.endTime,
      status: "upcoming" as const,
      locked: true,
      ...(template.time!.location ? { note: template.time!.location } : {})
    }));
}

/**
 * A day's slots with its fixed commitments added, and any routine block (Sleep, a meal, Gym) that
 * overlaps one stepped aside — the same rule an unsaved day gets, where routine yields to fixed
 * blocks before anything is materialized. On a saved day the routine block is already stored, and
 * leaving it would put two undeletable locked blocks on top of each other: the week planner's
 * Accept runs `validateSlots` over the whole day and would refuse every block onto it. Nothing is
 * lost by setting it aside — routine blocks are re-derived by id every time a day is opened, so it
 * comes back the day the commitment is paused or moved.
 */
export function withCommitments(slots: ScheduleSlot[], commitments: ScheduleSlot[]): ScheduleSlot[] {
  const missing = commitments.filter((commitment) => !slots.some((slot) => slot.id === commitment.id));
  // Commitments already saved onto the day count too: a day saved with both blocks overlapping
  // (before this rule existed) is repaired the next time it's read, not left refusing every Accept.
  const fixed = [...missing, ...slots.filter((slot) => slot.id.startsWith(COMMITMENT_SLOT_PREFIX))];
  const overlapsCommitment = (slot: ScheduleSlot) =>
    fixed.some(
      (commitment) =>
        minutesFromTime(slot.startTime) < minutesFromTime(commitment.endTime) && minutesFromTime(commitment.startTime) < minutesFromTime(slot.endTime)
    );
  const kept = slots.filter((slot) => !(slot.id.startsWith("routine-") && overlapsCommitment(slot)));
  if (missing.length === 0 && kept.length === slots.length) return slots;
  return sortedSlots([...kept, ...missing]);
}

const COMMITMENT_SLOT_PREFIX = "commitment-";

export function commitmentSlotId(templateId: string): string {
  return `${COMMITMENT_SLOT_PREFIX}${templateId}`;
}

/**
 * A generated task that is one occurrence of a fixed commitment. Its time is already on the
 * calendar as `commitmentSlotsForDate`'s block, so it is never work to place: offering it would
 * size a one-hour meeting as a generic task and put it wherever a gap was (the bug plan/16 §2.1
 * describes), and every past occurrence nobody ticked done would come back as overdue backlog.
 * Paused templates count too — a paused meeting is not work either.
 */
export function isFixedCommitmentOccurrence(task: Pick<Task, "seriesId">, templates: Pick<RecurringTaskTemplate, "id" | "time" | "bucket">[]): boolean {
  if (!task.seriesId) return false;
  const template = templates.find((item) => item.id === task.seriesId);
  return Boolean(template && isFixedCommitment(template));
}

/**
 * §4.3 — the deterministic id a generated instance gets, so re-running generation over an
 * overlapping window is naturally idempotent (an admin-side `.create()` on this id just throws
 * `ALREADY_EXISTS` for a date that's already materialized) instead of needing an existence-check
 * read first.
 */
export function recurringTaskInstanceId(templateId: string, dateKey: string): string {
  return `rec-${templateId}-${dateKey}`;
}

/**
 * Every date from `fromDateKey` through `toDateKey`, inclusive, as yyyy-MM-dd keys. Built with
 * `addDaysToKey` (lib/dates.ts), the same local-time-consistent parse/format round-trip every
 * other date-key helper in this codebase already uses, rather than a UTC-based day-stepping loop
 * that could drift a day off in a server timezone behind UTC.
 */
export function dateKeysInRange(fromDateKey: string, toDateKey: string): string[] {
  const keys: string[] = [];
  let cursor = fromDateKey;
  while (cursor <= toDateKey) {
    keys.push(cursor);
    cursor = addDaysToKey(cursor, 1);
  }
  return keys;
}

export type RevisionTemplateSyncPlan =
  | { action: "none" }
  | { action: "create"; templateId: string; template: NewRecurringTaskTemplate }
  | { action: "update"; templateId: string; patch: Partial<RecurringTaskTemplate> }
  | { action: "pause"; templateId: string };

/**
 * A course's auto revision template always lives at this id rather than one `addDoc` would hand
 * out. Without it, two "Save" clicks close enough together that the second fires before the
 * template list has refreshed would each see no `existing` template and each create one —
 * two duplicate "Revise <course>" templates generating tasks every week, neither ever found again
 * by `find(t => t.generatedFrom === ...)` reliably. A deterministic id makes the create a `setDoc`
 * upsert instead of an `addDoc` insert — same idempotency rationale as `recurringTaskInstanceId`.
 */
export function revisionTemplateId(courseId: string): string {
  return `revision-${courseId}`;
}

/**
 * The user asked for revision time to be "scheduled as tasks automatically every week, hours set
 * on the course" — this decides what (if anything) needs to change about a course's one
 * auto-managed weekly "Revise <course>" template so that its size always matches
 * `course.targetMinutesPerWeek`, without the user ever touching the recurring-commitments UI
 * themselves. Pure, so the actual read-existing/write-the-change I/O (`lib/courses.ts`'s
 * `syncRevisionTemplate`) can stay a thin wrapper and this logic can be unit-tested directly.
 *
 * Deliberately asymmetric: clearing the hours to 0 always pauses the template (mirrors
 * `changeStatus`'s "course ended → pause its templates" rule on the course card), but raising the
 * hours again never force-reactivates a template the user paused by hand from the course card's
 * "Pause" button — only resizes it. Otherwise nudging the hours field would silently undo a
 * deliberate pause, which is worse than leaving the user to hit "Resume" themselves.
 *
 * plan/16 §5.4 (settling §8 Q8) added `autoEnabled`, and it is deliberately required rather than
 * defaulted: a default of `true` would let a new call site silently keep the old auto-create
 * behavior, which is the exact thing the setting exists to stop. Two rules follow from it, and
 * together they are what makes this opt-in rather than a removal:
 *
 * - `!autoEnabled && !existing` → `none`. A new course with a revision target generates nothing;
 *   the target reaches a day only through weekly planning, where the user picks the time.
 * - `!autoEnabled && existing` → the template is *paused*, never deleted. A course that already has
 *   an auto template made before this setting existed reads as opted in (`Course.autoRevisionTasks`
 *   absent), so nothing regresses for it; turning the switch off then pauses it, and the generated
 *   tasks that already exist are left alone.
 */
export function planRevisionTemplateSync(
  course: Pick<Course, "id" | "name" | "targetMinutesPerWeek" | "startDate" | "endDate">,
  existing: RecurringTaskTemplate | undefined,
  workMinutes: number,
  autoEnabled: boolean
): RevisionTemplateSyncPlan {
  const minutesPerWeek = course.targetMinutesPerWeek ?? 0;
  if (!autoEnabled) {
    return existing?.active ? { action: "pause", templateId: existing.id } : { action: "none" };
  }
  if (minutesPerWeek <= 0) {
    return existing?.active ? { action: "pause", templateId: existing.id } : { action: "none" };
  }

  // Matches lib/timeline.ts's taskBlockMinutes inverse: a task's real duration is
  // estimatedPomodoros * workMinutes, floored at one pomodoro so a small hours target never
  // rounds down to a task with nothing to actually do.
  //
  // Deliberately *not* capped at one sitting here, although plan/16 §5.1 lists this function among
  // the call sites that inherit the cap. Capping the estimate would not shorten a block, it would
  // silently shrink the target: a 3-hour revision commitment would become a 50-minute one and two
  // and a half hours of intended work would vanish. The cap belongs where a task becomes a *block*
  // — `taskChunkMinutes`/`createTaskBlock` (lib/timeline.ts) and the weekly planner's own candidate
  // generation — and every one of those paths now applies it, so the generated task still cannot
  // produce a block longer than one sitting. This stays the honest total.
  
  const estimatedPomodoros = Math.max(1, Math.round(minutesPerWeek / workMinutes));

  if (!existing) {
    return {
      action: "create",
      templateId: revisionTemplateId(course.id),
      template: {
        title: `Revise ${course.name}`,
        courseId: course.id,
        category: "reading",
        priority: "medium",
        estimatedPomodoros,
        cadence: "weekly",
        // Sunday — a fixed, predictable catch-up slot the user never has to choose, since the
        // whole point is this needs no setup beyond the hours number.
        daysOfWeek: [0],
        active: true,
        startDate: course.startDate,
        endDate: course.endDate,
        generatedFrom: "courseRevisionTarget",
        bucket: "revision"
      }
    };
  }

  const patch: Partial<RecurringTaskTemplate> = {};
  if (existing.estimatedPomodoros !== estimatedPomodoros) patch.estimatedPomodoros = estimatedPomodoros;
  if (existing.startDate !== course.startDate) patch.startDate = course.startDate;
  if (existing.endDate !== course.endDate) patch.endDate = course.endDate;
  // L2 (plan/14 §2.4) — a template created before `bucket` existed generates tasks the Revision
  // row's own filter can never see; patch it in for every existing auto template, not just new ones.
  if (existing.bucket !== "revision") patch.bucket = "revision";
  if (Object.keys(patch).length === 0) return { action: "none" };
  return { action: "update", templateId: existing.id, patch };
}
