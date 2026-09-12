"use client";

import { useEffect, useState } from "react";
import { currentMinute } from "@/lib/schedule";

/** Re-renders every 60s so "now" markers (DayStrip, TimeGrid — plan/FocusOS-v2-Plan-Day-Timeline.md §4.1/§4.2) stay accurate without a full page refresh. */
export function useCurrentMinute(): number {
  const [minute, setMinute] = useState(() => currentMinute());
  useEffect(() => {
    const id = window.setInterval(() => setMinute(currentMinute()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return minute;
}
