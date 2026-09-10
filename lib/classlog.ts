import { createRevisionItem, createTask, createTopic, fetchCourseTopics, saveClassLog, updateTopic } from "@/lib/firestore";
import { DEFAULT_LADDER, ladderIndexForConfidence } from "@/lib/revision";
import { addDays, format, parseISO } from "date-fns";
import type { ClassAttendance, Course } from "@/types";

/** Rule-based topic split for Phase 1 — an AI task (course.splitTopics) replaces this in Phase 4, with this as its fallback. */
export function splitTopics(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\n;,]/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

export interface ClassLogInput {
  date: string;
  attendance: ClassAttendance;
  rawTopics?: string;
  understanding?: number;
  notes?: string;
  durationMin?: number;
}

async function ensureRevisionItem(uid: string, topicId: string, courseId: string, title: string, confidence: number, todayKey: string) {
  const ladderIndex = ladderIndexForConfidence(confidence);
  const dueDate = format(addDays(parseISO(todayKey), DEFAULT_LADDER[ladderIndex]), "yyyy-MM-dd");
  const revisionItemId = await createRevisionItem(uid, {
    kind: "topic",
    refId: topicId,
    courseId,
    title,
    ladderIndex,
    dueDate,
    reps: 0,
    lapses: 0,
    suspended: false
  });
  await updateTopic(uid, topicId, { revisionItemId });
}

/**
 * Saves a class log end to end: splits topics, creates/links Topic docs (matched
 * case-insensitively against topics already logged for this course so repeats
 * don't fork into duplicates), creates a catch-up task for a missed class, gives
 * every new (or Phase-1-era, not-yet-linked) topic a starting RevisionItem seeded
 * from the understanding rating, then writes the log itself. A missed class still
 * gets its topics recorded, just at the lowest confidence, rather than vanishing
 * from the course's coverage.
 */
export async function saveClassLogEntry(uid: string, course: Course, input: ClassLogInput) {
  const titles = splitTopics(input.rawTopics ?? "");
  const existingTopics = await fetchCourseTopics(uid, course.id);
  const confidence = input.attendance === "missed" ? 1 : (input.understanding ?? 3);

  const topicIds: string[] = [];
  for (const title of titles) {
    const existing = existingTopics.find((topic) => topic.title.toLowerCase() === title.toLowerCase());
    if (existing) {
      await updateTopic(uid, existing.id, {
        confidence,
        classLogIds: Array.from(new Set([...existing.classLogIds, input.date]))
      });
      topicIds.push(existing.id);
      // A topic logged before the revision engine existed (Phase 1) never got one — backfill it now,
      // but only for topics that never had a review schedule; don't reset one already in progress.
      if (!existing.revisionItemId) {
        await ensureRevisionItem(uid, existing.id, course.id, existing.title, confidence, input.date);
      }
    } else {
      const id = await createTopic(uid, {
        courseId: course.id,
        title,
        firstSeenDate: input.date,
        classLogIds: [input.date],
        confidence,
        status: "active"
      });
      topicIds.push(id);
      await ensureRevisionItem(uid, id, course.id, title, confidence, input.date);
    }
  }

  await saveClassLog(uid, course.id, {
    courseId: course.id,
    date: input.date,
    attendance: input.attendance,
    topicIds,
    rawTopics: input.rawTopics || undefined,
    understanding: input.attendance === "missed" ? undefined : input.understanding,
    notes: input.notes || undefined,
    durationMin: input.durationMin
  });

  if (input.attendance === "missed") {
    await createTask(uid, {
      title: titles.length > 0 ? `Catch up: ${course.name} — ${titles.join(", ")}` : `Catch up: ${course.name} (${input.date})`,
      status: "todo",
      priority: "high",
      category: "admin",
      dueDate: undefined,
      estimatedPomodoros: undefined
    });
  }
}
