# FocusOS

FocusOS is a production-oriented workday operating system for a PhD scholar. It replaces a calendar app, a pomodoro app, a reading-list app, and a notes app with one calm Next.js dashboard: courses, paper reading, task planning, day scheduling, focus sessions with end-of-session surveys, hydration/break coaching, reviews, analytics, PDF exports, data export, and AI-generated insights — all backed by Firestore.

This README documents every screen and every button, including the non-obvious behavior ("nuances") you'll run into using it day to day. If something below sounds like a limitation rather than a feature, it's stated that way on purpose.

**This is a single-owner app right now**, mid-way through a larger rewrite. See [Roadmap](#roadmap) at the bottom for what "Phase 0" through "Phase 3" mean and what's coming next.

## Stack

- Next.js App Router with TypeScript, React 19
- Tailwind CSS
- Firebase Authentication (Google sign-in only)
- Firebase Firestore as the persistent source of truth (all data lives under `users/{uid}/...`)
- Firebase Admin (server-side only, `app/api/**`) for AI insight generation
- Claude (`@anthropic-ai/sdk`) and/or Gemini (`@google/generative-ai`) for AI insights, switchable via env var
- Recharts for the analytics charts; `jspdf` + `jspdf-autotable` for the daily-frame PDF
- Vercel Blob (`@vercel/blob`) for optional paper PDF uploads, with client-side direct upload so the file bytes never pass through a Next.js function
- `pdfjs-dist` for client-side PDF outline extraction (the Pass 3 structure-recall gate)
- Vercel-friendly environment variable configuration, region-pinned to `bom1`, with Vercel Cron driving the daily AI insight job

## Quick start

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

Open `http://localhost:3000`. Without a configured Firebase project, sign-in is disabled entirely — see **Authentication** below.

---

## Authentication

`/login` offers four sign-in paths, all backed by real Firebase Authentication:

- **Continue with Google** — standard OAuth popup.
- **Continue as guest** — Firebase Anonymous auth. Re-added after Phase 0 explicitly removed it, specifically **for testing** — see the nuance below before relying on it for anything real.
- **Email/password** — a Sign in / Create account toggle over one form.
- **Magic link** — enter an email, get a sign-in link, open it on the same device to complete sign-in (the pending email is stashed in `localStorage` so the completing tab doesn't have to ask again; if you open the link on a *different* device/browser, it'll prompt you to re-type the email since there's nothing to read it from).

**Nuance:** "demo mode" (`isDemoMode` in the UI, shown as an "Env needed" badge) is triggered whenever any of the six `NEXT_PUBLIC_FIREBASE_*` variables is missing. In that state every sign-in method is disabled — there is no way to get past `/login` without a real Firebase project configured.

**Which of the four buttons actually render is admin-controlled**, not hardcoded: `/login` fetches `GET /api/public/sign-in-methods` (unauthenticated, cached 60s server-side) and only shows the methods `admin/settings.signInMethods` has enabled — see [Admin panel](#admin-panel-admin) below. Defaults to all four on, so upgrading never locks anyone out. Turning off "Anonymous" here doesn't touch the underlying Firebase Auth provider (still enabled, still enforced by rules) — it only stops `/login` from offering the "Continue as guest" button to new visitors; an already-signed-in guest session is unaffected. `scripts/enable-auth-providers.mjs` enables the Email/Password, email-link, and Anonymous providers on the Firebase project itself (Google still needs enabling by hand once, in the console, since it requires picking a support email interactively) — that's a one-time project-level setting, separate from this per-request toggle.

Once signed in, `AuthProvider` writes/merges a `users/{uid}` profile document on every auth state change (`upsertUser`), calls `POST /api/admin/bootstrap` once (a no-op unless this is the very first sign-in from `BOOTSTRAP_OWNER_EMAIL`, or there's a pending invite for this email — see [Admin panel](#admin-panel-admin)), reads the resulting `role` custom claim off a freshly-minted ID token, and redirects: signed-out users are bounced to `/login`; signed-in users visiting `/login` are bounced to `/dashboard`. This redirect logic runs client-side after Firebase resolves the auth state, so a logged-out visitor briefly sees a "Loading FocusOS..." screen first.

**Signing in grants a normal account, not AI access by budget alone.** Every AI route now authorizes from the `role` custom claim (`disabled` is rejected, everything else passes) rather than an allowlist — `OWNER_UIDS` is gone. What actually limits a new account is its tier's `allowedModels`/`aiMonthlyBudgetUsd` (see [Tiers](#tiers)) and the global `aiGloballyEnabled` kill switch (see [Admin panel](#admin-panel-admin)), same as any other user.

---

## Feature reference

### Vocabulary glossary

The UI went through a plain-language rename (`lib/copy.ts`) — same features, clearer words. Nothing below (TypeScript identifiers, Firestore field names, existing routes) changed; only user-facing labels did. Section headings below note the old name once as "(formerly ...)"; this table is the full list.

| Old term | Current label |
|---|---|
| Load Index (LI) | Workload |
| Required minutes / Actual minutes | Planned / Done |
| Debt | Catch-up hours |
| Streak (LI ≥ 0.9) | On-track streak |
| Coverage | Topics revised |
| Next Action | Up next |
| Checkpoint | Assessment |
| Class log | Log a class |
| Topic confidence | Understanding |
| Revision item / ladder / queue | Revision card / revision schedule / today's revision |
| `/review` page | Revise |
| Pass 1 / Pass 2 / Pass 3 | Skim / Read / Deep dive |
| Verdict continue / park / drop | Keep reading / Save for later / Not relevant |
| Reading goal + goalKind | Why am I reading this? |
| Paper group (cluster) / survey mode | Paper set / Literature survey |
| Group synthesis | What connects these papers? |
| Layered notes | Layered summary |
| Highlight candidates | Suggested highlights |
| Slot | Block |
| Day template / default template | Day template / Workday template |
| Break-mode template | Break-day template |
| Term kind semester / break / none | Semester / Semester break / No term |
| Workday session | Your day |
| Pomodoro (timer) | Focus session (Focus timer) |
| End-of-session survey | How did that go? |
| Daily review | Daily wrap-up |
| Weekly review | Weekly check-in |
| Morning brief | Morning overview |
| Evening rollup / proposed tasks & slots | Suggestions for tomorrow |
| Alerts (Critical / Important) | Heads-up (Urgent / Important) |
| External task | Hard deadline |
| Planner (`/planner/day`) | Plan — Day (`/plan/day`) |
| Calendar (`/calendar`) | Plan — Calendar (`/plan/calendar`), merged into one "Plan" destination with tabs |

### Dashboard (`/dashboard`)

The home screen, laid out as three columns on wide screens (timer · full-day schedule · priorities/tasks/scratchpad):

- **Next Action card** — sits above everything else and answers "what do I do right now?" with exactly one recommendation, no list to choose from. A deterministic cascade, no model call: an urgent checkpoint inside its prep window first, then your revision queue if anything's due, then your highest-priority open task due this week, then (only once you're already well ahead of today's target) an explicit suggestion to rest. See [Next Action &amp; Load Index](#next-action--load-index) below.
- **Metrics strip** — today's pomodoro count, focused minutes, tasks completed, and current streak (consecutive days with at least one completed work pomodoro), computed client-side from your recent records (see `lib/analytics.ts`).
- **Pomodoro timer** (compact) in the left column.
- **Full-day schedule widget** in the middle — a live view of today's `DailySchedule`, if one exists.
- **Load Index widget** — top of the right column; today's band (Behind/Light day/On track/Ahead/Overrun) and the actual-vs-required minutes behind it. See [Next Action &amp; Load Index](#next-action--load-index).
- **Top priorities** — pin up to 3 real tasks (via a dropdown of your open tasks) as today's priorities, stored as `pinnedTaskIds` on today's merged `days/{date}` document. Unlike the old free-text version, a priority is always a real, checkable task.
- **Today tasks** — tasks whose `dueDate` is today OR whose status is `in_progress`, **capped at the first 5 matches**. Checking the box marks a task `done` (and stamps `completedAt`); unchecking reverts it to `todo` (not back to its previous status, e.g. `in_progress` is lost).
- **Scratchpad** — a free-text note per day, stored as `scratchpad` on the same `days/{date}` document.
- **Download PDF** — see [PDF export](#pdf-export-the-daily-frame) below. **Nuance:** it uses the same capped 5-item "Today tasks" list and your pinned-task titles as shown on the dashboard at click time — it is not a full task export.
- **Open day planner** — links to `/plan/day` for the current date.

**Nuance:** the whole day's state — session, pinned tasks, scratchpad, review, and the Load Index snapshot — lives on **one Firestore document** (`days/{date}`), not four-plus separate ones. Opening the dashboard costs one read for all of it, not four.

### Workday session: Start day / End day

The button in the top-right of every page (next to the theme toggle) is the "clock in / clock out" ritual:

- **Start day**:
  1. Requests browser Notification permission (only if you haven't already answered that prompt).
  2. If today has no `DailySchedule` yet: on a normal semester day, builds one from your **default day template** plus any class blocks from your **active** courses that meet today (see [Courses](#courses-courses)); on a day with no active term or an explicit break term, applies your **break-mode template** instead (Settings — see below) and generates **no** class blocks at all, regardless of what courses exist (see [Break mode](#break-mode)). If you have no templates and no matching classes, no schedule is created and the dashboard's schedule widget will show its empty state.
  3. Marks today's workday session started (on `days/{date}.session`) and begins the hydration/break reminder loop.
- **End day**: stamps `session.endedAt` on today's day doc, stops reminders, and immediately navigates you to `/reviews/daily`.
- While active, the button is replaced with a small "N water · N breaks" counter plus "End day".

**Nuances:**

- Starting only creates a schedule if one is *missing*; it never merges course slots into a schedule that already exists. If you add a new course after already starting the day, run "Apply template" or add slots manually in the Day Planner to pick it up.
- Course slots are merged in without overlap checking — if a class collides with a template block, both are saved as-is. The Day Planner's own slot editor *would* flag that overlap if you edited the day there, so it's worth eyeballing the schedule after "Start day" on days you added or changed a course.
- The workday session's "date" is computed from the browser's local date at the moment the relevant code runs, not re-checked automatically. If you leave the tab open across midnight without it re-rendering, it can keep referencing yesterday's session; refreshing the page picks up the new date correctly.
- There's no "already ended, resume day" flow — if you accidentally click "End day" early, click "Start day" again to reopen a session for today (it won't recreate the schedule since one already exists).

### Hydration & break reminders

While a workday session is active, a 30-second internal check compares elapsed time against two independent intervals (defaults: 60 minutes for hydration, 50 minutes for breaks; both configurable in **Settings**, and synced to your account — see below):

- **Hydration** fires regardless of what you're doing — it does not check your schedule.
- **Break** reminders are suppressed (and silently reset) whenever the schedule's currently active slot is a `break`, `meal`, `sleep`, or `free` block — the app assumes you're already resting.
- A reminder shows as a banner under the header, plus a real OS/browser notification if you granted permission.
- **"Done"** dismisses the banner *and* increments the visible counter *and* writes the acknowledgment to Firestore (`session.hydrationCount`/`session.breaksTaken`, `session.lastHydrationAt`/`session.lastBreakPromptAt`).
- **The × button** just dismisses the banner locally — the timer resets so it won't immediately refire, but nothing is written to Firestore and the counter doesn't move. Dismissed reminders leave no record.
- Only one reminder is shown at a time (hydration is checked first, so it takes priority if both are due simultaneously).

**Nuances:** this is a pure client-side timer — it only runs while the tab is open and only checks every 30 seconds, so reminders can fire a little late if the tab is backgrounded/throttled by the browser, or not at all if the tab/computer is asleep. There's no server-side or push-notification fallback.

### Focus timer (formerly Pomodoro timer)

Available compact on the dashboard and wherever else it's embedded.

- Configurable work / short break / long break lengths, in **Settings** (see below). **Nuance:** changing a length while that mode's timer is currently running does **not** reset the in-progress countdown — the new length only applies the next time that mode starts fresh. (This used to reset a running timer; it's fixed.)
- Every 4th completed **work** session triggers a **long break** instead of a short one; the cycle counter only increments after work sessions, not breaks.
- **Session label**, **category** (one of the fixed six: research, coding, reading, writing, admin, personal — there's no course- or paper-specific category), and an optional **task picker** ("Scheduled for task") let you tag what a session was actually for.
  - **Nuance:** the task picker only lists tasks that aren't `done`, and the whole dropdown disappears if you have zero open tasks.
  - Linking a pomodoro to a task (`taskId`) is a separate mechanism from assigning tasks to a schedule slot in the Day Planner (`assignedTaskIds`) — the two aren't synced with each other.
- **Start/Resume**, **Reset** (restarts the current mode's countdown without logging anything), and **Finish** (immediately ends the current interval early and runs the same completion flow as a natural timeout).
- **End-of-session survey**: after any **work** session completes (naturally or via Finish), a modal asks for a 1–5 productivity rating and an optional comment before the session is saved. **Save** stores both fields; **Skip** saves the session without them. Breaks never trigger a survey and are saved immediately.
- **Today history** shows your most recent sessions (2 in compact mode, 4 otherwise) with minutes, rating (if given), and comment (if given).

There is intentionally no sound toggle — the old one was a visual placeholder that played nothing and has been removed rather than shipped as fake.

### Tasks (`/tasks`)

Standard task CRUD: title, optional description, category, priority, optional due date, estimated pomodoros.

- View filter: Inbox (all), Today (`dueDate` = today), This week (`dueDate` ≥ the current week's Monday — note this includes future weeks too, since it's an unbounded "on or after" filter, not "this calendar week only"), Completed.
- Additional category/priority/status filters stack on top of the view filter.
- Marking a task done from the checkbox sets `status: "done"` and stamps `completedAt`; unchecking always reverts to `todo`.
- An inline "In progress" link on each task sets its status without touching the checkbox.

### Plan — Day (formerly Day Planner) (`/plan/day`)

A 24-hour timeline editor for one date (`?date=yyyy-MM-dd` in the URL; defaults to today; the Calendar page links here with a specific date).

- Add/edit/delete/reorder ("Move up"/"Move down") slots: title, type (including the `class` type used for course sessions), start/end time, optional note, status (upcoming/completed/skipped), and which open tasks are assigned to it.
- **Validation** blocks saving whenever: a slot has no title, a slot ends before/at its own start time, or a slot starts before the previous slot (sorted by start time) has ended. Gaps between slots are fine and treated as implicit free time — only overlaps are rejected.
- **Templates**: save the current day as a reusable template, apply a template to the currently viewed date (overwrites that date's schedule), duplicate or delete a template, mark one as the **default** (star icon — shown as a "Default" badge), or update an existing template's slots from the current day's editor.
  - The **default** template is the one "Start day" applies automatically when today has no schedule yet. Your first template (sample or custom) is marked default automatically; after that, use the star icon to change it.
  - **"Add sample"** only appears when you have zero templates — it seeds one research-weekday template and marks it default. It won't create duplicates on repeat clicks because it's simply not there to click once a template exists.

### Plan — Calendar (formerly Calendar) (`/plan/calendar`)

A month grid aggregating, per day: class sessions from active courses, task due dates, and checkpoint due dates, plus a small dot indicating whether a `DailySchedule` document already exists for that date. Clicking any day opens `/plan/day` for that date (even if nothing is scheduled yet — you'll land on an empty timeline).

**Nuances:**

- Class blocks shown here are computed **live** from your current courses every time the page renders — they are not the same data as the "class" slots baked into a saved `DailySchedule` document. Editing a course's sessions now **regenerates every future saved schedule's class slots** to match (see [Courses](#courses-courses)), so this drift only shows up for dates before you made the edit — which is correct, since the past shouldn't retroactively change.
- On any date inside a break term (or with no active term at all), the Calendar shows **no** class blocks for that date, matching what "Start day" would actually generate (see [Break mode](#break-mode)).

### Courses (`/courses`)

The most substantially rebuilt page in Phase 1. Three layers: terms, courses, and per-course checkpoints/class-logs/topics.

**Terms** — a term is a date range with a `kind`: `semester` (normal), `break` (reallocates focus, no classes), or `none`. Add one with a name and start/end date; the "active" term for any date is whichever term's range contains it (terms shouldn't overlap, but nothing currently stops you from creating overlapping ones — the first match wins). Courses without a term attached are always treated as active, ignoring terms entirely.

**Courses** — name, optional code/instructor, an optional term, optional start/end dates (defaulting to the chosen term's dates if left blank), an optional weekly time target (for a future Load Index), and one or more weekly **sessions** (day of week + start/end time + optional location).

- **Status is derived, not just stored**: a course past its `endDate` shows as **Completed** automatically even if you never touched the status dropdown — the dropdown lets you additionally force `Active`/`Completed`/**`Dropped`** (dropped always wins, regardless of dates).
- Only courses whose *derived* status is `active` **and** whose date bounds cover today contribute class blocks — to "Start day" schedule generation and to the Calendar — and only when today isn't inside a break term (see [Break mode](#break-mode)).
- **Edit sessions** opens an inline editor for the weekly time slots. Saving it updates the course **and regenerates every already-saved future `DailySchedule`'s class slots for this course** (past schedules are left alone) — this is the fix for the old "calendar shows new times, saved schedule still shows old ones" drift.
- **Deleting a course cascades**: its checkpoints and class logs (both nested under the course) are deleted with it in one batch. Its **topics are kept** — they're flat, cross-course records meant to outlive an individual course, e.g. for revision later even if you drop the course.

**Checkpoints** (replaces the old flat course-assignment list) — a quiz/lab/assignment/midsem/endsem/presentation/other, with a due date, optional weight %, and a `requiresPrep` flag that defaults per type (quiz/midsem/endsem/presentation default to needing prep; lab/assignment/other default to not). Status is one of upcoming/prepping/submitted/done/missed; marking one **done** reveals a score/max result field. Checkpoints from every course feed the Calendar.

**Class log** — logging a class is meant to be fast: pick the date (defaults to today), attendance (attended/missed/cancelled/self-study), paste or type topics covered (one per line, or comma/semicolon-separated — split with a simple rule-based parser, no AI call yet), and rate your understanding 1–5 (skipped for cancelled/missed classes, since there's nothing to rate).

- Each topic you type is matched case-insensitively against topics already logged for that course; a match updates the existing `Topic` doc (bumping confidence and recording this date), anything new creates one.
- **A missed class still records its topics** — at confidence 1, the lowest — rather than vanishing from the course's coverage, and automatically creates a "Catch up: …" task (category `admin`, priority `high`) listing what was missed if you named any topics.
- Re-logging the **same date** for the same course overwrites that day's log rather than creating a second one (the log's document id is the date).

**Topics** — a compact per-course list showing each topic's title and current confidence (1–5), with a Retire/Reactivate toggle. Topics aren't deleted when retired, just excluded from being "active." **Nuance:** they don't do anything yet beyond bookkeeping — they become the unit of spaced-repetition review in Phase 2.

### Break mode

FocusOS assumes you won't always have active coursework — between semesters, "sometimes there is no course at all" is a first-class state, not an empty-widget afterthought.

- **No class blocks are generated** on any date that falls inside a `break`-kind term, or on any date with no active term at all — regardless of what any individual course's dates say.
- **"Start day" applies your break-mode template** (set in Settings) instead of your normal default template on those dates. Leave it unset to just keep using the default template.
- **The dashboard swaps in a "Break focus" card** in place of the usual context — right now that's your paper reading queue (to-read/reading papers); a break-scoped goals view is planned for when Goals land in Phase 6.
- The Calendar reflects the same rule: no class blocks shown for a break-mode date, even if a course's weekly sessions would otherwise put one there.

### Review (`/review`)

The spaced-repetition engine Phase 2 adds on top of Phase 1's class logs and topics — one card at a time, four grade buttons, keyboard 1–4.

- Every topic you've ever logged got a `RevisionItem` the first time it was created (or, for topics logged back in Phase 1 before this existed, the first time you log that course again — it's backfilled then). Starting position on the ladder comes from your understanding rating at log time: 5 → the 3rd rung, 3 → the 2nd, 1 (or a missed class) → the 1st, due tomorrow.
- **The ladder** is `[1, 3, 7, 16, 35, 70]` days, a modified Leitner schedule. Grading a card: **Again** resets to the 1st rung and counts as a lapse, due tomorrow; **Hard** keeps your rung and reschedules at that rung's interval; **Good** advances one rung; **Easy** advances two. Falling off the end of the ladder retires the item — it resurfaces once, 180 days later, capped at 3 resurfaced items per day so old material doesn't flood a session.
- **The queue** is everything due today (bounded Firestore query, `suspended == false && dueDate <= today`), reordered — never rescheduled — so that topics in scope for a checkpoint due within its own prep-lead window float to the top; your daily item cap (default 20) and minute cap (default 45, both editable in Settings) are applied last. **Nuance:** the reordering never touches `dueDate` — a quiz added 3 days out changes tomorrow's card order without silently rescheduling anything, which is also what makes "add a quiz" safe to do at any time.
- **Retrieval before recognition**: each `topic`/`paper`-kind card first asks a generic prompt — *"Explain '' in two sentences, without looking anything up"* — before showing anything else. There's no stored answer to compare against yet, so revealing just confirms the topic and shows your review history; the point is that you attempted recall before seeing anything, not that the reveal is rich.
- **A `paperGroup`-kind card looks different**: no reveal step. It shows every paper in the group side by side with its latest completed pass's summary, a text box asking "what's the through-line, and what changed since last time?", and the same four grade buttons — see [Paper groups](#paper-groups--combined-revision-and-survey-mode) above. Typing a synthesis and then grading saves both in one action; grading without typing anything just grades.
- Space/Enter reveals a topic/paper card; **1/2/3/4** grade once revealed (or immediately, for a group card). Each grade is a single Firestore write to that item — reviewing a full 20-item queue costs about 20 writes, not a write per side-effect.

### Up next & Workload (formerly Next Action & Load Index)

- **Next Action** (the dashboard card) picks from, in order: an urgent `requiresPrep` checkpoint inside its lead window → your revision queue if non-empty → your highest-priority open task due this week → (if you're already past LI 1.3) an explicit rest suggestion → nothing, if none of those apply. It's a plain function, not a model call, so it's instant and never wrong about what data it saw.
- **The Load Index (LI)** is one number: `actual minutes ÷ required minutes` for today (required is floored at 30 minutes so an empty morning doesn't spike it). Bands: **<0.60 Behind**, **0.60–0.89 Light day**, **0.90–1.15 On track**, **1.16–1.50 Ahead**, **>1.50 Overrun**.
  - *Required* = today's scheduled deep-work minutes + (revisions due × 3 min) + checkpoint prep owed (each `requiresPrep` checkpoint's `prepEstimateMin` spread evenly over its `prepLeadDays` window) + active courses' `targetMinutesPerWeek` ÷ 7 + active goals' `targetHoursPerWeek` ÷ 7 (Phase 6 — a `break`-horizon goal only counts while its own term is the active one; see [Goals](#goals-goals) below).
  - *Actual* = today's focused pomodoro minutes + (revisions completed today × 3 min).
- **Nuance:** the dashboard shows a **live** LI that recomputes on every render from current data — it is not the historical record. A **snapshot** is only written to `days/{date}.loadIndex` when you click **"End day"**, which is what the Analytics page's Load Index trend chart reads. If you never click End day, no history accumulates, even though the dashboard number was there all along.
- **Debt, Coverage, Streak** (Phase 6, `lib/loadindex.ts`): Debt is a rolling 14-day sum of `max(0, required − actual)` in hours, capped at 40h so a long dry spell stays legible — shown on the dashboard's Load Index widget and the Weekly Review. Streak now counts consecutive days at LI ≥ 0.9, replacing the old pomodoro-day streak in that one slot (the pomodoro streak itself still shows separately on Analytics/Weekly Review). Coverage (`topics revised ≥1 time ÷ topics logged`, per course) shows on each course card on `/courses` — "revised" means the topic's linked revision item has at least one completed rep, not just that one exists.

### Papers (`/papers`) — the Skim / Read / Deep dive reading workflow (formerly the 3-pass workflow)

Rebuilt in Phase 3 around Keshav's *How to Read a Paper* rather than a status pill. The list page shows title/authors/venue/year, a **derived** status badge, a progress bar, and links to a full detail page (`/papers/{id}`) where the actual reading happens.

**Reading goal first** — before you can start Pass 1, a paper needs a `goal` (why am I reading this?) and a `goalKind` (survey / method / baseline / related-work / reproduce / critique), set on the detail page. This is deliberately the highest-friction point in the whole subsystem: it's what stops the library filling with papers you opened once and forgot, and it conditions every later AI call about the paper once Phase 4 adds those. **Nuance:** creating a paper doesn't ask for a goal — only *starting Pass 1* is gated on it, so quickly capturing a paper you found is still a two-field form.

**The three passes**, each a timer (anchored to a persisted `startedAt`, so **refreshing mid-pass doesn't lose your progress** — the elapsed time is real wall-clock time since you started, not a component-local stopwatch) plus a structured form:

- **Pass 1** (~7 min seed estimate) — four checkboxes (title/abstract/intro, headings, conclusions, skim references), free-text category/context/correctness, contributions, a 1–5 clarity rating, references already read (feeds paper groups' survey mode — see below), and a **verdict**: continue / park / drop. Dropping or parking both end the paper's active reading and set its status to `archived` — they differ only in what happens next: **park** creates a 180-day resurfacing revision item (so it can resurface in `/review` "someday"), **drop** creates nothing.
- **Pass 2** (~60 min) — key points, a per-figure checklist (axes labelled? error bars? significance stated?), unread references marked (also feeds survey mode), and a required **summary** you could hand to someone who never opened the PDF (a live word count nudges you past ~70 words, but doesn't block). The outcome — grasped / set aside / return-later / persevere — matters: **return-later** lets you list background reading and a revisit date, and auto-creates a task per background item.
- **Pass 3** (~90 min, **opt-in** — only unlocked once Pass 2 is done, and most papers never need it) — assumption-challenging, a from-scratch re-implementation sketch, strong/weak points, missing citations, and a **completion gate**: you write what you recall of the paper's structure with the PDF closed, *then* compare against the actual structure (extracted from the PDF's bookmark outline via `pdfjs-dist` if a file is attached and has one; otherwise you type it in manually), self-grade 1–5, and that grade seeds a normal ladder revision item — the same mechanism a class topic gets.

**Status and progress are derived, never set directly** (`lib/papers.ts`): progress is 0/33/66/100 based on which passes are `done`; status is `archived` on a drop/park verdict, `read` once Pass 3 is done (or Pass 2 is done with a "grasped" outcome and Pass 3 was never started), `reading` once any pass is in progress or done, else `to_read`. There is intentionally no progress slider — the old one fired a Firestore write per drag tick and showed a percentage ("37% read") that didn't mean anything.

**Calibration**: each pass's seed estimate (7/60/90 min) is what the timer displays until you've completed that pass number 5+ times, after which `lib/papers.ts`'s `calibratedPassEstimate` would use your own median — **nuance:** the estimate shown in the timer UI is still always the fixed seed for now; the calibration function exists and is correct, but nothing calls it yet to override the displayed number.

**Drop rate**: the share of papers where Pass 1 finished with a drop/park verdict, shown on both the Papers page and the Weekly Review. Below 50% is the plan's stated signal that you're over-reading — Pass 1's entire purpose is to let you stop.

**Notes** (`papers/{id}/notes`): quote / idea / question / critique / todo, freeform. A `todo` note has a one-click promote-to-task action that creates the task and deletes the note.

Filters on the list page: status and tag (tag list derived from whatever tags currently exist across your papers).

### Files — attaching a PDF to a paper

Optional and off by default. A paper works completely fine as a link-only record forever — attaching a PDF only unlocks Pass 3's automatic outline extraction.

- **Upload** goes straight from your browser to Vercel Blob storage (`@vercel/blob/client`) — the bytes never pass through a Next.js function, so there's no 4.5 MB body-size ceiling to worry about. A 20 MB per-file hard cap is enforced client-side before the upload even starts.
- **Requires `BLOB_READ_WRITE_TOKEN`** (server-side env var, see [Firebase Setup](#firebase-setup)'s sibling section below). **Without it, the upload button still appears but fails with a clear "PDF uploads aren't configured" message** — every other paper feature keeps working; this is the same graceful-degrade pattern as the AI insight keys.
- **Removing a PDF** goes through a server route (`/api/files/{id}` `DELETE`) because deleting from Blob needs the write token, which the browser never holds. This detaches the file and frees its quota but **leaves all your notes and pass outputs intact** — exactly the "detach PDF, keep notes" action the plan calls for when you're near your storage quota.
- **Quota**: an 800 MB **soft** account-wide cap (Vercel Blob gives 1 GB on Hobby) tracked in `users/{uid}/meta/blobUsage`. At 90%+ the Papers page shows a warning banner suggesting you detach a PDF you no longer need the file for — it's advisory, not a hard wall.

### Layered Notes and PDF annotation (Phase 5)

Two AI tasks that need the actual PDF, not a text summary of it — both live on the paper detail page whenever a file is attached, both Claude-only (no fallback, button/section shows a plain error if unconfigured), and both share one cached upload so the bytes are only ever sent to Anthropic once per paper.

- **Anthropic Files API caching** (`lib/ai/anthropic-files.ts`, `lib/admin-papers.ts`): the first call for a paper uploads its PDF to Anthropic's Files API and caches the resulting `file_id` as `Paper.anthropicFileId`; every later call for that paper reuses it. Re-attaching or removing the PDF clears the cache (and the layered notes generated from it) automatically — `updatePaper` treats a `fileId` change as invalidating both, since a stale summary of a since-replaced PDF would be actively misleading. This is genuinely Claude-only: Gemini/Ollama have no equivalent file-reference mechanism, so `lib/ai/tasks.ts`'s `requiresAnthropicFile` flag restricts the provider chain to Claude alone rather than risking a hallucinated-but-schema-valid response from a provider that silently ignored the reference.
- **Layered Notes** (`paper.layeredNotes`) — reads the PDF plus your own notes, pass summaries, and reading goal, and produces a structured L0 (one-line gist) → L1 (problem/contribution/result/why-it-matters-to-me) → L2 (method/datasets/metrics/baselines/ablations/assumptions) → L3 (formulation/hyperparameters/failure modes/reproduction checklist) summary, plus citations to read, open questions, claims to verify, and a `promptPack` (≤1200 tokens) meant to stand in for the PDF in any later AI call about this paper. Regenerating overwrites the field (`aiRuns` keeps the audit trail of prior generations). **Cut from the original spec**: `relatedInLibrary` (auto-suggested related papers from your own library) — nothing in this codebase does similarity/embedding search, and a naive title-guessing version would just be unreliable noise; `citationsToRead` (external references the model can name from the paper's own bibliography) covers the grounded half of that idea.
- **Highlights & annotation** — click "Generate highlights" to get 8–20 verbatim-quote candidates from the model (`paper.highlightCandidates`), then a client-side pipeline (`lib/pdf-annotate.ts`) matches each quote against the PDF's actual extracted text: exact match first, then a bounded fuzzy pass (anchor-word prefiltered so it stays fast — a naive full sliding-window search would be far too slow to run synchronously in a browser tab) at a 0.9 normalized-similarity threshold. A match maps back to on-page rects, merged per line into quads (`HighlightQuad`, stored in unscaled PDF page-space so it survives any zoom level). Matched quotes render as colored overlays on a `pdf.js`-rendered canvas; **unmatched quotes are persisted too** (`matched: false`, no page/quads) and surface in a sidebar rather than silently disappearing. You can also **select text directly** on the rendered page (a custom invisible, positioned text layer enables native browser selection — not `pdfjs-dist`'s official `TextLayer` class, which leans on very new CSS `round()`/custom-property scaffolding this app doesn't otherwise need) to add a manual highlight with your own category and note. **Export** produces a real annotated PDF (`lib/pdf-export.ts`, via `pdf-lib`'s low-level object API to construct actual `/Subtype /Highlight` annotations with `QuadPoints` — not drawn rectangles baked into the page) that opens with native, editable highlights in Acrobat/Preview. **Cut from the original spec**: manual figure-box drawing — the plan already excluded *automatic* figure detection, and adding a second manual interaction mode (draw-a-box vs. select-text) for a rarely-used feature wasn't worth it.
- **Scanned-PDF detection**: `hasTextLayer()` (`lib/pdf-outline.ts`, built ahead of schedule during Phase 3's Pass 3 outline work) checks page 1 for any extractable text before the annotation UI renders at all — a scanned PDF with no text layer shows a clear message instead of a pipeline that can never match anything. OCR is out of scope, per the plan.
- **Verified live** against the real Anthropic API before shipping: a synthetic 2-page test PDF confirmed the Files API upload, caching (a second call reused the same `file_id`), and schema-valid responses from both tasks (~$0.07 total) — this run also caught a real bug, below. The quote-matching algorithm was separately verified against real `pdf.js`-extracted text from the same test PDF (via `pdfjs-dist`'s Node-targeted "legacy" build, since the shipped code's browser-oriented dynamic import can't run standalone in Node), confirming exact matches, correct dehyphenation/line-joining across wrapped text, and correct multi-line quad merging.
- **Bug found during that live test**: both tasks originally capped `maxTokens` at 2000; a real Layered Notes call filled exactly that budget and returned truncated (invalid) JSON, which failed schema validation and surfaced as a 503 since the task has no fallback. Fixed by raising the caps (4000 for Layered Notes, 3000 for highlights) — the full L0-L3 shape plus a compressed `promptPack` routinely needs more than 2000 output tokens.

### Paper sets — combined revision and literature survey (formerly Paper groups / survey mode)

A group clusters 2+ papers for revision **as a comparison**, not five separate flashcards — you revise "what's the through-line and what changed since last time," which shows up as its own card type in `/review` (see [Review](#review-review) above): each paper's latest completed-pass summary side by side, a text box for the synthesis, and the same four grade buttons. The synthesis is saved to the group (`lastSynthesis`) and shown the next time you revise it.

**Survey mode** (`kind: "survey"`) is the same group, plus the literature-survey procedure from Keshav §3. Only its **stage 2 is automated** — this is Phase 3's implementation of the plan's "single highest-leverage automated suggestion in the paper subsystem": since Pass 1's references-already-read and Pass 2's unread-references-marked are already populated checklist fields, `lib/papergroups.ts` computes **shared citations** (cited by 2+ papers in the group, flagged if the citation doesn't loosely match any paper title already in your library) and **repeated authors** across the group with a plain set intersection — no model call, shown expanded under each group on the Papers page. Stages 1/3/4/5 (finding seed papers, checking key researchers' venues, scanning proceedings, iterating) are manual for now; there's no dedicated stage tracker UI yet, just the `kind: "survey"` flag and the computed stage-2 view.

### Goals (`/goals`)

The long-horizon layer that survives term boundaries (plan §11.1) — Phase 6. A goal has a `horizon` (`week`/`term`/`break`/`year`/`phd`), a required `definitionOfDone`, an optional `why`, milestones (title, optional due date, done), an optional `targetHoursPerWeek` that feeds the Load Index's required-minutes target, a `reviewCadence` (weekly/monthly), and a `status` (active/paused/achieved/dropped) — only `active` goals count toward anything. A `break`-horizon goal additionally carries a `termId`: it only contributes to the Load Index (and shows as "not counting toward Load Index today" on its card) while that specific break term is the active one, so a sem-break reading goal doesn't quietly keep inflating your required minutes once term starts again (`lib/goals.ts`'s `isGoalActiveForDate`). Milestones are edited inline on each goal's card — add, toggle done, or delete, no separate screen. Courses can optionally be linked to a goal (checkboxes on the card) for future cross-referencing; papers/tasks linking isn't wired to any UI yet, only the data model supports it.

An overdue milestone (>7 days past its due date, still not done) becomes a Critical alert (`lib/ai/triage.ts`) the next time triage runs.

### The daily loop — morning overview & suggestions for tomorrow (formerly morning brief / evening rollup)

Phase 6's other half (plan §10.1): two daily crons plus on-demand generation for both.

- **Morning brief** (`lib/dailyloop.ts`'s `buildMorningBrief`, `~06:00 IST` cron or the Dashboard's "Generate" button) is **entirely deterministic — no AI call at all**. It's a structured readout: revisions due, checkpoints inside their prep window, papers currently in the reading queue, goal milestones due within 7 days, external tasks inside their reminder window, the count of unresolved Critical alerts, and today's required-minutes target. Written to `days/{date}.brief`.
- **Evening rollup** (`lib/dailyloop.ts`'s `buildProposedTasks`/`buildProposedSlots`, `~22:00 IST` cron or triggered by **"End day"** — also available as a manual "Generate" button on the Daily Review page) compares today against yesterday. Its `summary`/`improvements` come from the `review.eod` AI task (with its existing numeric fallback); its `proposedTasks` and `proposedSlots` are **always deterministic** — the same due-date-sorted logic the registered-but-unwired `plan.tomorrow` task's own fallback uses — so what's actually accept-able into tomorrow's plan never depends on an AI call succeeding. `proposedSlots` specifically fills the gap Phase 1 explicitly deferred: auto-suggested "prep block" schedule slots for checkpoints in their prep window.
- **Nothing is ever auto-applied.** Each proposed task/slot on the Daily Review page is an editable card (title/category/pomodoros for tasks, start/end time for slots) with **Accept** (creates the real `Task`, or appends the slot into tomorrow's `DailySchedule` — creating it fresh if tomorrow has no schedule yet) and **Dismiss** buttons. Every decision is persisted (`EveningRollup.taskDecisions`/`slotDecisions`, keyed by array index) so reopening the page never re-offers something you already handled.
- **Cut from this pass**: `unloggedClasses` is always `[]` for now — detecting "2+ unlogged classes" needs an extra per-course class-log read this pass didn't add, same deferral `lib/ai/triage.ts` already documented for its own version of that trigger. Per-goal hours-against-target isn't computed either (the data model has no session-to-goal attribution) — the Weekly Review shows each active goal's `targetHoursPerWeek` and milestone progress, not hours actually logged toward it.

### Daily wrap-up (`/reviews/daily`) and Weekly check-in (`/reviews/weekly`) (formerly Daily Review / Weekly Review)

- Daily review is keyed by date (a date picker lets you view/edit **any** past day, not just today): what got done, what was blocked, what should carry forward, plus 1–5 focus and energy ratings, and (today only) the Evening Rollup section above. All of it lives in that date's `days/{date}` document.
- Weekly review is keyed by the current week's Monday: the free-text wins/missed-goals/blockers/priorities fields, plus (Phase 6) a **goal-centric section** — each active goal's milestone progress and target hours, with a "Mark reviewed" button for weekly-cadence goals — and a **Load Index trend** for the week (a chip per day) alongside the Debt/Streak stat tiles.
- Both show a brief "Saved" confirmation message and disable the Save button while writing.

### Analytics (`/analytics`)

Three bar charts plus three headline metrics, labeled "Last 7 days" — and now all of it actually is:

- **Pomodoros per day**, **Tasks completed by day**, **Focused minutes by category**, and the completion-rate/total-focus-minutes/total-pomodoros headline metrics are all windowed to the last 7 calendar days.
- **Nuance on completion rate specifically**: it's computed over tasks that were either due or completed within the window, not your entire task list — a task created a month ago with no due date and still open doesn't drag the number down forever.
- **Load Index trend** — a fourth chart, last 30 days, reading `days/{date}.loadIndex.value`. Empty until you've clicked "End day" at least once (see [Next Action &amp; Load Index](#next-action--load-index)).

### Settings (`/settings`)

- **Profile**: display name, email, and your Firebase UID.
- **Preferences**: dark mode toggle.
- **Reminders**: the hydration and break interval inputs (minutes) that drive the workday-session reminder loop described above.
- **Break-mode template**: which day template "Start day" applies on a date with no active semester term (see [Break mode](#break-mode)). Defaults to your normal default template if left unset.
- **Plan**: your current tier's name, which AI providers it allows, its AI monthly budget, and its PDF storage quota — read-only, set by an admin (see [Tiers](#tiers) below).
- **Revision**: the daily item cap and minute cap for the `/review` queue, **clamped to your tier's ceiling** (defaults 20 items / 45 minutes if no tier is configured). The ladder itself (`1, 3, 7, 16, 35, 70` days) isn't editable in the UI yet, just shown for reference.
- **Export data**: see below.
- **Firebase status**: shows whether client Firebase env vars are present.

**Nuance:** theme and reminder intervals are synced to your account (`users/{uid}/meta/settings`) rather than `localStorage`, so they follow you across devices/browsers — the very first load in a new browser still reads a local fallback before the synced value arrives, so there can be a brief flash of the default.

### PDF export (the daily frame)

The dashboard's "Download PDF" button builds a one-page PDF client-side (`jspdf`/`jspdf-autotable`) containing:

1. The date, formatted.
2. Your pinned-task titles as a numbered "Top priorities" list (a placeholder line if nothing is pinned).
3. A table of today's schedule slots (time, title, type, note) — empty if no schedule exists for today.
4. A checklist-style table of the dashboard's "Today tasks" (done/not-done marker, title, priority) — **the same capped, filtered list described in the Dashboard section above**, not your full task list.

It downloads directly via the browser (`focusos-daily-frame-<date>.pdf`); nothing is uploaded anywhere.

### Data export (JSON / CSV)

From **Settings → Export data**:

- **Full export (JSON)**: a one-time (non-live) read of `tasks`, `pomodoroSessions`, `days`, `dailySchedules`, `dayTemplates`, `weeklyReviews`, `terms`, `courses`, `topics`, `revisionItems`, `papers`, `aiInsights`, plus every course's nested `checkpoints` and `classLogs` flattened into two top-level arrays — bundled into one JSON file with an `exportedAt` timestamp.
- **Pomodoro log (CSV)**: one row per pomodoro session, columns `completedAt, label, category, mode, minutes, cycle, taskId, slotId, productivityRating, comment`.
- Both are meant to be handed to an external AI tool or spreadsheet for analysis outside FocusOS.

### AI Insights (`/insights`)

- Click **"Regenerate today's insight"** to call `/api/insights` with your Firebase ID token. The server verifies the token, rejects a `disabled` role, reads your data with Firebase Admin, and runs it through the `insight.daily` AI task (see [AI layer v2](#ai-layer-v2) below) — the result is saved as one `AiInsight` document keyed by today's date (regenerating overwrites that document — one insight per day, not a running log of every click).
- The **daily cron** (`/api/cron/daily-insight`, wired via `vercel.json`) does the same thing automatically each morning, gated by a `CRON_SECRET` bearer token and `admin/settings.cronEnabled`, for every non-disabled `users/{uid}` document (`lib/admin-users.ts`'s `getActiveUids`) rather than a fixed allowlist. It also runs the day's [triage/alerts](#ai-layer-v2) evaluation for each uid right after, and records its own outcome to `admin/cronRuns` for the [admin overview screen](#admin-panel-admin).
- **What the AI actually sees**: your tasks, pomodoro sessions (including productivity ratings and comments), the last 7 days of review data, papers, and every course's checkpoints — computed into the same metrics shown on `/analytics` (pomodoros today/this week, focus minutes by category, completion rate, average focus rating) plus lists of high-priority open tasks, upcoming checkpoint deadlines, and your active reading queue.
  - **Nuance:** it does **not** see your actual schedule/calendar slots, weekly reviews, class logs, topics, or full course details — only checkpoints and the metrics above.
- **No provider configured is not an error case any more.** With no `ANTHROPIC_API_KEY`/`GEMINI_API_KEY` set, both routes still return a real insight — a deterministic, numeric one computed from the same data (pomodoros, focused minutes, tasks completed, completion rate, the next checkpoint/task/paper in the queue) instead of a generated summary. The saved document's `degraded: true` flag and the page's "· rule-based fallback" label are the only visible difference.
- A small status strip above the insight shows live provider health (`/api/ai/health`): whether Claude/Gemini are configured, whether either's circuit breaker is open, whether Ollama is enabled and reachable, and this month's AI spend against your budget.
- **Also gated by your tier**: a provider outside your tier's `allowedModels` is skipped in the chain exactly like a missing API key — see [Tiers](#tiers).

### Tiers

A tier is an admin-defined bundle of limits and AI-model access — **not** a fixed set of plan names baked into the code. An admin can create, edit, and delete tiers freely; this exists ahead of the admin panel itself (Phase 4.5, see Roadmap) specifically so the AI layer (Phase 4, next) has real limits to enforce from day one instead of retrofitting them later.

- **What a tier controls**: a daily revision item cap, a daily revision minute cap, an AI monthly budget in USD, a PDF storage quota in MB, and which AI providers (`claude`/`gemini`) it may call at all.
- **Assignment**: each user has an optional `tierId` on their `users/{uid}` root document. No tier assigned (or no tiers created yet) means the hardcoded fallback limits apply — introducing tiers to a project never silently cuts off a feature that already worked.
- **What's actually enforced today**: the AI-model allowlist (checked by `runAiTask` before attempting any cloud provider — see [AI layer v2](#ai-layer-v2)), the AI monthly budget (checked before every call; over it, every task silently falls back to rule-based output), the revision-cap inputs on the Settings page (clamped to the tier's ceiling), and the Papers page's blob-storage warning banner (reads the tier's quota instead of a fixed 800 MB).
- **Managed at `/admin/tiers`** (see [Admin panel](#admin-panel-admin) below) — list with live per-tier user counts, create/edit, set-default, delete (blocked on the default tier, reassigns affected users otherwise), and tier assignment from `/admin/users`. `scripts/manage-tiers.mjs` still works identically (both go through the same `lib/admin-tier-crud.ts`) if you'd rather script it:

```bash
node scripts/manage-tiers.mjs list
node scripts/manage-tiers.mjs create --name="Free" --default \
  --maxRevisionsPerDay=20 --maxRevisionMinutesPerDay=45 \
  --aiMonthlyBudgetUsd=5 --blobQuotaMb=800 --allowedModels=claude,gemini
node scripts/manage-tiers.mjs create --name="Restricted" \
  --maxRevisionsPerDay=5 --maxRevisionMinutesPerDay=15 \
  --aiMonthlyBudgetUsd=1 --blobQuotaMb=100 --allowedModels=gemini
node scripts/manage-tiers.mjs set-default --id=<tierId>
node scripts/manage-tiers.mjs assign --uid=<firebase-uid> --tierId=<tierId>
node scripts/manage-tiers.mjs delete --id=<tierId>   # blocked if it's the default tier
```

**Nuance:** deleting a tier that isn't the default reassigns its users to whichever tier is currently marked default — the script prints the list of affected uids so you can re-assign any of them individually afterward if that's not what you wanted. Deleting the default tier itself is refused outright; set a different tier as default first.

### AI layer v2

Every AI-powered feature in the app — insights, reading plans, prep plans, pass assistance, group synthesis — goes through one shared system instead of each having its own provider call. The rule that shapes all of it: **no feature is AI-only.** Every task has a real, useful, deterministic fallback; the only two exceptions (`paper.passAssist` and `group.synthesis`) simply hide/disable their button when no provider is available rather than showing a stub result.

- **The provider chain** (`lib/ai/run.ts`): local Ollama (if configured and healthy, only for tasks marked `preferLocal`) → Claude → Gemini → the task's own rule-based fallback. A provider is skipped if its API key is absent, if it's outside your tier's `allowedModels`, or if its circuit breaker is open (3 consecutive failures opens it for 10 minutes, in-memory per warm serverless instance). A task marked `requiresAnthropicFile` (Phase 5's `paper.layeredNotes`/`paper.highlightCandidates`) additionally restricts the chain to Claude alone — Gemini/Ollama have no equivalent to an Anthropic Files API `file_id`, and silently ignoring the reference would risk a hallucinated-but-schema-valid response being trusted as if it had actually read the PDF. Local Ollama is never gated by tier or budget — it's a free, shared accelerator, and its absence is meant to be invisible.
- **The task registry** (`lib/ai/tasks.ts`) is one file, one entry per task: a zod schema the response must validate against, a prompt builder, whether it prefers local, its model tier (`small`/`large`, mapped to `AI_MODEL_LARGE`/`AI_MODEL_SMALL`/`GEMINI_MODEL_LARGE`/`GEMINI_MODEL_SMALL`), and its fallback function. A response that fails schema validation counts as that provider's failure and falls through the chain — it is never rendered raw.
  - `course.splitTopics`, `plan.tomorrow`, `triage.actions`, `review.eod` — registered with real fallbacks, not yet wired to a button (class-log speed and the daily-loop UI itself are protected/pending — see Roadmap).
  - `paper.readingPlan` — a button on the paper detail page; generates a goal-tailored checklist, falls back to a generic pass-by-pass one.
  - `checkpoint.prepPlan` — a button on each `requiresPrep` checkpoint in Courses; generates prep steps from its linked topics, falls back to those topics sorted by lowest confidence.
  - `paper.passAssist` — an "AI assist" box inside the Pass 1 and Pass 2 forms: paste raw notes, get suggested field values to review and edit, nothing auto-submitted. No fallback — a failed call shows an inline message instead of a stub.
  - `group.synthesis` — the "Draft with AI" button next to the manual synthesis textarea in group revision (`/review`), routed through the job system below since it's the one task most likely to take a moment. No fallback — the manual textarea is always still there.
  - `paper.layeredNotes`, `paper.highlightCandidates` — Phase 5's PDF-ingest tasks, Claude-only (`requiresAnthropicFile`, see [Layered Notes and PDF annotation](#layered-notes-and-pdf-annotation-phase-5) above). No fallback; the section/button hides behind a clear error if Claude isn't configured, same pattern as `paper.passAssist`.
- **Every run is logged** to `users/{uid}/aiRuns/{runId}` — task, provider, model, tokens, cost, latency, and outcome, success or failure, including a schema-validation failure.
- **The budget guard** (`lib/ai/budget.ts`) tracks estimated spend in `users/{uid}/usage/{yyyy-MM}.ai` (the same monthly doc the dev usage overlay already writes read/write counts to) against the tighter of your tier's `aiMonthlyBudgetUsd` and the global `AI_MONTHLY_BUDGET_USD` env var. Over budget, every task's fallback runs automatically — no error surfaced to the UI.
- **Jobs** (`users/{uid}/aiJobs/{jobId}`, via `POST /api/ai/jobs`): a generic single-step wrapper around the same provider chain, for the one task (`group.synthesis`) worth tracking progress on. The client subscribes to the job document directly rather than polling.
- **Deterministic triage + alerts** (`lib/ai/triage.ts`, `lib/admin-alerts.ts`): every rollup run (the daily cron, and a manual "Regenerate insight") re-evaluates a fixed rule table — an under-prepped checkpoint close to its due date, a revision backlog over 2× your daily cap, a 3-day Load Index streak below 0.5 or outside the 0.9–1.15 on-track band, a paper marked "reading" untouched for 14+ days — and writes deduped `Alert` documents (`users/{uid}/alerts/{dedupeKey}`, one per condition per day). Critical and Important alerts surface as a dismissible banner on the Dashboard; there's no separate AI step here — the rules are the ground truth, and the optional `triage.actions` task may only reword or reorder them, never downgrade a severity.
- **Local Ollama** is off by default and admin-configured, not an env var, because its address isn't a secret and it changes: `admin/settings.ollama` (a server-only Firestore doc), managed at **`/admin/ollama`** (address field with inline SSRF rejection, a server-side "Test connection" button that populates a live model picker from `/api/tags`, `maxConcurrent`, and a health strip) or equivalently via `pnpm manage:ai-settings -- show|set|disable`. A box reports its own address on a timer via `POST /api/admin/ollama/heartbeat` (bearer `OLLAMA_HEARTBEAT_SECRET`, not tied to any user account, not role-gated). Every address is validated against basic SSRF rules (no loopback, no cloud-metadata IPs, no RFC1918 private ranges, `https://` required unless `ALLOW_INSECURE_OLLAMA=1`) both on manual save and on every heartbeat.
  - **Exposing the box safely**: since Ollama itself has no auth, whatever's in front of it needs one. `lib/ai/providers/ollama.ts`'s `authHeaders()` sends `Authorization: Bearer ${OLLAMA_TOKEN}` on every request (checked by a reverse proxy/app-level auth you put in front of the box) and, additively, `CF-Access-Client-Id`/`CF-Access-Client-Secret` if both are set — for a box exposed via a **Cloudflare Tunnel with a Cloudflare Access application** in front of it (Zero Trust → Access → Service Auth), Access rejects every request before it reaches the tunnel unless these two headers carry a valid service token. Neither mechanism depends on the other; use one or both depending on what's in front of your box. Also bind Ollama to `127.0.0.1` (`OLLAMA_HOST=127.0.0.1`), not `0.0.0.0` — a tunnel daemon running on the same box only ever needs loopback, and binding to every interface means anything on the LAN (or a misconfigured public IP) can reach the raw port directly, bypassing both the tunnel and any auth in front of it entirely.
- **`AI_PROVIDER` is gone.** The task decides the provider now, not a single global switch — see [AI Insights Setup](#ai-insights-setup-optional) below (or `.env.example`) for the replacement set.

### Admin panel (`/admin`)

Phase 4.5, per `plan/FocusOS-v2-Admin-Panel.md`. Gated on a Firebase **custom claim**, `role: 'owner' | 'admin' | 'member' | 'disabled'` — signed into the ID token, so every `/api/admin/**` route authorizes from the token alone with no Firestore read per request. `/admin` itself and every page under it 404s (not 403s) for anyone without `owner`/`admin`, so the panel's existence isn't advertised to a normal member. **No credential management here** — Claude/Gemini keys stay in Vercel env vars; the one piece of provider config that *is* admin-managed is Ollama's address, because it isn't a secret and it changes (see above).

- **Bootstrapping the first owner**: set `BOOTSTRAP_OWNER_EMAIL` in env. The next time that email signs in, `POST /api/admin/bootstrap` (called once automatically by `AuthProvider`) grants the `owner` claim and marks it done — inert on every sign-in after that, and on every other email. There's exactly one owner; it cannot be demoted or deleted by anyone, including itself. `admin` can manage `member` accounts and everything on this panel except creating other admins or touching the owner.
- **`/admin`** — provider status (key present/absent, circuit breaker state — never the key itself), month-to-date AI spend, Firestore/Blob free-tier meters (amber at 70%, red at 90% of Spark's daily/monthly ceilings), the daily cron's last run and outcome, and the five most recent failed `aiRuns`.
- **`/admin/users`** — search/filter, change role (`setCustomUserClaims` + `revokeRefreshTokens`, so it takes effect on the user's next request instead of waiting up to an hour for token refresh), change status/tier, toggle `aiEnabled`, edit per-user budget/blob-quota overrides, force sign-out, invite by email, and **delete** — a two-step, job-based flow (type the email to confirm, export-first defaulted on) since a full account wipe (Blob objects → Firestore subcollections → the user doc → the Auth record, in that order) can exceed one function invocation; `adminJobs/{jobId}` tracks progress and a re-POST to the same job resumes wherever it stopped, skipping stages already marked done.
- **`/admin/tiers`** and **`/admin/ollama`** — the screens for the systems described above.
- **`/admin/usage`** — AI spend and Firestore reads/writes broken down by user, by task, and by provider for the current month.
- **`/admin/settings`** — the runtime switches: `aiGloballyEnabled` (the most useful one — flips the *entire app* to rule-based fallbacks with no deploy and no errors), `cronEnabled`, `maintenanceMode` (members see a banner, admins still get in), `signupMode`/`maxActiveUsers`, and the four `signInMethods` toggles from the Authentication section above.
- **`/admin/audit`** — every mutating admin action, read-only: who, what, when, before/after. Nothing here can be deleted; a `POST /api/admin/ollama/heartbeat` write only shows up when the reported address actually changes.

**What's a documented simplification, not a bug**: the free-tier meters read "today" as month-to-date, since `lib/usage.ts` only ever tracked monthly totals — a genuine daily rollover would need new tracking infra this phase didn't add. `signupMode: 'closed'` only affects the invite flow's own bookkeeping; it does not reach into Firebase Auth to actually reject a sign-in attempt (that's a client-SDK call this server never sees), so treat it as a policy flag for now, not a hard gate. The audit log is append-only with no automatic 180-day expiry sweep — nothing deletes old entries yet. And per-uid aggregate queries (usage, overview) iterate a bounded list of user documents rather than a Firestore `collectionGroup` query, specifically to avoid needing extra collection-group indexes beyond the one `aiRuns` failure-lookup already requires (`firestore.indexes.json` — apply with `pnpm ensure:indexes`, same caveat as the Phase 2 revision index above).

### Dark mode

A light/dark toggle (moon/sun icon in the header) that defaults to your OS preference on first visit and is then synced to your account (see Settings above).

### Dev usage overlay

In development only (`NODE_ENV=development`), a small "reads N · writes N (session)" badge sits in the bottom-right corner. It's a session counter, not a historical one — it resets on page reload — meant to make a runaway `onSnapshot` listener visible immediately instead of showing up as a surprise in the Firebase console days later. The same counts are also debounced (every 20s of activity) into `users/{uid}/usage/{yyyy-MM}` in Firestore for a running monthly total, in both dev and production.

---

## Firebase Setup

Create a Firebase project, enable the **Google** Authentication provider (needs a support email picked interactively, so this one's manual), then create a Firestore database. Add a web app in Firebase and copy the config values into `.env.local`.

Enable the other three providers (Email/Password, email-link passwordless, Anonymous) with one command instead of three console clicks: `pnpm enable:auth-providers` (needs `FIREBASE_SERVICE_ACCOUNT_BASE64` set — see [AI Insights Setup](#ai-insights-setup-optional) for how to generate it). Safe to re-run.

Required client environment variables:

```bash
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
```

All six must be present or the app falls back to demo mode and sign-in is disabled (see **Authentication** above).

## Paper PDF Uploads Setup (optional)

Attaching a PDF to a paper needs Vercel Blob: Vercel dashboard → your project → Storage → Blob → create a store → copy its read-write token into `BLOB_READ_WRITE_TOKEN`. Without it, every other paper feature (3-pass reading, notes, groups, link-only papers) works fine — only the upload button is disabled, with a clear message rather than a broken form.

## AI Insights Setup (optional)

The [AI layer](#ai-layer-v2) needs server-side credentials — these never reach the browser bundle. Every one of these is optional: with none set, every AI feature still works via its deterministic fallback (see above).

1. Generate a Firebase service account key (Firebase console → Project settings → Service accounts → Generate new private key) and base64-encode it: `base64 -i serviceAccountKey.json`. Put the result in `FIREBASE_SERVICE_ACCOUNT_BASE64`.
2. Set `ANTHROPIC_API_KEY` and/or `GEMINI_API_KEY`. Both can be set at once — the chain tries Claude first, then Gemini, per task; there's no single "active provider" switch any more. Optionally override `AI_MODEL_LARGE`/`AI_MODEL_SMALL` (Claude) and `GEMINI_MODEL_LARGE`/`GEMINI_MODEL_SMALL` (Gemini) and `AI_MONTHLY_BUDGET_USD` (global spend ceiling, default $5).
3. Set `CRON_SECRET` to a random string — Vercel Cron sends it back as a bearer token so `/api/cron/daily-insight` only accepts real cron requests.
4. Set `BOOTSTRAP_OWNER_EMAIL` to your own email, then sign in once with it — you'll hold the `owner` role from then on (see [Admin panel](#admin-panel-admin)). Every signed-in, non-disabled account can use the AI layer now; there's no separate allowlist to maintain — a new account's actual limits come from whichever tier it's on (see [Tiers](#tiers)).
5. **Local Ollama, optional and off by default**: not an env var — configure it at **`/admin/ollama`** (see [Admin panel](#admin-panel-admin)) or with `pnpm manage:ai-settings -- set --enabled=true --baseUrl=https://your-tunnel-or-hostname --model=llama3.1`. `OLLAMA_TOKEN` (a bearer token your reverse proxy checks), `OLLAMA_HEARTBEAT_SECRET` (for the self-registration heartbeat), and, if the box sits behind a Cloudflare Access application, `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` (a Zero Trust service token — see the note above) are the env vars involved, since those are the actual secrets.

Without any of this set, the dashboard and every other feature keep working normally — AI buttons render their result from the rule-based fallback instead of a generated one, clearly labeled where it's visible (e.g. the Insights page's "· rule-based fallback" tag).

## Firestore Schema

FocusOS stores user-owned records under each user document, plus one collection that's shared across every user:

```text
tiers/{tierId}
admin/settings
admin/auditLog/entries/{entryId}
admin/cronRuns/entries/{name}
admin/locks/ollama/counter
adminJobs/{jobId}
invites/{email}

users/{uid}
users/{uid}/tasks/{taskId}
users/{uid}/pomodoroSessions/{sessionId}
users/{uid}/days/{yyyy-MM-dd}
users/{uid}/dayTemplates/{templateId}
users/{uid}/dailySchedules/{yyyy-MM-dd}
users/{uid}/weeklyReviews/{weekStart}
users/{uid}/terms/{termId}
users/{uid}/courses/{courseId}
users/{uid}/courses/{courseId}/checkpoints/{checkpointId}
users/{uid}/courses/{courseId}/classLogs/{yyyy-MM-dd}
users/{uid}/topics/{topicId}
users/{uid}/revisionItems/{itemId}
users/{uid}/papers/{paperId}
users/{uid}/papers/{paperId}/notes/{noteId}
users/{uid}/papers/{paperId}/annotations/{annotationId}
users/{uid}/paperGroups/{groupId}
users/{uid}/files/{fileId}
users/{uid}/aiInsights/{yyyy-MM-dd}
users/{uid}/meta/settings
users/{uid}/meta/blobUsage
users/{uid}/usage/{yyyy-MM}
users/{uid}/aiRuns/{runId}
users/{uid}/aiJobs/{jobId}
users/{uid}/alerts/{dedupeKey}
users/{uid}/goals/{goalId}
```

Core task fields include title, optional description, status, priority, category, optional due date, estimated pomodoros, completion time, and timestamps. Pomodoro sessions additionally carry optional `taskId`/`slotId` links and the end-of-session survey fields `productivityRating` and `comment`. Tasks gained (Phase 6) an optional `kind` (`"external"` for a hard-deadline, non-study task — a form, a visa renewal — excluded from the Load Index's required-minutes term but still counted toward actual on completion) and `reminderLeadDays` (days-before-due to surface in the morning brief, e.g. `[7, 2, 0]`); there's no separate `oneOff` flag since this app has no recurring-task concept at all, so every task is already one-off.

**`goals/{goalId}`** (Phase 6) — `title`, `horizon` (`week`/`term`/`break`/`year`/`phd`), an optional `termId` (only meaningful with `horizon: "break"`), optional `why`, required `definitionOfDone`, `milestones[]` (`id`, `title`, optional `dueAt`, `done`), `linked` (`courseIds`/`paperIds`/`taskIds`/`goalIds` — only `courseIds` has UI today), an optional `targetHoursPerWeek` that feeds the Load Index, `status`, `reviewCadence`, and an optional `lastReviewedAt`. See [Goals](#goals-goals) above.

`days/{date}` gained two optional Phase 6 fields: **`brief`** (the deterministic `MorningBrief` — see [The daily loop](#the-daily-loop--morning-brief--evening-rollup) above) and **`rollup`** (the `EveningRollup`, whose `taskDecisions`/`slotDecisions` are plain objects keyed by the proposal's array index as a string, tracking Accept/Dismiss so a proposal is never re-offered).

**`tiers/{tierId}`** is the one top-level, cross-user collection — `name`, optional `description`, `isDefault`, a `limits` object (`maxRevisionsPerDay`, `maxRevisionMinutesPerDay`, `aiMonthlyBudgetUsd`, `blobQuotaMb`), and `allowedModels` (a subset of `claude`/`gemini`). Readable by any signed-in user (so Settings can show your own plan), writable only via the Admin SDK — see [Tiers](#tiers) above. `users/{uid}` itself gained an optional `tierId` field pointing at one of these.

**`days/{date}`** is the merged per-day document — one read renders an entire day. It carries `session` (workday clock-in/out + hydration/break counters), `pinnedTaskIds` (today's pinned priorities), `scratchpad` (the free-text note), and `review` (the daily review fields), all as sub-objects on one doc rather than four separate collections.

Daily schedules embed ordered `slots[]` on the schedule document for fast dashboard reads. Each slot has `id`, `title`, `type` (including `class` for course sessions), `startTime`, `endTime`, optional `assignedTaskIds`, optional `note`, `status`, and optional `color`. Templates use the same slot shape plus an `isDefault` flag, and can be applied to a date without mutating the source template.

**Terms** have a `kind` (`semester`/`break`/`none`) and a date range; **courses** optionally reference a `termId`, carry their own optional `startDate`/`endDate` (falling back to the term's), an optional `targetMinutesPerWeek`, and embed a `sessions[]` array of weekly recurrences (`dayOfWeek`, `startTime`, `endTime`, optional `location`) expanded per-date by `lib/courses.ts`. `status` is stored (`active`/`completed`/`dropped`) but the app always displays and filters on the *derived* status (`lib/courses.ts`'s `effectiveCourseStatus`), which treats a course past its end date as completed regardless of the stored value.

**Checkpoints** (nested under a course) are quizzes/labs/assignments/exams — `type`, `title`, `dueAt`, optional `weightPct`, `requiresPrep`/`prepLeadDays`/`prepEstimateMin` (defaulted by type), `topicIds`, `status`, and an optional `result: {score, max, notes}`. **Class logs** (also nested, doc id = date) carry `attendance`, the `topicIds` created/matched when it was saved, the raw typed-in text, an optional `understanding` rating, and optional notes. **Topics** are flat and cross-course (`users/{uid}/topics`, filtered by a `courseId` field) so they can outlive an individual course — they carry a `confidence` rating, `active`/`retired` status, and an optional `revisionItemId` link.

**Revision items** are flat (`users/{uid}/revisionItems`) — one per topic under review, with `ladderIndex`, `dueDate`, `reps`/`lapses`, `suspended`, and an optional `retiredAt` once it's fallen off the ladder. The due-items query (`suspended == false && dueDate <= today`, ordered by `dueDate`) needs a composite index — `firestore.indexes.json` declares it; apply it with `pnpm ensure:indexes` (uses the same service account as the migration scripts, but needs a GCP IAM role beyond what a fresh Firebase Admin key gets by default — if it 403s, either grant that role in the Cloud Console or just open `/review` signed in once and click the "create index" link Firestore prints in the browser console, which creates the identical index).

AI insights store one document per date with the generated `summary`, `suggestions[]`, which `provider` produced it, whether it came from a manual click or the cron job, and an optional `degraded` flag when it's the rule-based fallback. `meta/settings` holds the synced theme, reminder intervals, break-mode template choice, and revision daily caps. `meta/blobUsage` holds a single `totalBytes` counter for the paper-PDF soft cap (see Files, below) — separate from `usage/{yyyy-MM}`, which accumulates a monthly Firestore read/write count (see the dev usage overlay above) plus, since Phase 4, an `ai` sub-object (`inputTokens`, `outputTokens`, `estimatedCostUsd`, `runsByTask`, `runsByProvider`) that the budget guard reads before every AI call — both reset every month, since blob storage is cumulative and doesn't.

**`aiRuns/{runId}`** is an append-only audit log — one document per provider *attempt* (not per task call; a task that fails over from Claude to Gemini writes two), with `task`, `provider`, optional `model`/token counts/`costUsd`, `latencyMs`, `ok`, and an optional `error`. **`aiJobs/{jobId}`** tracks a longer-running AI task's status (`queued`/`running`/`partial`/`done`/`failed`), a `steps[]` array, and the final `output` — the client subscribes to this document directly instead of polling a status endpoint. **`alerts/{dedupeKey}`** holds deduped, severity-tagged (`critical`/`important`/`general`) signals from the daily triage rules, keyed so the same condition on the same day never creates a second document; an optional `resolvedAt` marks one dismissed.

**`admin/settings`** is the one Firestore location in the whole schema that is *not* under `users/{uid}` and *not* readable by any client rule at all — Admin SDK only, always, cached 60s server-side (`lib/admin-settings.ts`) so a runtime switch doesn't cost a Firestore read per request. Holds `ollama` (`enabled`, `baseUrl`, `model`, `fallbackModels`, `timeoutMs`, `maxConcurrent`, `health` — see [AI layer v2](#ai-layer-v2)) plus the [Admin panel](#admin-panel-admin)'s runtime switches: `aiGloballyEnabled`, `cronEnabled`, `maintenanceMode`, `chainOrder`, `signInMethods`, `signupMode`/`allowedEmailDomains`/`maxActiveUsers`, `defaultUserBudgetUsd`/`defaultUserBlobMb`, and `ownerBootstrapped`. **`admin/auditLog/entries/{entryId}`** is the append-only log every mutating admin route writes to (`actorUid`/`actorEmail`, `action`, `targetType`/`targetId`, optional `before`/`after`). **`admin/cronRuns/entries/{name}`** records each cron's last outcome for the overview screen ("last ran", never "next runs at" — Hobby crons fire ±59 min). **`admin/locks/ollama/counter`** is the Firestore-transaction concurrency guard for `maxConcurrent`. **`adminJobs/{jobId}`** tracks a resumable admin-triggered job (currently just user deletion — `kind`, `targetUid`, `exportFirst`, `status`, `exportUrl`, `deletedCollections[]`). **`invites/{email}`** (doc id = a sanitized lowercased email) holds a pending invite's `tierId`, claimed and deleted the first time that email signs in. All five of these non-`admin/settings` locations share the same "Admin SDK only" access pattern.

**Papers** carry an optional `goal`/`goalKind` (required before Pass 1 can start), up to three `pass1`/`pass2`/`pass3` objects (`status`, `startedAt`, `completedAt`, `minutes`, and a pass-specific `output` — see `types/index.ts`'s `Pass1Output`/`Pass2Output`/`Pass3Output`), a derived `progress`/`status` (see `lib/papers.ts`), an optional `fileId` pointing at a `files/{fileId}` doc, `groupIds` (currently always `[]` on the paper — group membership is tracked the other way around, from `paperGroups/{groupId}.paperIds`), an optional `anthropicFileId` (the cached Files API upload, cleared whenever `fileId` changes), and an optional `layeredNotes` object (Phase 5 — see [above](#layered-notes-and-pdf-annotation-phase-5)). **Paper notes** (nested) carry a `kind`, `body`, and optional page/quote anchor fields (still unused by any feature — the annotation pipeline uses the separate `annotations` subcollection below instead). **Paper annotations** (nested, Phase 5) carry a `quote`, `category` (`claim`/`method`/`result`/`limitation`/`definition`/`weakness`), an optional `note`/`layer`, `source` (`ai`/`manual`), and `matched` — a matched one additionally carries `page` and `quads[]` (`HighlightQuad`, unscaled PDF page-space coordinates); an unmatched one has neither and surfaces in the annotation sidebar instead. **Paper groups** carry `paperIds`, a `kind` (`cluster`/`survey`), an optional `revisionItemId` once a group revision has been started, an optional `survey` state object, and an optional `lastSynthesis`. **Files** are Vercel Blob metadata only (`url`, `pathname`, `bytes`, `contentType`, `linkedTo`) — the PDF bytes themselves live in Blob storage, never in Firestore.

Suggested Firestore rules (covers all of the above, since everything lives under `users/{uid}`):

```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /tiers/{tierId} {
      allow read: if request.auth != null && request.auth.token.get('role', 'member') != 'disabled';
      allow write: if false;
    }
    match /admin/{document=**} {
      allow read, write: if false;
    }
    match /adminJobs/{document=**} {
      allow read, write: if false;
    }
    match /invites/{document=**} {
      allow read, write: if false;
    }
    match /users/{userId} {
      allow read, write: if request.auth != null
                         && request.auth.uid == userId
                         && request.auth.token.get('role', 'member') != 'disabled';
      match /{document=**} {
        allow read, write: if request.auth != null
                           && request.auth.uid == userId
                           && request.auth.token.get('role', 'member') != 'disabled';
      }
    }
  }
}
```

`tiers/{tierId}` is deliberately readable by any signed-in, non-disabled user (so a Settings page can show your own plan's limits) but writable by nobody through the client rules — only the Admin SDK (`/api/admin/tiers*`, or `scripts/manage-tiers.mjs`) can create, edit, or delete one. `admin/**`, `adminJobs/**`, and `invites/**` are closed to every client entirely, read and write both — nothing under any of them is ever meant to reach the browser. The `.get('role', 'member')` — not a bare `.role` — matters: almost every account predates the role-claims system and has no `role` custom claim at all, and dot-accessing a map key that doesn't exist raises a rules-evaluation error (denying the request) rather than returning `null` the way it would in JavaScript. `.get(key, default)` is the safe map lookup that treats "no claim yet" as `'member'`, matching `lib/api-auth.ts`'s server-side default. This check is what actually cuts off a disabled account's data access at the database layer, not just at the API layer — a role change takes effect the moment the client's ID token next refreshes, forced immediately server-side via `revokeRefreshTokens` (see [Admin panel](#admin-panel-admin)).

Note that these client-facing rules don't apply to the AI API routes (`/api/ai/**`, `/api/insights`, `/api/cron/daily-insight`) or `/api/admin/**` — they use the Firebase Admin SDK with a service account, which bypasses Firestore security rules entirely by design, gated instead by the caller's `role` claim (`lib/api-auth.ts`'s `verifyActiveUser`/`verifyAdminRequest`) and, for AI calls specifically, each caller's tier's `allowedModels` (see [Tiers](#tiers)).

`firestore.indexes.json` declares Phase 2's revision-queue index (see above) plus three the admin panel's overview/audit screens need: a collection-group index on `aiRuns` (`ok` + `at`, for the five-most-recent-failures widget) and two on the audit log's `entries` subcollection (`actorUid`/`action` each paired with `at`, for filtering). Apply all of them with `pnpm ensure:indexes`, `firebase deploy --only firestore:indexes` (Firebase CLI, project linked first), or by letting Firestore's own error link create the specific one a query needs the first time it runs.

## Vercel Deployment

1. Push the repository to GitHub.
2. Import the project in Vercel.
3. Add the six `NEXT_PUBLIC_FIREBASE_*` environment variables, plus (if you want the AI layer) `ANTHROPIC_API_KEY` and/or `GEMINI_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_BASE64`, `CRON_SECRET`, and `BOOTSTRAP_OWNER_EMAIL` (your own email, to claim the `owner` role on first sign-in), plus (if you want paper PDF uploads) `BLOB_READ_WRITE_TOKEN`, in Project Settings. If you provision Vercel Blob through the Vercel dashboard's Storage tab on this same project, it can set `BLOB_READ_WRITE_TOKEN` for you automatically. See `.env.example` for the full optional set (model overrides, budget ceiling, Ollama secrets).
4. Deploy with the default Next.js settings.
5. Add the Vercel domain to Firebase Authentication authorized domains.
6. `vercel.json` pins the deployment region to `bom1` (Mumbai) and declares three daily crons: `/api/cron/daily-insight` at 06:00 UTC, and (Phase 6) `/api/cron/morning-brief` at 00:30 UTC and `/api/cron/evening-rollup` at 16:30 UTC — 00:30/16:30 UTC being the plan's "~06:00/~22:00 IST" targets converted for Hobby's UTC-only cron scheduling (unlike `daily-insight`, which was left at a round UTC hour rather than IST-converted — an existing inconsistency, not something this phase changed). It also sets `maxDuration` on the AI routes (120s for `/api/ai/run`, `/api/ai/papers/[paperId]/layered-notes`, `/api/ai/papers/[paperId]/highlights`, and `/api/cron/evening-rollup`/`/api/daily-loop/rollup` since both call the `review.eod` AI task; 300s for `/api/ai/jobs`) and the two user-deletion job routes (300s each, for `/api/admin/users/[uid]/delete-job` and `/api/admin/jobs/[jobId]`) — adjust any of these if you want a different region, time, or budget. Vercel's Hobby plan allows cron jobs no more often than once a day; all three are already daily, and three total is well within Hobby's 100-cron limit.
7. Sign in once with the `BOOTSTRAP_OWNER_EMAIL` account to claim the owner role, then visit `/admin` — see [Admin panel](#admin-panel-admin).

## Migrating existing data (Phase 0 upgraders only)

If you used FocusOS before this rewrite, you may have data in the now-removed `thoughts`, `thoughtSelections`, `weeklyGoals`, `dailyNotes`, `dailyPlans`, `dailyReviews`, and `workdaySessions` collections. `scripts/migrate-phase0.mjs` backs all of it up to a local JSON file, then (opt-in) merges the day-shaped collections into `days/{date}` and (opt-in) deletes the old documents:

```bash
export FIREBASE_SERVICE_ACCOUNT_BASE64=$(base64 -i serviceAccountKey.json)
pnpm migrate:phase0 -- --uid=<your-firebase-uid>              # dry run: backs up only
pnpm migrate:phase0 -- --uid=<your-firebase-uid> --migrate     # also writes merged days/{date} docs
pnpm migrate:phase0 -- --uid=<your-firebase-uid> --migrate --delete   # also deletes the old collections
```

The old free-text "Top 3 priorities" (`dailyPlans.priorities`) can't be auto-converted to pinned task ids — they aren't real tasks — so the script prints them for you to re-pin manually and preserves them in the backup JSON either way.

If you created courses/assignments before Phase 1, `scripts/migrate-phase1.mjs` converts the old flat `courseAssignments` collection into `courses/{courseId}/checkpoints` docs (`type: 'assignment'`), same dry-run/`--migrate`/`--delete` flow:

```bash
pnpm migrate:phase1 -- --uid=<your-firebase-uid>
pnpm migrate:phase1 -- --uid=<your-firebase-uid> --migrate
pnpm migrate:phase1 -- --uid=<your-firebase-uid> --migrate --delete
```

An assignment's `grade`/free-text `notes` field has no equivalent on `Checkpoint` (its `result` is a numeric score/max) — the script prints anything it couldn't carry over and leaves it in the backup JSON.

Phase 2 doesn't move or cut any data, so there's no `migrate-phase2` script — just apply the new composite index (`pnpm ensure:indexes`, see the Firestore Schema section above) before relying on `/review`.

If you added papers before Phase 3, `scripts/migrate-phase3.mjs` backfills them with the new fields — it synthesizes `pass1`/`pass2` completion (and a `progress` value) from the paper's old flat `status`, so a paper you'd already marked "read" shows up with sensible pass history instead of resetting to "to read." It deliberately does **not** invent a `goal`/`goalKind` — those stay unset on migrated papers, and you're prompted for them the next time you start a pass:

```bash
pnpm migrate:phase3 -- --uid=<your-firebase-uid>              # dry run: backs up only
pnpm migrate:phase3 -- --uid=<your-firebase-uid> --migrate     # backfills pass1/pass2/progress on old papers
```

There's no `--delete` step for this one — nothing old is removed, only new fields are added to existing documents.

## Architecture

The app uses client components for authenticated Firebase workflows and keeps reusable logic in `lib`, `hooks`, `types`, and `components`. Protected routes live under `app/(app)`, while `/login` is public. Firestore helper functions in `lib/firestore.ts` centralize collection paths and mutations, and every read/write funnels through `lib/usage.ts`'s counters (see the dev usage overlay above).

Schedule logic lives in `lib/schedule.ts` (time parsing, overlap validation, active slot detection, progress calculations, deep work summaries, template generation) and `lib/courses.ts` (expanding a course's weekly sessions into that day's schedule slots, deriving course status, resyncing future schedules). The dashboard widgets are reusable client components that subscribe through the existing `useUserCollection` hook (bulk collections) or `useDay` (the merged per-day doc); `components/workday-session-provider.tsx` owns the start/end-of-day ritual, the hydration/break reminder timers, and (at "End day") computing and persisting the Load Index snapshot, mounted once in `app/(app)/layout.tsx`. `useUserSettings` syncs theme, reminder intervals, and revision caps through `users/{uid}/meta/settings`.

The revision engine is three small, pure, client-side modules with no server dependency: `lib/revision.ts` (the ladder, grading, queue building — due-item fetching plus daily-cap/resurfacing/pull-forward logic), `lib/loadindex.ts` (the required/actual/band computation, plus Phase 6's Debt/Coverage/Streak), and `lib/next-action.ts` (the dashboard's priority cascade). `lib/classlog.ts` wires class logging to topic creation and, transitively, to seeding each new topic's `RevisionItem`.

**Goals and the daily loop** (Phase 6) follow the same pure-logic-plus-thin-server split as the rest of the app. `lib/goals.ts` is pure and client-safe (`isGoalActiveForDate`'s break-term scoping, `goalTargetMinutesForDay`, `overdueMilestones`/`upcomingMilestones` — the latter two shared by both the client Weekly Review and the server-side triage/brief code) and `lib/dailyloop.ts` is pure too (`buildMorningBrief`, `buildProposedTasks`, `buildProposedSlots` — no Firestore, no AI call inside any of them). The server half, `lib/admin-dailyloop.ts`, is the only place that actually calls an AI task (`review.eod`, for the rollup's `summary`/`improvements`) or touches Firestore — `generateMorningBrief`/`generateEveningRollup` are each called from three places with identical behavior: their cron (`app/api/cron/morning-brief`, `app/api/cron/evening-rollup`), the on-demand routes (`app/api/daily-loop/brief`, `app/api/daily-loop/rollup`), and — for the rollup specifically — "End day" (`components/day-session-bar.tsx`, fired best-effort, not awaited, since the Daily Review page it navigates to has its own "Generate" fallback).

The papers subsystem follows the same pure-logic-plus-thin-UI split: `lib/papers.ts` (progress/status derivation, the Pass 1 goal gate, calibration, drop rate), `lib/papergroups.ts` (the computable shared-citations/repeated-authors survey logic), and `lib/paperrevision.ts` (seeding a `RevisionItem` for a parked paper or a Pass 3 structure-recall grade) have no Firestore or network dependency and are unit-testable in isolation. `components/paper-pass-section.tsx` is the one large stateful component — it owns starting/finishing a pass, the pass-specific forms, and the pomodoro-session write on completion; `lib/pdf-outline.ts` is a separate client-only module (guards against SSR) wrapping `pdfjs-dist` for the Pass 3 outline extraction and (Phase 5) the `hasTextLayer` scanned-PDF check.

**Phase 5's PDF-ingest pipeline** adds a server half and a client half, kept as separate as the AI layer's own split. Server, never imported from a client component: `lib/ai/anthropic-files.ts` (`uploadPdfToAnthropic`, a one-line wrapper over `@anthropic-ai/sdk`'s `client.files.upload`) and `lib/admin-papers.ts` (`ensureAnthropicFileId` — the caching logic, reading the paper's attached `FileRef` and writing the resulting `file_id` back onto the paper doc via the Admin SDK); `app/api/ai/papers/[paperId]/layered-notes/route.ts` and `.../highlights/route.ts` are dedicated routes rather than going through the generic `/api/ai/run`, since resolving the cached file needs the Admin SDK in a way the client can't do itself — both fetch the paper, `ensureAnthropicFileId`, then call the normal `runAiTask`. Client, entirely new modules: `lib/pdf-annotate.ts` (the quote-matching pipeline — per-page text indexing with dehyphenation/ligature-folding, exact-then-fuzzy matching with an anchor-word prefilter, and per-line quad merging) and `lib/pdf-export.ts` (`buildAnnotatedPdfBytes`, constructing real `pdf-lib` `/Subtype /Highlight` annotation dictionaries via its low-level object API, since pdf-lib has no high-level "add highlight" helper). `components/paper-annotation-viewer.tsx` renders the PDF to a `<canvas>` via `pdfjs-dist`, overlays a custom invisible positioned-span text layer (built directly from the same per-item geometry `lib/pdf-annotate.ts` computes for highlight quads, rather than `pdfjs-dist`'s own `TextLayer` class) to enable native text selection for manual highlights, and overlays colored divs for existing matched highlights. `components/layered-notes-card.tsx` is the simpler of the two — a generate button and a read-only rendering of the L0-L3 structure plus a copy-to-clipboard `promptPack`.

Files are the one place a client component talks to a Vercel product directly: `lib/files-client.ts` calls `@vercel/blob/client`'s `upload()` against `/api/files/upload-token` (`app/api/files/upload-token/route.ts`, using `@vercel/blob`'s `handleUpload` helper), and writes the resulting `FileRef` and a `usage/blobUsage` byte increment through the normal `lib/firestore.ts` functions once the browser-to-Blob transfer finishes — there is no server-side webhook callback in the loop, which is also why it works unmodified in local dev (Vercel's `onUploadCompleted` webhook needs a publicly reachable URL; this app never relies on it). Deleting a file goes through `app/api/files/[id]/route.ts` instead, since Blob deletion needs the read-write token the browser never holds.

Anything that needs a secret or must run unattended lives server-side under `app/api/**`, using `lib/firebase-admin.ts` (Firebase Admin, initialized from `FIREBASE_SERVICE_ACCOUNT_BASE64`, and the one place `db.settings({ignoreUndefinedProperties: true})` gets applied so every admin-side writer can safely build a patch with optional fields left `undefined` — wrapped in a try/catch that swallows the specific "already initialized" error dev-mode hot reload can trigger, since Turbopack Fast Refresh resets this module's own guard flag while firebase-admin's underlying app/Firestore singletons survive the reload), `lib/api-auth.ts` (`verifyActiveUser`/`verifyAdminRequest` — the shared ID-token-plus-role check every route starts with, replacing the old `OWNER_UIDS` allowlist), `lib/admin-tiers.ts` (the tier resolver — see below), and `lib/ai/**` (the full task-registry provider chain — see [AI layer v2](#ai-layer-v2)). `app/api/insights/route.ts` and `app/api/ai/run/route.ts`/`app/api/ai/jobs/route.ts` all start with `verifyActiveUser`, then let `runAiTask` apply the per-task tier/budget check; `app/api/cron/daily-insight/route.ts` is gated by `CRON_SECRET` and `admin/settings.cronEnabled`, looping `lib/admin-users.ts`'s `getActiveUids()` (every non-disabled `users/{uid}` document, not a fixed allowlist). None of these modules is ever imported from a client component, so no server secret reaches the browser bundle. The two file routes verify the caller's Firebase ID token the same way, reject a `disabled` role, and additionally check the caller's effective Blob quota (`resolveUserTier`'s `effectiveBlobQuotaMb` against the sum of their existing `files/*.bytes`) before issuing an upload token.

Tiers are a shared-collection exception to the usual "everything lives under `users/{uid}`" rule: `lib/tier-defaults.ts` holds the pre-tier hardcoded fallback values with no framework imports, so both the client hook (`lib/tiers.ts`'s `useUserTier`, subscribes to `tiers/*` and the user's own `tierId`) and the server resolver (`lib/admin-tiers.ts`'s `resolveUserTier`/`isModelAllowedForUser`, used throughout the AI layer) fall back identically when no tier is configured. `resolveUserTier` also reads the calling user's own per-user overrides (`aiEnabled`, `monthlyBudgetUsd`, `blobQuotaMb`) in the same Firestore read, since the admin panel's per-user budget/quota editing (§3.1) needed somewhere to resolve "the tighter of the tier and the override" without a second round trip. `lib/admin-tier-crud.ts` holds the actual create/update/delete/set-default/assign mutations, shared by both `/api/admin/tiers*` and `scripts/manage-tiers.mjs` — the collection's Firestore rule blocks client writes entirely either way.

The AI layer (`lib/ai/**`) splits cleanly into a client half and a server half. Client: `lib/ai/client.ts` (`callAiTask`/`startAiJob`, the fetch wrappers every AI button uses). Server, never imported from a client component: `lib/ai/tasks.ts` (the registry), `lib/ai/schemas.ts` (zod schemas), `lib/ai/run.ts` (`runAiTask`, the orchestrator — now also checking `admin/settings.aiGloballyEnabled`/`chainOrder` before anything else), `lib/ai/providers/*.ts` (Claude/Gemini/Ollama call wrappers — `providers/ollama.ts` additionally exports `testOllamaConnection`, an uncached fresh probe for the admin panel's "Test connection" button, distinct from the cached `probeHealth` the chain itself uses), `lib/ai/circuit-breaker.ts`, `lib/ai/budget.ts`, `lib/ai/aiRuns.ts`, `lib/ai/triage.ts` (pure, no Firestore dependency — `lib/admin-alerts.ts` wraps it with the actual reads/writes), `lib/ai/pricing.ts`, and `lib/ai/ollama-validate.ts`/`lib/admin-ollama-settings.ts` for the local-model config. `lib/ai/prompt.ts` is the one holdover from the pre-registry insight feature — `buildInsightPrompt` and its new sibling `buildInsightFallback` are both still keyed off the same `InsightData` shape from `lib/admin-firestore.ts`.

### Admin panel internals

`app/(admin)/admin/**` is a separate route group from `app/(app)/**`, with its own client-side layout (`app/(admin)/admin/layout.tsx`) that checks the `role` claim from `useAuth()` and calls Next's `notFound()` for anyone who isn't `owner`/`admin` — a UX nicety only, since every route below independently re-verifies the claim server-side, which is the actual boundary. Every screen is a client component fetching through `lib/admin-client.ts`'s `adminFetch` (the same thin ID-token-attaching wrapper pattern as `lib/ai/client.ts`).

Server-side, one module per concern, none ever imported from a client component: `lib/admin-roles.ts` (`setUserRole` — claim + `revokeRefreshTokens` + Firestore mirror + audit, and `bootstrapOwnerIfNeeded`), `lib/admin-settings.ts` (the 60s-cached `admin/settings` resolver), `lib/admin-audit.ts` (`writeAuditEntry`, called from every mutating route), `lib/admin-users.ts` (`listUsers`/`patchUser`/`getActiveUids`/`listAllUids` — `patchUser` is also where a `status` change and a `role` change are kept in lockstep, since disabling is authorized from the `role` claim but the admin screen lets you toggle either field), `lib/admin-tier-crud.ts` (above), `lib/admin-user-delete.ts` (the resumable deletion job — `adminJobs/{jobId}`, four ordered stages: export via a generic recursive Firestore subcollection walk uploaded to Blob if `BLOB_READ_WRITE_TOKEN` is set (skipped, not failed, if it isn't) → Blob prefix delete → `adminDb().recursiveDelete()` on the user's Firestore doc → `adminAuth().deleteUser()` last, so a mid-way failure still leaves an identifiable, retryable account), `lib/admin-invites.ts` (email-keyed pending invites, claimed on next sign-in), `lib/admin-cron-log.ts` (`admin/cronRuns` — durable "last ran" record, since Hobby only keeps an hour of runtime logs), `lib/admin-overview.ts` and `lib/admin-usage.ts` (the two aggregate-reporting screens, both iterating a bounded uid list rather than a Firestore `collectionGroup` query for `usage`/`files`, to avoid needing extra collection-group indexes for a query that's naturally bounded by `maxActiveUsers` anyway).

## Development Notes

- Firestore is the production database. Theme and reminder intervals sync per-account via `users/{uid}/meta/settings`, with a `localStorage` value used only as the very-first-paint fallback before the synced value loads.
- The current AI insight prompts are intentionally lightweight and derived from the user's recent records — no server-side aggregation or caching yet beyond what's described above.
- Reminders only fire while a workday session is active and the tab is open; browser Notification permission is requested the first time you click "Start day".
- Known gaps worth knowing about before relying on them: no actual pomodoro completion sound, calendar class blocks can drift from already-saved schedule snapshots after editing a course, workday sessions don't automatically roll over at midnight without a page refresh, and a pass's calibrated-estimate function exists but isn't wired into the timer display yet (it always shows the fixed seed minutes).
- The circuit breaker for Claude/Gemini/Ollama (`lib/ai/circuit-breaker.ts`) is in-memory per serverless instance, not Firestore-backed — it resets on a cold start rather than persisting its 10-minute open window across instances. Acceptable since a cold start is itself a fresh start; a persistent version would cost a write on every single failure.
- The admin panel's `signupMode: 'closed'` is a policy flag read by the invite flow, not an actual gate on Firebase Auth sign-in — a determined visitor with sign-in enabled at the Firebase project level can still create an account (they just land on `member` with the default tier's limits, unable to reach anything without an invite/role from an admin). The overview screen's free-tier meters are month-to-date, not a true daily rollover — there's no per-day usage tracking to read from yet. The audit log has no automatic expiry sweep despite the 180-day retention the spec names — nothing currently deletes an old entry.

## Roadmap

FocusOS is being rebuilt in phases toward a much larger spec — see `plan/FocusOS-v2-Plan.md` (plus `plan/FocusOS-v2-Admin-Panel.md` and `plan/FocusOS-v2-Focus-Design.md`) for the full plan. **This README describes Phase 0 (Foundation and cuts) through Phase 6 (Goals, daily loop, alerts).** Still to come:

1. ~~Terms, Courses v2, class logs, checkpoints~~ — **done**: terms, derived course status/date bounds, break mode, a real class-log workflow with topic creation, checkpoints replacing flat course assignments, and future-schedule regeneration when a course's sessions change. Not yet built from the fuller spec: AI-assisted topic splitting (rule-based only for now, by design — Phase 4 adds the AI task with this as its fallback), and auto-generated "prep block" schedule slots for checkpoints (deferred to whenever the Phase 6 accept/edit/dismiss proposal UI lands, since a silently-scheduled block with no review step is exactly the "auto-applied AI plan" anti-pattern the companion design doc warns against).
2. ~~Revision engine + Load Index~~ — **done**: the ladder, one-card-at-a-time review with keyboard grading, daily cap/resurfacing/checkpoint-pull-forward, the Load Index computation plus its dashboard widget and 30-day trend chart, and the Next Action card. Not yet built: Debt and Coverage-per-course metrics, an LI-based streak, and the Critical/Important alerts + evening-rollup automation that's supposed to write the Load Index snapshot on its own — "End day" is standing in for that trigger for now.
3. ~~Files + Papers v2~~ — **done**: Vercel Blob PDF uploads (optional, degrades to link-only without a token), the full 3-pass reading workflow with a persisted-timer that survives a refresh, paper notes, paper groups with the computable survey-mode citation/author intersection, and a `paperGroup`-kind card in `/review`. Not yet built from the fuller spec: automatic pass-estimate calibration wired into the timer UI (the function exists, nothing calls it yet), and stages 1/3/4/5 of survey mode (only stage 2's citation/author computation is automated — the rest is manual bookkeeping via the `kind: "survey"` flag).
4. ~~AI layer v2~~ — **done**: the task-registry provider chain (local Ollama → Claude → Gemini → rule-based fallback), zod schema validation, per-provider circuit breakers, `aiRuns`/`aiJobs`, the budget guard, and deterministic triage + deduped `alerts`, replacing the old single `AI_PROVIDER` switch — see [AI layer v2](#ai-layer-v2) above. Wired into real buttons: `paper.readingPlan`, `checkpoint.prepPlan`, `paper.passAssist`, `group.synthesis` (via the job system), `insight.daily` (the ported `/insights` feature), and (Phase 5) `paper.layeredNotes`/`paper.highlightCandidates`. Registered but not yet wired to a button: `course.splitTopics` (kept out of the class-log form deliberately, to protect Phase 1's "log a class in ≤15s" goal), and `plan.tomorrow`/`review.eod` (waiting on Phase 6's actual daily-loop UI to have somewhere to render into).
   - **Tiers** — admin-creatable/deletable plans (`tiers/{tierId}`) bundling a revision-item/minute cap, an AI monthly budget, a PDF storage quota, and an allowed-AI-provider list per plan, all four enforcement points live, now with a full `/admin/tiers` screen (see below).
5. ~~Admin panel~~ — **done**: Firebase custom-claim roles (`owner`/`admin`/`member`/`disabled`) replacing `OWNER_UIDS` everywhere, an owner-bootstrap flow, `/admin` overview (provider status, spend, free-tier meters, cron history, recent failures), `/admin/users` (search/filter, role/status/tier/budget/quota edits, force sign-out, invite, resumable job-based deletion), `/admin/tiers`, `/admin/ollama` (address + SSRF validation + live test/model-picker + health strip), `/admin/usage`, `/admin/settings` (the `aiGloballyEnabled` kill switch, `cronEnabled`, `maintenanceMode`, sign-in method toggles), and a read-only `/admin/audit` log — see [Admin panel](#admin-panel-admin) above for the full breakdown, including which parts of the spec were deliberately simplified (month-to-date meters standing in for daily, `signupMode` as a policy flag rather than a Firebase Auth-level gate, no audit-log expiry sweep).
6. ~~Layered notes + PDF annotation~~ — **done**: Anthropic Files API upload-and-cache (`Paper.anthropicFileId`), the `paper.layeredNotes`/`paper.highlightCandidates` tasks (Claude-only, no fallback), the client-side quote-matching pipeline (exact + anchor-prefiltered fuzzy match, per-line quad merging), a highlight overlay with native-text-selection manual highlighting, `pdf-lib`-based export to a real annotated PDF, and scanned-PDF detection — see [Layered Notes and PDF annotation](#layered-notes-and-pdf-annotation-phase-5) above for the full breakdown, including the two things cut from the original spec (`relatedInLibrary`, manual figure-box drawing) and the token-budget bug the live Anthropic test caught and fixed.
7. ~~Goals, daily loop, alerts~~ — **done**: the Goals subsystem (milestones, horizons, break-term scoping — see [Goals](#goals-goals) above) feeding the Load Index's `goalTargetMinutes` term; external one-time tasks (`Task.kind: "external"`); the morning brief (deterministic, no AI) and evening rollup (`review.eod` AI task for prose, deterministic `proposedTasks`/`proposedSlots`) with Accept/Edit/Dismiss, on two new crons plus on-demand generation and an "End day" trigger; Debt/Coverage/Streak on the Load Index; and the Weekly Review rebuilt around goals + the LI trend. The deterministic triage rules built in Phase 4 now cover goal-milestone-overdue and external-task-due-soon too — see [The daily loop](#the-daily-loop--morning-brief--evening-rollup) above for what's still cut (`unloggedClasses`, per-goal hours attribution).
8. **Polish** — a fully complete data export, an error log (Vercel Hobby only keeps an hour of runtime logs), and general cleanup.

The former local MCP server was deleted in Phase 0, per the plan's own recommendation — it duplicated the JSON export's purpose, bypassed Firestore rules via a service account, and would only have grown more out of sync with the schema as later phases land.
