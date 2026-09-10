import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

let app: App | null = null;

function loadServiceAccount() {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!encoded) return null;
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
}

function getAdminApp() {
  if (app) return app;
  if (getApps().length) {
    app = getApps()[0];
    return app;
  }
  const serviceAccount = loadServiceAccount();
  if (!serviceAccount) return null;
  app = initializeApp({ credential: cert(serviceAccount) });
  return app;
}

export function adminAuth() {
  const instance = getAdminApp();
  if (!instance) throw new Error("Firebase Admin is not configured. Set FIREBASE_SERVICE_ACCOUNT_BASE64.");
  return getAuth(instance);
}

let firestoreSettingsApplied = false;

export function adminDb() {
  const instance = getAdminApp();
  if (!instance) throw new Error("Firebase Admin is not configured. Set FIREBASE_SERVICE_ACCOUNT_BASE64.");
  const db = getFirestore(instance);
  if (!firestoreSettingsApplied) {
    try {
      // Several admin-side writers (e.g. lib/admin-ollama-settings.ts) build patches with
      // optional fields left `undefined` rather than omitted; without this, the Admin SDK
      // throws "Cannot use 'undefined' as a Firestore value" the first time that path runs.
      db.settings({ ignoreUndefinedProperties: true });
    } catch (error) {
      // Dev-mode hot reload resets this module's `firestoreSettingsApplied` flag while
      // firebase-admin's own app/Firestore singletons (getApps()) survive the reload —
      // so a later request can land here after settings() already ran once. That's the
      // one error this call can throw at this point, so it's safe to swallow.
      if (!(error instanceof Error) || !error.message.includes("already been initialized")) throw error;
    }
    firestoreSettingsApplied = true;
  }
  return db;
}
