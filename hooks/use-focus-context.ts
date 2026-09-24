"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { useCurrentMinute } from "@/hooks/use-current-minute";
import { todayKey } from "@/lib/dates";
import { subscribeDoc } from "@/lib/firestore";
import { getActiveSlot, sortedSlots } from "@/lib/schedule";
import { categoryForSlotType } from "@/lib/timeline";
import type { Category, DailySchedule, TaskBucket } from "@/types";

export interface FocusContext {
  slotId: string;
  label: string;
  category: Category;
  courseId?: string;
  bucket?: TaskBucket;
  /** The block's own single assigned task, per the same disambiguation rule the `?startFocus=1`
   *  path already applies (dashboard/page.tsx): a block with zero or several tasks is ambiguous. */
  taskId?: string;
}

/**
 * plan/14 §6.2 — today's currently-active `ScheduleSlot`, re-derived on `useCurrentMinute()`'s
 * per-minute tick, for `FocusSessionProvider` to auto-fill the timer from. Composes pieces that
 * already exist elsewhere (today's `DailySchedule`, `getActiveSlot`) rather than adding a new
 * subscription pattern.
 */
export function useFocusContext(): FocusContext | null {
  const { user } = useAuth();
  const today = todayKey();
  const [schedule, setSchedule] = useState<DailySchedule | null>(null);
  const minute = useCurrentMinute();

  useEffect(() => {
    if (!user) {
      setSchedule(null);
      return;
    }
    return subscribeDoc<DailySchedule>(user.uid, "dailySchedules", today, setSchedule);
  }, [user, today]);

  if (!schedule) return null;
  const active = getActiveSlot(sortedSlots(schedule.slots), minute);
  if (!active) return null;

  const linkedTaskIds = active.assignedTaskIds ?? [];
  return {
    slotId: active.id,
    label: active.title,
    category: categoryForSlotType(active.type),
    courseId: active.courseId,
    bucket: active.bucket,
    taskId: linkedTaskIds.length === 1 ? linkedTaskIds[0] : undefined
  };
}
