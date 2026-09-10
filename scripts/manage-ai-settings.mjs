#!/usr/bin/env node
/**
 * Pre-admin-panel Ollama configuration. `admin/settings` is a single,
 * server-only Firestore doc (Admin SDK only) — the address is a mutable
 * non-secret that changes often, so it lives here rather than an env var
 * that would need a redeploy per change (plan §9.2.1). Until `/admin/ollama`
 * exists (Phase 4.5), this script is the only way to edit it.
 *
 * Usage:
 *   node scripts/manage-ai-settings.mjs show
 *   node scripts/manage-ai-settings.mjs set --enabled=true --baseUrl=https://ollama.example.com \
 *     --model=llama3.1 --maxConcurrent=2 --timeoutMs=90000
 *   node scripts/manage-ai-settings.mjs disable
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_BASE64 in the environment.
 */
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const [, , command, ...rest] = process.argv;
const args = Object.fromEntries(
  rest.map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? true];
  })
);

const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!encoded) {
  console.error("FIREBASE_SERVICE_ACCOUNT_BASE64 is not set. Export it before running this script.");
  process.exit(1);
}

const serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
const app = initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });

const DOC = () => db.collection("admin").doc("settings");

const DEFAULT_CONFIG = {
  enabled: false,
  fallbackModels: [],
  timeoutMs: 90_000,
  maxConcurrent: 2,
  health: { consecutiveFailures: 0 }
};

// Same string checks as lib/ai/ollama-validate.ts — duplicated deliberately (see the
// comment on other scripts/*.mjs files: scripts run outside Next's bundler/path aliases).
function validateBaseUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http:// and https:// are allowed.");
  if (url.protocol === "http:" && process.env.ALLOW_INSECURE_OLLAMA !== "1") {
    throw new Error("http:// requires ALLOW_INSECURE_OLLAMA=1. Use https:// for anything reachable from the internet.");
  }
  const hostname = url.hostname;
  if (hostname === "169.254.169.254" || hostname === "metadata.google.internal") throw new Error(`${hostname} is a cloud metadata address.`);
  if (hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.")) {
    throw new Error(`${hostname} is a loopback address — a Vercel function cannot reach the box it's running on.`);
  }
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (match) {
    const [a, b] = [Number(match[1]), Number(match[2])];
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      throw new Error(`${hostname} is a private address. A Vercel function cannot reach your network — expose the box with a tunnel or a public hostname.`);
    }
  }
  return url.toString().replace(/\/+$/, "");
}

async function show() {
  const snapshot = await DOC().get();
  const ollama = { ...DEFAULT_CONFIG, ...(snapshot.data()?.ollama ?? {}) };
  console.log(JSON.stringify(ollama, null, 2));
}

async function set() {
  const snapshot = await DOC().get();
  const current = { ...DEFAULT_CONFIG, ...(snapshot.data()?.ollama ?? {}) };
  const next = { ...current, updatedAt: new Date().toISOString(), updatedBy: "cli" };
  if (args.enabled !== undefined) next.enabled = args.enabled === "true" || args.enabled === true;
  if (args.baseUrl) next.baseUrl = validateBaseUrl(args.baseUrl);
  if (args.model) next.model = args.model;
  if (args.fallbackModels) next.fallbackModels = args.fallbackModels.split(",").map((m) => m.trim());
  if (args.maxConcurrent) next.maxConcurrent = Number(args.maxConcurrent);
  if (args.timeoutMs) next.timeoutMs = Number(args.timeoutMs);
  await DOC().set({ ollama: next }, { merge: true });
  console.log("Updated admin/settings.ollama:");
  console.log(JSON.stringify(next, null, 2));
}

async function disable() {
  await DOC().set({ ollama: { enabled: false, updatedAt: new Date().toISOString(), updatedBy: "cli" } }, { merge: true });
  console.log("Ollama disabled. The chain now skips straight to Claude/Gemini for every task.");
}

async function main() {
  switch (command) {
    case "show":
      return show();
    case "set":
      return set();
    case "disable":
      return disable();
    default:
      console.error("Usage: node scripts/manage-ai-settings.mjs show|set|disable [--flags]");
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
