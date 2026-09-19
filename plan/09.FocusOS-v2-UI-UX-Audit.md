# FocusOS UI/UX Audit — Glitches & Improvements

## Implementation status

All four actionable findings below (§1.1, §2.1, §2.2, §3.1, §3.2) have been implemented and verified live at a 354px viewport in the browser, plus `tsc --noEmit` and `eslint . --max-warnings=0` both pass clean on the whole repo. `/admin`'s dev-server crash (see its own section) was left as-is — it's a Turbopack/dev-tooling issue outside the app's own code, not something fixable by editing a component.

- **§1.1 mobile nav** — `components/app-shell.tsx` now opens a slide-in drawer (hamburger button, all 13 nav items + Settings/Help listed vertically, closes on link click / overlay click / Escape, locks body scroll while open) instead of the horizontally-scrolling strip. Desktop sidebar is untouched (`SidebarNav` is shared between both so they can't drift apart again).
- **§2.1 header crowding** — `flex-wrap gap-2` added to the shared card-header pattern in all 13 locations the audit's grep found (not just the one screenshotted instance).
- **§2.2 Tasks filters** — the 4 filter `<select>`s are now a 2-column grid below `md` instead of 4 stacked full-width rows.
- **§3.1 empty paper-picker** — shows "Add a paper above first — sets are built from papers on your reading list." instead of a blank tinted box when there are no papers yet.
- **§3.2 loading flash** — the full-page loading state now shows the same green "F" logo mark used in the sidebar, on the app's real background tokens, instead of plain unstyled text on default background.

---

Manual walkthrough of every route in the app (desktop ~1300–1450px and mobile ~354px viewport — the narrowest this test environment could reliably produce, see §1.1's caveat — light + dark theme), done via live browser against `npm run dev`, cross-checked with DOM measurements (`getBoundingClientRect`, `scrollWidth`) rather than relying on screenshots alone for the layout claims. Logged in as the existing seeded user, with no tasks/papers/courses/goals data yet (see the limitation note at the bottom). Findings are ordered by severity within each section. Each item names the concrete file/line where the cause was confirmed in source, where applicable.

Pages covered: Today (dashboard), Tasks, Plan (Day + Calendar), Papers, Courses, Revise, Goals, Daily wrap-up, Weekly check-in, Analytics, AI Insights, Settings, Help. `/admin` could not be evaluated — see the dedicated section below.

---

## 1. Critical — mobile navigation breaks

### 1.1 Header nav strip is squeezed almost entirely off-screen on phone-size widths
**Where:** `components/app-shell.tsx`, the mobile nav (`<nav className="flex gap-1 overflow-x-auto lg:hidden">`, ~line 155) sitting next to the icon cluster (`<div className="ml-auto flex items-center gap-2">`, ~line 163).

Below the `lg` breakpoint the desktop sidebar (`<aside>`) is hidden entirely, and the *only* way to reach any other page is this horizontally-scrolling strip of small nav buttons in the header, competing for space with the "Start day" pill, info icon, floating-widget icon, theme toggle, avatar and sign-out icon.

Neither flex child has `flex-shrink-0`, and because the nav uses `overflow-x-auto`, its browser-computed `min-width` is `0` — so when the icon cluster doesn't fit, the *nav* is what gets squeezed, not the icons. Measured directly in the DOM at a 354px viewport (the narrowest this environment could reliably reproduce — see caveat below):

```
viewport width:        354px
nav visible width:      91px   (offsetWidth)
nav full content width: 897px  (scrollWidth) — all 13 items: Today, Tasks, Plan,
                                Papers, Courses, Revise, Goals, Daily wrap-up,
                                Weekly check-in, Analytics, AI Insights, Settings, Help
```
Only ~10% of the strip's content is visible (reads as "Today" plus a sliver of "Tasks"); the other ~90% — 11 of 13 destinations, including Settings and Help — requires scrolling a plain, unlabeled `overflow-x-auto` region that has no visible scrollbar, fade edge, or arrow hinting it scrolls. (Sign-out is a separate icon button in the cluster, not part of this nav — its measured rect at 354px is `x:119–338`, which fits inside the 354px viewport, so it stayed reachable.)

I could not get this test environment's window below a 354px CSS viewport (`resize_window` calls below that width were silently clamped) to confirm whether the strip fully disappears on the very narrowest real phones (e.g. 320px devices) — flag that as unverified rather than confirmed. What's confirmed is that at a completely ordinary phone width (354px, narrower than an iPhone SE's 375px), 90% of the app's navigation is hidden behind an undiscoverable horizontal scroll.

**Impact:** on real phone widths, a first-time mobile user has no visual cue that Plan/Papers/Courses/Settings/etc. exist at all — they'd have to guess to swipe left on a patch of background next to "Today".

**Suggested fix:** give the app a real mobile nav pattern — e.g. a hamburger/drawer, or a fixed bottom tab bar for the primary items — instead of relying on an unlabeled horizontally-scrolling strip that has to compete with the header's icon cluster for space.

*(Checked and ruled out: the document itself does not scroll horizontally at 354px — `document.documentElement.scrollWidth` equals `clientWidth` — so this is isolated to the nav strip, not a page-wide overflow bug.)*

---

## 2. Medium — layout crowding on mobile

### 2.1 Card header + action button crowd together when they don't wrap
**Where:** e.g. `app/(app)/plan/day/page.tsx:144-146` — `<div className="mb-4 flex items-center justify-between"><h2>Templates</h2><button>Browse templates</button></div>`.

On mobile the "Browse templates" button wraps to two lines and sits almost flush against the "Templates" heading with barely a gap (screenshotted at a 354px viewport). This one instance is confirmed by screenshot. The same `flex items-center justify-between` header pattern (heading + one action button, no `flex-wrap`) also appears in 12 other places across the app (Papers "Add a paper", Goals "New goal", Courses "Add a course", Paper sets, etc.) — those weren't individually re-tested, but share the same missing-`flex-wrap` shape and are worth a quick spot-check on a small viewport.

**Suggested fix:** add `flex-wrap` (and a small gap) to this header pattern, or drop to a stacked layout below `sm`.

### 2.2 Tasks page: four full-width filter dropdowns before any content
`app/(app)/tasks` stacks "Inbox / All categories / All priorities / All statuses" as four full-width `<select>`s on mobile before the task list itself. It's functional, but pushes the actual content (or empty state) a long way down the screen. Consider a 2×2 grid for these on mobile instead of 4 rows.

---

## 3. Low — polish / empty-state gaps

### 3.1 Papers → "Paper sets": blank gray box when there are no papers yet
**Where:** `components/paper-groups-panel.tsx` — the paper-picker checklist:
```tsx
<div className="grid max-h-32 gap-1 overflow-auto rounded-md bg-ink-50 p-2 dark:bg-ink-800 sm:grid-cols-2">
  {papers.map((paper) => ...)}
</div>
```
When `papers` is empty (new user, or before adding any papers), this renders as an empty tinted rectangle with padding and no content — it reads as a rendering glitch rather than an intentional empty area. Add a short placeholder line ("Add a paper above to build a set") or hide the box until there's at least one paper.

### 3.2 Bare, unbranded "Loading…" flash on full page loads
Any hard navigation / refresh briefly shows a plain centered "Loading FocusOS…" on a plain background with no logo, layout, or skeleton — a jarring flash compared to the rest of the app's fairly polished look. A minimal branded splash (logo mark centered, matching the app's dark/light background) would smooth this over.

---

## Could not evaluate — dev server crashes on `/admin`

Navigating to `/admin` (as this non-admin test user) reliably crashed the Turbopack dev server rather than rendering anything: the terminal logs a `FATAL: An unexpected Turbopack error occurred… Failed to write app endpoint /(admin)/admin/page … Next.js package not found`, immediately followed by a tight loop of repeated `GET /admin 200` requests (dozens per second), and the browser tab hangs — on one attempt it silently stayed on a bare "Loading…" screen; on a second, separate attempt (after restarting the dev server) the tab's renderer froze so hard that a screenshot call timed out after 30s. This happened twice, independently, across two dev-server restarts, so it's reproducible, not a one-off flake.

This is very likely a local Turbopack/dev-tooling issue rather than a bug in the `/admin` page's own code (the panic message is a generic Turbopack internal error, "Next.js package not found," not an application exception) — but it means **the actual non-admin access-control UX for `/admin` was never actually observed** and should not be treated as verified either way. Worth a manual check with `next dev` on webpack (`next dev --no-turbo` or equivalent) or in a production build.

---

## Checked and confirmed fine (no action needed)

- **Dev-only usage overlay** ("reads N · writes N (session)" badge, bottom-right): confirmed in `components/usage-overlay.tsx` it's gated behind `process.env.NODE_ENV !== "development"` — it will not appear in production, so this is not a bug.
- **Light/dark theme parity**: toggled both themes on Dashboard, Help, and Analytics — consistent, legible, no contrast issues found on those three pages. Not checked on every other page.
- **Dashboard's 3-column grid**: re-verified with DOM measurements — "Daily schedule," "Workload," and "Reading now" sit in independent column stacks (not row-height-matched), so a short "Daily schedule" card does not leave a visible gap next to its neighbors. An earlier version of this doc flagged this as a bug; it wasn't — retracted after measuring actual element positions.
- **No console errors** were logged navigating through any of the pages above.
- **Settings, Courses, Goals, Daily wrap-up, Weekly check-in** all reflow cleanly to a single column on mobile with no overlap or clipping beyond what's noted in §2.

---

## Not verifiable via automated browser testing

- **Document Picture-in-Picture floating widget** (Settings → "Customize", and the PiP toggle icon in the header): this opens a real OS-level PiP window outside the tab's DOM, which the automated screenshot tool cannot capture. The in-page "Customize" dialog itself renders correctly, but the actual floating widget's layout/behavior needs a manual pass in an actual Chromium browser window.

---

## Testing limitation: everything above was tested with an empty account

Every page in this pass had no tasks, papers, courses, goals, or focus-session history — all findings are about **layout with no data**. List rendering, text truncation/wrapping with real (possibly long) titles, and interactive states like the paper-group `GroupRow` expand/collapse were not exercised, since there was nothing to populate them with. A second pass after adding a handful of tasks, papers, and courses (including at least one with a long title) would be worth doing before treating this as a complete audit.
