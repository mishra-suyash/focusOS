/**
 * plan/19 §4.2 — who may ask for a FocusLab token, and where the answer may be sent.
 *
 * Two ways a client identifies itself:
 * - **DCR** (RFC 7591): it POSTs to /api/oauth/register and gets a random `client_id`, stored in
 *   `oauthClients/{clientId}`.
 * - **CIMD** (Client ID Metadata Document): its `client_id` is an HTTPS URL that serves its own metadata.
 *   We fetch it behind an SSRF guard (HTTPS only, a public address, 5 s, 10 KB, no redirects) and cache it.
 *   Which host claude.ai's hosted apps publish from isn't confirmed, so any HTTPS host is accepted for
 *   now, and every one seen is recorded in `oauthClients` (kind "cimd") so the allowlist can be set to
 *   what real connections used.
 *
 * Redirect URIs: Claude's hosted callback, or a loopback address for Claude Code (matched without the
 * port, which Claude Code picks at random).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase-admin";

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  kind: "dcr" | "cimd";
}

const HOSTED_CALLBACKS = new Set(["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function clientsCollection() {
  return adminDb().collection("oauthClients");
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/** A redirect URI a DCR client may register: Claude's hosted callback or a loopback address. */
export function isAllowedRedirectUri(uri: string): boolean {
  if (HOSTED_CALLBACKS.has(uri)) return true;
  try {
    const url = new URL(uri);
    return isLoopback(url) && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

/** Whether `requested` is one of `registered`. Exact, except a loopback address matches on any port (RFC 8252 §7.3). */
export function redirectUriMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let want: URL;
  try {
    want = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopback(want)) return false;
  return registered.some((uri) => {
    try {
      const have = new URL(uri);
      return isLoopback(have) && have.hostname === want.hostname && have.pathname === want.pathname && have.search === want.search;
    } catch {
      return false;
    }
  });
}

export async function registerClient(input: { clientName: string; redirectUris: string[] }): Promise<OAuthClient> {
  const clientId = `fl_client_${randomUUID()}`;
  const record = { clientName: input.clientName, redirectUris: input.redirectUris, kind: "dcr" as const, createdAt: new Date().toISOString() };
  await clientsCollection().doc(clientId).set(record);
  return { clientId, clientName: record.clientName, redirectUris: record.redirectUris, kind: "dcr" };
}

const CIMD_TIMEOUT_MS = 5000;
const CIMD_MAX_BYTES = 10 * 1024;
const CIMD_CACHE_MS = 10 * 60 * 1000;
const cimdCache = new Map<string, { client: OAuthClient; expiresAt: number }>();

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

async function fetchMetadataDocument(clientId: string): Promise<OAuthClient | null> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.pathname === "/" || isIP(url.hostname.replace(/^\[|\]$/g, ""))) return null;
  // SSRF guard: the host must resolve only to public addresses.
  const addresses = await lookup(url.hostname, { all: true }).catch(() => []);
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CIMD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { redirect: "manual", signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CIMD_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const doc = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { client_id?: string; client_name?: string; redirect_uris?: unknown };
    // The document must name itself: a URL serving someone else's metadata isn't that client.
    if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris)) return null;
    const redirectUris = doc.redirect_uris.filter((uri): uri is string => typeof uri === "string");
    return { clientId, clientName: (doc.client_name ?? url.hostname).slice(0, 100), redirectUris, kind: "cimd" };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The client behind a `client_id`, or null when it's unknown or its metadata can't be trusted. */
export async function resolveClient(clientId: string): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > 2048) return null;
  if (clientId.startsWith("https://")) {
    const cached = cimdCache.get(clientId);
    if (cached && cached.expiresAt > Date.now()) return cached.client;
    const client = await fetchMetadataDocument(clientId);
    if (!client) return null;
    cimdCache.set(clientId, { client, expiresAt: Date.now() + CIMD_CACHE_MS });
    // plan/19 §4.2 — record every CIMD client seen, so the host allowlist can be set from real traffic.
    const docId = `cimd_${createHash("sha256").update(clientId).digest("hex").slice(0, 40)}`;
    await clientsCollection()
      .doc(docId)
      .set({ clientName: client.clientName, clientIdUrl: clientId, redirectUris: client.redirectUris, kind: "cimd", lastSeenAt: new Date().toISOString() }, { merge: true })
      .catch(() => undefined);
    return client;
  }
  const snapshot = await clientsCollection().doc(clientId).get();
  if (!snapshot.exists) return null;
  const data = snapshot.data() as { clientName: string; redirectUris: string[]; kind: "dcr" };
  return { clientId, clientName: data.clientName, redirectUris: data.redirectUris, kind: "dcr" };
}
