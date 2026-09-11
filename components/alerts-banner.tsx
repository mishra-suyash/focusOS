"use client";

import { orderBy } from "firebase/firestore";
import { AlertTriangle, X } from "lucide-react";
import { useMemo } from "react";
import { useAuth } from "@/components/auth-provider";
import { useFeatures } from "@/hooks/use-features";
import { useUserCollection } from "@/hooks/use-user-collection";
import { ALERT_TYPE_MODULE } from "@/lib/features";
import { resolveAlert } from "@/lib/firestore";
import type { Alert, AlertSeverity } from "@/types";

const SEVERITY_STYLES: Record<AlertSeverity, string> = {
  critical: "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
  important: "border-amberline/40 bg-amberline/10 text-amber-800 dark:text-amber-300",
  general: "border-ink-200 bg-ink-50 text-ink-700 dark:border-ink-800 dark:bg-ink-800 dark:text-ink-300"
};

/** Deduped, severity-tagged signals from the daily triage run (lib/ai/triage.ts). Critical/Important surface here; General has no dedicated surface yet — it's the least common case today. */
export function AlertsBanner() {
  const { user } = useAuth();
  const { isEnabled } = useFeatures();
  const { items } = useUserCollection<Alert>("alerts", useMemo(() => [orderBy("createdAt", "desc")], []));
  const active = items
    .filter((alert) => !alert.resolvedAt && (alert.severity === "critical" || alert.severity === "important"))
    // Plan §9.2: the heads-up banner only shows alerts whose source module is enabled.
    .filter((alert) => {
      const moduleId = ALERT_TYPE_MODULE[alert.type];
      return !moduleId || isEnabled(moduleId);
    })
    .slice(0, 5);

  if (active.length === 0) return null;

  return (
    <div className="space-y-2">
      {active.map((alert) => (
        <div key={alert.id} className={`flex items-start gap-2 rounded-md border p-3 text-sm ${SEVERITY_STYLES[alert.severity]}`}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1">
            <p className="font-medium">{alert.title}</p>
            <p className="text-xs opacity-80">{alert.detail}</p>
          </div>
          <button className="opacity-60 hover:opacity-100" onClick={() => user && resolveAlert(user.uid, alert.id)} aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
