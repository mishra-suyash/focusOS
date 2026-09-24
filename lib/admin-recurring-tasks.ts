import { adminDb } from "@/lib/firebase-admin";
import { dateKeysInRange, isTemplateDueOn, recurringTaskInstanceId } from "@/lib/recurring-tasks";
import type { NewTask, RecurringTaskTemplate } from "@/types";

/** gRPC ALREADY_EXISTS. Falls back to a message check since different SDK/transport versions
 * haven't always surfaced `.code` consistently — see the comment on `createInstanceIfDue` below
 * for why this is the one error this call is meant to swallow. */
function isAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: number }).code;
  return code === 6 || error.message.toLowerCase().includes("already exists");
}

/** Exported for scripts/verify-recurring-tasks.ts — the other half of L2 (plan/14 §2.4): the
 * generate-time copy that gets a fresh instance's `bucket` right from the start. */
export function taskFromTemplate(template: RecurringTaskTemplate, dateKey: string): NewTask {
  return {
    title: template.title,
    description: template.description,
    status: "todo",
    priority: template.priority,
    category: template.category,
    dueDate: dateKey,
    estimatedPomodoros: template.estimatedPomodoros,
    courseId: template.courseId,
    bucket: template.bucket,
    seriesId: template.id
  };
}

/**
 * plan/10.FocusOS-v2-Connected-Flow-Plan.md §4.2/§4.3 — generates real `Task` docs for every active
 * template's due dates in `[fromDateKey, toDateKey]`. Runs entirely server-side through the Admin
 * SDK (same as `lib/admin-dailyloop.ts`'s cron generators), which is what makes `DocumentReference
 * .create()` available: it's atomic and throws ALREADY_EXISTS instead of silently overwriting a
 * doc that's already there, so a deterministic id (`recurringTaskInstanceId`) plus this call is
 * enough to make the whole operation idempotent with no existence-check read first. Re-running an
 * overlapping window — the daily cron re-covering its own rolling window, or a manual "Generate
 * now" overlapping the next cron tick — just throws-and-ignores on every date already materialized,
 * and because `.create()` never touches an existing doc, a generated instance is immutable after
 * creation: editing one is always just editing that one task by hand.
 *
 * L2 backfill (plan/14 §2.4/§11) — that immutability is exactly why the `bucket` fix in
 * `planRevisionTemplateSync`/`taskFromTemplate` can't reach an instance this function already
 * created before either of those existed (or before this template had a `bucket` at all): the
 * ALREADY_EXISTS branch below used to just swallow and move on. It now patches `bucket` onto that
 * existing instance directly whenever the template has one it's missing, so a course whose auto
 * revision template already generated this week's task self-heals on the very next "Generate now"
 * or cron tick, instead of only ever fixing tasks generated from here on.
 */
export async function generateRecurringTaskInstances(uid: string, fromDateKey: string, toDateKey: string): Promise<{ created: number; backfilled: number }> {
  const snapshot = await adminDb().collection("users").doc(uid).collection("recurringTaskTemplates").where("active", "==", true).get();
  const templates = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as RecurringTaskTemplate);
  if (templates.length === 0) return { created: 0, backfilled: 0 };

  const dateKeys = dateKeysInRange(fromDateKey, toDateKey);
  const createdAt = new Date().toISOString();
  let created = 0;
  let backfilled = 0;

  for (const template of templates) {
    for (const dateKey of dateKeys) {
      if (!isTemplateDueOn(template, dateKey)) continue;
      const ref = adminDb().collection("users").doc(uid).collection("tasks").doc(recurringTaskInstanceId(template.id, dateKey));
      try {
        await ref.create({ ...taskFromTemplate(template, dateKey), createdAt, updatedAt: createdAt });
        created += 1;
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        if (!template.bucket) continue;
        const existing = await ref.get();
        if (existing.exists && existing.data()?.bucket !== template.bucket) {
          await ref.update({ bucket: template.bucket, updatedAt: createdAt });
          backfilled += 1;
        }
      }
    }
  }

  return { created, backfilled };
}
