import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { writeAuditEntry } from "@/lib/admin-audit";
import {
  MAX_PUBLISHED_TEMPLATES,
  validateTemplatePayload,
  type AdminTemplateSettings,
  type NewOrgTemplate,
  type OrgTemplate,
  type PublicCatalog,
  type TemplateKind
} from "@/lib/templates/schema";
import type { DayTemplate, PackId } from "@/types";

/**
 * Admin-panel CRUD + lifecycle for org-published templates (plan §7). Two
 * Firestore locations, following the same client-readable/Admin-SDK-only
 * split as `tiers`:
 *
 *   templates/{templateId}        Admin SDK only — source of truth.
 *   publicCatalog/current         client-readable — rebuilt on every mutation.
 *   admin/templateSettings        Admin SDK only — durable packDefaults/hiddenBuiltInIds
 *                                 config `rebuildPublicCatalog` folds into the rebuilt doc.
 *
 * This repo has no committed `firestore.rules` file (indexes are pushed via
 * `scripts/ensure-indexes.mjs`, not the Firebase CLI) — apply this by hand in
 * the Firebase console:
 *
 *   match /publicCatalog/{docId} {
 *     allow read: if request.auth != null && request.auth.token.get('role', 'member') != 'disabled';
 *     allow write: if false;
 *   }
 *   match /templates/{document=**} {
 *     allow read, write: if false;
 *   }
 *   match /admin/templateSettings {
 *     allow read, write: if false;
 *   }
 */

type Actor = { uid: string; email: string };

function nowIso() {
  return new Date().toISOString();
}

function templatesCollection() {
  return adminDb().collection("templates");
}

export async function listAdminTemplates(): Promise<OrgTemplate[]> {
  const snapshot = await templatesCollection().orderBy("updatedAt", "desc").get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as OrgTemplate);
}

export async function getAdminTemplate(id: string): Promise<OrgTemplate | null> {
  const doc = await templatesCollection().doc(id).get();
  return doc.exists ? ({ id: doc.id, ...doc.data() } as OrgTemplate) : null;
}

export class TemplateValidationError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(errors.join("; "));
    this.errors = errors;
  }
}

export async function createDraftTemplate(actor: Actor, input: NewOrgTemplate): Promise<string> {
  const result = validateTemplatePayload(input.kind, input.payload);
  if (!result.ok) throw new TemplateValidationError(result.errors);

  const at = nowIso();
  const doc: Omit<OrgTemplate, "id"> = {
    kind: input.kind,
    name: input.name,
    description: input.description,
    payload: result.value,
    status: "draft",
    version: 1,
    packIds: [],
    createdBy: actor.uid,
    updatedBy: actor.uid,
    createdAt: at,
    updatedAt: at
  };
  const ref = await templatesCollection().add(doc);
  await writeAuditEntry({ actorUid: actor.uid, actorEmail: actor.email, action: "template.create", targetType: "template", targetId: ref.id, after: doc });
  return ref.id;
}

export async function updateTemplate(
  actor: Actor,
  id: string,
  patch: Partial<Pick<OrgTemplate, "name" | "description" | "payload" | "packIds" | "audienceTierIds">>
): Promise<void> {
  const ref = templatesCollection().doc(id);
  const existing = await ref.get();
  if (!existing.exists) throw new Error(`No template with id ${id}.`);
  const before = existing.data() as OrgTemplate;

  if (patch.payload !== undefined) {
    const result = validateTemplatePayload(before.kind, patch.payload);
    if (!result.ok) throw new TemplateValidationError(result.errors);
    patch = { ...patch, payload: result.value };
  }

  await ref.set({ ...patch, updatedAt: nowIso(), updatedBy: actor.uid }, { merge: true });
  await writeAuditEntry({ actorUid: actor.uid, actorEmail: actor.email, action: "template.update", targetType: "template", targetId: id, before, after: patch });
  // Deliberately does NOT touch publicCatalog/current or bump `version` here, even for an
  // already-published template — §7.1's lifecycle is "Publishing bumps version", and letting an
  // edit alone change what the catalog serves would leave existing user copies' `sourceVersion`
  // silently stale relative to blocks nobody asked them to update. Re-publish is the explicit step.
}

export async function publishTemplate(actor: Actor, id: string): Promise<void> {
  const ref = templatesCollection().doc(id);
  const existing = await ref.get();
  if (!existing.exists) throw new Error(`No template with id ${id}.`);
  const before = existing.data() as OrgTemplate;

  const wasPublished = before.status === "published";
  if (!wasPublished) {
    const publishedCount = await templatesCollection().where("status", "==", "published").count().get();
    if (publishedCount.data().count >= MAX_PUBLISHED_TEMPLATES) {
      throw new Error(`Cannot publish — already at the ${MAX_PUBLISHED_TEMPLATES}-template limit. Archive one first.`);
    }
  }

  // First publish keeps the draft's version (1) rather than jumping straight to 2 — "bumped on
  // each publish" (§7.1) means each *re*-publish after the first, so a fresh copy's sourceVersion
  // matches what the catalog actually served it.
  const nextVersion = wasPublished ? before.version + 1 : before.version;
  const at = nowIso();
  await ref.set({ status: "published", version: nextVersion, publishedAt: at, updatedAt: at, updatedBy: actor.uid }, { merge: true });
  await writeAuditEntry({ actorUid: actor.uid, actorEmail: actor.email, action: "template.publish", targetType: "template", targetId: id, before });
  await rebuildPublicCatalog();
}

export async function archiveTemplate(actor: Actor, id: string): Promise<void> {
  const ref = templatesCollection().doc(id);
  const existing = await ref.get();
  if (!existing.exists) throw new Error(`No template with id ${id}.`);
  await ref.set({ status: "archived", updatedAt: nowIso(), updatedBy: actor.uid }, { merge: true });
  await writeAuditEntry({ actorUid: actor.uid, actorEmail: actor.email, action: "template.archive", targetType: "template", targetId: id });
  await rebuildPublicCatalog(); // archiving never touches user copies (plan §7.4) — only removes it from the catalog going forward
}

/** Lists the calling admin's own day templates, for the "Import from my templates" picker (plan §7.1) — Admin SDK reads `users/{actor.uid}/dayTemplates`, never another user's. */
export async function listOwnDayTemplates(actor: Actor): Promise<DayTemplate[]> {
  const snapshot = await adminDb().collection("users").doc(actor.uid).collection("dayTemplates").get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as DayTemplate);
}

/**
 * Publishes one of the admin's own day templates directly — "the fastest way to share a real,
 * battle-tested research day" (plan §7.1), so this goes straight to `published` rather than
 * leaving a draft that needs a second click.
 *
 * Re-importing the same source day template (`payload.id === dayTemplateId`) updates the
 * existing OrgTemplate and bumps its version, instead of creating a second, indistinguishable
 * published entry — otherwise copies from the first import would never see the re-import as an
 * "Update available", and the catalog would carry two same-named templates.
 */
export async function importFromOwnDayTemplate(actor: Actor, dayTemplateId: string): Promise<string> {
  const doc = await adminDb().collection("users").doc(actor.uid).collection("dayTemplates").doc(dayTemplateId).get();
  if (!doc.exists) throw new Error(`No day template with id ${dayTemplateId} on your own account.`);
  const source = doc.data() as DayTemplate;

  const payload = {
    id: dayTemplateId,
    version: 1,
    name: source.name,
    description: source.description,
    slots: source.slots.map((slot) => ({ title: slot.title, type: slot.type, startTime: slot.startTime, endTime: slot.endTime, note: slot.note }))
  };
  const result = validateTemplatePayload("day", payload);
  if (!result.ok) throw new TemplateValidationError(result.errors);

  const existingSnapshot = await templatesCollection().where("kind", "==", "day").where("payload.id", "==", dayTemplateId).limit(1).get();
  const at = nowIso();

  if (!existingSnapshot.empty) {
    const existingDoc = existingSnapshot.docs[0];
    const before = existingDoc.data() as OrgTemplate;
    const nextVersion = before.status === "published" ? before.version + 1 : before.version;
    await existingDoc.ref.set(
      { name: source.name, description: source.description, payload: result.value, status: "published", version: nextVersion, publishedAt: at, updatedAt: at, updatedBy: actor.uid },
      { merge: true }
    );
    await writeAuditEntry({ actorUid: actor.uid, actorEmail: actor.email, action: "template.import", targetType: "template", targetId: existingDoc.id, before, after: { dayTemplateId } });
    await rebuildPublicCatalog();
    return existingDoc.id;
  }

  const publishedCount = await templatesCollection().where("status", "==", "published").count().get();
  if (publishedCount.data().count >= MAX_PUBLISHED_TEMPLATES) {
    throw new Error(`Cannot publish — already at the ${MAX_PUBLISHED_TEMPLATES}-template limit. Archive one first.`);
  }

  const templateDoc: Omit<OrgTemplate, "id"> = {
    kind: "day",
    name: source.name,
    description: source.description,
    payload: result.value,
    status: "published",
    version: 1,
    packIds: [],
    createdBy: actor.uid,
    updatedBy: actor.uid,
    createdAt: at,
    updatedAt: at,
    publishedAt: at
  };
  const ref = await templatesCollection().add(templateDoc);
  await writeAuditEntry({ actorUid: actor.uid, actorEmail: actor.email, action: "template.import", targetType: "template", targetId: ref.id, after: { dayTemplateId } });
  await rebuildPublicCatalog();
  return ref.id;
}

export async function getTemplateSettings(): Promise<AdminTemplateSettings> {
  const doc = await adminDb().collection("admin").doc("templateSettings").get();
  return doc.exists ? (doc.data() as AdminTemplateSettings) : { packDefaults: {}, hiddenBuiltInIds: [] };
}

export async function setPackDefaultTemplate(
  actor: Actor,
  packId: PackId,
  slot: "workdayTemplateId" | "breakDayTemplateId",
  templateId: string | null
): Promise<void> {
  const settings = await getTemplateSettings();
  // FieldValue.delete() (not just omitting the key) is required here: this whole `packDefaults`
  // object is written via a merge set, and Firestore's merge only clears a nested field you name
  // explicitly — an omitted key leaves whatever was already stored untouched, so "Built-in
  // default" would never actually clear a prior override.
  const packDefaults: Record<string, unknown> = {
    ...settings.packDefaults,
    [packId]: { ...settings.packDefaults[packId], [slot]: templateId ?? FieldValue.delete() }
  };
  await adminDb()
    .collection("admin")
    .doc("templateSettings")
    .set({ packDefaults, updatedAt: nowIso(), updatedBy: actor.uid }, { merge: true });
  await writeAuditEntry({
    actorUid: actor.uid,
    actorEmail: actor.email,
    action: "template.pack-default.set",
    targetType: "template",
    targetId: `${packId}.${slot}`,
    after: { templateId }
  });
  await rebuildPublicCatalog();
}

export async function setBuiltinHidden(actor: Actor, builtinId: string, hidden: boolean): Promise<void> {
  const settings = await getTemplateSettings();
  const hiddenBuiltInIds = hidden
    ? Array.from(new Set([...settings.hiddenBuiltInIds, builtinId]))
    : settings.hiddenBuiltInIds.filter((id) => id !== builtinId);
  await adminDb()
    .collection("admin")
    .doc("templateSettings")
    .set({ hiddenBuiltInIds, updatedAt: nowIso(), updatedBy: actor.uid }, { merge: true });
  await writeAuditEntry({
    actorUid: actor.uid,
    actorEmail: actor.email,
    action: "template.builtin.hide",
    targetType: "template",
    targetId: builtinId,
    after: { hidden }
  });
  await rebuildPublicCatalog();
}

/** Fully regenerates `publicCatalog/current` from `templates` (published only) + `admin/templateSettings` — called after every mutation above, per plan §7.2's "rebuilt on every publish/archive/edit". */
export async function rebuildPublicCatalog(): Promise<void> {
  const [publishedSnapshot, settings] = await Promise.all([templatesCollection().where("status", "==", "published").get(), getTemplateSettings()]);
  const templates: PublicCatalog["templates"] = publishedSnapshot.docs.map((doc) => {
    const data = doc.data() as OrgTemplate;
    return {
      id: doc.id,
      kind: data.kind,
      name: data.name,
      description: data.description,
      payload: data.payload,
      version: data.version,
      packIds: data.packIds,
      audienceTierIds: data.audienceTierIds,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      publishedAt: data.publishedAt
    };
  });
  const catalog: PublicCatalog = {
    rebuiltAt: nowIso(),
    templates,
    packDefaults: settings.packDefaults,
    hiddenBuiltInIds: settings.hiddenBuiltInIds
  };
  await adminDb().collection("publicCatalog").doc("current").set(catalog);
}

export async function listTemplateKindCounts(): Promise<Record<TemplateKind, number>> {
  const all = await listAdminTemplates();
  const counts: Record<TemplateKind, number> = { day: 0, taskPack: 0, goal: 0, readingGoal: 0, timer: 0 };
  for (const template of all) counts[template.kind] += 1;
  return counts;
}
