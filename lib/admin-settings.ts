import { adminDb } from "@/lib/firebase-admin";
import { writeAuditEntry } from "@/lib/admin-audit";
import type { AdminSettings } from "@/types";

export const DEFAULT_ADMIN_SETTINGS: AdminSettings = {
  signupMode: "open",
  allowedEmailDomains: [],
  maxActiveUsers: 10,
  defaultUserBudgetUsd: 5,
  defaultUserBlobMb: 75,
  aiGloballyEnabled: true,
  cronEnabled: true,
  maintenanceMode: false,
  chainOrder: ["local", "claude", "gemini"],
  signInMethods: { google: true, emailPassword: true, emailLink: true, anonymous: true }
};

let cached: { value: AdminSettings; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

function settingsDoc() {
  return adminDb().collection("admin").doc("settings");
}

/** Cached 60s so runtime switches don't cost a Firestore read on every AI call / cron tick / page load. */
export async function getAdminSettings(): Promise<AdminSettings> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const snapshot = await settingsDoc().get();
  const value: AdminSettings = { ...DEFAULT_ADMIN_SETTINGS, ...(snapshot.exists ? (snapshot.data() as Partial<AdminSettings>) : {}) };
  cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export function invalidateAdminSettingsCache(): void {
  cached = null;
}

export async function updateAdminSettings(
  patch: Partial<AdminSettings>,
  actor: { uid: string; email: string }
): Promise<AdminSettings> {
  const before = await getAdminSettings();
  const after: AdminSettings = { ...before, ...patch, updatedAt: new Date().toISOString(), updatedBy: actor.uid };
  await settingsDoc().set(after, { merge: true });
  invalidateAdminSettingsCache();

  const action = patch.aiGloballyEnabled !== undefined
    ? "ai.killswitch"
    : patch.cronEnabled !== undefined
      ? "cron.toggle"
      : patch.maintenanceMode !== undefined
        ? "maintenance.toggle"
        : patch.chainOrder !== undefined
          ? "chain.reorder"
          : patch.signInMethods !== undefined
            ? "signin.method.toggle"
            : "settings.update";

  await writeAuditEntry({
    actorUid: actor.uid,
    actorEmail: actor.email,
    action,
    targetType: "settings",
    targetId: "admin/settings",
    before,
    after: patch
  });

  return after;
}
