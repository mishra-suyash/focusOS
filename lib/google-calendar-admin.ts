import crypto from "node:crypto";
import { calendar_v3, google } from "googleapis";
import { adminDb } from "@/lib/firebase-admin";
import { effectiveCourseStatus } from "@/lib/courses";
import { todayKey } from "@/lib/dates";
import {
  DEFAULT_TIMEZONE,
  checkpointEventDraft,
  courseSessionEventDraft,
  googleEventIdForRefKey,
  hashEventDraft,
  planPushDiff,
  resolvePushEnabled,
  taskEventDraft,
  timedRecurringTemplateEventDraft,
  type GoogleCalendarLinkRecord,
  type GoogleEventDraft
} from "@/lib/google-calendar";
import type { Checkpoint, Course, GoogleCalendarConnection, GoogleCalendarLink, RecurringTaskTemplate, Task } from "@/types";

/**
 * plan/FocusOS-v2-Google-Calendar-Sync-Plan.md §3 — the narrowest scope set that covers Phase 1
 * (push) plus the account email shown in Settings. `email` alone (not `profile`/`openid`) is the
 * minimal scope for that display purpose, and — per the plan's own §3.5 finding — adding it doesn't
 * worsen the Testing-mode 7-day refresh-token expiry, since that's already triggered by the
 * calendar scopes below regardless.
 */
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/userinfo.email"
];

const FOCUSOS_CALENDAR_SUMMARY = "FocusOS";
const STATE_TTL_MS = 10 * 60 * 1000;

function oauthConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google Calendar integration is not configured. Set GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI.");
  }
  return { clientId, clientSecret, redirectUri };
}

function newOAuthClient() {
  const { clientId, clientSecret, redirectUri } = oauthConfig();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Signed `state` param for the OAuth redirect round-trip — ties the callback (which Google calls
 * with no Firebase Authorization header at all) back to the right FocusOS uid, HMAC'd with the
 * OAuth client secret so it can't be forged (plan §10's CSRF callout). Not a JWT/session token:
 * just enough to survive one redirect, expiring after `STATE_TTL_MS`.
 */
export function signOAuthState(uid: string): string {
  const payload = Buffer.from(JSON.stringify({ uid, ts: Date.now() })).toString("base64url");
  const signature = crypto.createHmac("sha256", oauthConfig().clientSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyOAuthState(state: string): string {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) throw new Error("Malformed state.");
  const expected = crypto.createHmac("sha256", oauthConfig().clientSecret).update(payload).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("Invalid state signature.");
  const { uid, ts } = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as { uid: string; ts: number };
  if (Date.now() - ts > STATE_TTL_MS) throw new Error("State expired — try connecting again.");
  return uid;
}

export function buildConsentUrl(uid: string): string {
  const client = newOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    // Forces Google to hand back a refresh_token even on a repeat consent (a first-time consent
    // always returns one; a reconnect after disconnect without this could silently return none).
    prompt: "consent",
    scope: SCOPES,
    state: signOAuthState(uid)
  });
}

// --- Token storage: users/{uid} is NOT this doc's home, deliberately — see
// plan §4.3/§10: a collection the client SDK can never reach, kept entirely outside the
// users/{uid}/** tree so no future blanket "owner can read their own subtree" rule can expose it. ---

function tokenDocRef(uid: string) {
  return adminDb().collection("googleCalendarTokens").doc(uid);
}

async function storeRefreshToken(uid: string, refreshToken: string) {
  await tokenDocRef(uid).set({ refreshToken, updatedAt: new Date().toISOString() });
}

async function getRefreshToken(uid: string): Promise<string | null> {
  const snapshot = await tokenDocRef(uid).get();
  return snapshot.exists ? ((snapshot.data()?.refreshToken as string | undefined) ?? null) : null;
}

export async function deleteStoredRefreshToken(uid: string) {
  await tokenDocRef(uid).delete();
}

// --- Non-secret connection doc: users/{uid}/integrations/googleCalendar (plan §4.2) ---

function connectionDocRef(uid: string) {
  return adminDb().collection("users").doc(uid).collection("integrations").doc("googleCalendar");
}

export async function getConnection(uid: string): Promise<GoogleCalendarConnection | null> {
  const snapshot = await connectionDocRef(uid).get();
  return snapshot.exists ? (snapshot.data() as GoogleCalendarConnection) : null;
}

async function patchConnection(uid: string, patch: Partial<GoogleCalendarConnection>) {
  await connectionDocRef(uid).set({ ...patch, updatedAt: new Date().toISOString() }, { merge: true });
}

/**
 * Handles the OAuth callback: exchanges `code`, stores the refresh token (§4.3), creates the
 * "FocusOS" secondary calendar if this is a first connect, fetches the account email, and writes
 * the connection doc exactly once, as the last step (§4.2's own invariant — never a partially
 * written doc some other read path can dereference into `undefined`).
 */
export async function completeOAuthConnect(code: string, uid: string) {
  const client = newOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token. Disconnect any prior FocusOS grant in your Google Account and try again.");
  }
  client.setCredentials(tokens);

  const [email, focusOsCalendarId] = await Promise.all([
    fetchAccountEmail(client),
    ensureFocusOsCalendar(client, (await getConnection(uid))?.focusOsCalendarId)
  ]);

  await storeRefreshToken(uid, tokens.refresh_token);
  await patchConnection(uid, { connected: true, googleAccountEmail: email, focusOsCalendarId, lastError: undefined });
}

async function fetchAccountEmail(auth: InstanceType<typeof google.auth.OAuth2>): Promise<string | undefined> {
  const oauth2 = google.oauth2({ version: "v2", auth });
  const { data } = await oauth2.userinfo.get();
  return data.email ?? undefined;
}

/** A stored `focusOsCalendarId` can go stale — the user might have deleted that calendar by hand in
 * Google — so a reconnect confirms it still exists (one extra call, only on connect, never on every
 * sync) rather than trusting the stored id and having every subsequent `events.insert` 404 against
 * a calendar that's gone with no recovery path short of manually clearing the field in Firestore. */
async function ensureFocusOsCalendar(auth: InstanceType<typeof google.auth.OAuth2>, existingCalendarId: string | undefined): Promise<string> {
  const calendar = google.calendar({ version: "v3", auth });
  if (existingCalendarId) {
    try {
      await calendar.calendars.get({ calendarId: existingCalendarId });
      return existingCalendarId;
    } catch (error) {
      if (!isGoogleNotFoundError(error)) throw error;
      // Falls through to recreate it below.
    }
  }
  const { data } = await calendar.calendars.insert({ requestBody: { summary: FOCUSOS_CALENDAR_SUMMARY } });
  if (!data.id) throw new Error("Google did not return a calendar id when creating the FocusOS calendar.");
  return data.id;
}

/** Revokes the token with Google (best-effort — proceeds with local cleanup regardless of whether
 * the revoke call itself succeeds, since a user re-revoking an already-invalid token shouldn't
 * block disconnecting locally) and clears local state. Deliberately leaves the "FocusOS" Google
 * calendar itself untouched — plan §13, open question 5. */
export async function disconnect(uid: string) {
  const refreshToken = await getRefreshToken(uid);
  if (refreshToken) {
    try {
      const client = newOAuthClient();
      await client.revokeToken(refreshToken);
    } catch {
      // Best-effort — see doc comment above.
    }
  }
  await deleteStoredRefreshToken(uid);
  await patchConnection(uid, { connected: false });
}

async function calendarClientForUser(uid: string) {
  const refreshToken = await getRefreshToken(uid);
  if (!refreshToken) throw new Error("Not connected to Google Calendar.");
  const client = newOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: "v3", auth: client });
}

// --- Push engine (§6) ---

async function fetchActiveCourses(uid: string): Promise<Course[]> {
  const snapshot = await adminDb().collection("users").doc(uid).collection("courses").get();
  const today = todayKey();
  return snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }) as Course)
    .filter((course) => effectiveCourseStatus(course, today) === "active");
}

/** One subcollection read per active course, all in parallel — unbounded concurrency against
 * Firestore, same category of thing plan §11 already names for the Calendar API side of a sync. At
 * the scale this app runs at (one user's own course list, not a multi-tenant fan-out) that's a
 * handful of reads, not a real concern; worth bounding if that assumption ever changes. */
async function fetchCheckpointsForCourses(uid: string, courses: Course[]): Promise<Array<Checkpoint & { courseLabel: string }>> {
  const results = await Promise.all(
    courses.map(async (course) => {
      const snapshot = await adminDb().collection("users").doc(uid).collection("courses").doc(course.id).collection("checkpoints").get();
      const courseLabel = course.code ? `${course.code} · ${course.name}` : course.name;
      return snapshot.docs
        .map((item) => ({ id: item.id, ...item.data() }) as Checkpoint)
        .filter((checkpoint) => checkpoint.status !== "missed")
        .map((checkpoint) => ({ ...checkpoint, courseLabel }));
    })
  );
  return results.flat();
}

async function fetchTimedActiveTemplates(uid: string): Promise<RecurringTaskTemplate[]> {
  const snapshot = await adminDb().collection("users").doc(uid).collection("recurringTaskTemplates").where("active", "==", true).get();
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as RecurringTaskTemplate).filter((template) => Boolean(template.time));
}

/** §6.1 — plain, hand-created tasks only (`seriesId` unset): a generated instance of a timed
 * template would just echo the recurring event `timedRecurringTemplateEventDraft` already pushes
 * for that template, and a generated instance of a non-timed template isn't calendar-shaped work.
 * Also excludes already-`done` tasks — nothing to remind about once it's finished. */
async function fetchPushableTasks(uid: string): Promise<Task[]> {
  const snapshot = await adminDb().collection("users").doc(uid).collection("tasks").get();
  return snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }) as Task)
    .filter((task) => Boolean(task.dueDate) && !task.seriesId && task.status !== "done");
}

async function fetchExistingLinks(uid: string): Promise<GoogleCalendarLinkRecord[]> {
  const snapshot = await adminDb().collection("users").doc(uid).collection("googleCalendarLinks").get();
  return snapshot.docs.map((item) => {
    const link = item.data() as GoogleCalendarLink;
    return { refKey: item.id, googleEventId: link.googleEventId, contentHash: link.contentHash };
  });
}

function buildDesiredEvents(
  courses: Course[],
  checkpoints: Array<Checkpoint & { courseLabel: string }>,
  templates: RecurringTaskTemplate[],
  tasks: Task[],
  pushEnabled: ReturnType<typeof resolvePushEnabled>,
  timezone: string
): GoogleEventDraft[] {
  const drafts: GoogleEventDraft[] = [];

  if (pushEnabled.courseSessions) {
    for (const course of courses) {
      const courseLabel = course.code ? `${course.code} · ${course.name}` : course.name;
      for (const session of course.sessions) {
        drafts.push(
          courseSessionEventDraft({
            courseId: course.id,
            courseLabel,
            dayOfWeek: session.dayOfWeek,
            startTime: session.startTime,
            endTime: session.endTime,
            location: session.location,
            effectiveStartDate: course.startDate,
            timezone
          })
        );
      }
    }
  }

  if (pushEnabled.checkpoints) {
    for (const checkpoint of checkpoints) {
      drafts.push(
        checkpointEventDraft({
          checkpointId: checkpoint.id,
          title: checkpoint.title,
          typeLabel: checkpoint.type.charAt(0).toUpperCase() + checkpoint.type.slice(1),
          courseLabel: checkpoint.courseLabel,
          dueAt: checkpoint.dueAt
        })
      );
    }
  }

  if (pushEnabled.timedCommitments) {
    for (const template of templates) {
      if (!template.time) continue;
      drafts.push(
        timedRecurringTemplateEventDraft({
          templateId: template.id,
          title: template.title,
          location: template.time.location,
          description: template.description,
          daysOfWeek: template.daysOfWeek,
          startTime: template.time.startTime,
          endTime: template.time.endTime,
          cadence: template.cadence,
          anchorDate: template.anchorDate,
          timezone
        })
      );
    }
  }

  if (pushEnabled.tasksWithDueDate) {
    for (const task of tasks) {
      if (!task.dueDate) continue;
      drafts.push(taskEventDraft({ taskId: task.id, title: task.title, dueDate: task.dueDate }));
    }
  }

  return drafts;
}

/**
 * The whole of Phase 1: reconcile the FocusOS calendar to match current, enabled-category FocusOS
 * data. Safe to call as often as needed (manual "Sync now" today; a cron on the same cadence as
 * every other cron once Phase 2 adds pull) — see `planPushDiff`'s own doc comment for why.
 */
export async function runGoogleCalendarPush(uid: string): Promise<{ created: number; updated: number; deleted: number }> {
  const connection = await getConnection(uid);
  if (!connection?.connected || !connection.focusOsCalendarId) {
    throw new Error("Not connected to Google Calendar.");
  }

  const pushEnabled = resolvePushEnabled(connection.pushEnabled);
  const timezone = (await adminDb().collection("users").doc(uid).collection("meta").doc("settings").get()).data()?.timezone ?? DEFAULT_TIMEZONE;

  const courses = await fetchActiveCourses(uid);
  const [checkpoints, templates, tasks, records] = await Promise.all([
    fetchCheckpointsForCourses(uid, courses),
    fetchTimedActiveTemplates(uid),
    // Skipped entirely (not just filtered out later) when the toggle is off — no reason to read
    // every task on every sync for the common case where this category is disabled.
    pushEnabled.tasksWithDueDate ? fetchPushableTasks(uid) : Promise.resolve([]),
    fetchExistingLinks(uid)
  ]);

  const desired = buildDesiredEvents(courses, checkpoints, templates, tasks, pushEnabled, timezone);
  const plan = planPushDiff(desired, records);

  const calendar = await calendarClientForUser(uid);
  const linksCollection = adminDb().collection("users").doc(uid).collection("googleCalendarLinks");
  let created = 0;
  let updated = 0;
  let deleted = 0;

  for (const item of plan) {
    if (item.action === "create") {
      // A deterministic id (googleEventIdForRefKey), not whatever id Google's response happens to
      // return, is what makes this idempotent: if a prior sync crashed after `events.insert`
      // succeeded but before the link doc below got written, this retry computes the exact same id
      // and gets a 409 on an event that already exists — instead of Google minting a second,
      // duplicate event this app has no record of.
      const eventId = googleEventIdForRefKey(item.refKey);
      try {
        await calendar.events.insert({
          calendarId: connection.focusOsCalendarId,
          requestBody: { id: eventId, ...toEventRequestBody(item.draft) }
        });
      } catch (error) {
        if (!isGoogleConflictError(error)) throw error;
        // The 409 only proves an event already exists at this deterministic id — not that its
        // content matches `item.draft`. If the link doc for this refKey was ever lost independently
        // of the Google event (e.g. deleted out from under this collection without also deleting
        // the event), this "create" is really the first sync to notice, and the event could still
        // hold whatever content it had the last time a link *did* exist. Converge it explicitly
        // rather than assuming it's already right — the same call the "update" branch below makes.
        await calendar.events.update({
          calendarId: connection.focusOsCalendarId,
          eventId,
          requestBody: toEventRequestBody(item.draft)
        });
      }
      await linksCollection.doc(item.refKey).set({
        googleEventId: eventId,
        contentHash: hashEventDraft(item.draft),
        updatedAt: new Date().toISOString()
      });
      created += 1;
    } else if (item.action === "update") {
      await calendar.events.update({
        calendarId: connection.focusOsCalendarId,
        eventId: item.googleEventId,
        requestBody: toEventRequestBody(item.draft)
      });
      await linksCollection.doc(item.refKey).set(
        { googleEventId: item.googleEventId, contentHash: hashEventDraft(item.draft), updatedAt: new Date().toISOString() },
        { merge: true }
      );
      updated += 1;
    } else {
      // A 404 here means the event was already removed on Google's side (e.g. the user deleted it
      // by hand) — the link doc is stale either way, so it's still cleaned up below.
      try {
        await calendar.events.delete({ calendarId: connection.focusOsCalendarId, eventId: item.googleEventId });
      } catch (error) {
        if (!isGoogleNotFoundError(error)) throw error;
      }
      await linksCollection.doc(item.refKey).delete();
      deleted += 1;
    }
  }

  return { created, updated, deleted };
}

function toEventRequestBody(draft: GoogleEventDraft): calendar_v3.Schema$Event {
  return {
    summary: draft.summary,
    description: draft.description,
    location: draft.location,
    start: draft.start,
    end: draft.end,
    recurrence: draft.recurrence,
    extendedProperties: { private: { focusOsRef: draft.refKey } }
  };
}

/** 404 (never existed / already deleted) and 410 (existed, now gone — Google favors this for a
 * resource it's actually purged) both mean the same thing to every caller of this helper: treat it
 * as "already not there," not an error. */
function isGoogleNotFoundError(error: unknown): boolean {
  const code = googleErrorCode(error);
  return code === 404 || code === 410;
}

function isGoogleConflictError(error: unknown): boolean {
  return googleErrorCode(error) === 409;
}

function googleErrorCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "code" in error ? (error as { code?: number }).code : undefined;
}

/** Runs the push and records the outcome on the connection doc — the one place both the manual
 * "Sync now" route and (from Phase 2 on) the cron route call into, so they can't drift apart. */
export async function runGoogleCalendarSync(uid: string): Promise<{ created: number; updated: number; deleted: number }> {
  try {
    const result = await runGoogleCalendarPush(uid);
    await patchConnection(uid, { lastPushAt: new Date().toISOString(), lastError: undefined });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed.";
    // invalid_grant is Google's error when the user revoked access outside this app (plan §10) —
    // surfaced distinctly so Settings can tell the user to reconnect rather than just "try again".
    const revoked = message.toLowerCase().includes("invalid_grant");
    // `connected: undefined` when not revoked leaves the field untouched — `patchConnection`'s
    // `.set(..., {merge: true})` runs through `adminDb()`'s `ignoreUndefinedProperties: true`
    // (lib/firebase-admin.ts), so an `undefined` field is omitted from the write entirely rather
    // than erroring or overwriting the stored value, unlike the client SDK elsewhere in this repo
    // which needs its own `withoutUndefined` helper to get the same behavior.
    await patchConnection(uid, {
      connected: revoked ? false : undefined,
      lastError: revoked ? "Google access was revoked — reconnect to resume syncing." : message
    });
    throw error;
  }
}
