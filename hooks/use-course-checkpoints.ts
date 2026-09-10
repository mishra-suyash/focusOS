"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { subscribeCourseCheckpoints } from "@/lib/firestore";
import type { Checkpoint, Course } from "@/types";

/** Subscribes to every given course's checkpoints subcollection and keeps them merged by course id. */
export function useCourseCheckpoints(courses: Course[]) {
  const { user } = useAuth();
  const [byCourse, setByCourse] = useState<Record<string, Checkpoint[]>>({});
  const courseIds = courses.map((course) => course.id).join(",");

  useEffect(() => {
    if (!user || !courseIds) {
      setByCourse({});
      return;
    }
    const ids = courseIds.split(",");
    const unsubscribes = ids.map((courseId) =>
      subscribeCourseCheckpoints(user.uid, courseId, (items) => {
        setByCourse((current) => ({ ...current, [courseId]: items }));
      })
    );
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [user, courseIds]);

  const all = Object.values(byCourse).flat();
  return { checkpointsByCourse: byCourse, allCheckpoints: all };
}
