# FocusLab overnight end-to-end run — runbook

Window: **Sat 31 Oct 22:00 IST → Sun 1 Nov 06:00 IST**. Read this file and `run-log.md` (same folder) at
the start of every wake-up, before doing anything else. Context will have been compacted; trust these files.

## Decisions the owner made (2026-10-31)
- Session usage ≥ 90% → **pause** until the 5-hour window resets, then resume. Weekly ≥ 95% or 06:00 → **hard stop**.
- Bugs → **log and fix on a branch** (`qa/overnight-2026-11-01`). Never commit to `main`, never merge, never push.
- **Exclude** AI insights and Google Calendar sync entirely (no AI-budget spend, no OAuth).
- Auto-start at 22:00 IST from a one-shot cron in this session.

## Enforcement (already installed, project-local, git-excluded)
- `.claude/usage-statusline.sh` writes `.claude/usage.json` ({t, rl.five_hour, rl.seven_day}) after every response.
- `.claude/usage-gate.sh` (PreToolUse hook) is active only while `.claude/overnight-run.active` exists (holds the
  deadline epoch). When it denies a tool call, **do what the denial reason says**: on PAUSE, log the pause and
  ScheduleWakeup until the reset; on HARD STOP, write the final report, `ScheduleWakeup stop:true`,
  then `rm -f /Volumes/SSD1/Project_SSD/FocusLab/.claude/overnight-run.active`.
- Even when allowed, glance at `.claude/usage.json` each wake-up and log the numbers.

## Preflight (first iteration only)
1. `echo 1793493000 > /Volumes/SSD1/Project_SSD/FocusLab/.claude/overnight-run.active` (06:00 IST deadline).
2. `caffeinate -dis -t 30600` in the background if not already running (`pgrep -fl caffeinate`).
3. `git switch -c qa/overnight-2026-11-01` (working tree must be clean; if not, log and stop).
4. `npm run dev` in the background; poll `curl -s -o /dev/null -w '%{http_code}' localhost:3000/login` until 200.
5. Chrome: tabs_context_mcp, then a new tab on localhost:3000. Confirm the signed-in account is
   **suyashbima@gmail.com**. If it's `the owner's real account` or signed out: do NOT proceed with writes; log it,
   and run only read-only checks. The owner's real account must never be modified.
6. Export a data baseline (Settings → export) and log what data already exists.

## Every wake-up
1. Read this runbook + run-log.md. Check usage.json, dev-server health (restart if down), Chrome tab alive.
2. Do the next unchecked item in the run log. Append results immediately (one line per check, ✅/❌/⚠️).
3. Pace: during a real-time focus session, ScheduleWakeup for its remaining time (cheap) instead of polling.
   Otherwise keep working; ScheduleWakeup 60–300 s only when waiting on something real.
4. Before any ScheduleWakeup, make sure run-log.md says exactly what's next.

## Usage-saving rules
- Prefer `get_page_text`, `read_page`, `find`, `javascript_tool` over screenshots. Screenshot only for visual or
  layout checks, and for evidence of a ❌ finding.
- Batch browser actions with `browser_batch` where possible. No GIF recording.

## Known traps (from memory)
- Owner's own FocusLab tab may join the cross-tab localStorage sync and claim sessions. If a session gets logged
  by neither test tab, suspect that, and log it.
- The end-of-session **survey modal swallows clicks** underneath; dismiss it before anything else.
- `javascript_tool` times out at 45 s; keep in-page waits < 40 s.
- Notifications: stub `window.Notification` (static permission "granted") and patch
  `HTMLMediaElement.prototype.play` to count audio. Both are lost on reload — reinstall after every navigation.
- PiP needs a real coordinate click on "Float focus widget" (screenshot first; first click may only focus).
- Fast completion: from a second app tab (e.g. /privacy-policy), write `focusos-active-session`
  `{v:2, core:{phase:"running", targetEndTime: Date.now()+5000, …}, ctx}`; the first tab adopts it.
- Automated tabs always report visible + focused; override `document.hasFocus` to test "not looking" logic.
- **Editing source hot-reloads the page** (kills PiP, restores session). Never edit files during a timed test.

## Fix policy (branch `qa/overnight-2026-11-01`)
- Fix only clear, contained defects. Before editing, write in the run log every system the change touches and
  what happens to each (sitting bounds + timer clamp, `slotAutoStatus` 60% rule → block strip + day score,
  `plannedMinutes` → next week's proposals, locked layer never moves, recurring slot ids need the date,
  derived-never-stored values).
- Then: `npm run typecheck`, `npm run lint`, the relevant `verify:*` script, **and re-run the failing flow in
  the browser**. Commit once per fix (message ends with the Co-Authored-By line). Don't edit mid-timed-test.
- Anything big, ambiguous, design-level, or touching Firestore rules/data shape: log it as a finding, don't fix.
- If a fix doesn't verify in the browser within ~2 attempts, revert it (`git restore`) and log it as unfixed.

## Scenario — one PhD scholar's week (test account only)
- **P1 Semester setup (22:20–23:15):** settings (min/max sitting length, work hours), routine (sleep, meals, gym),
  feature toggles, 3 courses with weekly lecture times, goals, 4 papers (no PDF upload unless already allowed —
  log it), tasks with deadlines + one recurring task.
- **P2 Plan the week (23:15–23:45):** generate week, drag blocks across days, mark a day off, re-plan. Check:
  locked layer never moves, no block > maxChunkMinutes, planned minutes add up, a dropped/blocked day isn't used.
- **P3 Midnight crossing (23:45–00:30):** start a real 25-min session ~23:50 (PiP on) that ends after 00:00, take
  survey. Do the daily review before 00:00. After 00:00: what "today" is, recurring routine/class slots on the
  new date, yesterday's day score, carry-over of unfinished work, streaks.
- **P4 Sunday workday (00:30–03:00):** 2–3 real-time sessions (timer accuracy vs wall clock, breaks, hydration
  nudges, cue sounds + soundscape mixer, notifications via stub) plus fast completions to fill the day.
  Paper reading window: passes + structure-recall gate. Pause/resume, abandon, skip. Sittings at exactly 59% and
  60% of a slot (slotAutoStatus). Two app tabs open at once.
- **P5 Review & analytics (03:00–05:00):** daily review, weekly review, analytics numbers vs sessions actually
  logged, insights page (no AI generation), PDF export, data export, help page claims vs real behaviour.
- **P6 Robustness (05:00–05:45):** reload/close-reopen mid-session, lower maxChunkMinutes while longer blocks
  exist, drop a course (its tasks must vanish from every suggestion surface), 390 px-wide layout.
- **P7 Report (05:45–06:00):** final report (below), stop loop, remove the run flag.

## Final report (`final-report.md`, same folder)
Findings ranked by severity: what happened vs expected, repro steps, evidence, fixed (commit hash) or not.
Then: coverage table per phase, usage readings over the night, pauses taken, anything skipped and why.
