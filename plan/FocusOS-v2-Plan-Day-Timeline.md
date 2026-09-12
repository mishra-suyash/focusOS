# FocusOS v2 — Plan › Day: Drag-and-Drop Timeline Redesign

**Status:** Draft for review · **Route:** `/plan/day` · **Companion to:** `FocusOS-v2-Plan.md`, `FocusOS-v2-Essentials-and-Templates-Plan.md`
**Principle carried over:** additive and non-destructive. No migration, no schema break, old saved days open unchanged.

---

## 0. TL;DR

Replace the current stack of per-block forms with three linked surfaces:

1. **Day strip** — a full-width 24-hour rectangle at the top showing the whole day's shape, a now-marker, and a viewport brush.
2. **Time grid** — a vertical, calendar-style day column where blocks are created, moved, and resized by dragging, snapping to 15 minutes.
3. **Inspector + tray** — a side panel that edits the selected block (replacing the inline forms) and, when nothing is selected, offers draggable tasks, quick blocks, and templates.

Saving becomes automatic (one Firestore write per finished gesture), "Move up / Move down" disappears (order is derived from time), and every drag has a keyboard and a type-it-in equivalent.

---

## 1. Rating legend

| Symbol | Meaning |
|---|---|
| **Impact ★1–5** | How much it improves day-to-day planning for a PhD student |
| **Effort S / M / L / XL** | S ≤ 1 day · M 2–4 days · L 1–2 weeks · XL > 2 weeks (solo dev) |
| **Risk 🟢 / 🟡 / 🔴** | Low / medium / high chance of regressions, data issues, or UX confusion |
| **Verdict** | ✅ Do · ⚠️ Do with care · ⏸ Defer · ❌ Don't |

---

## 2. Audit of the current screen

Based on the uploaded screenshot of `/planner/day` (11 Sep 2026) and the Browse templates modal.

| # | Issue | Evidence | Flag | Addressed in |
|---|---|---|---|---|
| A1 | **No visual timeline.** The card is titled "24-hour timeline" but renders a list of forms; gaps, overlaps, and the day's shape are invisible. | Five stacked cards, no time axis | 🔴 | §4.1, §4.2 |
| A2 | **Vertical cost per block is ~140px.** Five blocks already need scrolling; a realistic 10–12 block research day is 3+ screens. | Title + note textarea + tasks + buttons per block | 🔴 | §4.2, §4.3 |
| A3 | **Move up / Move down contradicts time order.** Validation sorts by start time, so array order and visual order can disagree; the buttons imply order is independent of time. | Buttons on every block | 🔴 | §7 |
| A4 | **Vocabulary drift.** UI shows "Planner", "Day Planner", "Add slot", "Delete slot", "Daily Review", "Weekly Review", "Review", while the README glossary says Block, Plan — Day, Daily wrap-up, Weekly check-in, Revise. Either the CI vocabulary scan is not gating this deploy, or the deploy predates the rename. | Sidebar + buttons | 🔴 | §14 DP0 |
| A5 | **Clipped native time inputs.** "08:00 A" / "06:30 P" truncation; native pickers differ per browser and are slow for 15-minute adjustments. | Time fields in every block | 🟡 | §4.3 |
| A6 | **Explicit "Save day".** Unsaved edits are lost on navigation, there is no dirty indicator, and validation errors only surface at save time. | Top-right button | 🟡 | §6 |
| A7 | **Manual per-block status.** A block at 08:00 still says "Upcoming" at 18:00; status is a dropdown the user must maintain. | "Upcoming" select on all blocks | 🟡 | §4.3 |
| A8 | **"Save as template" permanently occupies the left column** for an occasional action; together with Templates it pushes the timeline into ~55% of the width. | Left column | 🟡 | §4.4 |
| A9 | **Repeated empty state.** "No open tasks to assign." appears in every block. | Each block | 🟢 | §4.3 |
| A10 | **Date shown twice in two formats** ("FRIDAY, SEPTEMBER 11" and `11/09/2026`), which is ambiguous for readers used to MM/DD. | Header + date input | 🟢 | §4 |
| A11 | **No day totals on the planner itself.** Deep-work totals exist in the template modal ("3h 30m deep work") but not for the day being edited. | Modal vs page | 🟢 | §4.1 |
| A12 | **Templates are disconnected from the timeline.** The modal already draws a mini timeline bar and has a "My day starts at" field, but you can't see the template against your existing day before applying. | Browse templates modal | 🟢 (opportunity) | §4.4 |
| A13 | **Legacy overlaps can exist.** Per README, "Start day" merges class blocks without overlap checks, so some saved days already contain overlaps the new UI must render safely. | README nuance | 🟡 | §4.2, §11 |

**What's already good and should be kept:** gaps-as-free-time (no forced scheduling), "Preview writes nothing", confirmation before overwriting a planned day, the mini timeline bars in the template cards, and deep-work summaries from `lib/schedule.ts`.

---

## 3. Goals and non-goals

**Goals**

- See the whole day at a glance, including free time and where "now" is.
- Create, move, and resize blocks by direct manipulation in ≤ 2 gestures.
- Keep typing as a first-class path: anyone who dislikes dragging can do everything from the inspector or keyboard.
- Zero Firestore writes during a drag; one write per committed change.
- No schema migration; old days and templates open unchanged.
- One unified vocabulary (Block, Plan — Day, etc.), enforced by the existing CI scan.

**Non-goals (this spec)**

- Multi-day or week-view dragging (see suggestion S13).
- Recurring blocks (the app has no recurrence concept; courses already cover class recurrence).
- Any AI auto-scheduling or auto-applied plan (explicit anti-feature).
- Real-time multi-tab/multi-device collaborative editing.

---

## 4. Target layout

### Desktop (≥ 1024px)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ◀  Fri, 11 Sep 2026  ▶   [Today]        Deep work 3h30 · Planned 6h05 · Free 9h │
│                                          [Templates]  [Save as template]  Saved ✓│
├──────────────────────────────────────────────────────────────────────────────┤
│ DAY STRIP                                                                    │
│ 00    03    06    09    12    15    18    21    24                           │
│ ░░░░░░░░░░░░░░░[Rev]      [Lunch]     [Assign][Read][Log]                    │
│                  ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ ← viewport brush      │▲now  │
├─────────────────────────────────────────────────┬────────────────────────────┤
│ TIME GRID                                       │ INSPECTOR  (block selected)│
│ 08:00 ┌───────────────────────────────────────┐ │ Title  [Revise today's …] │
│       │ 📖 Revise today's cards   08:00–08:45 │ │ Type   (Reading)(Deep)(…) │
│ 09:00 └───────────────────────────────────────┘ │ Time   08:00 → 08:45  45m │
│       ·  ·  ·  ·  free  ·  ·  ·  ·  ·  ·  ·  ·  │        [25][45][60][90]   │
│ 10:00                                           │ Note   …                  │
│  …                                              │ Tasks  + Assign a task    │
│ 12:30 ┌───────────────────────────────────────┐ │ Status Auto (Past) ✓ Skip │
│       │ 🍽 Lunch                  12:30–13:30 │ │ [Duplicate] [Split] [🗑]  │
│ 13:30 └───────────────────────────────────────┘ │ ─────────────────────────  │
│  …                                              │ TRAY  (nothing selected)   │
│                                                 │ Tasks to schedule   ⠿ ⠿ ⠿ │
│                                                 │ Quick blocks        ⠿ ⠿ ⠿ │
│                                                 │ Templates           ⠿ ⠿   │
└─────────────────────────────────────────────────┴────────────────────────────┘
```

### Mobile (< 768px)

Strip pinned under the header (compact, no labels except 06/12/18), grid full width, inspector as a bottom sheet on tap, tray as a floating "+" that opens a bottom sheet.

---

### 4.1 Day strip (the top rectangle)

**Purpose:** overview and navigation. Precise editing happens in the grid.

| Property | Spec |
|---|---|
| Range | Always 00:00–24:00. Ticks every hour, labels every 3h (desktop) or 6h (mobile). |
| Size | Full content width; 48px tall desktop, 36px mobile. |
| Blocks | Absolutely positioned, width ∝ duration, colour from type (or `slot.color` override), plus a type icon when width ≥ 20px. |
| Free time | Rendered as empty track, never as a warning colour. |
| Past | Region before now dimmed to ~60% opacity (today only). |
| Now marker | Vertical line + small triangle; recomputed every 60s. Hidden on other dates. |
| Viewport brush | Outlines the range currently visible in the grid. Drag brush → scroll grid. Click anywhere on strip → centre grid on that time. |
| Hover / long-press | Tooltip: title, time range, duration, status. |
| Totals | Deep work · Planned · Free (awake) shown beside or above the strip, from the existing deep-work summary logic. |
| Conflicts | A red tick above any overlapping range (legacy data only, see A13). |
| Optional lane (DP5) | A thin second lane showing actual focus sessions for the day, "planned vs done" (S2). |

**Component reuse (strongly recommended):** one `<DayStrip variant="full" | "mini">` powers this strip, the template preview bars in Browse templates, the dashboard's full-day schedule widget, and later the calendar week view.

#### Strip decisions, rated

| Option | Pros | Cons | Impact | Effort | Risk | Verdict |
|---|---|---|---|---|---|---|
| Strip as overview + navigation only | Simple, no precision problems, great at-a-glance | Users may try to drag on it and nothing happens | ★5 | M | 🟢 | ✅ |
| Also allow **moving** blocks on the strip (desktop) | Fast coarse rescheduling | At 1200px, 15 min ≈ 12px, fiddly; two places to edit = double testing | ★2 | M | 🟡 | ⏸ |
| Allow moving on strip (mobile) | — | At 360px, 15 min ≈ 4px; unusable | ★1 | M | 🔴 | ❌ |
| **Drag-to-create** on strip (desktop, snaps 30 min, then refine in grid) | Lets users "paint" a rough day quickly | Minor learning curve | ★3 | S | 🟢 | ⚠️ (DP3, behind setting) |
| Compress night hours (e.g. 00–06 narrower) | More room for waking hours | Breaks proportionality; "24-hour" becomes misleading | ★2 | S | 🟡 | ❌ (grid auto-scroll solves this instead) |

---

### 4.2 Time grid

| Property | Spec |
|---|---|
| Orientation | Vertical, one column (the day). |
| Scale | Default 64px per hour (24h = 1536px); zoom presets 48 / 64 / 96 via `Ctrl +/-` or a small control. |
| Snap | Default 15 min; setting 5 / 10 / 15 / 30. Hold `Alt` while dragging to snap to 5 min. |
| Edge magnetism | When a dragged edge comes within 10 min of a neighbour's edge, it sticks to it (back-to-back blocks without gaps). |
| Initial scroll | Today: now − 1h. Other dates: first block − 30 min. Empty day: 08:00 (or "day starts at" setting). |
| Hour labels | 12h or 24h per user setting (default from locale). Fixes the clipping in A5. |
| Block card | Title, time range, type icon, assigned-task count chip, status marker. Blocks < 30 min collapse to one line; < 15 min show title on hover only. |
| Selection | One selected block at a time (multi-select deferred). Selected = raised + outline + visible resize handles. |
| Class blocks | Lock icon; see decision D2 in §16. |
| Legacy overlaps | Laid out side-by-side in lanes with a red outline and a "Resolve overlap" action (move later block to next free gap / trim). Rendering never mutates data. |
| Empty state | "Drag on the grid to add a block, or pick a template" with the template chips inline. |

---

### 4.3 Inspector (replaces the inline forms)

Opens when a block is selected; edits apply on blur (and are undoable).

| Field | Current | New | Why |
|---|---|---|---|
| Title | Text input | Text input, autofocused on newly created blocks | Create → type → done |
| Type | Select | Chip row with icons (Reading, Deep work, Admin, Meal, Break, Class…, from the existing type union) | One tap, visible options |
| Start / end | Native time inputs | Typeable `HH:mm` fields (accept "9", "930", "9:30pm"), ± snap steppers, duration presets 25 / 45 / 60 / 90 | Faster, no clipping, consistent cross-browser |
| Note | Always-visible textarea | Collapsed "Add note" link → expands | Removes empty boxes |
| Tasks | Always-visible list or empty message | "+ Assign a task" combobox; chips for assigned tasks; hidden when none and no open tasks | Fixes A9 |
| Status | Manual select | **Auto display** (Upcoming / Now / Past) derived from time; explicit actions ✓ Done and Skip write `completed` / `skipped` | Fixes A7 with no schema change |
| Actions | Move up / Move down / Delete | Duplicate · Split at… · Delete (undo toast) · **Start focus session** (S11) | Order is time-derived now |

---

### 4.4 Tray (inspector when nothing is selected)

| Section | Behaviour |
|---|---|
| **Tasks to schedule** | Open tasks due today / this week and in-progress tasks, priority-sorted. Drag onto empty grid → creates a block sized from `estimatedPomodoros × work length` (min 25 min), titled after the task, with the task assigned. Drag onto an existing block → assigns only. |
| **Quick blocks** | One chip per common type with a default duration (Deep work 90, Reading 45, Admin 30, Break 15, Meal 60). Drag onto grid or click to drop into the next free gap after now. |
| **Templates** | Mini strips of built-in and user templates. Drag a template onto the grid → ghost preview anchored at the drop time (this replaces the "My day starts at" field) → **Replace day / Fill gaps only / Cancel**. |
| **Save as template** | Moved from the permanent left column into the header as a button + small dialog (fixes A8). |

---

## 5. Interaction specification

| Action | Mouse / trackpad | Touch | Keyboard | Result + feedback |
|---|---|---|---|---|
| Create | Drag down on empty grid; double-click = 60 min block | Long-press empty grid (400ms) then drag; or "+" sheet | `N` creates at focused time (default 60 min) | Ghost with live label `10:15–11:45 · 1h30`; inspector opens with title focused |
| Select | Click block | Tap block | `Tab` / `Shift+Tab` through blocks in time order | Inspector shows block |
| Move | Drag block body | Long-press block (250ms) then drag | `↑ / ↓` ± snap · `Shift+↑/↓` ± 1h | Snap guides + time label; invalid drop shows red ghost and reverts |
| Resize | Drag top/bottom handle | Drag enlarged handle zones (≥ 24px) on selected block | `Alt+↑/↓` changes end · `Alt+Shift+↑/↓` changes start | Duration label updates live |
| Duplicate | `Alt`-drag, or `Ctrl/Cmd+D` | Inspector button | `Ctrl/Cmd+D` | Copy placed in next free gap of equal length |
| Delete | Inspector 🗑 | Inspector 🗑 | `Delete` / `Backspace` | Removed + "Undo" toast (6s) |
| Undo / redo | `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` | Toast "Undo" | same | Session-local stack, 50 steps |
| Cancel drag | `Esc` | Drag back to origin | `Esc` | Reverts with no write |
| Auto-scroll | Pointer within 48px of grid edge while dragging | same | — | Grid scrolls, speed ∝ proximity |
| Jump to time | Click day strip | Tap day strip | `T` = now (today) | Grid centres |

**Accessibility announcements** (live region): "Reading, moved to 10:15 to 11:00", "Cannot drop, overlaps Lunch", "Block deleted, press Control Z to undo".

### 5.1 Overlap policy — options rated

The current validator rejects overlaps; downstream logic (active-block detection, break-reminder suppression, Workload's scheduled deep-work minutes) assumes non-overlapping blocks.

| Option | Pros | Cons | Impact | Effort | Risk | Verdict |
|---|---|---|---|---|---|---|
| **A. Refuse** — red ghost, snap back | Matches current invariant exactly; predictable | Frustrating on packed days | ★3 | S | 🟢 | ✅ default |
| **B. Snap to nearest free gap** that fits, else refuse | Forgiving; feels "smart" | Block can land somewhere the user didn't aim; must show where before release | ★4 | M | 🟡 | ⚠️ add as ghost hint ("will place at 14:00") in DP2 |
| **C. Push (ripple)** later blocks down | Great for "running late" | Surprising cascades, can push past 24:00, collides with locked class blocks | ★4 | M | 🔴 | ⚠️ only via explicit `Shift`-drag or the "Shift rest of day" action (S1), never default |
| **D. Allow overlap with warning** | Most flexible | Breaks the invariant several features depend on | ★2 | S | 🔴 | ❌ |

**Recommendation:** A + edge magnetism for DP2; add B's hint and C as an explicit modifier in DP3 after using A for a week.

---

## 6. Save model — options rated

| Option | Pros | Cons | Impact | Effort | Risk | Verdict |
|---|---|---|---|---|---|---|
| **A. Keep explicit "Save day"** | Familiar; fewest writes | Lost edits on navigation; drag UIs feel broken without instant persistence; late validation | ★2 | — | 🟡 | ❌ |
| **B. Autosave per committed gesture** (drop, resize end, inspector blur), coalesced with a 1s debounce | Nothing lost; every state is valid because gestures can't produce invalid states | Slightly more writes; needs a visible save status | ★5 | M | 🟢 | ✅ |
| **C. B + flush on `visibilitychange` (hidden) and route change** | Covers closing the tab mid-debounce | Small extra code | ★4 | S | 🟢 | ✅ with B |
| **D. Local draft, "Publish day" button** | Lets users experiment freely | Two states to reason about; undo already covers experimentation | ★2 | M | 🟡 | ❌ |

**Rules**

- Never write during `pointermove`. The in-flight position lives in a ref/`requestAnimationFrame` loop, not React state or Firestore.
- Each write sends the full sorted `slots[]` array on the day's schedule document (same as today), so one gesture = one write.
- Budget check: an intense planning session of ~60 gestures ≈ 60 writes, negligible against Spark's 20k writes/day.
- Header status pill: `Saving…` → `Saved ✓` → `Offline, will retry` → `Couldn't save, Retry`.
- Typed inspector values are validated inline (end after start, no overlap) before commit; invalid fields show an error and do not save.
- **Two tabs open:** last write wins on the array. Mitigation: keep an `updatedAt` on the schedule doc; if a snapshot arrives with a newer `updatedAt` while the user has un-flushed edits, show "This day changed in another tab — Reload / Keep mine". Rated ★3 · S · 🟢 · ✅.

---

## 7. Data model and code structure

### 7.1 Schema impact

| Item | Change | Notes |
|---|---|---|
| `slots[]` shape (`id`, `title`, `type`, `startTime`, `endTime`, `assignedTaskIds`, `note`, `status`, `color`) | **None** | Already sufficient for the grid. |
| Array order | Always written sorted by `startTime` | Dashboard and PDF export keep working; Move up/down removed (fixes A3). |
| `status` | Unchanged values; "Now / Past" is display-only | Only explicit ✓ / Skip writes. |
| `updatedAt` on schedule doc | Additive, optional | For the two-tab check in §6. Old docs without it are treated as "unknown". |
| Class override (optional) | Additive `courseOverride?: true` on a moved class block | Only if decision D2 = "allow moving"; `lib/courses.ts` resync must skip overridden blocks. |
| Planner prefs in `meta/settings` via `useUserSettings` | Additive `planDay: { snapMinutes, hourHeight, timeFormat, defaultBlockMinutes, dayStartsAt, showDoneLane }` | Defaults in code so missing = current behaviour. |
| Templates (`dayTemplates`, built-ins in code, `publicCatalog/current`) | **None** | Drop-anchoring reuses the existing "day starts at" shift logic. |

No migration script. Nothing is deleted or renamed in Firestore.

### 7.2 Proposed modules

| Path | Kind | Responsibility |
|---|---|---|
| `lib/timeline.ts` | Pure, unit-tested | minutes ↔ px, snap, clamp to 00:00–24:00, collision detection, `nearestFreeGap`, `rippleShift`, `laneLayout` for legacy overlaps, parse typed times ("930", "9:30pm") |
| `hooks/use-plan-day-editor.ts` | Reducer + effects | Commands: `create`, `move`, `resize`, `update`, `delete`, `duplicate`, `split`, `applyTemplate(mode)`, `undo`, `redo`; debounced autosave; save status |
| `components/plan/day-strip.tsx` | Client | `variant: "full" | "mini"`; reused by template cards and dashboard |
| `components/plan/time-grid.tsx` | Client | Hour lines, now line, drag/resize surface, auto-scroll |
| `components/plan/block-card.tsx` | Client, memoised | Visual block + handles + a11y label |
| `components/plan/block-inspector.tsx` | Client | Fields in §4.3 |
| `components/plan/plan-tray.tsx` | Client | Tasks, quick blocks, templates |

This follows the existing pure-logic-plus-thin-UI split (`lib/schedule.ts`, `lib/revision.ts`, etc.). `lib/schedule.ts` keeps overlap validation as the single source of truth; `lib/timeline.ts` calls it rather than duplicating it.

### 7.3 Feature flag

Register `planDayTimeline` in the feature module registry (from the Essentials plan). Off → current editor. On → new editor. Both read and write the identical document shape, so toggling is non-destructive. Remove the old editor after two weeks of personal use without falling back.

---

## 8. Drag-and-drop library — options rated

| Option | Pros | Cons | Impact | Effort | Risk | Verdict |
|---|---|---|---|---|---|---|
| **Custom Pointer Events + `lib/timeline.ts`** | Exact time math, zero dependency, best perf, full control of resize | You build touch-vs-scroll disambiguation, keyboard DnD, auto-scroll, a11y announcements yourself | ★4 | L | 🟡 | ⚠️ good for grid move/resize |
| **dnd-kit (`@dnd-kit/core`)** | Pointer, touch, and keyboard sensors; activation delay/tolerance for touch; built-in screen-reader instructions and live regions; `DragOverlay`; modifiers for snapping; small core | Built around droppable targets rather than continuous time; resize isn't a built-in concept; confirm React 19 compatibility of the version you install | ★5 | M | 🟢 | ✅ for tray → grid and task → block |
| **FullCalendar (time grid view)** | Drag, resize, and select work out of the box | Heavy; styling it to match the Tailwind dark theme is a fight; no day strip; custom block cards and the tray are awkward; another data model to map | ★3 | M | 🟡 | ❌ |
| **react-big-calendar + DnD addon** | Similar out-of-box behaviour | Dated look, same theming/mapping cost | ★2 | M | 🟡 | ❌ |
| **Pragmatic drag and drop** | Tiny, framework-agnostic, good for cross-container | Less React-idiomatic; keyboard drag left to you | ★3 | M | 🟡 | ⏸ |

**Recommendation:** hybrid. Use dnd-kit's `DndContext` for everything that crosses containers (tray tasks, quick blocks, templates) and for block moves (custom modifier snaps the y-delta to `snapMinutes` via `lib/timeline.ts`). Implement resize handles with plain pointer events on the block. Do a **one-day spike** first (move + resize + touch on a phone) before committing; record the outcome in `DECISIONS.md`.

---

## 9. Accessibility

| Requirement | Spec |
|---|---|
| Non-drag alternative for every drag (WCAG 2.2 SC 2.5.7) | Inspector typing + keyboard shortcuts in §5 |
| Target size (WCAG 2.2 SC 2.5.8, ≥ 24×24 CSS px) | Resize handles have ≥ 24px hit areas (visual line can be thinner) |
| Colour not the only signal | Type icons on blocks and strip; conflict = outline + icon, not just red |
| Semantics | Each block is a focusable button: `aria-label="Reading, 18:30 to 19:15, upcoming, 1 task"`; grid has an `aria-describedby` with keyboard instructions |
| Announcements | Live region messages listed in §5 |
| Motion | `prefers-reduced-motion` disables drop animations and auto-scroll easing |
| Focus | After delete, focus moves to the next block in time; after create, to the title field |

---

## 10. Performance

- During drag, move a `DragOverlay` / CSS `transform` only; commit to reducer state on drop.
- 24h × 64px = 1536px of DOM; no virtualisation needed.
- Memoise `block-card` by `slot` identity; strip renders as absolutely positioned divs (or one SVG) — ≤ 30 elements.
- Target: 60fps drag on a mid-range Android phone; no layout thrash (read geometry once at drag start).
- No new Firestore listeners: reuse the existing schedule subscription.

---

## 11. Edge cases

| Case | Handling | Flag |
|---|---|---|
| **Blocks crossing midnight** (e.g. sleep 23:00–07:00) | Current model forbids end ≤ start. Options: clamp at 24:00 and let the user add 00:00–07:00 on the next day; or allow `endTime: "24:00"` only. Cross-date blocks are out of scope. See D1. | 🟡 |
| **Legacy overlapping days** | Render in lanes, flag, offer "Resolve"; never auto-fix | 🟡 |
| **Course edit regenerates future class blocks** | If class blocks are draggable, a later course edit would silently undo the move unless `courseOverride` is respected. See D2. | 🔴 |
| **Moving the currently active block during "Your day"** | Break-reminder suppression reads the schedule, so it updates immediately; no special code, but add a test | 🟢 |
| **Past dates** | Editable (useful for logging what actually happened) but show a subtle "Past day" banner; blocks default to Past display | 🟢 |
| **Tab left open across midnight** | Now marker detects date change and shows "It's a new day — go to today" instead of silently drawing on yesterday | 🟡 |
| **Template apply on a planned day** | Replace / Fill gaps only / Cancel; Fill gaps skips template blocks that would overlap | 🟢 |
| **Very short blocks (< snap)** | Allowed if typed; render min 12px tall; drag resize can't go below snap | 🟢 |
| **Accepted "Suggestions for tomorrow" blocks** | Appear as normal blocks; if S3 is built, pending ones show as ghosts | 🟢 |
| **Guest session** | Same behaviour; autosave still applies | 🟢 |
| **Offline** | If Firestore offline persistence is enabled, writes queue; status pill shows "Offline, will retry" | 🟡 |

---

## 12. Overall pros and cons, rated per feature

| Feature | Pros | Cons | Impact | Effort | Risk | Verdict |
|---|---|---|---|---|---|---|
| Day strip (overview + brush + now) | Whole day visible instantly; reusable in 3 other places | Another component to keep in sync with the grid | ★5 | M | 🟢 | ✅ |
| Vertical time grid with drag move/resize | Direct manipulation; gaps and conflicts obvious | Biggest build item; touch needs care | ★5 | L | 🟡 | ✅ |
| Inspector replaces inline forms | Compact list, no repeated empty fields | One extra click to edit notes/tasks | ★4 | M | 🟢 | ✅ |
| Typeable times + duration presets | Fast, fixes clipping | Parser edge cases ("12" = noon or midnight?) | ★4 | S | 🟡 | ✅ (noon; document it) |
| Autosave + undo | No lost work; safe experimentation | Needs status pill and two-tab guard | ★5 | M | 🟢 | ✅ |
| Remove Move up / Move down | Removes a contradictory mental model | Users who relied on it lose nothing real (time decides order) | ★3 | S | 🟢 | ✅ |
| Auto status (Now/Past) + ✓/Skip | No stale "Upcoming" | Past-but-unmarked needs a gentle, non-guilt treatment | ★4 | S | 🟢 | ✅ |
| Tray: drag tasks into the day | Connects Tasks and Plan (currently separate worlds) | Duration estimate from pomodoros may be off | ★5 | M | 🟡 | ✅ |
| Drag templates onto the grid (anchored) + Fill gaps | Preview in context; replaces "day starts at" field | Ghost + confirm flow adds UI states | ★4 | M | 🟡 | ✅ |
| Overlap: refuse + magnetism | Keeps invariants | Packed days feel rigid | ★3 | S | 🟢 | ✅ |
| Overlap: ripple push as default | Fast rescheduling | Surprising; touches class blocks | ★4 | M | 🔴 | ❌ default / ⚠️ modifier |
| Strip drag-to-move | Coarse speed | Precision + double testing | ★2 | M | 🟡 | ⏸ |
| Multi-select drag | Move a morning at once | Complex selection model, low frequency | ★2 | L | 🟡 | ⏸ |
| Mobile bottom-sheet inspector | Usable on phone | Sheet + drag gesture conflicts | ★4 | M | 🟡 | ⚠️ |

**Net assessment**

- ✅ **Pros:** turns a form editor into a planner; removes three existing UX bugs (A3, A6, A7); no schema risk; reuses existing logic and the template strip; ties Tasks, Templates, and Focus sessions into one surface.
- ⚠️ **Cons:** ~3–4 weeks solo for DP0–DP4; touch DnD is the most likely source of polish bugs; class-block regeneration interaction must be decided before DP2; more client JS on the Plan page (mitigate by lazy-loading the editor route chunk).

---

## 13. Additional suggestions, rated

| # | Suggestion | Why it fits FocusOS | Impact | Effort | Risk | Verdict |
|---|---|---|---|---|---|---|
| S1 | **"Running late? Shift rest of day"** (+15 / +30 / custom) ripples all non-locked blocks after now | The most common real-world edit; explicit, so not an auto-plan | ★5 | S | 🟢 | ✅ |
| S2 | **Planned vs done lane** on the strip from focus sessions (they already carry `slotId`) | Zero schema change; makes the daily wrap-up honest | ★4 | M | 🟢 | ✅ DP5 |
| S3 | **Ghost blocks for "Suggestions for tomorrow"** rendered in tomorrow's grid with Accept / Dismiss | Uses existing `proposedSlots` + decisions; keeps "nothing auto-applied" | ★4 | M | 🟢 | ✅ DP5 |
| S4 | **Start focus session from a block** (pre-fills label, category mapped from type, `slotId`) | Closes the plan → do loop in one click | ★5 | S | 🟢 | ✅ DP5 |
| S5 | **"Schedule it" on the Up next card** → places it in the next free gap and opens Plan — Day | Bridges dashboard recommendation to action | ★4 | S | 🟢 | ✅ |
| S6 | **Fill gaps only** template mode | Lets a template top up a day with classes already in it | ★4 | S | 🟢 | ✅ DP3 |
| S7 | **Copy another day** (yesterday / same weekday last week) as a ghost | Faster than templates for repeating weeks | ★3 | S | 🟢 | ✅ |
| S8 | **Checkpoint prep markers** on the strip (small flags for assessments inside their prep window) | Context while planning; data already computed | ★3 | S | 🟢 | ✅ |
| S9 | **Live Workload preview** while editing ("this plan → On track") | Shows effect of planning before the day happens | ★3 | M | 🟡 | ⚠️ keep neutral wording, no red guilt |
| S10 | **Quick add by text** ("read 45m 6pm", "deep work 9-11") with a deterministic parser | Keyboard-first users; no AI needed | ★3 | M | 🟡 | ⏸ after DP4 |
| S11 | **Split / merge blocks** | Useful for long deep-work blocks with a break inserted | ★2 | S | 🟢 | ✅ (split only) |
| S12 | **Suggested buffers** between back-to-back deep-work blocks (hint, not inserted) | Supports sustainable pacing | ★2 | S | 🟢 | ⏸ |
| S13 | **Week strip** — seven mini `DayStrip`s in Plan — Calendar instead of a "schedule exists" dot | Reuses the component; shows weekly balance | ★4 | M | 🟢 | ✅ after DP5 |
| S14 | **PDF export draws the strip** | Nicer daily frame, same data | ★2 | M | 🟢 | ⏸ |

**Anti-features to keep out:** auto-rescheduling without a click, "perfect day" or fill-rate scores, colouring free time as a problem, forcing every hour to be planned, streak-style penalties for skipped blocks.

---

## 14. Phased rollout

| Phase | Scope | Exit criteria |
|---|---|---|
| **DP0 — Groundwork** (S–M) | Fix vocabulary on this page and the sidebar (A4) and confirm the CI scan runs on the deploy branch; `lib/timeline.ts` + unit tests; extract `<DayStrip variant="mini">` from the template modal; register `planDayTimeline` flag | CI fails on a planted retired term; timeline tests green; template modal unchanged visually |
| **DP1 — Read-only views** (M) | Full strip with brush + now marker + totals; time grid rendering; click → inspector (reusing current field components); remove Move up / Move down; typeable times | Every existing saved day renders correctly, including a legacy overlap fixture; no writes from viewing |
| **DP2 — Direct manipulation** (L) | Create / move / resize with snap + magnetism; overlap policy A; autosave + status pill + flush on hide; undo/redo; delete toast; resolve decision D2 before starting | Zero writes during drag (dev usage overlay); one write per gesture; no invalid state reachable by gestures |
| **DP3 — Tray** (M) | Tasks drag-in and assign; quick blocks; template drag with ghost + Replace / Fill gaps; overlap hint B and `Shift` ripple; Save as template moved to header | Template apply equals old behaviour in Replace mode; Fill gaps never overlaps |
| **DP4 — Accessibility + mobile** (M) | Keyboard map, live announcements, focus management, touch long-press, bottom sheets, handle hit areas | Full day plannable with keyboard only; plannable on a 360px phone; no scroll/drag conflicts |
| **DP5 — Loop closers** (M) | S1 shift rest of day, S2 done lane, S3 suggestion ghosts, S4 start focus from block, S5 schedule-it | Used for one week without falling back to the flag-off editor |

Recommended order relative to the existing roadmap: DP0 alongside the Essentials U-phases (it shares vocabulary and feature-registry work); DP1–DP2 as one milestone; DP3–DP5 after a week of real use.

---

## 15. Acceptance criteria

1. A 90-minute deep-work block can be created at a chosen time in ≤ 2 gestures on desktop and ≤ 3 on touch.
2. No Firestore write occurs during any drag; each committed gesture produces exactly one write (verified with the dev usage overlay).
3. Every day saved by the old editor opens with identical blocks, times, notes, tasks, and statuses.
4. A day containing a legacy overlap renders without error and without modifying data until the user resolves it.
5. Every action in §5 is achievable with keyboard only and with inspector typing only.
6. The array written to Firestore is always sorted by `startTime` and passes `lib/schedule.ts` validation.
7. The CI vocabulary scan passes; no retired term (e.g. "slot", "Planner", "Day Planner") appears in UI copy.
8. Toggling `planDayTimeline` off and on loses no data.
9. Reloading within 1 second of a drag never loses the change (flush on `visibilitychange`).
10. The strip, template previews, and dashboard widget render the same day identically (shared component).

---

## 16. Open decisions (resolve before DP2, log in `DECISIONS.md`)

| ID | Question | Options | Recommendation |
|---|---|---|---|
| D1 | Cross-midnight blocks? | Clamp at 24:00 · allow `endTime "24:00"` · true cross-date blocks | Allow `"24:00"` as a valid end; no cross-date |
| D2 | Can class blocks be dragged? | Locked (edit the course instead) · movable with `courseOverride` skip in resync | Locked in DP2; revisit after use. Lock icon + "Edit course schedule" link in inspector |
| D3 | Overlap default | A refuse · B snap to gap | A, with B as a visible hint in DP3 |
| D4 | Snap default | 5 · 10 · 15 · 30 | 15 |
| D5 | Time format | Follow locale · explicit setting | Setting, defaulting from locale |
| D6 | Editing past days | Allowed · read-only · allowed with banner | Allowed with banner |
| D7 | Keep old editor behind flag how long? | Remove at DP2 · remove after DP5 + 2 weeks | After DP5 + 2 weeks |
| D8 | Strip drag-to-create on desktop | Off · on behind setting | Behind setting, DP3 |
