#!/usr/bin/env node
/**
 * Enables the Email/Password (+ email-link passwordless), and Anonymous sign-in
 * providers on the Firebase project via the Identity Platform Admin API — the
 * same three toggles you'd otherwise flip by hand in the Firebase console under
 * Authentication > Sign-in method. Google must still be enabled manually there
 * (it needs a support email chosen interactively).
 *
 * Usage: node scripts/enable-auth-providers.mjs
 * Requires FIREBASE_SERVICE_ACCOUNT_BASE64 in the environment.
 */
import { GoogleAuth } from "google-auth-library";

const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!encoded) {
  console.error("FIREBASE_SERVICE_ACCOUNT_BASE64 is not set. Export it before running this script.");
  process.exit(1);
}

const serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
const auth = new GoogleAuth({ credentials: serviceAccount, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const projectId = serviceAccount.project_id;

async function main() {
  const token = await auth.getAccessToken();
  const updateMask = ["signIn.email.enabled", "signIn.email.passwordRequired", "signIn.anonymous.enabled"].join(",");
  const url = `https://identitytoolkit.googleapis.com/admin/v2/projects/${projectId}/config?updateMask=${encodeURIComponent(updateMask)}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      signIn: {
        // passwordRequired: false allows *both* password and email-link sign-in on the
        // same "email" provider — true would make email-link sign-in fail outright.
        email: { enabled: true, passwordRequired: false },
        anonymous: { enabled: true }
      }
    })
  });
  const data = await response.json();

  if (response.ok) {
    console.log("Enabled: Email/Password, Email link (passwordless), and Anonymous sign-in.");
    console.log("Google sign-in still needs to be enabled manually in the Firebase console (it requires picking a support email interactively).");
  } else if (data.error?.status === "PERMISSION_DENIED") {
    console.error(
      "Permission denied. The service account needs the \"Firebase Authentication Admin\" (or Editor/Owner) IAM role on this GCP project. " +
        "Grant it in the Cloud Console, or enable these providers by hand: Firebase console > Authentication > Sign-in method > " +
        "enable Email/Password (with the \"Email link (passwordless sign-in)\" toggle on) and Anonymous."
    );
  } else {
    console.error("Failed to update sign-in config:", data.error ?? data);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
