#!/usr/bin/env tsx
/**
 * CLI for admin-published templates (plan §7.3) — a thin wrapper over
 * `lib/admin-templates.ts`, the same module `/api/admin/templates/**` calls.
 * Unlike the older `manage-tiers.mjs`/`manage-phase*.mjs` scripts (plain
 * `.mjs`, no TS loader available at the time), this one runs via `tsx` and
 * imports the real admin logic directly — so this script and the API routes
 * can never drift.
 *
 * Usage:
 *   tsx scripts/manage-templates.ts list [--kind=day] [--status=published]
 *   tsx scripts/manage-templates.ts publish --id=<templateId> --actorUid=<uid> --actorEmail=<email>
 *   tsx scripts/manage-templates.ts archive --id=<templateId> --actorUid=<uid> --actorEmail=<email>
 *   tsx scripts/manage-templates.ts import --dayTemplateId=<id> --actorUid=<uid> --actorEmail=<email>
 *   tsx scripts/manage-templates.ts my-day-templates --actorUid=<uid>
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_BASE64 in the environment. --actorUid
 * should be an owner/admin account — this script does not re-check the
 * caller's role the way the API routes' verifyAdminRequest does, so treat it
 * the same as direct Firestore/Admin-SDK access.
 */
import {
  archiveTemplate,
  importFromOwnDayTemplate,
  listAdminTemplates,
  listOwnDayTemplates,
  publishTemplate
} from "../lib/admin-templates";
import type { TemplateKind, TemplateStatus } from "../lib/templates/schema";

const [, , command, ...rest] = process.argv;
const args = Object.fromEntries(
  rest.map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? true];
  })
) as Record<string, string | true>;

function requireActor(): { uid: string; email: string } {
  const uid = args.actorUid;
  const email = args.actorEmail;
  if (typeof uid !== "string" || typeof email !== "string") {
    console.error("--actorUid and --actorEmail are required for this command.");
    process.exit(1);
  }
  return { uid, email };
}

function printUsage() {
  console.error(
    [
      "Usage:",
      "  tsx scripts/manage-templates.ts list [--kind=day] [--status=published]",
      "  tsx scripts/manage-templates.ts publish --id=<templateId> --actorUid=<uid> --actorEmail=<email>",
      "  tsx scripts/manage-templates.ts archive --id=<templateId> --actorUid=<uid> --actorEmail=<email>",
      "  tsx scripts/manage-templates.ts import --dayTemplateId=<id> --actorUid=<uid> --actorEmail=<email>",
      "  tsx scripts/manage-templates.ts my-day-templates --actorUid=<uid>"
    ].join("\n")
  );
}

async function run() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    console.error("FIREBASE_SERVICE_ACCOUNT_BASE64 is not set. Export it before running this script.");
    process.exit(1);
  }

  switch (command) {
    case "list": {
      const templates = await listAdminTemplates();
      const kind = args.kind as TemplateKind | undefined;
      const status = args.status as TemplateStatus | undefined;
      const filtered = templates.filter((t) => (!kind || t.kind === kind) && (!status || t.status === status));
      for (const t of filtered) console.log(`${t.id}  [${t.kind}/${t.status} v${t.version}]  ${t.name}`);
      console.log(`\n${filtered.length} template(s).`);
      break;
    }
    case "publish": {
      if (typeof args.id !== "string") return printUsage();
      await publishTemplate(requireActor(), args.id);
      console.log(`Published ${args.id}.`);
      break;
    }
    case "archive": {
      if (typeof args.id !== "string") return printUsage();
      await archiveTemplate(requireActor(), args.id);
      console.log(`Archived ${args.id}.`);
      break;
    }
    case "import": {
      if (typeof args.dayTemplateId !== "string") return printUsage();
      const id = await importFromOwnDayTemplate(requireActor(), args.dayTemplateId);
      console.log(`Published as template ${id}.`);
      break;
    }
    case "my-day-templates": {
      const actor = requireActor();
      const templates = await listOwnDayTemplates(actor);
      for (const t of templates) console.log(`${t.id}  ${t.name}  (${t.slots.length} slots)`);
      console.log(`\n${templates.length} day template(s).`);
      break;
    }
    default:
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
