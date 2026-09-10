/**
 * The one plain-language vocabulary (plan §5, decision D3). Every new screen
 * built from U1 onward pulls its labels from here instead of inventing its
 * own copy, so the eventual app-wide rename (U4) only has to migrate screens
 * that predate this file — nothing built after it needs to change words twice.
 *
 * Scope: UI labels, headings, buttons, toasts, empty states. NOT renamed:
 * TypeScript identifiers, Firestore field names, routes, export keys — see
 * plan §5 for the full boundary. Each entry's `label` is the word shown to
 * users; `hint` is the one-line ⓘ explanation from the plan's table.
 */
export interface CopyEntry {
  label: string;
  hint?: string;
}

export const copy = {
  workload: { label: "Workload", hint: "How much you've done today compared with what today asked for" },
  planned: { label: "Planned" },
  done: { label: "Done" },
  catchUpHours: { label: "Catch-up hours", hint: "Planned work you didn't get to over the last two weeks" },
  onTrackStreak: { label: "On-track streak", hint: "Days in a row you hit your planned workload" },
  topicsRevised: { label: "Topics revised", hint: "Share of a course's topics you've revised at least once" },
  upNext: { label: "Up next", hint: "The single most useful thing to do right now" },
  assessment: { label: "Assessment", hint: "A quiz, lab, assignment, presentation, or exam with a due date" },
  logAClass: { label: "Log a class", hint: "Record attendance, topics covered, and how well you understood them" },
  understanding: { label: "Understanding", hint: "1-5, how well you know this topic" },
  revisionCard: { label: "Revision card" },
  revisionSchedule: { label: "Revision schedule" },
  todaysRevision: { label: "Today's revision" },
  revisePage: { label: "Revise" },
  skim: { label: "Skim", hint: "Read a paper in stages (Keshav's three-pass method); stop whenever you have enough" },
  read: { label: "Read" },
  deepDive: { label: "Deep dive" },
  keepReading: { label: "Keep reading" },
  saveForLater: { label: "Save for later", hint: "Brings the paper back in ~6 months" },
  notRelevant: { label: "Not relevant" },
  whyAmIReadingThis: { label: "Why am I reading this?" },
  paperSet: { label: "Paper set", hint: "Compare related papers together" },
  literatureSurvey: { label: "Literature survey", hint: "A paper set that also finds shared citations" },
  whatConnectsThesePapers: { label: "What connects these papers?" },
  layeredSummary: { label: "Layered summary", hint: "One-line gist down to reproduction details, generated from the PDF" },
  suggestedHighlights: { label: "Suggested highlights" },
  block: { label: "Block", hint: "A chunk of time on your plan" },
  dayTemplate: { label: "Day template" },
  workdayTemplate: { label: "Workday template", hint: "The template Start day uses" },
  breakDayTemplate: { label: "Break-day template", hint: "Used on days in a semester break" },
  semester: { label: "Semester" },
  semesterBreak: { label: "Semester break" },
  noTerm: { label: "No term" },
  yourDay: { label: "Your day", hint: "Starting it builds today's plan and turns on reminders" },
  focusSession: { label: "Focus session" },
  focusTimer: { label: "Focus timer" },
  howDidThatGo: { label: "How did that go?" },
  dailyWrapUp: { label: "Daily wrap-up" },
  weeklyCheckin: { label: "Weekly check-in" },
  morningOverview: { label: "Morning overview" },
  suggestionsForTomorrow: { label: "Suggestions for tomorrow", hint: "Nothing is added until you accept it" },
  headsUp: { label: "Heads-up" },
  hardDeadline: { label: "Hard deadline", hint: "Forms, visas, fees — not counted in your workload plan" },
  browseTemplates: { label: "Browse templates" },
  useForToday: { label: "Use for today" },
  previewOnToday: { label: "Preview on today" },
  makeWorkdayTemplate: { label: "Make workday template" },
  yourTemplates: { label: "Your templates" },
  fromYourGroup: { label: "From your group" },
  builtIn: { label: "Built-in" }
} as const satisfies Record<string, CopyEntry>;

export type CopyKey = keyof typeof copy;

export function label(key: CopyKey) {
  return copy[key].label;
}
