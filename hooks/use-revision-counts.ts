"use client";

import { where } from "firebase/firestore";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { subscribeCollection, subscribeDueRevisionItems } from "@/lib/firestore";
import type { RevisionItem } from "@/types";

/** Due-today count (for the Load Index's "required" term) and reviewed-today count (for "actual"). */
export function useRevisionCounts(todayKey: string) {
  const { user } = useAuth();
  const [dueCount, setDueCount] = useState(0);
  const [reviewedTodayCount, setReviewedTodayCount] = useState(0);

  useEffect(() => {
    if (!user) {
      setDueCount(0);
      return;
    }
    return subscribeDueRevisionItems(user.uid, todayKey, (items) => setDueCount(items.length));
  }, [user, todayKey]);

  useEffect(() => {
    if (!user) {
      setReviewedTodayCount(0);
      return;
    }
    return subscribeCollection<RevisionItem>(user.uid, "revisionItems", (items) => setReviewedTodayCount(items.length), [
      where("lastReviewedAt", ">=", `${todayKey}T00:00:00.000Z`)
    ]);
  }, [user, todayKey]);

  return { dueCount, reviewedTodayCount };
}
