/**
 * plan/19 §4.1/§4.2/§4.4 — every credential the MCP server accepts, in `mcpTokens/{sha256(token)}`.
 * Tokens are opaque random strings, stored only as their hash, looked up by one `get`, and revocable
 * instantly. Three kinds:
 *
 * - `pat`: a personal access token made in Settings, for Claude Code / MCP Inspector. No expiry, no
 *   audience binding (the same database serves localhost and production).
 * - `access`: an OAuth access token, 1 hour, bound to the MCP resource URL it was issued for.
 * - `refresh`: an OAuth refresh token, 60 days, rotated on every use. Reusing a rotated one revokes its
 *   whole `familyId` — every token descended from that one approval.
 *
 * Top-level and server-only: never readable by a client (plan/19 §2.5). Expiry is enforced here in code,
 * whether or not a Firestore TTL policy also cleans the documents up.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Transaction } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";

export type TokenKind = "pat" | "access" | "refresh";
export type McpScope = "read" | "write";

export interface TokenRecord {
  uid: string;
  kind: TokenKind;
  clientId: string;
  clientName: string;
  scopes: McpScope[];
  /** The MCP resource URL an OAuth token was issued for. Absent on a PAT. */
  resource?: string;
  label?: string;
  /** Every token from one approval (or one PAT) shares this; revoking the family revokes them all. */
  familyId: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  /** Set on a refresh token once it has been exchanged; presenting it again is reuse. */
  rotatedAt?: string;
}

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 24 * 60 * 60;
export const AUTH_CODE_TTL_SECONDS = 60;

const PREFIX: Record<TokenKind, string> = { pat: "fl_pat_", access: "fl_at_", refresh: "fl_rt_" };

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function newSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function tokensCollection() {
  return adminDb().collection("mcpTokens");
}

export function codesCollection() {
  return adminDb().collection("oauthCodes");
}

export function normalizeScopes(input: string | string[] | undefined, fallback: McpScope[] = ["read"]): McpScope[] {
  const words = (Array.isArray(input) ? input : (input ?? "").split(/\s+/)).map((word) => word.trim());
  const scopes = new Set<McpScope>();
  for (const word of words) if (word === "read" || word === "write") scopes.add(word);
  // Writing without seeing is never useful, so `write` always brings `read`.
  if (scopes.has("write")) scopes.add("read");
  return scopes.size > 0 ? (["read", "write"] as McpScope[]).filter((scope) => scopes.has(scope)) : fallback;
}

export function isExpired(record: Pick<TokenRecord, "expiresAt">, now = Date.now()): boolean {
  return Boolean(record.expiresAt && Date.parse(record.expiresAt) <= now);
}

export async function createPersonalAccessToken(uid: string, label: string, scopes: McpScope[]): Promise<{ token: string; id: string }> {
  const token = newSecret(PREFIX.pat);
  const id = hashSecret(token);
  const record: TokenRecord = { uid, kind: "pat", clientId: "pat", clientName: label, label, scopes, familyId: id, createdAt: new Date().toISOString() };
  await tokensCollection().doc(id).set(record);
  return { token, id };
}

export interface IssuedTokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** A fresh access + refresh pair in `familyId`, written in `tx`: the code exchange and the refresh rotation each run in one, so a code or a refresh token can't be spent twice. */
export function issueTokenPair(
  grant: { uid: string; clientId: string; clientName: string; scopes: McpScope[]; resource: string; familyId: string },
  tx: Transaction
): IssuedTokens {
  const nowMs = Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const access = newSecret(PREFIX.access);
  const refresh = newSecret(PREFIX.refresh);
  const base = { uid: grant.uid, clientId: grant.clientId, clientName: grant.clientName, scopes: grant.scopes, resource: grant.resource, familyId: grant.familyId, createdAt };
  const accessRecord: TokenRecord = { ...base, kind: "access", expiresAt: new Date(nowMs + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString() };
  const refreshRecord: TokenRecord = { ...base, kind: "refresh", expiresAt: new Date(nowMs + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString() };
  const accessRef = tokensCollection().doc(hashSecret(access));
  const refreshRef = tokensCollection().doc(hashSecret(refresh));
  tx.create(accessRef, accessRecord);
  tx.create(refreshRef, refreshRecord);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refresh, scope: grant.scopes.join(" ") };
}

export async function getToken(secret: string): Promise<{ id: string; record: TokenRecord } | null> {
  const id = hashSecret(secret);
  const snapshot = await tokensCollection().doc(id).get();
  return snapshot.exists ? { id, record: snapshot.data() as TokenRecord } : null;
}

/** Revokes every live token in a family. Equality-only query: no composite index needed. */
export async function revokeFamily(familyId: string, tx?: Transaction): Promise<number> {
  const query = tokensCollection().where("familyId", "==", familyId);
  const snapshot = tx ? await tx.get(query) : await query.get();
  const revokedAt = new Date().toISOString();
  const live = snapshot.docs.filter((doc) => !(doc.data() as TokenRecord).revokedAt);
  if (tx) {
    live.forEach((doc) => tx.update(doc.ref, { revokedAt }));
  } else if (live.length > 0) {
    const batch = adminDb().batch();
    live.forEach((doc) => batch.update(doc.ref, { revokedAt }));
    await batch.commit();
  }
  return live.length;
}

/** All of a user's tokens. Equality-only query, sorted in memory. */
export async function listUserTokens(uid: string): Promise<{ id: string; record: TokenRecord }[]> {
  const snapshot = await tokensCollection().where("uid", "==", uid).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, record: doc.data() as TokenRecord })).sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt));
}

/** Account deletion (plan/19 §4.4): a deleted user's tokens and pending codes go with them. */
export async function deleteUserCredentials(uid: string): Promise<number> {
  const [tokens, codes] = await Promise.all([tokensCollection().where("uid", "==", uid).get(), codesCollection().where("uid", "==", uid).get()]);
  const refs = [...tokens.docs, ...codes.docs].map((doc) => doc.ref);
  for (let i = 0; i < refs.length; i += 400) {
    const batch = adminDb().batch();
    refs.slice(i, i + 400).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
  return refs.length;
}
