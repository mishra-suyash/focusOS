# FocusLab overnight run — log

Status: FINISHED 03:33 Sun — all planned and follow-up checks done; no stop condition hit.
Next: none — see final-report.md.

## Usage readings
- 14:40 Sat (planning): 5h 16% (resets 18:40), 7d 63% (resets Sun 03:30)

- 22:24 Sat: 5h 17% / 7d 67%
- 23:14 Sat: 23% / 67%
- 00:23 Sun: 30% / 68%
- 00:29 Sun: 36% / 69% (≈1%/min while fixing)
- 00:43 Sun: 46% / 70%
- 01:10 Sun: 50% / 70%
- 01:57 Sun: 66% / 73% (jumped 16 pts over a mostly idle 45 min)
- 02:04 Sun: 72% / 73%
- 02:53 Sun: window reset (5h n/a), 7d 73%
- 03:09 Sun: 12% / 75%
- 03:29 Sun: 31% / 77%
- 21:59 Sat (start): 5h 0% (resets 02:50 Sun), 7d 65% (resets 03:30 Sun)

## Checklist
- [x] Preflight 1–6
- [x] P1 Semester setup (22:15)
- [x] P2 Plan the week (22:40) — week 11-02 accepted (Sat 11-07 off), 23h25m placed
- [x] P3 Midnight crossing (00:23)
- [x] P4 Sunday workday (00:40; block-close seam not testable live — see F26)
- [x] P5 Review & analytics
- [x] P6 Robustness (390px layout skipped)
- [x] P7 Final report (03:33)

## Results
- Preflight: dev server OK (slow-FS warning, first compile 14s); signed in suyashbima@; branch qa/overnight-2026-11-01.
- Baseline (export captured in-page, no file saved): courses 1, papers 4, tasks 2, days 6, dailySchedules 18,
  revisionItems 1, weeklyReviews 1, files 1, terms 0, dayTemplates 0. Settings: Premium tier, focus preset 25m.
- P1 data created (test acct): settings longest 60/shortest 20, reading 4×45 mornings; term "Monsoon 2026" 08-01→12-15;
  routine: gym enabled Mon/Wed/Fri 17:30–18:30, weekly planning Sun 18:00–18:30 (sleep 23:00–07:00, meals pre-existing);
  courses: "Machine Learning Theory" CS 721 Tue+Thu 10:00–11:30 rev 3h/wk (assessments: Problem set 3 due 11-05 10%,
  Midsem 11-12 30%, both needs-prep); "Research Methods" RM 600 Wed 14:00–16:00 rev 1h/wk; pre-existing "Test Course" Mon 09:00–10:30.
  tasks: related-work (writing, high, 6 sess, hard deadline, due 11-06), baselines (coding, high, 4, 11-04), PS3 Q1-4 (CS 721, 3, 11-05),
  email advisor (admin, 1, 11-01), RM slides (RM 600, 2, 11-09). Recurring: Lab group meeting Fri 15–16, Grade PS Mon (2 sess, untimed).
  Pre-existing recurring: TA meeting Wed 14–15 (CLASHES with RM 600 Wed 14–16), "Lunch overlap test" Fri 12–13 (overlaps lunch 12:30).
  papers: +URL-only Decision Transformer, +Levine offline-RL survey (high, tags). goal: workshop paper (term, 8h/wk, 2 milestones, linked RM 600).

## Findings
- F1 ❌ (low-med) Settings → Timezone select showed "Africa/Abidjan" while the stored/default value is Asia/Kolkata:
  Chrome's Intl.supportedValuesOf lists legacy "Asia/Calcutta", so the controlled value matched no option. FIXED e8abfb7.
- F2 ⚠️ (low, UX/a11y) Routine day pills: selected vs unselected nearly indistinguishable in dark mode (rgb(44,55,49) vs
  moss 15% alpha), and no aria-pressed. Not fixed (styling choice).
- F3 ⚠️ (low, UX) Tasks → Quick add → More options: estimate number box has no visible label/unit (only aria-label);
  the same field under Recurring commitments has placeholder "Focus sessions". components/task-form.tsx:98. Not fixed.
- F4 ⚠️ (low, UX) REVISED 23:15: task list has no overdue marker at all (components/task-list.tsx has no "overdue"):
  TA meeting due 10-14/10-21 looks like any future task. Missing 10-28 instance = Vercel cron (vercel.json) doesn't run
  locally — env artifact, not a bug. "In progress" = toggle button (N4). Not fixed (design).
- F5 ℹ️ (doc drift) README:501 says "this app has no recurring-task concept at all" but Tasks has Recurring commitments.
- N1 ℹ️ URL-only paper keeps the raw URL as its title — documented as not built (lib/paper-capture.ts:6). Not a bug.
- N2 ℹ️ "Generate prep plan" on assessments is AI (callAiTask) — skipped per owner.
- F6 ❌ (med) Week plan: an added milestone's later sittings ignore its due date — laterDays (plan/week/page.tsx:1011)
  = every day ≥ start; when capped, fallback (lib/weekplan.ts:416) uses any working day. "Baselines reproduced" due 11-04
  got its 8th sitting on Thu 11-05. No warning. Also hint "first at 16:00 on Mon, the rest on the days after" wrong:
  2 sittings went on Mon morning. Design call (didn't-fit vs warn) → not fixed.
- F7 ⚠️ (med, design) Each milestone due in the week asks the goal's full targetHoursPerWeek (page.tsx:952): two milestones
  of an 8h/wk goal = 16h, on top of "plus 8h of goal hours you plan yourself". Not fixed.
- F8 ❌ (med) Unplaced sitting row showed 5 min (00:00–00:00 → max(5,0)) and placed a 5-min block when given a day,
  below minChunk 20. FIXED 7bd6267 (components/plan/week-grid.tsx).
- F9 ❌ (med) Header "to place" > "asked in all" by 1h15m; ML Theory Assignment cell blank; would read "over" once placed.
  Bucket row ask = target (0h) ignored due task estimates (PS3 75m). FIXED 2ab10d6.
- F10 ❌ (low) "capped at 60minutes" / "at most 60minutes" — compiled JSX dropped the space. FIXED 47ef8d6.
- F11 ❌ (HIGH) Accept all silently fails for the whole week when two FIXED items clash on one day (recurring TA meeting
  Wed 14–15 vs RM 600 class Wed 14–16): validateSlots fails → setAcceptError("2026-11-04: TA meeting overlaps…") and
  return false before ANY write. Message reads like a warning, not "nothing was saved". Routine yields to fixed
  (page.tsx:315) but class-vs-commitment doesn't. Single accepts on other days work. Design call → not fixed.
  Workaround used: paused TA meeting 14–15, added TA meeting Wed 16–17.
- F12 ❌ (med) After accepting, checkpoint prep re-offered 9 × 15–22m sittings (< min 20) on days already holding their
  share; ask grew 23h10m→26h22m; would repeat each accept. FIXED (prep sharedDays) — verified 0h to place after.
  Data artifact left: Mon 11-02 has two PS3 prep sittings (10:30, 11:15).
- F13 ⚠️ (med) Midsem prep sittings 67 min > maxChunkMinutes 60 (pinned prep never chunked, page.tsx perDay). Timer
  clamp 60 → 89% ≥ 60% so still closes. Also pinned on Sun 11-08 ("Not a working day") by design. Not fixed.
- F14 ⚠️ (low) /plan/day: last Sleep block 23:00→ shows blank end time (24:00 not representable in time input).
- N3 ℹ️ "What's coming" Add-to-week additions are lost on reload (draft only); Day-off toggle persists.
- R1 ✅ Real session #1 (22:25:02→22:50:02, "Email advisor"): display accurate (24:57 at +3s), ended exactly at target,
  end cue played once at 22:50:02, no notification (tab visible — expected), survey shown; saved 4/5 + comment →
  Today history "25m · 4/5", stats 1 session / 25 min / streak 1d, workload 0.13 (25 of 190m). Break 05:00 shown
  (core.remainingSeconds stayed 1500 in idle short_break — display correct, harmless).
- F15 ⚠️ (low, a11y) End-of-session survey modal has no role="dialog"/aria-modal.
- F16 ⚠️ (med, seam) Completing a task early leaves its accepted future sittings (Email advisor Fri 11-06 11:15–11:40)
  on the plan with no "done" marker; they'll count against that day. Survey never asks "is the task done?". Not fixed.
- N4 ℹ️ Task card "In progress" is a toggle button, not a status label (misread, not a bug).
- R2 ✅ Skim (Offline-RL survey, reason related-work): started 22:53:19 as a 20-min session (armedMinutes 20; card says
  "about 7m usual"), opened arXiv in a new tab, ended exactly 23:13:19, app moved to /papers/<id>; "End of sitting"
  modal (page reached 12, Yes-done, 4/5) → "Save & finish the pass" saved & scrolled to #pass-1; chose Keep reading →
  "Finish Skim · Keep reading" → status Reading · Read next, "Skim done · 20m · Verdict: Keep reading". Flow coherent.
  Reading plan "Generate" is AI — skipped.
- N5 ℹ️ Reading card "This week: 0 of 4 sittings · 20 of 180 min" after the 20-min skim — minutes counted, not a sitting.
- R3a ✅ 00:01:08 mid-session after midnight: dashboard rolled to "SUNDAY, NOVEMBER 1" live (no reload), stats reset,
  timer 13:53 left = correct (end 00:15:01), cycle counter reset to 1, PiP shows "Sun · 00:01" + task, still open.
- F17 ❌ (HIGH, systemic) completedAt is UTC ISO (focus-session-provider.tsx:685) but 19 sites take its date with
  .slice(0,10)/.startsWith(localTodayKey): for IST, sessions finishing 00:00–05:30 land on the PREVIOUS day in
  dashboard stats/history, slot auto-close coverage (focus-session-provider.tsx:266 → slotAutoStatus 60% → day score),
  weekplan "worked" (weekplan.ts:675), courses accounting (courses.ts:232,302), analytics (5), papers, workday provider,
  day-timeline-editor, plan/week:1419; server admin-dailyloop.ts:56,179 (UTC cron — needs user tz).
  CONFIRMED in UI 00:17: session ended 00:15:01 Sun but Sunday dashboard showed 0 sessions/0 min/empty history
  (evidence-F17-sunday-zero-sessions.jpg in scratchpad). FIXED 5858fa9 (dateKeyOfIso, 15 files incl. paper-set dueDate +
  export filename). Verified: Sunday shows 1 session · 25 min · history 4/5 · workload 0.13 · streak 2d.
  Server lib/admin-dailyloop.ts:56,179 still UTC-sliced (cron; needs user tz) — NOT fixed.
- F18 ❌ (med) calculateStreak (analytics.ts:16) starts at today → "ACTIVE-DAY STREAK 0d" from 00:00 until the first
  session even if yesterday was active; same screen's workload card says "1-day streak" (a different LI≥0.9 streak) — confusing.
- F19 ⚠️ (med, design) Workload on Sun 00:01: "Behind · 0m done of 190m required today" though the week planner treats Sunday as
  "Not a working day". Cause: lib/loadindex.ts spreads course/goal weekly targets /7 over every day; only Day.dayOff
  exempts. Non-working days accrue catch-up debt unless marked off. Not fixed (product decision).
- R3 ✅ Session #3 23:50:01→00:15:01 across midnight: ended exactly, cue once 00:15:01, PiP → "SHORT BREAK 05:00 · LAST
  FOCUS", survey shown; saved 4/5. PiP opened on first real click (1306,23).
- R4 ✅ Start day (Sun 00:25): applied "Research Day" template + routine (Sleep, meals, Weekly planning 18:00) to Sunday.
- F20 ⚠️ (med) Start day banner: "Used the Research Day template… No plan for today. Your last weekly planning session was
  19 days ago" — contradictory right after applying a template, and ignores tonight's accepted week (only "Commit"
  counts). "Skipped 2 template blocks: Lunch, Advisor, lab meetings, email" reads as 4 items. Not fixed.
- F21 ⚠️ (med, invariant) Research Day template inserts Deep work 08:45–10:45 (120m) and 14:00–15:30 (90m) > maxChunk 60;
  timer clamps to 60 → needs 2 sessions to reach 60%. Template blocks bypass sitting bounds. Not fixed.
- F22 ⚠️ (low) Start day raised "required today" 190m → 400m (template work blocks count) on a non-working Sunday.
- F23 ❌ (med) During Sleep the Now card offered "Start focus · 7h"; clicking armed a 60-min focus session labelled
  "Sleep" (category personal) tied to the Sleep slot. Idle timer auto-follow (use-focus-context) and next-action start
  also followed rest blocks. FIXED 12d5e04 (REST_SLOT_TYPES shared from lib/schedule.ts). Verified: no Start focus on Sleep.
- R5 ✅ Abandon: Reset on a running session → idle, nothing logged, no survey, stats unchanged.
- F24 ❌ (med) FIXED 2cd77d6 — Reset keeps the block's context (touched) + armedMinutes: next Start for ANY task ran 60:00 (the
  abandoned Sleep sitting length) instead of 25:00 and could log to that block. reset() and setTaskId now drop
  slotId/armedMinutes/paperId/passNo/findPaper. Verified: re-picking task → 25:00. (Reset is disabled while idle.)
- F25 ⚠️ (low) Locked Sleep 00:00–07:00 means a late-night worker can't put a work block on today's plan (overlaps blocked).
- R6 ✅ Pause/resume (00:32–00:33): display frozen 24:50 for 30s, targetEnd shifted exactly +30s.
- R7 ✅ Two app tabs: tab 2 mirrored running session; Finish in tab 1 → logged ONCE, 1m (≈51s worked, pause excluded),
  both tabs → break + survey; survey saved in tab 2 cleared tab 1, rating shown in tab 1 history.
- N6 ℹ️ Timer only visible on Today; other pages' top bar shows no running countdown (PiP exists for that).
- F26 ❌ (med-high, design) Routine edits never reach saved days: moved Sleep start 23:00→01:30 (saved OK), but today
  (started) and the accepted week 11-02 keep Sleep 00:00–07:00 + 23:00–; Now card still says Sleep 00:00–07:00.
  Routine blocks on a day have "Delete block" DISABLED and are locked, so a night owl can't remove the stale block,
  and Add block can't go inside it → no way to plan or attribute any work 00:00–07:00 today. Only escape:
  re-apply a template (confirm dialog). Not fixed (needs a decision on re-syncing saved days vs accepted sittings).
- F27 ⚠️ (low) Day plan "Add block" always inserts 09:00–10:30 (lib/schedule.ts:205) — 90m > maxChunk 60 and collides
  with whatever is there ("New block overlaps with Deep work…") instead of picking a free gap.
- N7 ℹ️ Routine Sleep left at 01:30–07:00 on the test account (was 23:00–07:00).
- R8 ✅ Daily wrap-up saved (3 fields, focus 4, energy 2). F28 ⚠️ (med, design) no date picker / day boundary: a wrap-up
  for Saturday written at 00:38 lands on Sunday; no "day ends at 04:00" setting for night owls. "Suggestions" = AI, skipped.
- R9 ✅ Analytics last 7 days: 10 sessions / 105 min = exact match with export (6 old on 10-27, Sat 2, Sun 2 — all on
  correct local days after 5858fa9).
- R10 ✅ Course class log (ML Theory, 10-29, 3 topics, understanding 2) → "Class time 1.5h · 1 of 2 logged", 3 topics;
  Revise shows 3 due / 3 overdue (first review 10-30 — correct); graded Good → 2 due, 1 reviewed today.
- R11 ✅ Dashboard "Download PDF": jsPDF blob, 1 page, 17.5 KB, contains date; no file written to ~/Downloads (stubbed).
- R12 ✅ Reload mid-session: started 00:41:51, two full navigations → same runId + targetEnd, display within 1s.
- F29 ❌ (med-high, design) Dropping a course leaves its saved class block (Mon 11-02 09:00 "Test Course") and accepted
  sittings ("Test Course — Revision" ×2 Mon, more later in week) on every saved day; week view's "already contains"
  hides the class and "placed" fell 23h25m→17h, so those blocks occupy days uncounted and will read as missed in the
  day score. No prompt to release them. Not fixed (needs a decision: auto-release future sittings vs ask).
- N8 ℹ️ Revise items (~6m/day) are held as 5 × 20m sittings (shortest sitting) = 1h40m/week — explained in UI.
- R13 ✅ Session #6 (baselines, 00:41:51→01:06:52, tab on /plan/week): ended +1s, survey 4/5 → Today 3 sessions / 51 min.
- R14 ✅ Week committed 01:07 → "Re-commit", Accept all disabled, nothing draggable. Replan only offered for the CURRENT
  week (page.tsx:1715 weekIsCurrent) → can't release the dropped course's sittings (F29) before Monday.
- F30 ❌ (low) "Committed 2026-10-31." for a commit at 01:07 IST 11-01 — 5 more UTC slices (commit date, look-back paper
  counts, Revise "last on", paper-set synthesis date, export filename). FIXED 7510334; verified "Committed 2026-11-01".
- R15 ✅ Read pass 2 (45m = reading-sitting setting, 01:10:52→01:55:52, cycle 4 → long break): ended exactly; "End of
  sitting" (p.30, Not yet, 4/5) saved; paper "65m read in all", pass "45m logged over 1 sitting · got to p. 30 · Continue
  Read"; Reading card "1 of 4 sittings · 65 of 180 min" (45m counts as a sitting, 20m skim didn't); Today 4 / 96 min ✓.
- F31 ⚠️ (low) Paper status card says "Reading · Read next" while the Read pass is in progress ("Read is in progress").
- F32 ⚠️ (med, design) Turning the Goals module OFF only hides nav/page (module-gate); goals still drive planning — week
  header "plus 8h of goal hours", GOALS look-back, both milestone rows in What's coming, and Workload required minutes —
  while the Goals page to pause/edit them is hidden. Re-enabled after the test. Not fixed.
- R16 ✅ /plan/calendar renders Nov 2026 with classes, assessment dues, task dues, Sunday Weekly planning; dropped Test
  Course's past Monday classes no longer shown (computed from active courses).
- R17 ✅ Goal milestone "Baselines reproduced" ticked → goal "1/2 milestones", row gone from What's coming.
- F33 ⚠️ (med, server) lib/admin-dailyloop.ts: todayKey() on Vercel = UTC date; evening-rollup cron 16:30 UTC = 22:00 IST
  snapshots the IST day's Load Index + day score (stored, "must not change later") from sessions startsWith(UTC date):
  misses that day's 00:00–05:30 IST work and anything after 22:00. Needs user tz (settings.timezone) + later cron. Not fixed.
- F34 ❌ (med) Soundscape mixer (latest commit 99d2782): rain/cafe fetched as 206 Partial Content (612/1413 KB) from a
  partial HTTP-cache entry (old <audio> range requests) → decoded TRUNCATED loop; cache.put rejected 206 (swallowed) →
  never cached, refetched each time. FIXED 8b65cd6 (fetch cache:"reload", store only 200). Verified: wind/birds/stream/
  rain/cafe all 200 full size and in focusos-sounds-v2. Mixer play/pause/preset switch OK.
- N9 ℹ️ Lowering Longest sitting below a placed block's length isn't a dead end: coverage sums sessions and each Start
  arms what's left (lib/tracking.ts:108), so a block closes over 2–3 sittings inside its window.
- R18 ✅ End day (02:55, AI rollup request stubbed → 503, no AI spend): "Day ended. Undo", → /reviews/daily, analytics
  Workload trend now has 11-01. Note: End day's server rollup calls runAiTask("review.eod") (admin-dailyloop.ts:195).
  Per F28, End day at 02:55 closes SUNDAY with LI ≈0.27 as its record.
- R19 ✅ Regression sweep of branch: all 13 verify:* scripts pass, full typecheck + lint clean, `next build` OK.
- R20 ✅ Rest-block fix side effects: floating widget What's-next only renders Start when startArgs (guarded); timer primary
  falls back to plain Start. Fresh /plan/week load with console capture: no [weekplan] ledger warnings.
- R21 ✅ Week grid drag across columns (week 11-09, uncommitted): Mon 11:30 → Tue 16:00 (snapped), 40m kept.
- N10 ℹ️ Day score (module on, then restored off): "0 of 7 sittings closed · 0 of 390 min · score 0" with 96 min logged —
  minutes count only as planned-sitting coverage (gamify.ts:79); with F26 a night owl's work never scores.
- F35 ❌ (HIGH, data) New day view (Plan — Day timeline) + edited routine: mergeMissingLockedSlots (lib/schedule.ts:125)
  appended the new Sleep (id routine-X, 01:30–07:00) over the saved midnight-split one (routine-X-wake/-bed) → TODAY's
  doc now stores THREE Sleeps (00:00–07:00, 01:30–07:00, 23:00–24:00), an invalid day (validateSlots overlap).
  FIXED e21903b (routine slots yield on overlap). Verified on 11-02: no stacked Sleep. Test-account 11-01 doc stays
  corrupted (locked blocks can't be deleted in either view).
- F36 ❌ (med, dev) New day view wrote the day on every OPEN (no edit): StrictMode re-runs the mount effect with the
  hasMountedRef already true → scheduleSave(init seed); its own echo then shows "This day changed in another tab".
  FIXED 2c7e3f0 (skip action "init"). Verified: opening 11-03 → no write, no banner; Add block → Saved ✓; Undo → saved,
  back to 12 slots. (Prod has no StrictMode double-run, so prod impact was likely nil; the guard is still correct.)
- N11 ℹ️ Cmd+Z did nothing right after Add block — focus is in the new block's title field (typing targets are skipped);
  the toolbar Undo works.
- F37 ⚠️ (med, design; F16/F29 family) Problem set 3 marked "submitted" → its accepted prep sittings (Mon ×2, Tue, Wed of
  the committed week) stay and still count in the ledger (Checkpoint prep 8h45m placed). Left as submitted on test acct.
- F38 ❌ (med) Opt-in "Start Deep dive" started a plain "Reading:" sitting with no passNo: startSitting used
  nextReadingPass(), null after a Read outcome other than "persevere" → pass 3 could never begin. FIXED (see git log,
  reading-sitting deepDive flag). Verified: "Deep dive: …" passNo 3; structure-recall gate (no PDF outline → manual
  textarea fallback) → "Deep dive done · Structure recall self-grade 3/5".
- F39 ⚠️ (low) Revise "N reviewed today" is page-local state (useState(0)) — resets to 0 on every reload.
- F40 ❌ (med, layout) At 388px (same-origin iframe viewport): Today scrollWidth 672 (timer card 656 — task <select>
  sized to longest option), Papers 581 (unbreakable URL title). Layout grids only had lg/xl columns → implicit auto
  column took min-content. FIXED 2ce8a87 (base grid-cols-[minmax(0,1fr)] on 9 grids). Verified 0 overflow on Today,
  Tasks, Papers, paper page, Courses, Goals, Revise, Plan day, Plan week, Settings.
- R22 ✅ Template "Tuesday class day" saved from 11-03 (12 blocks); no toast, list updates. F41 ⚠️ (low-med) the FIRST
  saved template silently becomes Default (plan/day/page.tsx:165 isDefault: templates.length === 0), and Start day
  uses the default (workday-session-provider.tsx:305) → every day's Start day now applies the Tuesday template instead
  of Research Day. Badge visible; not fixed.
- F42 ⚠️ (med, design) Marking Wed 11-04 (committed NEXT week) a day off keeps all its work sittings (PS3 prep, Midsem prep,
  RM revision, Reading) on the day; the day-off Replan nudge exists only for the current week (plan/week:2287), so nothing
  re-places them until Monday — a sick day planned ahead silently loses that work. Undone afterwards.
- R23 ✅ Self-review of the branch diff: date-helper hunks mechanical/correct; no ISO-vs-dateKey range comparisons left
  (papers.ts:213/224/439 compare ISO with ISO). Found a regression in my own F9 fix (2ab10d6 made bucket "over"
  impossible) → corrected to ask = max(target, taskEstimates); verified 11-09 to-place = asked, 11-02 "All placed",
  no [weekplan] console warnings.
- R24 ✅ Insights renders (rule-based fallback; not generated), Help links all resolve, calendar → Dec 2026 shows 7 classes
  and none after the 12-15 term end.
- Sibling hunt: only one first-run-ref save guard (F36, fixed). F43 ❌ (med) block inspector (new day view) offered
  "Start focus session" on Sleep/meal blocks (F23 sibling). FIXED (see git log). Verified: Sleep → no link, ML block → link.
- N12 ℹ️ Fake-clock peek at Monday 09:05 (Date override after load) didn't re-render — abandoned, real clock restored.
  After End day, Workload shows "0-day streak · 9.4h catch-up" (was 3.5h): Sunday's 02:55 snapshot counts as a short day.
- F10 sibling scan (text-join DOM scan on 12 pages): only intentional unit suffixes (45m, 5d, 8h/week) — no more bugs.

## Fixes (branch qa/overnight-2026-11-01)
- 47ef8d6 plan-week copy spacing
- 7bd6267 week-grid unplaced row duration
- 2ab10d6 bucket ask covers task estimates
- (next) prep re-offer — see git log
- e8abfb7 timezone select keeps the saved value as an option. Affects only the settings display; stored value untouched; Calendar sync (only reader) unaffected. Verified in browser.
