import { adminDb } from "@/lib/firebase-admin";
import type { AuditAction } from "@/types";

export interface WriteAuditEntryInput {
  actorUid: string;
  actorEmail: string;
  action: AuditAction;
  targetType: "user" | "settings" | "ollama" | "tier" | "template";
  targetId: string;
  before?: unknown;
  after?: unknown;
}

/** Append-only log at admin/auditLog/{entryId} — every mutating /api/admin/** route writes one of these. */
export async function writeAuditEntry(entry: WriteAuditEntryInput): Promise<void> {
  await adminDb()
    .collection("admin")
    .doc("auditLog")
    .collection("entries")
    .add({ ...entry, at: new Date().toISOString() });
}
