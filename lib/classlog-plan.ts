/**
 * The pure rules of logging a class, shared by the app (lib/classlog.ts) and the MCP server's log_class
 * (plan/19), so a class logged either way creates the same topics and the same first revision date.
 */
import { addDays, format, parseISO } from "date-fns";
import { DEFAULT_LADDER, ladderIndexForConfidence } from "@/lib/revision";

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

/** A new topic's first revision card: its ladder rung from the understanding rating, due that many days after the class. */
export function topicRevisionSeed(confidence: number, classDateKey: string): { ladderIndex: number; dueDate: string } {
  const ladderIndex = ladderIndexForConfidence(confidence);
  return { ladderIndex, dueDate: format(addDays(parseISO(classDateKey), DEFAULT_LADDER[ladderIndex]), "yyyy-MM-dd") };
}
