"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { subscribeDoc } from "@/lib/firestore";
import type { Day } from "@/types";

export function useDay(dateKey: string) {
  const { user } = useAuth();
  const [day, setDay] = useState<Day | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setDay(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    return subscribeDoc<Day>(user.uid, "days", dateKey, (next) => {
      setDay(next);
      setLoading(false);
    });
  }, [user, dateKey]);

  return { day, loading };
}
