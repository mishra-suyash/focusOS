import { adminDb } from "@/lib/firebase-admin";
import { getCronRun } from "@/lib/admin-cron-log";
import { getAdminSettings } from "@/lib/admin-settings";
import { listAllUids } from "@/lib/admin-users";
import { breakerSnapshot } from "@/lib/ai/circuit-breaker";
import { claudeConfigured } from "@/lib/ai/providers/claude";
import { geminiConfigured } from "@/lib/ai/providers/gemini";
import { isOllamaAvailable } from "@/lib/ai/providers/ollama";
import { effectiveCapUsd } from "@/lib/ai/budget";

// Firestore Spark's daily 50k-read / 20k-write ceilings (plan §2.2, admin panel §6).
const FIRESTORE_READ_CEILING = 50_000;
const FIRESTORE_WRITE_CEILING = 20_000;
const BLOB_BYTE_CEILING = 1024 * 1024 * 1024;

function monthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

function meterLevel(pct: number): "ok" | "amber" | "red" {
  if (pct >= 0.9) return "red";
  if (pct >= 0.7) return "amber";
  return "ok";
}

export async function buildAdminOverview() {
  const settings = await getAdminSettings();
  const month = monthKey();
  const uids = await listAllUids();

  const [perUserUsage, perUserFiles, recentFailures, cronRun, ollama] = await Promise.all([
    Promise.all(uids.map((uid) => adminDb().collection("users").doc(uid).collection("usage").doc(month).get())),
    Promise.all(uids.map((uid) => adminDb().collection("users").doc(uid).collection("files").get())),
    // Requires a collection-group composite index (firestore.indexes.json) that Firestore
    // builds asynchronously after `pnpm ensure:indexes` — never let a not-yet-ready index
    // take down the whole overview screen while it builds.
    adminDb()
      .collectionGroup("aiRuns")
      .where("ok", "==", false)
      .orderBy("at", "desc")
      .limit(5)
      .get()
      .then((snapshot) => snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })))
      .catch(() => [] as { id: string }[]),
    getCronRun("daily-insight"),
    isOllamaAvailable()
  ]);

  let reads = 0;
  let writes = 0;
  let aiSpendUsd = 0;
  perUserUsage.forEach((snapshot) => {
    const data = snapshot.data();
    reads += (data?.reads as number | undefined) ?? 0;
    writes += (data?.writes as number | undefined) ?? 0;
    aiSpendUsd += (data?.ai?.estimatedCostUsd as number | undefined) ?? 0;
  });

  const blobBytes = perUserFiles.reduce(
    (sum, snapshot) => sum + snapshot.docs.reduce((inner, doc) => inner + ((doc.data().bytes as number | undefined) ?? 0), 0),
    0
  );
  const budgetCapUsd = effectiveCapUsd(settings.defaultUserBudgetUsd * settings.maxActiveUsers);

  return {
    providers: {
      claude: { configured: claudeConfigured(), ...breakerSnapshot("claude") },
      gemini: { configured: geminiConfigured(), ...breakerSnapshot("gemini") },
      ollama: { enabled: ollama.config.enabled, available: ollama.available, health: ollama.config.health }
    },
    budget: { spentUsd: aiSpendUsd, capUsd: budgetCapUsd, pct: budgetCapUsd > 0 ? aiSpendUsd / budgetCapUsd : 0 },
    freeTierMeters: {
      // "Today" is approximated as month-to-date — lib/usage.ts only tracks monthly totals, not a daily rollover.
      firestoreReads: { value: reads, ceiling: FIRESTORE_READ_CEILING, level: meterLevel(reads / FIRESTORE_READ_CEILING) },
      firestoreWrites: { value: writes, ceiling: FIRESTORE_WRITE_CEILING, level: meterLevel(writes / FIRESTORE_WRITE_CEILING) },
      blobBytes: { value: blobBytes, ceiling: BLOB_BYTE_CEILING, level: meterLevel(blobBytes / BLOB_BYTE_CEILING) }
    },
    crons: { "daily-insight": { enabled: settings.cronEnabled, lastRun: cronRun } },
    recentFailures,
    maintenanceMode: settings.maintenanceMode,
    aiGloballyEnabled: settings.aiGloballyEnabled
  };
}
