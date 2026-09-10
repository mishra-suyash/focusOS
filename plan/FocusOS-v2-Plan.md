# FocusOS v2 — Implementation Plan & Build Spec

**Target:** upgrade the existing FocusOS (Next.js + Firestore + Vercel) into a course/paper/goal system per the handwritten specs.
**Deployment target:** Vercel **Hobby (free)** + Firebase **Spark (free)**. Every decision below is constrained by that.
**Status of this document:** it is both the plan and the prompt. Hand it to a coding agent one phase at a time.

---

## 0. How to use this document

Companion documents:
- **`FocusOS-v2-Admin-Panel.md`** — Phase 4.5: users, roles, quotas, runtime switches, audit log.
- **`FocusOS-v2-Focus-Design.md`** — the behavioural changes that decide whether this gets used in month three. Read it before picking what to build.

1. Read §1–§5 first. They contain the hard constraints and the decisions that everything else depends on.
2. Build in the phase order in §12. Do not start a phase until the previous phase's acceptance criteria pass.
3. Rules for the coding agent:
   - **Never** add a dependency without stating why in the PR description. The bundle and the function size are budgets, not suggestions.
   - **CPU-heavy work runs in the browser**, not in a Vercel function (see §3.4).
   - **Every AI feature must degrade to a deterministic rule-based fallback.** The app must be fully usable with zero API keys configured.
   - **Every Firestore listener must be bounded** (`where` + `orderBy` + `limit`). No unbounded `onSnapshot` on a collection.
   - Prefer deleting code to adding a flag.

---

## 1. What the new specs actually ask for

Decoded from the handwritten notes, grouped:

| # | Requirement | Where it lands |
|---|---|---|
| C1 | Log every class: attendance + topics covered | §7.2 Class logs |
| C2 | Regular "look back" / revision on covered topics, indefinitely | §7.3 Revision engine |
| C3 | A course has multiple checkpoints: quiz, lab, assignment, end-sem | §7.4 Checkpoints |
| C4 | Some checkpoints need prep, some don't | §7.4 `requiresPrep` + prep ladder |
| C5 | Attach PDFs (question papers etc.) to each checkpoint | §7.4 + §6 Files |
| C6 | Schedule revisions ahead of quizzes/exams | §7.3 pull-forward |
| C7 | A course has a duration and ends; sometimes there is no course at all | §7.1 Terms + Break mode |
| P1 | 3-pass reading technique with per-pass tracking | §8.2 |
| P2 | Notes per paper, options to extend | §8.3 |
| P3 | Club papers together for revision | §8.4 Paper groups |
| P4 | AI analyses the paper, takes the user's *reading goal* as input | §8.5 `paper.readingPlan` |
| P5 | AI generates layered notes from PDF + my notes, reusable as future context | §8.6 Layered Notes |
| P6 | Turn the paper PDF into an annotated (highlighted/boxed) PDF | §8.7 Annotation pipeline |
| G1 | Local model (Ollama) + Claude/Gemini, with fallbacks | §9.1–9.3 |
| G2 | AI consults on data, classifies actions Critical / Important / General | §9.4 Triage |
| G3 | End of day: improvements + next-day plan + suggested todos | §10.1 Evening loop |
| G4 | An index that shows doing more/less than required, with alerts | §10.2 **Load Index** |
| G5 | Global checkpoints (goals) spanning sem breaks | §11.1 Goals |
| G6 | External one-time tasks | §11.2 |

---

## 2. Platform constraints (verified, Sept 2026)

These are the numbers the design must respect. Verify before launch; they change.

### 2.1 Vercel Hobby

| Limit | Value | Consequence for FocusOS |
|---|---|---|
| Function max duration | 300 s (default and max, with Fluid compute) | Long AI jobs must still be chunked — see §9.6 |
| Function memory | 2 GB / 1 vCPU | Don't rasterize PDFs server-side |
| **Request/response body** | **4.5 MB hard** | **PDFs can never be POSTed through an API route.** Client → Blob direct upload only |
| Function invocations | 1 M/month | Not a concern |
| Active CPU | 4 CPU-hours/month | **Is** a concern if PDF/text processing goes server-side |
| Bundle size | 250 MB uncompressed | Fine, but don't bundle `pdfjs` into a server route |
| Cron jobs | 100 per project, **once per day each**, ±59 min, **UTC only** | Two daily crons max cadence; UI must never assume the cron already ran |
| Runtime logs | 1 hour / 4000 rows | Write your own error log to Firestore |
| Region | single region, default `iad1`, changeable | **Set to `bom1`** (Mumbai) for Chennai latency |
| Blob storage | 1 GB/month, 10 GB transfer, 10k simple ops, **2k advanced ops (uploads)** | Enough for a few hundred PDFs. Needs a quota guard |
| Licence | non-commercial personal use only | Fine for this use case |

Exceeding a Hobby limit pauses the feature for the rest of the 30-day window — it does not bill you and does not delete anything, but the app must fail gracefully.

### 2.2 Firebase Spark

| Limit | Value | Consequence |
|---|---|---|
| Firestore storage | 1 GiB | Fine for text; **do not** store PDF bytes in Firestore |
| Firestore reads | 50,000/day | Bounded queries + merged daily docs (§5.2) |
| Firestore writes | 20,000/day | Debounce; no per-keystroke or per-drag writes |
| Auth | 50k MAU | Fine |
| **Cloud Storage** | **Not available on Spark since 3 Feb 2026** — buckets require a linked billing account (Blaze) | **Blocker.** See §3.1 |

### 2.3 Claude API (for PDF work)

- Max request size **32 MB**; max **100 pages** per request at standard context (600 at 1M-token context). Both limits apply to the *whole* payload.
- Use the **Files API** (`files-api-2025-04-14` beta header) to upload a PDF once and reference it by `file_id` on later calls — this avoids re-encoding a 5 MB paper into every request and keeps you under the payload limit.
- Cost model: roughly 1,500–3,000 tokens per PDF page. A 12-page paper is ~25k tokens of input per call. Budget accordingly (§9.5).
- Files API storage: 500 MB per file, 100 GB per organisation.

### 2.4 Reaching a shared Ollama box — server-side only

**Decision: all model calls, Ollama included, are made from the backend.** The browser never talks to a model endpoint.

This is the right call for a multi-user app, and not only for tidiness. Browser-direct calls to a LAN address would have worked *only for users physically on that network* — everyone else would have seen a silently unavailable provider they couldn't fix. It also would have been Chrome and Edge only, needed a per-user permission prompt, needed `OLLAMA_ORIGINS`, and broken on mobile. Server-side removes all of that: no mixed content, no Local Network Access permission, no CORS, no browser feature detection, one code path.

**The consequence you have to design around: the box must be reachable from Vercel's datacentre.**

A Vercel function is in `bom1`, not on your network. It cannot reach `192.168.x.x`, `10.x.x.x` or a `.local` name — those will fail with a timeout, not an error you can debug from the app. So the endpoint must be publicly routable, and that means it must be protected, because raw Ollama on an open port lets anyone use your GPU and call destructive endpoints (`/api/delete`, `/api/pull`). Internet-wide scans routinely find six figures of exposed Ollama servers; don't add one.

**You cannot solve this with a firewall IP allowlist.** Vercel Hobby deployments have dynamic egress IPs — static IPs and Secure Compute are Pro/Enterprise features. There is no set of addresses to allow. Authentication has to happen at the application layer, with a bearer token.

Ranked ways to expose it safely:

| Option | Public address | Auth | Port forwarding | Handles changing IP |
|---|---|---|---|---|
| **Cloudflare Tunnel** (free) | stable `https://` hostname | Cloudflare Access, or your own token | **None** — outbound only | Yes, completely |
| Tailscale Funnel | stable `https://` hostname | built in | None | Yes |
| DDNS + Caddy/nginx + Let's Encrypt | stable hostname | bearer token you configure | Yes | Yes |
| Raw public IP + reverse proxy | changes | bearer token | Yes | Only via the heartbeat (§9.2.2) |

**Recommendation: Cloudflare Tunnel.** Ollama stays bound to `127.0.0.1` on the box, the tunnel daemon makes an outbound connection, and you get a stable HTTPS hostname with no inbound firewall hole and no port forwarding. It also makes the changing-IP problem disappear rather than managing it. Keep the editable address field and the heartbeat anyway — they cost little and cover moving the box or switching approach.

**What this costs on the free tier.** Every local-model call now occupies a Vercel function for its full duration. Two limits apply and neither is close: waiting on I/O does **not** count toward the 4 CPU-hours of Active CPU, but provisioned memory time does accrue — 360 GB-hrs ÷ 2 GB = roughly **180 hours of wall-clock function time per month**. At 30 s per generation that's ~21,000 calls; at a slow 120 s it's ~5,400. Fine for a handful of users, but it means a slow local model is no longer free in the way a browser-direct call would have been.

**Unchanged:** the provider chain treats local as optional, probes it, and silently falls through. No feature may depend on it.

---

## 3. Decisions forced by the constraints

### 3.1 PDF storage → **Vercel Blob**, not Firebase Storage

Firebase Cloud Storage now requires a billing account even for zero usage. Vercel Blob gives 1 GB on Hobby with no card.

- Upload path: **client upload** via `@vercel/blob/client` `upload()` + a `/api/files/upload-token` handler. This uploads browser → Blob directly, so the 4.5 MB function body limit never applies.
- Store only metadata in Firestore (`files/{fileId}`).
- Enforce a **20 MB per-file cap** client-side (Claude's request ceiling) and a **soft 800 MB account cap** with a warning banner.
- Offer **link-only mode** for papers you don't need stored (just a DOI/URL) — this is the default for anything you can re-download.
- *Documented alternative:* if you later want more room, Firebase Storage on Blaze with a US region bucket stays at $0 within Google's Always-Free 5 GB, but requires a card and a budget alert. Not the default.

### 3.2 Two daily crons, and the UI never depends on them

- `/api/cron/morning-brief` — `30 0 * * *` UTC = ~06:00 IST
- `/api/cron/evening-rollup` — `30 16 * * *` UTC = ~22:00 IST

Hobby fires these ±59 minutes and only once per day. Therefore: **every cron output is also generatable on demand.** If the brief for today is missing when you open the dashboard, the page offers a "Generate now" button rather than showing an empty state.

### 3.3 Cron must not loop over all users

The current `/api/cron/daily-insight` iterates every `users/{uid}` document, i.e. every account that ever signed in, and spends API credits on each. Since v2 is multi-user, the fix isn't a single-owner allowlist — it's a filtered query: `where('status','==','active').where('aiEnabled','==',true)`, plus a per-user budget check inside the loop, plus a global kill switch (§Admin doc). An anonymous account that signed in once is `status: 'invited'` at best and never reaches the loop. Also remove anonymous sign-in entirely (§4).

The cron must also be **resumable**: with N users it can exceed 300 s. Process in batches, record a cursor, and let the next invocation (or an on-demand trigger) continue. Never let user #9's brief depend on user #3's model call succeeding.

### 3.4 CPU-heavy work runs in the browser

Hobby gives 4 CPU-hours/month. PDF parsing, text-layer extraction, coordinate matching, annotation baking and export all run client-side with `pdf.js` + `pdf-lib`. Vercel functions only: hold secrets, call model APIs, verify tokens, run crons.

### 3.5 Long AI calls become jobs, not requests

Even with 300 s available, a 3-pass analysis of a 30-page paper can exceed it and any timeout loses all work. Use a job document (§9.6): the route writes partial results as it goes; the client polls; a resumed job skips completed steps.

---

## 4. What gets cut

Removing these is part of the plan, not optional cleanup. Each one either duplicates something in v2, burns free-tier quota, or is a maintenance cost with no payoff.

| Cut | Why | Migration |
|---|---|---|
| **Thoughts + thought selections + "Thought of the day"** | Two collections, a hash-based selection that changes when the list changes, a favourite flag with no view. Zero relation to the new specs. | Export to JSON, delete collections. If you want a daily line, put a static array in a config file. |
| **Anonymous / guest sign-in** | Guest auth creates orphan `users/{uid}` docs with no email, which can't be managed, invited, budgeted or contacted — meaningless in a multi-user app with roles. | Google-only + role claims + a signup mode (closed / invite / open) set in the admin panel. |
| **`dailyPlans` "Top 3 priorities"** | A third parallel notion of "important thing" next to tasks and goals, with no enforcement that a priority is a real task. | Replace with `pinnedTaskIds` on the day doc; the dashboard shows up to 3 pinned tasks. |
| **Separate `dailyNotes`, `dailyReviews`, `workdaySessions`, `dailyPlans`** | Four documents keyed by the same date = 4 reads to render one day. | Merge into one `days/{yyyy-MM-dd}` document (§5.2). |
| **`courseAssignments`** | An assignment is just a checkpoint with `type: 'assignment'`. | Migrate into `checkpoints`. |
| **`weeklyGoals` three-bucket planner** | Duplicates tasks and goals; the shared-input UI is a known usability trap. | Migrate into `goals` with `horizon: 'week'`, or into tasks. Delete the page. |
| **Papers progress slider** | Fires a Firestore write per drag tick, and "37% read" means nothing. | Progress derives from pass completion: 0 / 33 / 66 / 100. |
| **"Sample" template button** | Creates a duplicate template on every click. | Remove; add an explicit `isDefault` flag on `dayTemplates` (fixes the "most recently created template wins" surprise too). |
| **Pomodoro sound toggle** | It's a placeholder that plays nothing. | Either implement with a 3-line Web Audio oscillator or delete the icon. Do not ship a fake control. |
| **`AI_PROVIDER` global env switch** | v2 routes per task, not per deployment. | Replaced by the task registry (§9.3). |
| **MCP server** *(recommendation, your call)* | A second auth path, a second build, read-only, and it bypasses Firestore rules with a service account. v2's own AI layer covers the same ground. | If you keep it, freeze it: no new tools, and point it at the merged `days/` schema. Otherwise delete the workspace and rely on the JSON export. |

**Fixed, not cut:** the `/analytics` "Last 7 days" label that actually shows lifetime totals; the weekly review's "average focus rating" that averages every review ever written. Both become genuinely windowed.

---

## 5. Data model

All under `users/{uid}`. Firestore doc limit is 1 MiB — none of these come close.

### 5.1 Collection map

```text
users/{uid}
  settings                                  (single doc: prefs, reminder intervals, AI config, load targets)
  usage/{yyyy-MM}                           (ai tokens, blob bytes, request counts)

  terms/{termId}
  courses/{courseId}
  courses/{courseId}/classLogs/{yyyy-MM-dd}
  courses/{courseId}/checkpoints/{checkpointId}
  topics/{topicId}                          (flat; cross-course; the unit of revision)

  revisionItems/{itemId}
  revisionSessions/{yyyy-MM-dd}             (one doc/day: what was reviewed, grades, minutes)

  papers/{paperId}
  papers/{paperId}/artifacts/{artifactId}   (layeredNotes | annotations | readingPlan)
  papers/{paperId}/notes/{noteId}
  paperGroups/{groupId}

  goals/{goalId}
  tasks/{taskId}                            (includes one-off external tasks)

  days/{yyyy-MM-dd}                         (MERGED: note, review, workday session, pinned tasks, loadIndex, brief)
  weeks/{yyyy-Www}                          (weekly review + rollup)
  dailySchedules/{yyyy-MM-dd}
  dayTemplates/{templateId}
  pomodoroSessions/{sessionId}

  files/{fileId}                            (blob metadata + anthropic file_id cache)
  aiJobs/{jobId}                            (long-running task state)
  aiRuns/{runId}                            (audit: task, provider, model, tokens, ms, ok)
  alerts/{alertId}                          (deduped, severity-tagged)
```

### 5.2 The merged `days/{date}` document

The single biggest read-cost win. One read renders the whole day.

```ts
type Day = {
  date: string;                      // yyyy-MM-dd, doc id
  session?: { startedAt, endedAt?, hydrationCount, breaksTaken, lastHydrationAt?, lastBreakPromptAt? };
  pinnedTaskIds: string[];           // replaces "top 3 priorities"
  scratchpad?: string;               // replaces dailyNotes
  review?: {                         // replaces dailyReviews
    done?: string; blocked?: string; carryForward?: string;
    focusRating?: 1|2|3|4|5; energyRating?: 1|2|3|4|5;
    submittedAt?: Timestamp;
  };
  loadIndex?: LoadIndexSnapshot;     // §10.2, written at rollup
  brief?: AiDailyBrief;              // morning cron or on-demand
  rollup?: AiEveningRollup;          // evening cron or on-demand
  updatedAt: Timestamp;
};
```

### 5.3 Terms and courses

```ts
type Term = {
  id: string;
  name: string;                      // "Sem 3", "Winter break 2026"
  kind: 'semester' | 'break' | 'none';
  startDate: string; endDate: string;
  // during kind !== 'semester', the planner reallocates course time to goals+papers (§7.1)
};

type Course = {
  id: string;
  termId: string;
  name: string; code?: string; instructor?: string;
  status: 'active' | 'completed' | 'dropped';
  startDate: string; endDate: string;         // endDate defaults to term.endDate
  sessions: { dayOfWeek: 0-6; startTime: 'HH:mm'; endTime: 'HH:mm'; location?: string }[];
  targetMinutesPerWeek?: number;              // feeds the Load Index "required"
  colour?: string;
};
```

`status` is derived on read from `endDate` — a course past its end date shows as completed without a manual edit. Class blocks stop being generated after `endDate`.

### 5.4 Class logs and topics

```ts
type ClassLog = {
  id: string;                        // yyyy-MM-dd
  courseId: string; date: string;
  attendance: 'attended' | 'missed' | 'cancelled' | 'self_study';
  topicIds: string[];                // created/linked at save time
  rawTopics?: string;                // what you typed, before splitting
  understanding?: 1|2|3|4|5;         // drives initial revision interval
  notes?: string;
  fileIds?: string[];                // slides, handouts
  durationMin?: number;
};

type Topic = {
  id: string;
  courseId: string; title: string;
  firstSeenDate: string; classLogIds: string[];
  confidence: 1|2|3|4|5;             // latest self-rating
  revisionItemId?: string;
  status: 'active' | 'retired';
};
```

Splitting `rawTopics` into topics is the first AI task with a rule-based fallback: split on newline/semicolon/comma if no model is available.

**Missed classes matter.** `attendance: 'missed'` creates topics with `confidence: 1` and a catch-up task, not nothing.

### 5.5 Checkpoints

```ts
type Checkpoint = {
  id: string; courseId: string;
  type: 'quiz' | 'lab' | 'assignment' | 'midsem' | 'endsem' | 'presentation' | 'other';
  title: string;
  dueAt: string;                     // ISO datetime
  weightPct?: number;
  requiresPrep: boolean;             // C4 — explicit, defaulted by type
  prepLeadDays: number;
  prepEstimateMin: number;
  topicIds: string[];                // revision scope; empty = all course topics since last checkpoint
  fileIds: string[];                 // C5 — past question papers, rubrics, spec sheets
  status: 'upcoming' | 'prepping' | 'submitted' | 'done' | 'missed';
  result?: { score: number; max: number; notes?: string };
};
```

Defaults by type (editable in settings):

| Type | requiresPrep | prepLeadDays | prepEstimateMin |
|---|---|---|---|
| quiz | true | 3 | 90 |
| lab | false | 2 | 60 |
| assignment | false | 5 | 180 |
| midsem | true | 10 | 600 |
| endsem | true | 21 | 1500 |
| presentation | true | 7 | 240 |

`requiresPrep: false` means no prep blocks and no pull-forward — the checkpoint still appears on the calendar and in alerts.

### 5.6 Revision items

```ts
type RevisionItem = {
  id: string;
  kind: 'topic' | 'paper' | 'paperGroup' | 'checkpoint';
  refId: string; courseId?: string; title: string;
  ladderIndex: number;               // index into settings.revisionLadder
  intervalDays: number;
  dueDate: string;                   // yyyy-MM-dd — the query key
  lastReviewedAt?: string;
  reps: number; lapses: number;
  suspended: boolean; retiredAt?: string;
};
```

### 5.7 Papers

```ts
type Paper = {
  id: string;
  title: string; authors: string[]; venue?: string; year?: number;
  doi?: string; url?: string; tags: string[];
  priority: 'low' | 'medium' | 'high';
  goal: string;                      // P4 — free text: why am I reading this
  goalKind: 'survey' | 'method' | 'baseline' | 'related-work' | 'reproduce' | 'critique';
  fileId?: string;                   // Blob PDF, optional (link-only mode)
  passes: Record<1|2|3, PassState>;
  progress: 0|33|66|100;             // derived, not stored by a slider
  status: 'to_read' | 'reading' | 'read' | 'archived';   // derived from passes
  groupIds: string[];
  revisionItemId?: string;
  createdAt; updatedAt;
};

type PassState = {
  status: 'not_started' | 'in_progress' | 'done' | 'skipped';
  startedAt?; completedAt?; minutes?: number;
  output?: Pass1Output | Pass2Output | Pass3Output;
};
```

### 5.8 Goals and files

```ts
type Goal = {
  id: string; title: string;
  horizon: 'week' | 'term' | 'break' | 'year' | 'phd';
  termId?: string;                   // G5 — a goal can be scoped to a sem break
  why?: string; definitionOfDone: string;
  milestones: { id: string; title: string; dueAt?: string; done: boolean }[];
  linked: { courseIds: string[]; paperIds: string[]; taskIds: string[]; goalIds: string[] };
  targetHoursPerWeek?: number;       // feeds Load Index
  status: 'active' | 'paused' | 'achieved' | 'dropped';
  reviewCadence: 'weekly' | 'monthly';
  lastReviewedAt?: string;
};

type FileRef = {
  id: string; url: string; pathname: string;
  kind: 'paper' | 'question_paper' | 'slides' | 'handout' | 'other';
  bytes: number; contentType: string;
  linkedTo: { type: 'paper'|'checkpoint'|'classLog'|'course'; id: string };
  anthropicFileId?: string;          // cached Files API id
  anthropicUploadedAt?: string;
  uploadedAt: Timestamp;
};
```

**External one-time tasks (G6)** are ordinary tasks with `kind: 'external'`, `oneOff: true`, a hard `dueAt`, and `reminderLeadDays: number[]` (e.g. `[7, 2, 0]`). No new collection.

---

## 6. Files subsystem

1. Client picks a file → validate `type === application/pdf`, `bytes <= 20 MB`, and check `usage/{yyyy-MM}.blobBytes` against the 800 MB soft cap.
2. `upload()` from `@vercel/blob/client` with `handleUploadUrl: '/api/files/upload-token'`. The route verifies the Firebase ID token, scopes the pathname to `u/{uid}/{kind}/{nanoid}.pdf`, and returns a client token. **The bytes never touch a function.**
3. `onUploadCompleted` (or a client callback) writes `files/{fileId}` and increments `usage`.
4. When a file first needs a model: `POST /api/files/{id}/ingest` fetches the blob server-side, uploads it to the Anthropic Files API, caches `anthropicFileId` on the doc. Later calls send the id, not the bytes.
5. Deleting a file deletes the blob, the Firestore doc, and decrements usage.

Guard rails: reject non-PDF; detect a missing text layer (scanned PDF) at render time and disable the annotation features for that file with an explicit message rather than producing garbage.

---

## 7. Courses subsystem

### 7.1 Terms and break mode (C7)

Every course belongs to a term. The active term is determined by today's date.

- **`kind: 'semester'`** — normal behaviour.
- **`kind: 'break'` or no active term** — no class blocks are generated. The day planner's default template switches to `settings.breakTemplateId`. The Load Index's "required" is computed from goals and papers only. The dashboard swaps the "Today's classes" panel for "Break focus": active break-scoped goals and the paper queue.

This is what "sometimes I won't have a course, that should be integrated" means in practice: the system doesn't show empty course widgets for two months, it reallocates.

### 7.2 Class logging (C1)

Entry points: a "Log class" button on any `class` slot in the day planner, on the course page, and in the evening rollup ("you had 2 classes today, 1 unlogged").

The log form is deliberately 15 seconds of work: attendance toggle, a topics textarea, a 1–5 understanding dial, optional notes/files. On save:

1. Split topics into `Topic` docs (AI task `course.splitTopics`, fallback: split on newlines/semicolons).
2. Create one `RevisionItem` per new topic, with the starting interval set by `understanding`: 5 → ladder index 2, 3 → index 1, 1 → index 0 (i.e. due tomorrow).
3. Update course coverage stats.

Batch all of it in one `writeBatch`.

### 7.3 Revision engine (C2, C6)

**Ladder** (`settings.revisionLadder`, default `[1, 3, 7, 16, 35, 70]` days). Modified Leitner, deterministic, computed client-side — no server, no cron dependency.

On review, grade the item:

| Grade | Effect |
|---|---|
| Again | `ladderIndex = 0`, `lapses++`, due tomorrow |
| Hard | `ladderIndex` unchanged, due `intervalDays` out |
| Good | `ladderIndex++` |
| Easy | `ladderIndex += 2` |

Past the end of the ladder the item is `retired` but stays queryable — "Regular Look Back ∞" is served by a **resurfacing rule**: retired items become eligible again at 180 days with a `low` priority, capped at 3 per day.

**Daily cap.** `settings.maxRevisionsPerDay` (default 20) and `maxRevisionMinutesPerDay` (default 45). Overflow does not pile up invisibly — it rolls forward *and* raises the Load Index backlog term, which is what triggers the alerts in §10.2.

**Checkpoint pull-forward (C6).** When a checkpoint with `requiresPrep` is within `prepLeadDays`:

- Items whose `topicIds` intersect the checkpoint scope get `prepBoost = true` and sort to the front of today's queue.
- Their `dueDate` is **not** mutated — the pull-forward is a computed view, so cancelling or moving a checkpoint doesn't corrupt the spacing history.
- The engine spreads the scope across the remaining days: `ceil(scopeSize / daysRemaining)` items per day, plus the normal queue, clipped by the daily cap. If it doesn't fit, that is a **Critical** alert on day one of the window, not a surprise on the last night.

**Query cost.** One bounded query per day: `where('dueDate','<=',today).where('suspended','==',false).orderBy('dueDate').limit(100)`. Requires a composite index; add it to `firestore.indexes.json`.

### 7.4 Checkpoints (C3, C4, C5)

- Checkpoints appear on the calendar, the dashboard "next up" strip, and the course page.
- `requiresPrep: true` generates **prep blocks** — schedule slots of `type: 'prep'` on the days in the lead window, sized to `prepEstimateMin` spread over available free slots. These are proposals: they land in the day plan as `status: 'proposed'` and you accept or dismiss them.
- Attached question papers (C5) unlock `checkpoint.prepPlan` (§9.3): the model reads the past paper plus the topic list and returns a weighted topic priority, likely question formats, and a prep checklist. Fallback with no model: a plain checklist of the scope topics ordered by lowest confidence.
- After the checkpoint, a one-field outcome capture (`score/max`) feeds back: topics in a checkpoint you scored under 60% on get `ladderIndex` knocked back by 1.

---

## 8. Papers subsystem

### 8.1 Reading goal first (P4)

A paper cannot enter `reading` without a `goal` and `goalKind`. This is the single highest-leverage field in the subsystem — it conditions every AI call about that paper, and it stops the library filling with papers you opened once.

### 8.2 The 3-pass model (P1)

Implements Keshav, *How to Read a Paper* (ACM SIGCOMM CCR 37:3, 2007) as specified in the source, not a paraphrase of it. Each pass is a checklist plus a structured output plus an explicit exit decision. This replaces the progress slider.

**Pass 1 — 5–10 min, bird's-eye view.**

The paper prescribes four steps; make them four checkboxes, because an unticked box is the honest signal that the pass wasn't done:

1. Read title, abstract, introduction
2. Read section and sub-section headings, ignore everything else
3. Read the conclusions
4. Glance over the references, ticking off the ones already read

```ts
type Pass1Output = {
  steps: { titleAbstractIntro: boolean; headings: boolean;
           conclusions: boolean; references: boolean };
  // the five Cs — prose, because that's what the source asks for
  category: string;        // measurement paper? analysis of a system? prototype?
  context: string;         // related papers, theoretical bases used
  correctness: string;     // do the assumptions appear valid?
  contributions: string[];
  clarity: { rating: 1|2|3|4|5; note?: string };
  referencesAlreadyRead: string[];         // feeds the survey workflow (§8.4)
  verdict: 'continue' | 'park' | 'drop';
  verdictReason: 'not-interested' | 'insufficient-background'
               | 'invalid-assumptions' | 'outside-area-but-relevant-later' | 'proceeding';
};
```

`verdictReason` is taken from the paper's own list of reasons to stop, and it earns its place: "park / outside my area but may someday prove relevant" is a genuinely different state from "drop / invalid assumptions", and only one of them should ever resurface. Parked papers get a revision item at 180 days; dropped ones don't.

**Pass 2 — up to 1 hr, grasp the content but not the details.**

Read with greater care, ignore proofs. The source calls out two specific sub-tasks, and both are checklist items:

```ts
type Pass2Output = {
  keyPoints: string[];
  figures: { ref: string; axesLabelled?: boolean; errorBars?: boolean;
             significanceOk?: boolean; note: string }[];
  unreadReferencesMarked: string[];        // "mark relevant unread references"
  summary: string;                         // the exit test, see below
  unclear: string[];
  outcome: 'grasped' | 'set-aside' | 'return-later' | 'persevere';
  returnAfter?: { backgroundToRead: string[]; revisitOn: string };
};
```

Two things here that the first draft of this plan missed:

- **The exit test is a summary you could give to another person**, not a feeling of having read it. Make `summary` a required field to mark Pass 2 done, with a 60-word soft cap. This is a retrieval exercise, not bookkeeping (§ Focus doc, "active recall over rereading").
- **The paper defines three explicit responses to not understanding a paper** — set it aside, return later after background reading, or persevere to pass 3. Model them as first-class outcomes. `return-later` is the valuable one: it creates tasks for the named background material and schedules a revisit, instead of leaving the paper rotting in `reading` forever. The "paper untouched >14 days" alert (§9.4) should not fire on a paper that is legitimately parked with a revisit date.

The figure checks are worth encoding literally — labelled axes, error bars, statistical significance — because they're the fastest available signal separating careful work from sloppy work, and a checklist asks the question when you'd otherwise skim past it.

**Pass 3 — ~1 hr experienced, 4–5 hrs for a beginner. Virtually re-implement.**

```ts
type Pass3Output = {
  assumptionsChallenged: { statement: string; challenge: string }[];
  reImplementation: string;                // how you'd make the same assumptions and rebuild it
  wouldPresentDifferently: string;
  strongPoints: string[]; weakPoints: string[];
  implicitAssumptions: string[];
  missingCitations: string[];
  techniqueIssues: string[];               // experimental or analytical
  futureWorkIdeas: string[];               // "jot down ideas for future work"
  structureRecall?: StructureRecall;       // the completion gate, below
};
```

**The completion gate is recall from memory.** The paper's stated end-state for pass 3 is being able to reconstruct the entire structure of the paper from memory. So marking Pass 3 done opens a recall prompt: reproduce the section structure and the main argument with the PDF closed. Only then does the app show the actual structure (extracted client-side from the PDF outline or heading text) side by side with what you wrote, and you self-grade.

```ts
type StructureRecall = { recalled: string; actual: string[]; selfGrade: 1|2|3|4|5; at: string };
```

That single interaction does three jobs: it enforces the paper's own exit criterion, it produces a revision item seeded at the graded confidence, and it's the highest-value 10 minutes in the whole reading workflow.

**Timing and calibration.** Seed per-pass estimates from the source (P1: 7 min, P2: 60 min, P3: 90 min, adjustable to 300 for unfamiliar areas). Each pass runs a timer that logs a `pomodoroSession` with `category: 'reading'` and `paperId`. After 5 completed passes of a given number, replace the seed with **your own median actual**. The paper's stated benefit is being able to estimate how long a set of papers will take; that only works with your numbers, not Keshav's. These calibrated estimates feed `paperPassPlanned` in the Load Index (§10.2).

**Drop rate is a tracked metric.** If fewer than half your papers stop at Pass 1, you are over-reading — the first pass exists to let you not read things. Surface `pass1 → drop/park` rate on the papers page and in the weekly review.

### 8.3 Notes (P2)

`papers/{id}/notes/{noteId}` — `{ passNo?, kind: 'quote'|'idea'|'question'|'critique'|'todo', body, anchor?: {page, quote}, createdAt }`. Notes of kind `todo` can be promoted to tasks in one click; `question` notes surface in the layered-notes generation as open questions.

### 8.4 Paper groups (P3)

```ts
type PaperGroup = {
  id: string; name: string; purpose?: string;
  paperIds: string[];
  revisionItemId?: string;                 // the group itself is revised
  synthesisArtifactId?: string;
};
```

A group revision is a single review event over the whole cluster: the UI shows each paper's L0/L1 layer side by side and asks one question — "what's the through-line, and what changed since last time?" The answer is stored as a group synthesis note and grades the group's revision item. This is what "club papers for revision" buys you: you revise the *comparison*, not five papers in sequence.

**Survey mode.** A group can be marked `kind: 'survey'`, which turns it into the literature-survey procedure from §3 of the Keshav paper — a five-stage checklist rather than a pile of papers:

```ts
type SurveyState = {
  stage: 1|2|3|4|5;
  seedPapers: string[];        // 3-5 recent papers found via Scholar/CiteSeer keywords
  surveyFound?: string;        // stage 1 shortcut: an existing survey ends the whole exercise
  sharedCitations: { ref: string; citedByPaperIds: string[] }[];
  repeatedAuthors: { name: string; paperIds: string[] }[];
  keyResearchers: { name: string; recentVenues: string[] }[];
  topVenues: string[];
  proceedingsScanned: { venue: string; year: number; at: string }[];
  iterationsDone: number;
};
```

| Stage | Action | What the app does |
|---|---|---|
| 1 | Find 3–5 recent papers by keyword, Pass 1 each, read their related-work sections | Creates the papers with `goalKind: 'survey'`; if a recent survey turns up, prompts you to stop |
| 2 | Find shared citations and repeated author names in the bibliographies | **Computable.** See below |
| 3 | Check the key researchers' recent publications to identify the top venues | Checklist + notes |
| 4 | Scan those venues' recent proceedings for high-quality related work | Checklist per venue/year |
| 5 | Two passes over the assembled set; if they all cite a paper you missed, add it and iterate | Tracks which papers have 2 passes; flags un-added common citations |

Stage 2 is the one worth automating. If Pass 1's `referencesAlreadyRead` and Pass 2's `unreadReferencesMarked` are populated — and they will be, because they're checklist fields — then shared citations and repeated authors are a set intersection over the group, computed client-side with no model call. The app can show "4 of your 5 seed papers cite Smith et al. 2019, which is not in your library" and offer to add it. That is the single highest-leverage automated suggestion in the paper subsystem, and it costs nothing to run.

Stage 5's iteration check is the same computation with a different threshold, so build it once.

### 8.5 AI reading plan (P4)

`paper.readingPlan` takes: title/abstract/section headings (extracted client-side, cheap) + `goal` + `goalKind` + your library's related tags. Returns:

```ts
{
  focusSections: { section: string; why: string; passNo: 1|2|3 }[];
  skipSections: string[];
  extractPerPass: Record<1|2|3, string[]>;   // what to pull out
  questionsToAnswer: string[];
  estimatedMinutes: Record<1|2|3, number>;
  severity: 'critical'|'important'|'general';
}
```

Note it takes **headings, not the whole PDF** — a small, cheap call that runs on a local model. The expensive full-PDF calls are §8.6 only.

### 8.6 Layered Notes (P5)

The deliverable the notes call "Later/Layer-Based Notes": a structured artifact designed to be *re-fed to a model later* as compact context, so you never re-upload the paper to ask a question about it.

Input: the Anthropic `file_id` for the PDF + all your notes + completed pass outputs + the reading goal.

```ts
type LayeredNotes = {
  version: number; generatedAt: string; provider: string; model: string;
  L0: string;                                  // one line, <=25 words
  L1: { problem, contribution, result, whyItMattersToMe };
  L2: { method: string[]; datasets: string[]; metrics: string[];
        baselines: string[]; ablations: string[]; assumptions: string[] };
  L3: { formulation: string; hyperparameters: string; failureModes: string[];
        reproductionChecklist: string[] };
  links: { citationsToRead: string[]; relatedInLibrary: { paperId, relation }[] };
  openQuestions: string[]; claimsToVerify: string[];
  sourceRefs: { quote: string; page: number; layer: 'L1'|'L2'|'L3' }[];
  promptPack: string;                          // <=1200 tokens, the serialised form used as future context
};
```

`promptPack` is the point. Any later AI call that references this paper injects `promptPack`, not the PDF. That keeps the Load Index-era token budget survivable.

Regeneration is versioned (`artifacts/layeredNotes` keeps `version` and the previous doc is overwritten but `aiRuns` retains the audit trail). Your handwritten notes are always included verbatim in the input and never overwritten by the model.

### 8.7 Annotated PDF (P6)

**Yes, this is achievable — client-side, without a PDF service.** The pipeline:

1. **Render** with `pdf.js`. Per page, call `page.getTextContent()` → text items with transforms, widths, heights.
2. **Normalise** each page into a single string, keeping a `charIndex → textItem` map. Normalisation: collapse whitespace, join hyphenated line breaks, fold ligatures (`ﬁ`→`fi`), strip soft hyphens.
3. **Ask the model for verbatim quotes**, not coordinates. Models cannot give reliable bounding boxes; they can quote. Task `paper.highlightCandidates` returns:
   ```ts
   { quote: string;                    // verbatim, >=6 words
     category: 'claim'|'method'|'result'|'limitation'|'definition'|'weakness';
     note: string; layer: 'L1'|'L2'|'L3' }[]
   ```
4. **Match** each quote against the normalised page text — exact first, then a bounded fuzzy match (normalised Levenshtein ≥ 0.9 over a sliding window). Map the matched char range back through the index map to text items, then to rects, merged per line into quads.
5. **Store** the result as `artifacts/annotations` (JSON, one doc): `{ page, quads, quote, category, note, source: 'ai'|'manual', createdAt }`. This is the source of truth — non-destructive, editable, portable, and it survives re-generating the PDF.
6. **Display** as absolutely-positioned divs over the `pdf.js` canvas, colour-coded by category. You can add, edit and delete highlights by selecting text; manual ones store the same shape with `source: 'manual'`.
7. **Export** with `pdf-lib`: load the original bytes, add real `Highlight` annotation objects per quad (plus optional square annotations for figure regions you box manually), save, download. Runs entirely in the browser.

**Known limits — state them in the UI, don't hide them:**
- Scanned PDFs (no text layer) can't be matched. Detect and disable with a clear message; OCR is out of scope.
- Expect 5–15% of AI quotes to fail matching (rewrapped text, math, tables). Unmatched quotes go to a sidebar as plain notes rather than silently disappearing.
- Rotated pages need the page rotation applied to the quad transform. Handle it; don't assume 0°.
- Boxing figures automatically is **not** in scope. Manual box-drawing on a region is, and it's cheap once the overlay exists.

---

## 9. AI layer

### 9.1 Principles

1. **No feature is AI-only.** Every task has a deterministic fallback that is genuinely useful, not a stub.
2. **The task decides the provider**, not a global env var.
3. **Structured output or nothing** — every task declares a schema; unparsable output is a failure that falls through to the next provider, not something rendered raw.
4. **Every run is logged** with provider, model, tokens, latency and outcome.

### 9.2 Provider chain

```
sharedOllama (server)  →  Claude (server)  →  Gemini (server)  →  rule-based fallback

All four run behind /api/ai/*. The browser never calls a model endpoint of any kind.
```

**Where the credentials live.** Claude and Gemini keys stay in **Vercel environment variables** and are read only by server routes. They are never in Firestore, never in the admin panel, never in a response body. The cost of this choice is that rotating a key means editing the env var and redeploying (Vercel env changes only take effect on a new deployment) — a two-minute job you'll do perhaps twice a year, in exchange for a database that holds no secrets at all.

Ollama's address is the opposite case and gets the opposite treatment: **not a secret, and it changes often**, so it lives in `admin/settings` where an admin edits it without a redeploy (§9.2.1). Any bearer token guarding it *is* a secret and stays in env. Mutable non-secret in the database, stable secret in the environment.

- **Local probe:** before routing a `preferLocal` task, check the cached health of the configured endpoint (§9.2.2). On failure, or when the concurrency limit is hit, mark local unavailable and fall through. Never block a user's action waiting on a box that may be switched off.
- **Server chain:** `/api/ai/run` tries Claude, then Gemini. A provider is skipped if its env key is absent, if the budget is spent, or if its circuit breaker is open (3 consecutive failures → open for 10 minutes).
- **Model tiering:** cheap classification/splitting tasks use the small model; deep analysis uses the large one. Model names live in env (cloud) or `admin/settings` (Ollama), never in code.

#### 9.2.1 Ollama is one global endpoint, called from the backend

```ts
// admin/settings.ollama
type OllamaConfig = {
  enabled: boolean;
  baseUrl: string;              // https://gpu.example.com  (must be publicly routable)
  model: string;                // chosen from a live /api/tags list, never typed
  fallbackModels: string[];     // used if `model` isn't installed after a box rebuild
  timeoutMs: number;            // default 90000, hard ceiling 240000 (§ below)
  maxConcurrent: number;        // default 2 — one box, many callers (§ below)
  health: {
    lastOkAt?: Timestamp; lastFailAt?: Timestamp;
    lastError?: string; consecutiveFailures: number;
    lastSeenAddress?: string;   // what the heartbeat last reported
  };
  updatedAt: Timestamp; updatedBy: string;
};
```

There is no `transport` field any more. Every call goes through `lib/ai/providers/ollama.ts`, invoked only from `/api/ai/*` routes, with `Authorization: Bearer ${OLLAMA_TOKEN}` from env attached when set. Nothing about the endpoint is ever sent to the client — the browser sees provider names, never addresses.

**Address validation (runs on save and on every heartbeat).** An admin-settable URL that the server fetches is an SSRF primitive, so:

- Scheme must be `http` or `https`; `https` required unless `ALLOW_INSECURE_OLLAMA=1` is set explicitly.
- Reject `169.254.169.254` and all cloud metadata ranges outright.
- Reject `127.0.0.0/8` and `::1` — a server-side loopback fetch here is always a bug.
- **Reject RFC1918 addresses at save time with a specific message**: *"192.168.1.50 is a private address. A Vercel function cannot reach your network — expose the box with a tunnel or a public hostname."* This is the single most likely misconfiguration and it must fail loudly at save, not as a 90-second timeout inside a cron three hours later.
- Zero redirects. Resolve and pin, don't follow.

**Timeouts.** A function's ceiling is 300 s (§2.1). Set the Ollama timeout meaningfully below it — 90 s default, 240 s absolute — so the provider fails cleanly and the chain falls through to Claude, rather than the whole function being killed mid-response with nothing written. For long generations, stream the response through the route to the client so the user sees progress instead of a spinner.

**Concurrency.** One box, autoscaling callers. Vercel will happily run thirty concurrent functions against a machine that can serve two, and the result is that everyone's request times out rather than a queue forming. Two guards:

- `maxConcurrent` enforced with a short-lived lock (a `locks/ollama` doc with a TTL, or a counter with a transaction). Over the limit, the chain skips local and goes to Claude immediately — degrading to a cloud model beats waiting.
- Set `OLLAMA_NUM_PARALLEL` on the box to match, so the box's own behaviour agrees with the app's assumption.

This also means **`preferLocal` tasks should be the small, tolerant ones** — topic splitting, triage, prompt generation. Never put an interactive, user-is-waiting path on the local model as its first choice.

**Privacy note, corrected.** With server-side calls, prompts pass through your Vercel function on the way to the box. The earlier claim that local-model use keeps data off your infrastructure no longer holds. What remains true: the prompt never reaches Anthropic or Google, which is the reason that actually matters for unpublished work.
#### 9.2.2 Keeping the address current

If you use a Cloudflare Tunnel or any stable hostname (§2.4), the address stops changing and this section is a safety net. If you're pointing at a raw public IP from a home connection, it's load-bearing.

**Heartbeat.** A script on the Ollama box posts its current public address on a timer, so the address updates itself:

```bash
# crontab: */5 * * * *
ADDR=$(curl -s https://api.ipify.org)
curl -sS -X POST https://focusos.vercel.app/api/admin/ollama/heartbeat \
  -H "Authorization: Bearer $FOCUSOS_HEARTBEAT_SECRET" \
  -H 'Content-Type: application/json' \
  -d "{\"baseUrl\":\"https://$ADDR:11434\"}"
```

Note it reports the **public** address, not `hostname -I` — the LAN address is useless to a Vercel function. The route validates the shared secret (`OLLAMA_HEARTBEAT_SECRET` in env), runs the URL through the same validation as a manual save, writes `baseUrl` and `health.lastSeenAddress`, and audits the change. **Skip the write when the address is unchanged** — otherwise a 5-minute heartbeat costs 288 Firestore writes a day for nothing.

**Health check with staleness.** A cached probe of `/api/tags`, 60 s TTL, run server-side. Three consecutive failures marks local unavailable and the chain stops attempting it until a probe succeeds. The admin overview shows address, model, and "last seen 4 minutes ago" — which is what distinguishes "the box is off" from "the app is broken".

Never surface a hard error to a user because the Ollama box is unreachable. It is an optional accelerator; its absence should be invisible everywhere except the admin panel.
### 9.3 Task registry

One file, `lib/ai/tasks.ts`. Each entry: `id`, `schema` (zod), `buildPrompt`, `preferLocal`, `tier`, `maxTokens`, `cacheKey`, `fallback`.

| Task | Prefer local | Tier | Fallback |
|---|---|---|---|
| `course.splitTopics` | yes | small | split on newline/`;`/`,` |
| `plan.tomorrow` | yes | small | template + due items, sorted by deadline |
| `triage.actions` | yes | small | rule table (§9.4) |
| `review.eod` | yes | small | numeric diff vs. yesterday |
| `paper.readingPlan` | yes | small | pass-by-pass generic checklist |
| `checkpoint.prepPlan` | no | large | scope topics sorted by lowest confidence |
| `paper.passAssist` | no | large | none (button hidden) |
| `paper.layeredNotes` | no | large | none (button hidden) |
| `paper.highlightCandidates` | no | large | none (manual highlighting still works) |
| `group.synthesis` | no | large | side-by-side L0/L1 view, no synthesis text |

Tasks that touch a full PDF are never routed to a local model: the file lives in Blob and is referenced by an Anthropic `file_id`.

### 9.4 Triage: Critical / Important / General (G2)

Every generated suggestion and every alert carries `severity`. The rules run *first*, deterministically; the model may re-rank within a band but may not downgrade a Critical.

| Severity | Deterministic triggers |
|---|---|
| **Critical** | Checkpoint with `requiresPrep` due in <48 h with prep <50% done · external task due <24 h · revision backlog > 2× daily cap · goal milestone overdue >7 days · 3+ consecutive days with `loadIndex < 0.5` |
| **Important** | Checkpoint due in its lead window with no prep started · 2+ unlogged classes · paper in `reading` untouched >14 days · weekly review missed · `loadIndex` outside 0.9–1.15 for 3 days |
| **General** | Everything else: suggestions, nudges, resurfacing prompts |

Alerts are written to `alerts/{id}` with a `dedupeKey` (`type:refId:yyyy-MM-dd`) so neither cron nor client can spam. Critical alerts persist until resolved; General alerts expire after 3 days.

### 9.5 Budget guard

`usage/{yyyy-MM}` tracks `inputTokens`, `outputTokens`, `estimatedCostUsd`, `blobBytes`, `runsByTask`. `settings.ai.monthlyBudgetUsd` (default 5) is enforced **server-side** before every call. At 80% the UI warns; at 100% the server chain refuses and everything falls back to local + rule-based. This is the difference between a hobby project and a surprise bill.

### 9.6 Long-running jobs

```ts
type AiJob = {
  id: string; task: string; refId: string;
  status: 'queued'|'running'|'partial'|'done'|'failed';
  steps: { name: string; status: string; output?: unknown }[];
  provider?: string; startedAt; updatedAt; error?: string;
};
```

`POST /api/ai/jobs` creates and starts one; the route writes each step's output to Firestore as it completes and returns whatever finished within its budget. The client polls `aiJobs/{id}` (or subscribes — it's a single doc). Re-invoking a `partial` job resumes from the first incomplete step. `maxDuration = 300` on these routes; keep each *step* under 60 s so a timeout costs one step, not the job.

---

## 10. The daily loop

### 10.1 Morning brief and evening rollup (G3)

**Morning** (cron ~06:00 IST, or on demand): revisions due (with the checkpoint pull-forward applied), checkpoints inside their lead window, papers scheduled, goal milestones this week, unresolved Critical alerts, and today's `requiredMinutes` target. Written to `days/{date}.brief`.

**Evening** (cron ~22:00 IST, or triggered by "End day"): compares planned vs. actual, computes the Load Index, drafts the daily review (pre-filled, you edit), lists 2–4 concrete improvements, and proposes tomorrow's plan.

The tomorrow proposal is **actionable, not prose**:
```ts
type EveningRollup = {
  summary: string;
  improvements: { text: string; severity: Severity }[];
  proposedTasks: { title: string; category: string; estimatePomodoros: number; severity: Severity }[];
  proposedSlots: { title: string; type: SlotType; startTime: string; endTime: string; refType?: string; refId?: string }[];
  unloggedClasses: string[];
  loadIndex: LoadIndexSnapshot;
};
```
Each proposed task/slot has Accept / Edit / Dismiss. Accept writes real docs. Nothing is auto-applied — one bad model output should never rewrite your calendar.

### 10.2 The Load Index (G4)

The named index the specs ask for. Call it the **Load Index (LI)**.

```
requiredMinutes(day) =
    scheduled deep-work minutes in the day plan
  + revisionDue.count × settings.minutesPerRevision   (default 3)
  + checkpointPrepOwed(day)                            // prepEstimateMin spread over the lead window
  + paperPassPlanned(day)
  + goalTargetMinutes(day)                             // targetHoursPerWeek ÷ planned working days

actualMinutes(day) =
    focused minutes from pomodoroSessions
  + revisionsCompleted × minutesPerRevision
  + logged pass minutes

LI = actualMinutes / max(requiredMinutes, 30)          // floor prevents divide-by-tiny
```

| Band | LI | Label | Behaviour |
|---|---|---|---|
| Under | < 0.60 | **Behind** | Critical alert if a checkpoint is <7 days out; otherwise Important |
| Low | 0.60–0.89 | Light day | General note in the rollup |
| Target | 0.90–1.15 | **On track** | Nothing. Silence is the reward |
| Ahead | 1.16–1.50 | Ahead | Rollup offers to pull tomorrow's revisions forward |
| Overrun | > 1.50 | **Overrun** | Flagged, not celebrated. 3 consecutive overrun days → Important alert suggesting a lighter day; the next-day proposal caps at 0.9 |

Also tracked:
- **Debt** — rolling 14-day sum of `max(0, required − actual)`, in hours. Displayed next to LI. Capped at 40 h so it stays legible.
- **Coverage** per course — `topics revised ≥1 time ÷ topics logged`. The number that actually predicts an exam result.
- **Streaks** — consecutive days with LI ≥ 0.9, replacing the current pomodoro streak.

`LoadIndexSnapshot` is written into `days/{date}.loadIndex` at rollup so history is cheap to chart.

---

## 11. Goals

### 11.1 Global checkpoints (G5)

Goals are the long-horizon layer that survives term boundaries. A goal with `horizon: 'break'` and a `termId` pointing at a break term is exactly "what I want to achieve over sem break": it only contributes to the Load Index during that term, and it's what fills the dashboard when there are no courses (§7.1).

Weekly and monthly goal check-ins are driven by `reviewCadence` and appear as their own alert when overdue. The weekly review page becomes goal-centric: milestone progress, hours against `targetHoursPerWeek`, and the LI trend.

### 11.2 External one-time tasks (G6)

Tasks with `kind: 'external'`, `oneOff: true`, a hard deadline and `reminderLeadDays`. They appear on the calendar, in the morning brief inside their lead window, and escalate to Critical at <24 h. They are excluded from the Load Index's `required` (they're usually admin, not study) but count toward `actual` when completed.

---

## 12. Build phases

Each phase is independently deployable. Do not merge a phase whose acceptance criteria fail.

### Phase 0 — Foundation and cuts (do this first)

- Remove: thoughts, anonymous auth, weekly-goal buckets, sample-template button, papers slider, fake sound toggle.
- Add `OWNER_UIDS` allowlist; rewrite the cron to iterate it, not all users.
- Merge `dailyPlans`/`dailyNotes`/`dailyReviews`/`workdaySessions` → `days/{date}`; write the migration script.
- Fix the analytics window bug and the weekly-review average-rating scope.
- Set the Vercel function region to `bom1`. Add `firestore.indexes.json`.
- Add a `usage/{yyyy-MM}` doc and a dev-only read/write counter overlay.
- Add `dayTemplates.isDefault`.

**Acceptance:** one day view = one Firestore read. Guest sign-in gone. Cron processes exactly one uid. Analytics numbers match a hand calculation over 7 days.

### Phase 1 — Terms, Courses v2, class logs, checkpoints

- `terms`, course date bounds, derived status, break mode on the dashboard.
- Class log form + `topics` creation (rule-based split for now).
- Checkpoints CRUD with type defaults; migrate `courseAssignments` → checkpoints.
- Calendar shows checkpoints; the known "calendar shows live class times but the saved schedule has old ones" drift gets fixed by regenerating class slots for future dates when a course's sessions change.

**Acceptance:** log a class in <15 s. A course past `endDate` stops generating class blocks. All old assignments visible as checkpoints. Deleting a course cascades cleanly.

### Phase 2 — Revision engine + Load Index

- `revisionItems`, the ladder, the review UI (one card at a time, four grade buttons, keyboard 1–4).
- Daily cap, rollover, resurfacing rule.
- Checkpoint pull-forward as a computed view.
- Load Index computation + the dashboard band widget + `days.loadIndex` history chart.

**Acceptance:** reviewing 20 items costs ≤ 25 Firestore writes (batched). A quiz added 3 days out visibly reorders tomorrow's queue without changing any `dueDate`. LI matches a hand calculation on a seeded day.

### Phase 3 — Files + Papers v2

- Blob upload flow, `files/`, quota guard, delete cascade.
- 3-pass model, structured pass outputs, per-pass timers writing pomodoro sessions.
- `goal`/`goalKind` required before `reading`. Progress derived. Notes subcollection. Paper groups.

**Acceptance:** a 15 MB PDF uploads without touching a function body. Refresh mid-pass and the timer state survives. Group revision produces one synthesis note.

### Phase 4 — AI layer v2

- Provider chain, local probe, circuit breaker, task registry, zod schemas, `aiRuns`, budget guard, `aiJobs`.
- Port the existing insight generation onto the registry, then delete the old `AI_PROVIDER` path.
- Triage rules + `alerts` with dedupe.

**Acceptance:** with **no** API keys set, every screen still works and every AI button shows its fallback. Kill the Claude key mid-session → Gemini serves the next call → kill both → rule-based. Budget cap blocks a call server-side.

### Phase 4.5 — Admin panel

Users, roles, usage meters, runtime kill switches and an audit log. **No credential management** — Claude and Gemini keys stay in env vars, Ollama is a per-user frontend setting. Full spec in **`FocusOS-v2-Admin-Panel.md`**. Supersedes `OWNER_UIDS` with Firebase role claims.

### Phase 5 — Layered notes + annotation

- `paper.layeredNotes` with `promptPack`; Anthropic Files API ingest + `anthropicFileId` caching.
- Highlight candidates → matcher → overlay → manual editing → `pdf-lib` export.
- Scanned-PDF detection.

**Acceptance:** on a 12-page two-column paper, ≥85% of returned quotes match and highlight correctly; unmatched ones appear in the sidebar. Exported PDF opens in Acrobat and Preview with highlights intact. Re-asking a question about the paper sends `promptPack`, not the PDF (verify in `aiRuns` token counts).

### Phase 6 — Goals, daily loop, alerts

- Goals with milestones and horizons; break-term scoping; external tasks with lead reminders.
- Morning brief and evening rollup with Accept/Edit/Dismiss; two crons; on-demand generation.
- Weekly review rebuilt around goals + LI.

**Acceptance:** "End day" produces a rollup whose proposed slots can be accepted into tomorrow's plan in one click. Deleting the cron's output and reopening the dashboard offers on-demand generation.

### Phase 7 — Polish

- Daily-frame PDF extended with revisions due and upcoming checkpoints.
- Full JSON export covering **all** collections (the current one silently omits several).
- Error log collection (Hobby keeps only 1 h of runtime logs).
- Decide the MCP server's fate.

---

## 13. API surface

All authenticated routes verify a Firebase ID token and check the `OWNER_UIDS` allowlist. All are Node runtime.

```
POST /api/ai/run                 { task, payload }            → { output, meta }
POST /api/ai/jobs                { task, refId, payload }     → { jobId }
GET  /api/ai/health                                           → { providers, budget }

POST /api/files/upload-token     (Vercel Blob client-upload handshake)
POST /api/files/:id/ingest       → uploads blob to Anthropic Files API, caches file_id
DELETE /api/files/:id

GET  /api/cron/morning-brief     (CRON_SECRET bearer)
GET  /api/cron/evening-rollup    (CRON_SECRET bearer)

GET  /api/export                 → full JSON, all collections

/api/admin/**                    → see FocusOS-v2-Admin-Panel.md §9
```

`vercel.json`:
```json
{
  "crons": [
    { "path": "/api/cron/morning-brief",   "schedule": "30 0 * * *" },
    { "path": "/api/cron/evening-rollup",  "schedule": "30 16 * * *" }
  ],
  "functions": {
    "app/api/ai/jobs/route.ts": { "maxDuration": 300 },
    "app/api/ai/run/route.ts":  { "maxDuration": 120 }
  }
}
```

---

## 14. Environment variables

```bash
# Client (all six required, or the app is in demo mode)
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=

# Server
FIREBASE_SERVICE_ACCOUNT_BASE64=
OWNER_UIDS=uid1,uid2                 # NEW — cron and API allowlist (superseded by role claims in Phase 4.5)
CRON_SECRET=

# Admin panel (Phase 4.5)
ADMIN_ENCRYPTION_KEY=                # openssl rand -base64 32
BOOTSTRAP_OWNER_EMAIL=

ANTHROPIC_API_KEY=                   # optional — server-only, never in Firestore
GEMINI_API_KEY=                      # optional — server-only, never in Firestore
AI_MODEL_LARGE=claude-sonnet-4-6     # configurable, not hardcoded
AI_MODEL_SMALL=claude-haiku-4-5-20251001
AI_MONTHLY_BUDGET_USD=5              # global ceiling; per-user caps live in Firestore

BLOB_READ_WRITE_TOKEN=               # auto-set by the Vercel Blob integration

# Admin panel (Phase 4.5)
BOOTSTRAP_OWNER_EMAIL=               # one-time owner bootstrap; inert once an owner exists

# Ollama — the ADDRESS is not here, it lives in admin/settings and changes.
# Only the secrets that guard it belong in env.
OLLAMA_TOKEN=                        # bearer token checked by the reverse proxy in front of the box
OLLAMA_HEARTBEAT_SECRET=             # shared secret for the address self-registration route
ALLOW_INSECURE_OLLAMA=               # set to 1 only to permit an http:// endpoint
```

`AI_PROVIDER` is removed. There is no `ADMIN_ENCRYPTION_KEY` — nothing secret is stored in the database. Note the deliberate split: **`baseUrl` in Firestore because it changes; `OLLAMA_TOKEN` in env because it doesn't.**

---

## 15. Risks and things to watch

| Risk | Mitigation |
|---|---|
| Blob 1 GB fills up | Link-only default for re-downloadable papers; usage meter; 20 MB per-file cap; a "detach PDF, keep notes" action that deletes bytes but keeps the layered notes |
| Firestore 20k writes/day | Batch revision reviews; debounce all text inputs at 800 ms; no writes on slider/drag |
| Ollama unreachable from the deployed origin | Documented as expected (§2.4); the chain falls through silently; nothing depends on it |
| A model returns unparsable JSON | zod validation → provider fallthrough → rule-based. Never render raw output as if it were structured |
| Cron fires late or not at all | Every cron output is generatable on demand; the UI never assumes it exists |
| Quote matching fails on dense PDFs | Unmatched quotes become sidebar notes; the failure is visible, not silent |
| AI cost creep | Server-side monthly budget; `promptPack` instead of re-sending PDFs; small model for the 80% of tasks that are classification |
| The system becomes a chore to feed | Class log ≤15 s, revision grading is 4 keys, every AI proposal is one click to accept. If a daily action takes more than a minute, it will not survive week three |

---

## 16. Open questions for you

1. **MCP server** — keep frozen, or delete? It's the one call I'd rather you make.
2. **Revision ladder** — is `[1, 3, 7, 16, 35, 70]` right for coursework, or do you want a shorter, more aggressive ladder before exams?
3. **Daily revision cap** — 20 items / 45 min a reasonable ceiling, or higher?
4. **Break mode** — during a sem break, should papers or goals get the larger share of the reallocated time?
5. **Annotated PDF** — do you want the highlights baked into an exported file, or is the in-app overlay enough? Baking is more work and produces a second artifact to keep in sync.
6. **Pass 3** — realistically, what fraction of papers reach it? If it's under 10%, make Pass 3 opt-in rather than a tracked stage on every paper.
7. **Multiple devices** — reminder intervals and theme currently live in `localStorage`. Move them into `settings` so they sync?
