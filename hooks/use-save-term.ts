"use client";

import { format, parseISO } from "date-fns";
import { useCallback } from "react";
import { useAuth } from "@/components/auth-provider";
import { useToast } from "@/components/toast-host";
import { useFeatures } from "@/hooks/use-features";
import { useUserSettings } from "@/hooks/use-user-settings";
import { scheduleDayKey } from "@/lib/dates";
import { createTerm, deleteTerm, fetchCollection, restoreTerm, updateCourse, updateRecurringTaskTemplate, updateTerm } from "@/lib/firestore";
import { resyncTermDays, undoDayChanges } from "@/lib/plan-release";
import { DEFAULT_ROUTINE_BLOCKS, routineSlotsForDate } from "@/lib/routine";
import { currentMinute } from "@/lib/schedule";
import { coursesFollowingTerm, templatesFollowingCourses } from "@/lib/term-change";
import type { Course, NewTerm, PomodoroSession, RecurringTaskTemplate, Term } from "@/types";

export type TermEdit = { kind: "add"; term: NewTerm } | { kind: "edit"; id: string; term: NewTerm } | { kind: "delete"; id: string };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Saves a term and carries it through everything that copied its dates or reads them off saved days:
 * courses created under it, their recurring tasks, and the class blocks on every saved day after today.
 * One toast says what moved, with an Undo that puts all of it back.
 */
export function useSaveTerm() {
  const { user } = useAuth();
  const toast = useToast();
  const { settings } = useUserSettings();
  const { isEnabled } = useFeatures();
  const coursesOn = isEnabled("courses");
  const routineBlocks = settings.routineBlocks ?? DEFAULT_ROUTINE_BLOCKS;

  return useCallback(
    async (edit: TermEdit) => {
      if (!user) return;
      const uid = user.uid;
      const [terms, courses, templates, sessions] = await Promise.all([
        fetchCollection<Term>(uid, "terms"),
        fetchCollection<Course>(uid, "courses"),
        fetchCollection<RecurringTaskTemplate>(uid, "recurringTaskTemplates"),
        fetchCollection<PomodoroSession>(uid, "pomodoroSessions")
      ]);
      const previous = edit.kind === "add" ? undefined : terms.find((term) => term.id === edit.id);
      if (edit.kind !== "add" && !previous) return;

      // A new term has no courses under it yet, and a deleted one's courses keep the dates they have.
      const coursePatches = edit.kind === "edit" && previous ? coursesFollowingTerm(courses, previous, edit.term) : [];
      const templatePatches = templatesFollowingCourses(templates, coursePatches);
      const coursesAfter = courses.map((course) => {
        const patch = coursePatches.find((item) => item.item.id === course.id);
        return patch ? { ...course, ...patch.after } : course;
      });

      let termId = edit.kind === "add" ? "" : edit.id;
      if (edit.kind === "add") termId = await createTerm(uid, edit.term);
      else if (edit.kind === "edit") await updateTerm(uid, edit.id, edit.term);
      else await deleteTerm(uid, edit.id);
      const stamp = { createdAt: "", updatedAt: "" };
      const termsAfter =
        edit.kind === "add"
          ? [...terms, { id: termId, ...edit.term, ...stamp }]
          : edit.kind === "edit"
            ? terms.map((term) => (term.id === edit.id ? { ...term, ...edit.term } : term))
            : terms.filter((term) => term.id !== edit.id);

      await Promise.all([
        ...coursePatches.map((patch) => updateCourse(uid, patch.item.id, patch.after)),
        ...templatePatches.map((patch) => updateRecurringTaskTemplate(uid, patch.item.id, patch.after))
      ]);
      const days = await resyncTermDays(uid, {
        before: { terms, courses: coursesOn ? courses : [] },
        after: { terms: termsAfter, courses: coursesOn ? coursesAfter : [] },
        routine: (dateKey) => routineSlotsForDate(routineBlocks, dateKey),
        clock: { todayKey: scheduleDayKey(), nowMinutes: currentMinute(), sessions }
      });

      // Nothing but the term itself changed: the panel already shows it, so there's nothing to report.
      if (edit.kind !== "delete" && coursePatches.length === 0 && days.length === 0) return;
      const name = edit.kind === "delete" ? previous?.name : edit.term.name;
      const released = days.reduce((sum, day) => sum + day.released, 0);
      const clashDays = days.filter((day) => day.clashes.length > 0).map((day) => format(parseISO(day.dateKey), "EEE d MMM"));
      toast({
        message: [
          edit.kind === "delete" ? `Deleted “${name}”.` : `Saved “${name}”.`,
          coursePatches.length > 0 ? `${plural(coursePatches.length, "course")} moved with it.` : "",
          days.length > 0 ? `Classes updated on ${plural(days.length, "saved day")}.` : "",
          released > 0 ? `${plural(released, "sitting")} went back to “to place”.` : "",
          clashDays.length > 0 ? `A class now lands on a block you placed on ${clashDays.join(", ")}: open ${clashDays.length === 1 ? "that day" : "those days"} to move it.` : ""
        ]
          .filter(Boolean)
          .join(" "),
        ms: 12000,
        action: {
          label: "Undo",
          onClick: () => {
            void (async () => {
              if (edit.kind === "add") await deleteTerm(uid, termId);
              else if (edit.kind === "edit" && previous) await updateTerm(uid, edit.id, { name: previous.name, kind: previous.kind, startDate: previous.startDate, endDate: previous.endDate });
              else if (previous) await restoreTerm(uid, previous);
              await Promise.all([
                ...coursePatches.map((patch) => updateCourse(uid, patch.item.id, patch.before)),
                ...templatePatches.map((patch) => updateRecurringTaskTemplate(uid, patch.item.id, patch.before))
              ]);
              const skipped = await undoDayChanges(uid, days);
              if (skipped > 0) toast({ message: `${plural(skipped, "day")} changed since, so ${skipped === 1 ? "it" : "they"} stayed as ${skipped === 1 ? "it is" : "they are"}.` });
            })();
          }
        }
      });
    },
    [user, toast, coursesOn, routineBlocks]
  );
}
