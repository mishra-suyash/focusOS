import type { DayTemplatePayload } from "@/lib/templates/schema";
import type { PackId } from "@/types";

/**
 * The built-in day template catalog (plan §6.2) — code-defined, read-only,
 * never referenced directly by Start day (see §6.1). `id`/`version` are
 * stable identifiers a materialized copy remembers via `DayTemplate.sourceTemplateId`
 * ('builtin:<id>') and `sourceVersion`.
 *
 * Slot-type mapping notes (the plan's own [ASSUMPTION] in §6.2, resolved here):
 * "meeting" blocks map onto the existing `admin` type (no schema change needed).
 * "reading" is a new `ScheduleSlotType` value (types/index.ts) rather than
 * `deep_work`, because `scheduleSummary().plannedDeepWork` — which feeds
 * `computeRequiredMinutes` (lib/loadindex.ts) — sums `deep_work` slots only.
 * Typing reading as deep_work would silently inflate required minutes past
 * the plan's own "keep deep work between 2.5 and 4h" guardrail.
 *
 * The Writing Day table in the plan sums to 4.5h of deep_work-typed time as
 * written; it's trimmed by 30 minutes here (see the "Edit and revise" block)
 * to respect that same guardrail rather than reproduced verbatim.
 */
export interface BuiltinDayTemplate extends DayTemplatePayload {
  /** Which starter packs recommend this template (plan §6.2 "Suggested for" column). */
  packs: PackId[];
  /** Packs for which this is the workday default (plan §8.1). */
  defaultForPack?: PackId[];
  /** Packs for which this is the break-day default (plan §8.1). */
  breakDefaultForPack?: PackId[];
}

export const BUILTIN_DAY_TEMPLATES: BuiltinDayTemplate[] = [
  {
    id: "research-day",
    version: 1,
    name: "Research Day",
    description: "A balanced research day: ~3.5h deep work, 1h reading, lab/advisor time.",
    packs: ["research", "everything", "core"],
    defaultForPack: ["research", "everything", "core"],
    slots: [
      { title: "Plan the day", type: "admin", startTime: "08:30", endTime: "08:45" },
      { title: "Deep work: experiments / code / analysis", type: "deep_work", startTime: "08:45", endTime: "10:45" },
      { title: "Break", type: "break", startTime: "10:45", endTime: "11:00" },
      { title: "Reading (skim or read a paper)", type: "reading", startTime: "11:00", endTime: "12:00" },
      { title: "Lunch", type: "meal", startTime: "12:00", endTime: "13:00" },
      { title: "Advisor, lab meetings, email", type: "admin", startTime: "13:00", endTime: "14:00" },
      { title: "Deep work: writing", type: "deep_work", startTime: "14:00", endTime: "15:30" },
      { title: "Break", type: "break", startTime: "15:30", endTime: "15:45" },
      { title: "Lab tasks & admin", type: "admin", startTime: "15:45", endTime: "16:45" },
      { title: "Wrap up & plan tomorrow", type: "admin", startTime: "16:45", endTime: "17:00" }
    ]
  },
  {
    id: "writing-day",
    version: 1,
    name: "Writing Day",
    description: "~4h of writing split across the day, with feedback and editing time.",
    packs: ["writing", "everything"],
    defaultForPack: ["writing"],
    slots: [
      { title: "Re-read yesterday's last page", type: "admin", startTime: "08:00", endTime: "08:15" },
      { title: "Writing", type: "deep_work", startTime: "08:15", endTime: "10:15" },
      { title: "Break", type: "break", startTime: "10:15", endTime: "10:30" },
      { title: "Writing", type: "deep_work", startTime: "10:30", endTime: "12:00" },
      { title: "Lunch", type: "meal", startTime: "12:00", endTime: "13:00" },
      { title: "Figures, tables, references", type: "admin", startTime: "13:00", endTime: "14:00" },
      { title: "Email & advisor feedback", type: "admin", startTime: "14:00", endTime: "15:00" },
      { title: "Walk / break", type: "break", startTime: "15:00", endTime: "15:30" },
      { title: "Edit and revise", type: "deep_work", startTime: "15:30", endTime: "16:00" },
      { title: "Break", type: "break", startTime: "16:00", endTime: "16:15" },
      { title: "Log progress, note tomorrow's starting point", type: "admin", startTime: "16:15", endTime: "16:30" }
    ]
  },
  {
    id: "coursework-day",
    version: 1,
    name: "Coursework Day",
    description: "Sparse on purpose — Start day merges your class blocks into the open window.",
    packs: ["coursework", "everything"],
    defaultForPack: ["coursework"],
    slots: [
      { title: "Revise today's cards", type: "reading", startTime: "08:00", endTime: "08:45" },
      { title: "Lunch", type: "meal", startTime: "12:30", endTime: "13:30" },
      { title: "Assignments & assessment prep", type: "deep_work", startTime: "17:00", endTime: "18:30" },
      { title: "Reading for research", type: "reading", startTime: "18:30", endTime: "19:15" },
      { title: "Log today's classes", type: "admin", startTime: "20:00", endTime: "20:20" }
    ]
  },
  {
    id: "literature-review-day",
    version: 1,
    name: "Literature Review Day",
    description: "Two 90-minute reading blocks, notes consolidation, and a paper-set comparison block.",
    packs: ["research", "everything"],
    slots: [
      { title: "Reading block 1", type: "reading", startTime: "08:30", endTime: "10:00" },
      { title: "Break", type: "break", startTime: "10:00", endTime: "10:15" },
      { title: "Reading block 2", type: "reading", startTime: "10:15", endTime: "11:45" },
      { title: "Notes consolidation", type: "admin", startTime: "11:45", endTime: "12:30" },
      { title: "Lunch", type: "meal", startTime: "12:30", endTime: "13:30" },
      { title: "What connects these papers? (paper set comparison)", type: "deep_work", startTime: "13:30", endTime: "14:30" },
      { title: "Break", type: "break", startTime: "14:30", endTime: "15:00" },
      { title: "Admin & email", type: "admin", startTime: "15:00", endTime: "16:00" }
    ]
  },
  {
    id: "lab-experiment-day",
    version: 1,
    name: "Lab / Experiment Day",
    description: "One long lab block, data logging, and afternoon analysis.",
    packs: ["research", "everything"],
    slots: [
      { title: "Lab / experiment block", type: "deep_work", startTime: "08:30", endTime: "11:30" },
      { title: "Break", type: "break", startTime: "11:30", endTime: "11:45" },
      { title: "Data logging", type: "admin", startTime: "11:45", endTime: "12:15" },
      { title: "Lunch", type: "meal", startTime: "12:15", endTime: "13:15" },
      { title: "Afternoon analysis", type: "deep_work", startTime: "13:15", endTime: "14:15" },
      { title: "Break", type: "break", startTime: "14:15", endTime: "14:30" },
      { title: "Write-up & admin", type: "admin", startTime: "14:30", endTime: "15:30" }
    ]
  },
  {
    id: "meeting-heavy-day",
    version: 1,
    name: "Meeting-Heavy Day",
    description: "Short 40-minute focus blocks between fixed meeting windows.",
    packs: ["coursework", "research", "writing", "everything"],
    slots: [
      { title: "Focus block", type: "deep_work", startTime: "09:00", endTime: "09:40" },
      { title: "Meeting", type: "admin", startTime: "09:40", endTime: "10:30" },
      { title: "Focus block", type: "deep_work", startTime: "10:30", endTime: "11:10" },
      { title: "Meeting", type: "admin", startTime: "11:10", endTime: "12:00" },
      { title: "Lunch", type: "meal", startTime: "12:00", endTime: "13:00" },
      { title: "Meeting", type: "admin", startTime: "13:00", endTime: "13:40" },
      { title: "Focus block", type: "deep_work", startTime: "13:40", endTime: "14:20" },
      { title: "Wrap-up / admin", type: "admin", startTime: "14:20", endTime: "15:00" }
    ]
  },
  {
    id: "light-day",
    version: 1,
    name: "Light Day",
    description: "A later start, two 1-hour focus blocks, longer breaks, done by 16:00.",
    packs: ["coursework", "research", "writing", "everything"],
    breakDefaultForPack: ["research"],
    slots: [
      { title: "Focus block", type: "deep_work", startTime: "10:00", endTime: "11:00" },
      { title: "Break", type: "break", startTime: "11:00", endTime: "11:30" },
      { title: "Focus block", type: "deep_work", startTime: "11:30", endTime: "12:30" },
      { title: "Lunch", type: "meal", startTime: "12:30", endTime: "13:30" },
      { title: "Admin / errands", type: "admin", startTime: "13:30", endTime: "14:00" },
      { title: "Break", type: "break", startTime: "14:00", endTime: "14:30" },
      { title: "Free time", type: "free", startTime: "14:30", endTime: "16:00" }
    ]
  },
  {
    id: "semester-break-day",
    version: 1,
    name: "Semester Break Day",
    description: "Late start, one reading block, one project block, free afternoon.",
    packs: ["coursework", "writing", "everything"],
    breakDefaultForPack: ["coursework", "writing"],
    slots: [
      { title: "Reading", type: "reading", startTime: "10:00", endTime: "11:30" },
      { title: "Break", type: "break", startTime: "11:30", endTime: "12:00" },
      { title: "Lunch", type: "meal", startTime: "12:00", endTime: "13:00" },
      { title: "Project block", type: "deep_work", startTime: "13:00", endTime: "14:00" },
      { title: "Free afternoon", type: "free", startTime: "14:00", endTime: "18:00" }
    ]
  },
  {
    id: "conference-travel-day",
    version: 1,
    name: "Conference / Travel Day",
    description: "One reading block, one notes-from-talks block, everything else free.",
    packs: ["coursework", "research", "writing", "everything"],
    slots: [
      { title: "Reading", type: "reading", startTime: "09:00", endTime: "09:30" },
      { title: "Lunch", type: "meal", startTime: "12:30", endTime: "13:30" },
      { title: "Notes from talks", type: "admin", startTime: "15:00", endTime: "15:30" }
    ]
  },
  {
    id: "half-day-sprint",
    version: 1,
    name: "Half-Day Sprint",
    description: "Four 25-minute focus sessions with breaks, done by noon.",
    packs: ["coursework", "research", "writing", "everything"],
    slots: [
      { title: "Focus session 1", type: "deep_work", startTime: "08:00", endTime: "08:25" },
      { title: "Break", type: "break", startTime: "08:25", endTime: "08:30" },
      { title: "Focus session 2", type: "deep_work", startTime: "08:30", endTime: "08:55" },
      { title: "Break", type: "break", startTime: "08:55", endTime: "09:00" },
      { title: "Focus session 3", type: "deep_work", startTime: "09:00", endTime: "09:25" },
      { title: "Break", type: "break", startTime: "09:25", endTime: "09:30" },
      { title: "Focus session 4", type: "deep_work", startTime: "09:30", endTime: "09:55" },
      { title: "Longer break", type: "break", startTime: "09:55", endTime: "10:10" },
      { title: "Open / free", type: "free", startTime: "10:10", endTime: "12:00" }
    ]
  }
];

export function findBuiltinDayTemplate(id: string) {
  return BUILTIN_DAY_TEMPLATES.find((template) => template.id === id);
}
