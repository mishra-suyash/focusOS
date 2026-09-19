# FocusOS v2 — Floating Widget (Document Picture-in-Picture)

**Companion to:** `FocusOS-v2-Plan.md`, `FocusOS-v2-Focus-Design.md`. The Focus Design doc's anti-feature rules (§11–12) are treated as binding constraints here, not suggestions — a floating always-visible surface is exactly the kind of feature that turns into notification noise if it isn't designed against that failure mode from the start.

**Origin:** the user asked for an Arc/Dia-style floating popup — pinned on top of every window, resizable, configurable in Settings via checkboxes (candidate items: Pomodoro timer, current task, quotes, reminders). This doc answers three things: is it possible, what should actually be in it, and how it's built.

---

## 0. TL;DR

1. **Yes, it's possible**, via the **Document Picture-in-Picture API** (`documentPictureInPicture.requestWindow()`) — a real OS-level floating window, resizable by the user, always-on-top, that survives tab switches. Chromium only (Chrome, Edge, Arc, Dia); no Safari/Firefox.
2. **The user's four candidate items don't survive contact with either the research or FocusOS's own rules unchanged.** Quotes fail outright (§3 below). "Reminders" as a generic toggle reopens a door the Focus Design doc explicitly closes. The real list is narrower and more specific than "four checkboxes."
3. **The hard technical problem isn't the PiP API — it's state.** The Pomodoro timer today lives entirely in `PomodoroTimer`'s local component state, mounted only on `/dashboard`. It doesn't survive navigating to `/tasks`, let alone surviving into a separate PiP document. Making the timer actually persist and show up in a floating window requires lifting it into a provider first (§6) — that's most of the implementation effort, not the floating-window mechanics.
4. Settings integration reuses the existing `dashboardWidgets` checkbox pattern (`lib/dashboard-widgets.ts` / `DashboardCustomizeDialog`) almost exactly — same shape, new list.

---

## 1. Feasibility

### 1.1 The API

```ts
const pipWindow = await documentPictureInPicture.requestWindow({
  width: 280,
  height: 160,
});
pipWindow.document.head.append(styleLink.cloneNode(true));
// render React content into pipWindow via a portal — see §6
```

- Opens a **real separate top-level window** the OS treats as always-on-top, draggable and resizable by the user — not an in-page overlay faking "floating."
- Must be triggered by a user gesture (a click on a "Float" button). Cannot auto-open on load.
- The new window has its **own empty document** — no CSS, no React root. Styles must be explicitly copied in (clone `<link>`/`<style>` tags into `pipWindow.document.head`); component trees are rendered into it via `ReactDOM.createPortal`.
- Firing `documentPictureInPicture.window` (a getter) tells you if a PiP window is currently open; a `pagehide`/`resize` listener on the pip window signals close/resize.

### 1.2 Support matrix

| Browser | Support | Behavior |
|---|---|---|
| Chrome, Edge, Arc, Dia, Opera, Brave (Chromium ≥ 116) | ✅ Full | Native resizable always-on-top window |
| Safari | ❌ No Document PiP (only classic `<video>` PiP) | Feature-detect, hide the Float button |
| Firefox | ❌ Not implemented | Feature-detect, hide the Float button |

**Fallback:** feature-detect `"documentPictureInPicture" in window`. When absent, the "Float" entry point simply doesn't render — no degraded in-page floating div, no broken promise. A fake "floating" `<div style="position:fixed">` is not a fallback worth building: it doesn't survive tab switches or sit above other apps, which is the entire point of what was asked for, so it would just teach users the feature is broken.

**Verdict: ✅ Do**, gated behind feature detection, Chromium-only for v1.

---

## 2. What actually belongs in it

An advisor pass (ambient-display / peripheral-display UX research, plus survey of what real floating widgets — Arc/Dia PiP, Sunsama, Forest, Session, Raycast's HUD — people keep enabled after week one vs. disable) converged on one governing principle, and it happens to be the same rule the Focus Design doc already states independently in §11:

> **Every row in the widget must be pre-attentively glanceable (parsed without reading — a number, a progress bar, one short label) and actionable in a single tap. If a row can't be acted on with a button, or requires actually reading a sentence, it doesn't belong here — it's not saving attention, it's creating attention residue.**

This tracks with why persistent widgets get disabled in practice: the ones people keep are the ones with zero reading cost (a countdown, a progress ring); the ones people turn off after a week are the ones with any prose, because prose in a peripheral window either gets ignored (wasted space) or interrupts the exact focus it's supposed to protect.

It also caps *how much* can be in the widget at once: peripheral-display research is consistent that glanceability collapses past a handful of simultaneous elements — this is a 3-row widget, not a mini-dashboard.

---

## 3. Item-by-item: the user's four suggestions, evaluated

| Suggested item | Verdict | Why |
|---|---|---|
| **Pomodoro timer** | ✅ Keep, unchanged | Purely numeric + a progress bar. Zero reading cost. Directly serves the app's own "mandatory loop" (Focus Design §1). The obvious anchor of the widget. |
| **Current task** | ⚠️ Reshape → "Current focus" | Don't show a raw task title in isolation — merge it with the app's existing **Next Action** logic (`lib/next-action.ts`, already deterministic, already speced in Focus Design §2). While a session is running, show the linked task/label. While idle, show `pickNextAction()`'s one-liner with its Start button. One line answering "what do I do" — not two competing signals (a stale "current task" chip *and* a live Next Action card). This is a reuse of existing logic, not new scope. |
| **Reminders** | ⚠️ Reshape → "hydration/break nudge only" | A generic "reminders" toggle is exactly the door Focus Design §12 closes: *"Notifications outside the hydration/break loop... this is a study tool, not a chat app."* Keep it narrow: surface only the already-sanctioned hydration/break nudge from `WorkdaySessionProvider`, and only the row when one is actually due — no generic reminder/task-due feed. |
| **Quotes** | ❌ Reject | This is the literal "freeform motivational text" Focus Design §11 bans by name, for a stated reason: it's noise you'll start skipping. It also fails the glanceability test on its own terms — a quote is prose, not pre-attentive, and it goes stale after being read once (no repeat value the way a live countdown has). There's no narrow form of this that survives the app's own rules; don't build it. |

**Net default set:** Timer · Current focus · Hydration/break nudge (shown only when due). Three rows, all glanceable, all either numeric or one-tap-actionable.

### 3.1 One addition worth considering (off by default)

An **advanced, opt-in-only** fourth row: today's Load Index value or `longestUnbrokenFocusMin` (already tracked per Focus Design §4/§8 as *leading* indicators). Numeric, glanceable, no prose. Left off by default per the §1 "minimal defaults" rule — offered as a toggle for users who specifically want it, not pre-selected.

---

## 4. Settings: checkbox list (reusing the existing pattern)

This is a near-exact copy of `lib/dashboard-widgets.ts` / `DashboardCustomizeDialog` — same shape, new domain. No new pattern to invent.

```ts
// lib/floating-widget.ts
export type FloatingWidgetItemId = "timer" | "currentFocus" | "hydrationNudge" | "loadIndex";

export const FLOATING_WIDGET_ITEMS: { id: FloatingWidgetItemId; label: string; defaultOn: boolean }[] = [
  { id: "timer",          label: "Focus timer",          defaultOn: true },
  { id: "currentFocus",   label: "Current focus / up next", defaultOn: true },
  { id: "hydrationNudge", label: "Hydration & break nudges", defaultOn: true },
  { id: "loadIndex",      label: "Today's Load Index (advanced)", defaultOn: false },
];
```

`UserSettings` gains one field, following the existing "absent = derived default, explicit list always wins" convention already used for `dashboardWidgets`:

```ts
// types/index.ts, on UserSettings
/** Rows shown in the floating focus widget (§9.4-equivalent for the PiP widget). Absent = FLOATING_WIDGET_ITEMS' defaultOn set. */
floatingWidgetItems?: string[];
```

A `FloatingWidgetCustomizeDialog` component, structurally identical to `DashboardCustomizeDialog`, lives in Settings (not on the dashboard — this isn't a per-page widget, it's a standing preference).

**Not settings-synced, kept in `localStorage` instead:** the PiP window's last width/height/position. That's a per-device, per-browser-profile fact (the OS window manager owns it), not a cross-device preference — syncing it through Firestore would fight the browser's own remembered window placement.

---

## 5. The actual hard part: making state survive outside the dashboard page

Right now, `PomodoroTimer` (`components/pomodoro-timer.tsx`) is only rendered on `app/(app)/dashboard/page.tsx`. Its running state — `secondsLeft`, `targetEndTime`, `mode`, `label`, `taskId` — is plain `useState` local to that one component instance. Navigate to `/tasks` and the component unmounts; the timer is simply gone (no session-end fires — it just stops existing).

That means before a floating widget can show a live timer, the timer has to become **persistent across navigation first**, independent of whether it also floats. This is the actual scope of the work, not the PiP window itself.

**Plan:**

1. **Extract a `FocusSessionProvider`** (same shape as the existing `WorkdaySessionProvider`), mounted once in `app-shell.tsx` alongside it. It owns `mode`, `secondsLeft`/`targetEndTime`, `running`, `label`, `category`, `taskId`, `cycle` — exactly the state block currently local to `PomodoroTimer` — plus the existing `completeSession`/`finalizeSession` logic (unchanged, just relocated).
2. `PomodoroTimer` becomes a **view** over that context instead of owning the state — same JSX, same behavior, it just reads/writes the provider instead of local `useState`. This is a refactor, not a rewrite; the countdown-anchoring-to-a-timestamp logic (already resilient to backgrounded tabs) moves as-is.
3. **The floating widget's timer row renders from the same provider** — same source of truth, so there's no second timer to keep in sync, no `BroadcastChannel`, no duplicated countdown logic that can drift from the real one.
4. **Rendering into the PiP window uses a React portal**, not a duplicate component tree: `createPortal(<FloatingWidgetContent />, pipWindow.document.body)`. `FloatingWidgetContent` is a small new component (§7) that reads `FocusSessionProvider`, `pickNextAction()`'s inputs, and `WorkdaySessionProvider`'s `reminder` — the exact same hooks the main app already uses, just rendered into a different document.

This also happens to fix a latent gap independent of this feature: today, starting a Pomodoro session and then clicking to `/tasks` silently kills it. Lifting the state fixes that for the normal in-page experience too, not just for the floating case.

**Risk flag:** this is the one piece of this plan that touches existing, working code (`PomodoroTimer`) rather than adding new files. It should be its own PR, landed and verified (existing Pomodoro behavior unchanged: survey modal, task-linking, presets, `initialFocus` from `BlockInspector`) before the floating window is built on top of it.

---

## 6. Floating window behavior & UX constraints

- **Entry point:** a "Float" button (only rendered when `"documentPictureInPicture" in window`) — natural home is next to the Pomodoro timer card and/or in the header near `DaySessionBar`. Clicking calls `requestWindow()`, portals `FloatingWidgetContent` in, and swaps the button to "Bring back" while the PiP window is open (mirroring how video PiP toggles).
- **Row cap: 3 visible by default** (timer, current focus, hydration nudge), 4 with the opt-in Load Index row. Not user-extensible beyond the defined list — this is deliberately not a generic widget framework.
- **Minimum functional size**, enforced both as the `requestWindow({width, height})` initial size and via CSS `clamp()`/container queries inside the PiP document, so a user can't drag-resize it into unreadable digits (roughly 200×120px floor).
- **Auto-hide (not dim) the hydration/break row during a protected block.** Focus Design §4 specs a 90-minute protected block that already suppresses hydration prompts; the floating widget must honor the same rule rather than punching a new hole in it. The row's `display` simply removes when a protected block is active — nothing to dismiss, nothing to see.
- **No modals inside the widget.** The window is small by design; any confirmation (e.g. a session-end "finished / interrupted / lost focus / switching tasks" prompt per Focus Design §6) reuses the same single-tap, one-question pattern already used elsewhere — never a stacked dialog inside an already-tiny floating window. If a wider survey (`PomodoroSurveyModal`) is needed, it opens in the **main** window, which the floating window can bring to focus.
- **Persist width/height in `localStorage`** (`pipWidgetSize`), read on next `requestWindow()` call — per-device as noted in §4.
- **Theme:** clone the current `data-theme`/dark-mode class onto the PiP document's root alongside the stylesheet link, so the floating widget matches whatever mode the main app is in at open time; it doesn't need to live-sync if the user later toggles theme in the main window (reopen picks it up).

---

## 7. New files / touched files

| File | Change |
|---|---|
| `components/focus-session-provider.tsx` | **New.** Lifts Pomodoro state out of `pomodoro-timer.tsx` (§5). |
| `components/pomodoro-timer.tsx` | Refactor to consume `FocusSessionProvider` instead of local `useState`. Behavior unchanged. |
| `app/layout.tsx` or `components/app-shell.tsx` | Mount `FocusSessionProvider`, alongside the existing `WorkdaySessionProvider`. |
| `lib/floating-widget.ts` | **New.** `FLOATING_WIDGET_ITEMS`, `isFloatingWidgetItemEnabled`/`resolveFloatingWidgetItems` — mirrors `lib/dashboard-widgets.ts`. |
| `components/floating-widget-button.tsx` | **New.** Feature-detects the API, owns `requestWindow()`/portal lifecycle, renders the "Float" / "Bring back" button. |
| `components/floating-widget-content.tsx` | **New.** The actual 3–4 row content — reads `FocusSessionProvider`, `pickNextAction`, `WorkdaySessionProvider.reminder`. This is the only component that ever renders inside the PiP document. |
| `components/floating-widget-customize-dialog.tsx` | **New.** Copy of `DashboardCustomizeDialog` targeting `FLOATING_WIDGET_ITEMS`. |
| `app/(app)/settings/…` | Add a "Floating widget" section that opens the customize dialog, next to the existing Customize entry point pattern. |
| `types/index.ts` | Add `UserSettings.floatingWidgetItems?: string[]`. |

---

## 8. Rating

| # | Piece | Impact ★1–5 | Effort | Risk | Verdict |
|---|---|---|---|---|---|
| 1 | `FocusSessionProvider` lift (timer survives navigation) | ★4 — fixes a real existing gap, unlocks everything else | M (refactor of working code) | 🟡 (touches existing Pomodoro flow — survey modal, presets, task-linking, `initialFocus`) | ✅ Do, first, as its own PR |
| 2 | Document PiP window + portal, Float button, feature detection | ★4 | S–M | 🟢 (additive, no existing code touched) | ✅ Do |
| 3 | Timer + current-focus rows | ★4 | S (reuses `pickNextAction`, provider state) | 🟢 | ✅ Do |
| 4 | Hydration/break nudge row, protected-block suppression | ★3 | S | 🟢 | ✅ Do |
| 5 | Settings checkbox list (`floatingWidgetItems`) | ★3 | S (copy of existing pattern) | 🟢 | ✅ Do |
| 6 | Opt-in Load Index / longest-unbroken-focus row | ★2 | S | 🟢 | ⚠️ Do, off by default |
| 7 | Quotes row | — | — | — | ❌ Don't (§3) |
| 8 | Generic "reminders" (task due-dates, arbitrary alerts) in the widget | — | — | — | ❌ Don't (§3, reopens Focus Design §12) |

---

## 9. Anti-features (things that will look like good ideas later — don't build them)

| Don't build | Why |
|---|---|
| Quotes / any motivational or encouragement text | Focus Design §11, and fails glanceability on its own terms (§3) |
| A generic, user-defined reminders/notifications feed in the widget | Reopens Focus Design §12's "no notifications outside hydration/break" rule |
| Letting the widget auto-open on app load | The API requires a user gesture anyway; even if it didn't, an unrequested always-on-top window is exactly the kind of thing that gets the app force-quit from the dock, not trusted |
| A second, independent timer instance inside the widget | Would drift from the real one and double the state to keep in sync — the whole reason §5/§6 insist on one provider + a portal |
| An in-page `position: fixed` fallback for unsupported browsers | Doesn't survive tab switches, doesn't sit above other apps — the actual point of the request — so it would just be a worse feature wearing the same name |
| Making the widget a general "pin any card" framework | Scope creep past what's asked; the row cap (§6) and fixed item list (§2) are deliberate, not a v1 limitation to lift later |

---

## 10. Open questions for a human to resolve

- **Entry point placement:** Float button on the dashboard's Pomodoro card only, or also in the header (`DaySessionBar`'s row) so it's reachable from any page once the timer is running? Leaning toward both, but the header one only appearing once a session is actually active.
- **Click target inside the PiP window:** does "Current focus"'s Start button, when idle, need to focus/switch the main window's route (e.g. jump to `/tasks`), or is the floating widget read/glance-only for that row with no click action? If it's the latter, it breaks the "actionable in one tap" rule from §2 for that specific row — worth deciding deliberately rather than by default.
- **Multi-tab:** if FocusOS is open in two tabs, does `documentPictureInPicture` in tab B know a PiP window from tab A already exists? (It doesn't, by API design — each tab owns its own PiP window.) Worth a one-line note in Settings ("float" opens relative to the tab it was clicked from) rather than silently surprising a multi-tab user.
