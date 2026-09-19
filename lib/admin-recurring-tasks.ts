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

function taskFromTemplate(template: RecurringTaskTemplate, dateKey: string): NewTask {
  return {
    title: template.title,
    description: template.description,
    status: "todo",
    priority: template.priority,
    category: template.category,
    dueDate: dateKey,
    estimatedPomodoros: template.estimatedPomodoros,
    courseId: template.courseId,
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
 */
export async function generateRecurringTaskInstances(uid: string, fromDateKey: string, toDateKey: string): Promise<{ created: number }> {
  const snapshot = await adminDb().collection("users").doc(uid).collection("recurringTaskTemplates").where("active", "==", true).get();
  const templates = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as RecurringTaskTemplate);
  if (templates.length === 0) return { created: 0 };

  const dateKeys = dateKeysInRange(fromDateKey, toDateKey);
  const createdAt = new Date().toISOString();
  let created = 0;

  for (const template of templates) {
    for (const dateKey of dateKeys) {
      if (!isTemplateDueOn(template, dateKey)) continue;
      const id = recurringTaskInstanceId(template.id, dateKey);
      try {
        await adminDb()
          .collection("users")
          .doc(uid)
          .collection("tasks")
          .doc(id)
          .create({ ...taskFromTemplate(template, dateKey), createdAt, updatedAt: createdAt });
        created += 1;
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
      }
    }
  }

  return { created };
}
