# FocusLab overnight end-to-end run — report

Run: Sat 31 Oct 21:59 → Sun 1 Nov (see "Run end").
Account: test account suyashbima@ only. Branch: `qa/overnight-2026-11-01` (15 commits, not merged, not pushed).
Scenario: a PhD scholar sets up a semester, plans next week, works late across midnight, reads, reviews.
Full chronological log with every check: `run-log.md` in the same folder.

## Fixed on the branch (each verified in the running app)

| # | Severity | What was wrong | Commit |
|---|---|---|---|
| F17 | **High** | Sessions finishing 00:00–05:30 IST were credited to the *previous* day everywhere: Today stats/history, block coverage (→ 60% close rule → day score), week-planner "worked"/placed accounting, analytics, reading log. `completedAt` is UTC ISO; 19 sites took `.slice(0,10)`. Evidence: `evidence-F17-sunday-zero-sessions.jpg`. | 5858fa9 |
| F35 | **High** | New day view + an edited routine stacked a second Sleep over the saved one and autosaved an overlapping (invalid) day. | e21903b |
| F38 | Med | "Start Deep dive" started a plain reading sitting with no pass — the opt-in Deep dive could never begin. | e2533d3 |
| F40 | Med | Phone width: Today was 672 px wide in a 388 px viewport, Papers 581 px (layout grids had no base column). | 2ce8a87 |
| F36 | Med (dev) | New day view wrote the day on every open (StrictMode re-run), showing its own echo as "changed in another tab". | 2c7e3f0 |
| F12 | Med | After accepting the week, checkpoint prep was re-offered on days already holding their share, as 15–22 min sittings (below the 20-min minimum); would recur on every accept. | a74552d |
| F9 | Med | Week header said more "to place" than "asked in all"; a course cell was blank though 75 min of its task work was waiting; that work would read as "over" once placed. | 2ab10d6 |
| F8 | Med | An unplaced sitting showed "5 min" and, given a day, was placed as a 5-minute block. | 7bd6267 |
| F23 | Med | During Sleep, the Now card offered "Start focus · 7h" and started a 60-min focus session logged against Sleep; the idle timer and What's-next start also followed rest blocks. | 12d5e04 |
| F24 | Med | After abandoning a block's sitting, the next session for *any* task ran that block's length (60:00 vs 25:00 preset) and could log to it. | 2cd77d6 |
| F34 | Med | Background-sound mixer (latest commit): loops fetched as 206 Partial Content from a stale HTTP-cache entry decoded **truncated** and were never stored in Cache Storage (refetched every play). | 8b65cd6 |
| F30 | Low | "Committed 2026-10-31" for a commit at 01:07 on 11-01 (+ 4 other UTC date displays). | 7510334 |
| F1 | Low | Settings timezone showed "Africa/Abidjan" (Chrome lists Asia/Calcutta, default is Asia/Kolkata). | e8abfb7 |
| F10 | Low | "capped at 60minutes" — missing space in two help texts. | 47ef8d6 |

After the fixes, a full regression sweep: all 13 `verify:*` scripts, full typecheck + lint, and `next build` pass.
Checks run for every fix: `tsc --noEmit`, eslint on changed files, relevant `verify:*` scripts, and the failing flow
re-run in Chrome.

## Needs your decision (logged, not fixed)

1. **F11 (High) — "Accept all" silently saves nothing** when two *fixed* items clash on any day (a recurring TA meeting
   vs a class). The only feedback is a line that reads like a warning. Single accepts on other days work.
2. **F26 (Med-High) — Routine edits never reach saved days.** Moving Sleep's start didn't change today or the accepted
   week; routine blocks there can't be deleted, so a night owl can't plan or attribute any work 00:00–07:00.
3. **F29 (Med-High) — Dropping a course leaves its class and accepted sittings** on every saved day, no longer
   counted in the week, and they'll read as missed. Replan only exists for the current week.
4. **F6 (Med) — A milestone's later sittings can land after its due date** (8th sitting of a Wed-due milestone on Thu).
5. **F7 (Med) — Each milestone asks the goal's whole weekly hours** (two milestones of an 8 h/wk goal = 16 h).
6. **F13 / F21 (Med) — Sitting bounds bypassed:** pinned checkpoint prep (67 min) and template blocks (120 / 90 min)
   exceed the 60-min max.
7. **F16 (Med) — Finishing a task early leaves its future planned sittings** on the plan.
8. **F18 (Med) — Active-day streak drops to 0 at midnight** until the first session of the day; a second, different
   "streak" (Workload ≥0.9) sits on the same screen.
9. **F19 / F22 (Med) — Workload "required today" on non-working days** (Load Index spreads weekly targets over 7 days;
   Start day's template then raises it further, 190 → 400 min on a Sunday).
10. **F28 (Med) — No configurable day boundary**: a wrap-up written at 00:38 is filed under the new day.
11. **F32 (Med) — Turning a module (Goals) off only hides the page**; goals still drive planning and Workload.
12. **F20 (Med) — Start day banner** says "No plan for today" right after applying a template, and "last weekly
    planning session 19 days ago" ignores accepted (uncommitted) weeks.
13. Low: F2 day-pill contrast + no aria-pressed · F3 unlabelled estimate box · F4 no overdue marker in Tasks ·
    F5 README:501 says no recurring tasks exist · F14 blank 24:00 end time · F15 survey modal not role="dialog" ·
    F25 Sleep blocks late-night planning · F27 "Add block" always 09:00–10:30 · F31 paper status "Read next" while
    Read is in progress.
14. **F37 (Med) — Submitting an assessment leaves its accepted prep sittings** on the plan and in the ledger
    (same family as F16/F29: finished/dropped work never releases its future sittings).
15. **F41 (Low-Med) — The first saved day template silently becomes the default** that Start day applies to every day.
16. **F39 (Low)** Revise's "N reviewed today" is page-local and resets on reload.
17. **F33 (Med, server) — evening rollup** (`lib/admin-dailyloop.ts`, cron 16:30 UTC = 22:00 IST) computes "today" in UTC
    and stores the day's Load Index + day score from sessions on that UTC date: an IST day's 00:00–05:30 work and anything
    after 22:00 are left out of the stored snapshot. Needs `settings.timezone` and a later cron.

## What worked end to end

Real-time focus sessions (5 real ones incl. one across midnight) ended to the second; end cue once; survey → Today
history; pause/resume shifts exactly; reload mid-session restores the same run; two tabs stay in sync and log once;
Finish logs real minutes; Reset logs nothing; End day → wrap-up + Workload trend point; PiP widget opened on first click and followed the session past midnight;
Skim → Read → Deep dive pass flow incl. structure-recall gate; week-grid drag across columns; End day; templates; class log → Revise cards → grading; analytics totals match raw data exactly; PDF export;
calendar; milestone completion updates the planner; committed week locks.

## Test data changed on the test account

Settings (sittings 60/20, reading 4×45 mornings), term Monsoon 2026, routine (gym M/W/F, weekly planning Sun 18:00,
**Sleep now 01:30–07:00**), courses ML Theory + Research Methods (+ **Test Course set to Dropped**), 5 tasks, 2 recurring
commitments (+ old TA meeting paused, new one Wed 16–17), 2 papers, 1 goal (1 milestone done), week of 11-02 accepted
and committed (Sat off), Sunday started with the Research Day template, 6 sessions, 1 daily wrap-up, 1 class log, Problem set 3 marked submitted, Deep dive done on "Attention Is All You Need",
template "Tuesday class day" saved (now the Default), Sunday ended at 02:55 (Workload ≈0.27 stored as its record).
**Today (11-01) is stored with three overlapping Sleep blocks** (from F35, before its fix) — locked blocks can't be
deleted in either view, so it needs a manual fix or a template re-apply.
Leftover artifact: Mon 11-02 has two "Prep: Problem set 3" sittings (from F12, before its fix).

## Run end

Stopped at 02:58 IST by choice, not by a limit: every scenario phase (setup, week planning, midnight crossing, Sunday
work, review/analytics, robustness) was done, and the rest of the scenario's night is the Sleep block, which ends after
the 06:00 window. No usage limit was hit — highest readings: session 72% (02:04, then reset at 02:50), week 73%.
No pause was needed.

Not covered: 390 px phone layout (resizing would have moved your Chrome window), AI features and Google Calendar
(excluded by you), notifications in a genuinely hidden tab (automated tabs always report visible), hydration/break
reminders (suppressed during the Sleep block all night).

Left running/installed: dev server stopped; `caffeinate` expires on its own ~07:00; the usage status line and gate hook
stay in `.claude/settings.local.json` (git-excluded) — the gate is inactive without `.claude/overnight-run.active`.
