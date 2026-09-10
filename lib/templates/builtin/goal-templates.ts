import type { GoalPayload } from "@/lib/templates/schema";

/** Built-in goal templates (plan §6.3) — prefill `definitionOfDone`, `horizon`, and milestones (relative due dates) on a new Goal. */
export const BUILTIN_GOAL_TEMPLATES: GoalPayload[] = [
  {
    id: "pass-qualifying-exam",
    version: 1,
    name: "Pass the qualifying exam",
    title: "Pass the qualifying exam",
    horizon: "term",
    why: "Required to advance to candidacy.",
    definitionOfDone: "Sat the exam and received a passing result from the committee.",
    milestones: [
      { title: "Exam scope agreed with committee", dueOffsetDays: -60 },
      { title: "First pass through reading list complete", dueOffsetDays: -30 },
      { title: "Mock exam / practice questions done", dueOffsetDays: -14 },
      { title: "Sit the exam", dueOffsetDays: 0 }
    ],
    targetHoursPerWeek: 10
  },
  {
    id: "submit-paper-to-venue",
    version: 1,
    name: "Submit a paper to a venue",
    title: "Submit a paper",
    horizon: "term",
    why: "Get this work in front of the community and on the record.",
    definitionOfDone: "Paper submitted before the venue's deadline.",
    milestones: [
      { title: "Experiments / results finalized", dueOffsetDays: -21 },
      { title: "Full draft written", dueOffsetDays: -10 },
      { title: "Internal review complete", dueOffsetDays: -5 },
      { title: "Submitted", dueOffsetDays: 0 }
    ],
    targetHoursPerWeek: 12
  },
  {
    id: "complete-literature-survey",
    version: 1,
    name: "Complete a literature survey",
    title: "Complete a literature survey",
    horizon: "term",
    why: "Build a solid map of the area before committing to a direction.",
    definitionOfDone: "A written survey covering the field's major approaches, with a clear synthesis.",
    milestones: [
      { title: "Scope and seed papers identified", dueOffsetDays: -28 },
      { title: "All candidate papers skimmed", dueOffsetDays: -14 },
      { title: "Most relevant papers deep-read", dueOffsetDays: -7 },
      { title: "Synthesis written", dueOffsetDays: 0 }
    ],
    targetHoursPerWeek: 8
  },
  {
    id: "finish-thesis-chapter",
    version: 1,
    name: "Finish a thesis chapter",
    title: "Finish a thesis chapter",
    horizon: "term",
    why: "One more chapter toward a complete thesis.",
    definitionOfDone: "Chapter drafted, reviewed by advisor, and revised to a near-final state.",
    milestones: [
      { title: "Outline agreed with advisor", dueOffsetDays: -45 },
      { title: "First full draft", dueOffsetDays: -21 },
      { title: "Advisor feedback incorporated", dueOffsetDays: -7 },
      { title: "Chapter finalized", dueOffsetDays: 0 }
    ],
    targetHoursPerWeek: 12
  },
  {
    id: "defend-the-proposal",
    version: 1,
    name: "Defend the proposal",
    title: "Defend the proposal",
    horizon: "year",
    why: "Committee sign-off to proceed with the planned research.",
    definitionOfDone: "Proposal defended and approved by the committee.",
    milestones: [
      { title: "Proposal draft complete", dueOffsetDays: -60 },
      { title: "Committee feedback incorporated", dueOffsetDays: -30 },
      { title: "Defense scheduled", dueOffsetDays: -14 },
      { title: "Defended", dueOffsetDays: 0 }
    ],
    targetHoursPerWeek: 10
  },
  {
    id: "build-daily-writing-habit",
    version: 1,
    name: "Build a daily writing habit",
    title: "Write every workday",
    horizon: "term",
    why: "Steady output beats sporadic marathons.",
    definitionOfDone: "Wrote on at least 4 of 5 workdays for the full term.",
    milestones: [
      { title: "First two weeks of consistent writing", dueOffsetDays: 14 },
      { title: "One month check-in", dueOffsetDays: 30 }
    ],
    targetHoursPerWeek: 5
  }
];

export function findBuiltinGoalTemplate(id: string) {
  return BUILTIN_GOAL_TEMPLATES.find((template) => template.id === id);
}
