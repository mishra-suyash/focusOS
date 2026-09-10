import { adminDb } from "@/lib/firebase-admin";

/**
 * Records the last outcome of each Vercel Cron job at admin/cronRuns/{name} —
 * Hobby crons fire ±59 min with no dashboard of their own beyond 1 hour of
 * runtime logs, so this is the only durable record /admin's overview screen
 * has to show "last ran" (never "next runs at", which Hobby can't promise).
 */
export async function recordCronRun(name: string, outcome: { ok: boolean; detail?: unknown }): Promise<void> {
  await adminDb()
    .collection("admin")
    .doc("cronRuns")
    .collection("entries")
    .doc(name)
    .set({ name, at: new Date().toISOString(), ...outcome }, { merge: true });
}

export async function getCronRun(name: string): Promise<{ name: string; at: string; ok: boolean; detail?: unknown } | null> {
  const snapshot = await adminDb().collection("admin").doc("cronRuns").collection("entries").doc(name).get();
  return snapshot.exists ? (snapshot.data() as { name: string; at: string; ok: boolean; detail?: unknown }) : null;
}
