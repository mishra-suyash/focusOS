"use client";

import { limit, orderBy } from "firebase/firestore";
import { useMemo } from "react";
import { useCourseCheckpoints } from "@/hooks/use-course-checkpoints";
import { useDay } from "@/hooks/use-day";
import { useFeatures } from "@/hooks/use-features";
import { useLiveLoadIndex } from "@/hooks/use-live-load-index";
import { useRevisionCounts } from "@/hooks/use-revision-counts";
import { useUserCollection } from "@/hooks/use-user-collection";
import { plannableTasks } from "@/lib/courses";
import { weekDates, weekStartKey } from "@/lib/dates";
import { pickNextAction, type NextAction } from "@/lib/next-action";
import { describeObjective } from "@/lib/objectives";
import { currentMinute, getActiveSlot, getNextSlot, sortedSlots } from "@/lib/schedule";
import { categoryForSlotType } from "@/lib/timeline";
import { sittingRemainingMinutes } from "@/lib/tracking";
import type { Category, Course, DailySchedule, Goal, Paper, PomodoroSession, Task, TaskBucket } from "@/types";

/** Exactly `startFocus`'s parameter shape (components/focus-session-provider.tsx). */
export interface FocusStartArgs {
  label: string;
  category: Category;
  slotId?: string;
  taskId?: string;
  courseId?: string;
  bucket?: TaskBucket;
  paperId?: string;
  passNo?: 1 | 2 | 3;
  minutes?: number;
}

/**
 * plan/16 §5.7 — "what to do next", and the correctly-sized, correctly-attributed session that
 * starts it, computed once for every surface that shows it.
 *
 * The dashboard's Up next card and the floating widget's new `nextAction` card must agree, and the
 * only way two surfaces agree is by not computing the same thing twice — the same reasoning that
 * produced `useLiveLoadIndex`. The PiP window is a React portal into the parent document's tree, so
 * this hook works there unchanged.
 *
 * `startArgs` is the §5.5 half: a session started from a block arms what is *left* of that sitting
 * (its planned minutes minus real logged coverage), and carries the block's course, bucket, paper
 * and pass — `describeObjective`'s `attribution` is deliberately shaped as `startFocus`'s argument
 * object, so there is no per-objective branching here.
 */
export function useNextAction(todayKey: string): { action: NextAction | null; startArgs: FocusStartArgs | null } {
  const { enabledModules } = useFeatures();
  const { items: tasks } = useUserCollection<Task>("tasks", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: sessions } = useUserCollection<PomodoroSession>("pomodoroSessions", useMemo(() => [orderBy("completedAt", "desc"), limit(200)], []));
  const { items: dailySchedules } = useUserCollection<DailySchedule>("dailySchedules", useMemo(() => [orderBy("updatedAt", "desc")], []));
  const { items: courses } = useUserCollection<Course>("courses", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: papers } = useUserCollection<Paper>("papers", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: goals } = useUserCollection<Goal>("goals", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { allCheckpoints } = useCourseCheckpoints(courses);
  const { dueCount } = useRevisionCounts(todayKey);
  const { day } = useDay(todayKey);
  const loadIndex = useLiveLoadIndex(todayKey);

  const slots = sortedSlots(dailySchedules.find((item) => item.dateKey === todayKey)?.slots ?? []);
  const minute = currentMinute();
  const action = pickNextAction({
    checkpoints: allCheckpoints,
    dueRevisionCount: dueCount,
    // plan/16 — never recommend work from a course the user has dropped. `pickNextAction` itself
    // stays unaware of courses: it is a pure cascade over whatever it is handed, and filtering here
    // keeps that true rather than threading course status into it.
    tasks: plannableTasks(tasks, courses),
    loadIndexValue: loadIndex.value,
    todayKey,
    weekEndKey: weekDates(weekStartKey())[6],
    enabledModules,
    activeSlot: getActiveSlot(slots, minute),
    nextSlot: getNextSlot(slots, minute),
    minute,
    isDayOff: Boolean(day?.dayOff)
  });

  const slot = action?.slot;
  if (!slot || slot.type === "class") return { action, startArgs: null };

  const todaysSessions = sessions.filter((session) => session.completedAt.startsWith(todayKey));
  const objective = describeObjective(slot, { courses, papers, checkpoints: allCheckpoints, tasks, goals });
  const assigned = slot.assignedTaskIds ?? [];
  const left = sittingRemainingMinutes(slot, todaysSessions);

  return {
    action,
    startArgs: {
      label: slot.title,
      category: categoryForSlotType(slot.type),
      slotId: slot.id,
      // A block linked to exactly one task credits that task; zero or several is ambiguous, so it's
      // left uncredited — the same rule the dashboard's own start path already applies.
      taskId: assigned.length === 1 ? assigned[0] : undefined,
      courseId: slot.courseId,
      bucket: slot.bucket,
      paperId: objective?.attribution.paperId,
      passNo: objective?.attribution.passNo,
      minutes: left > 0 ? left : undefined
    }
  };
}
