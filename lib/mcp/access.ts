/**
 * plan/19 §4.3 / D2 — who may use the MCP server at all, checked on every request and at the consent
 * screen. Three gates, in order:
 *
 * 1. The account: a `disabled` role or a disabled Firebase Auth user is refused (mirrors
 *    `verifyActiveUser`, lib/api-auth.ts). Cached 60 s per warm instance.
 * 2. The kill switch: `admin/settings.mcpEnabled` (absent = off).
 * 3. The role gate: owner and admin always; members only while `admin/settings.mcpMembersAllowed` is on.
 */
import { getAdminSettings } from "@/lib/admin-settings";
import { adminAuth } from "@/lib/firebase-admin";
import type { UserRole } from "@/types";

const ROLE_CACHE_MS = 60_000;
const roleCache = new Map<string, { role: UserRole; disabled: boolean; email: string; expiresAt: number }>();

export async function accountOf(uid: string): Promise<{ role: UserRole; disabled: boolean; email: string } | null> {
  const cached = roleCache.get(uid);
  if (cached && cached.expiresAt > Date.now()) return cached;
  try {
    const user = await adminAuth().getUser(uid);
    // Accounts created before role claims default to "member", as in lib/api-auth.ts.
    const entry = { role: ((user.customClaims?.role as UserRole | undefined) ?? "member") as UserRole, disabled: user.disabled, email: user.email ?? "", expiresAt: Date.now() + ROLE_CACHE_MS };
    roleCache.set(uid, entry);
    return entry;
  } catch {
    return null;
  }
}

export type AccessDecision = { ok: true; role: UserRole } | { ok: false; status: 403; reason: string };

export async function mcpAccess(uid: string): Promise<AccessDecision> {
  const account = await accountOf(uid);
  if (!account || account.disabled || account.role === "disabled") return { ok: false, status: 403, reason: "This account has been disabled." };
  const settings = await getAdminSettings();
  if (!settings.mcpEnabled) return { ok: false, status: 403, reason: "Connecting Claude to FocusLab is turned off by the admin." };
  if (account.role === "member" && !settings.mcpMembersAllowed) {
    return { ok: false, status: 403, reason: "Connecting Claude is open to owner and admin accounts only for now." };
  }
  return { ok: true, role: account.role };
}
