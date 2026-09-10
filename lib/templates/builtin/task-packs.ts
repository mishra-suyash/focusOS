import type { TaskPackPayload } from "@/lib/templates/schema";

/**
 * Built-in task checklist packs (plan §6.3) — applying one creates every task
 * in a single batch, with due dates offset from a chosen anchor date. FocusOS
 * has no recurring tasks, so packs like "TA week" create one-off tasks for
 * that instance only (plan §6.3 closing note).
 */
export const BUILTIN_TASK_PACKS: TaskPackPayload[] = [
  {
    id: "paper-submission",
    version: 1,
    name: "Paper submission",
    description: "The last two weeks before a paper deadline.",
    anchorLabel: "Submission deadline",
    tasks: [
      { title: "Finalize experiments / results", category: "research", priority: "high", dueOffsetDays: -10 },
      { title: "Draft complete: all sections written", category: "writing", priority: "high", dueOffsetDays: -6 },
      { title: "Related work / citations pass", category: "writing", priority: "medium", dueOffsetDays: -5 },
      { title: "Figures and tables finalized", category: "writing", priority: "medium", dueOffsetDays: -4 },
      { title: "Internal review from advisor / labmates", category: "admin", priority: "high", dueOffsetDays: -3 },
      { title: "Proofread full draft", category: "writing", priority: "medium", dueOffsetDays: -2 },
      { title: "Check submission formatting requirements", category: "admin", priority: "medium", dueOffsetDays: -1 },
      { title: "Submit paper", category: "admin", priority: "high", kind: "external", dueOffsetDays: 0 }
    ]
  },
  {
    id: "conference-deadline-countdown",
    version: 1,
    name: "Conference deadline countdown",
    description: "Registration, travel, and talk prep leading up to a conference.",
    anchorLabel: "Conference start date",
    tasks: [
      { title: "Register for conference", category: "admin", priority: "high", kind: "external", dueOffsetDays: -30 },
      { title: "Book travel and accommodation", category: "admin", priority: "high", kind: "external", dueOffsetDays: -21 },
      { title: "Apply for visa (if required)", category: "admin", priority: "high", kind: "external", dueOffsetDays: -45 },
      { title: "Draft talk / poster outline", category: "writing", priority: "medium", dueOffsetDays: -14 },
      { title: "Finish slides / poster", category: "writing", priority: "high", dueOffsetDays: -5 },
      { title: "Practice talk with lab group", category: "admin", priority: "medium", dueOffsetDays: -3 }
    ]
  },
  {
    id: "rebuttal-reviewer-response",
    version: 1,
    name: "Rebuttal / reviewer response",
    description: "The short, high-pressure window between reviews and a rebuttal deadline.",
    anchorLabel: "Rebuttal deadline",
    tasks: [
      { title: "Read all reviews carefully, note key concerns", category: "research", priority: "high", dueOffsetDays: -6 },
      { title: "Run any experiments reviewers requested", category: "research", priority: "high", dueOffsetDays: -4 },
      { title: "Draft point-by-point responses", category: "writing", priority: "high", dueOffsetDays: -3 },
      { title: "Advisor review of draft rebuttal", category: "admin", priority: "high", dueOffsetDays: -2 },
      { title: "Finalize and proofread rebuttal", category: "writing", priority: "medium", dueOffsetDays: -1 },
      { title: "Submit rebuttal", category: "admin", priority: "high", kind: "external", dueOffsetDays: 0 }
    ]
  },
  {
    id: "qualifying-exam-prep",
    version: 1,
    name: "Qualifying exam prep",
    description: "A structured run-up to a qualifying / comprehensive exam.",
    anchorLabel: "Exam date",
    tasks: [
      { title: "Define exam scope with advisor / committee", category: "admin", priority: "high", dueOffsetDays: -60 },
      { title: "Build reading list for exam topics", category: "research", priority: "high", dueOffsetDays: -50 },
      { title: "First pass through core readings", category: "reading", priority: "medium", dueOffsetDays: -30 },
      { title: "Practice questions / mock exam", category: "research", priority: "medium", dueOffsetDays: -14 },
      { title: "Review weak areas", category: "research", priority: "high", dueOffsetDays: -7 },
      { title: "Final review day", category: "research", priority: "high", dueOffsetDays: -1 }
    ]
  },
  {
    id: "thesis-chapter-kickoff",
    version: 1,
    name: "Thesis chapter kickoff",
    description: "Getting a new thesis chapter off the ground.",
    anchorLabel: "Target chapter draft date",
    tasks: [
      { title: "Outline chapter structure", category: "writing", priority: "high", dueOffsetDays: -45 },
      { title: "Identify gaps needing more research", category: "research", priority: "medium", dueOffsetDays: -40 },
      { title: "Write first section draft", category: "writing", priority: "medium", dueOffsetDays: -30 },
      { title: "Share outline + draft section with advisor", category: "admin", priority: "medium", dueOffsetDays: -28 },
      { title: "Complete full first draft", category: "writing", priority: "high", dueOffsetDays: 0 }
    ]
  },
  {
    id: "advisor-meeting-prep",
    version: 1,
    name: "Advisor meeting prep",
    description: "A short checklist for the day before a one-on-one.",
    anchorLabel: "Meeting date",
    tasks: [
      { title: "List what got done since the last meeting", category: "admin", priority: "medium", dueOffsetDays: -1 },
      { title: "List blockers / open questions to raise", category: "admin", priority: "medium", dueOffsetDays: -1 },
      { title: "Update shared notes / slides", category: "admin", priority: "low", dueOffsetDays: -1 },
      { title: "Propose next steps to discuss", category: "admin", priority: "low", dueOffsetDays: 0 }
    ]
  },
  {
    id: "literature-review-kickoff",
    version: 1,
    name: "Literature review kickoff",
    description: "Starting a new literature review or survey from scratch.",
    anchorLabel: "Target completion date",
    tasks: [
      { title: "Define review scope and research question", category: "research", priority: "high", dueOffsetDays: -30 },
      { title: "Identify seed papers", category: "reading", priority: "high", dueOffsetDays: -28 },
      { title: "Search and collect candidate papers", category: "reading", priority: "medium", dueOffsetDays: -21 },
      { title: "Skim all candidates, triage relevance", category: "reading", priority: "medium", dueOffsetDays: -14 },
      { title: "Deep-read the most relevant papers", category: "reading", priority: "medium", dueOffsetDays: -7 },
      { title: "Write synthesis / summary", category: "writing", priority: "high", dueOffsetDays: 0 }
    ]
  },
  {
    id: "ta-week",
    version: 1,
    name: "TA week",
    description: "One week of teaching-assistant duties — a one-off checklist, not recurring.",
    anchorLabel: "Week start date",
    tasks: [
      { title: "Prepare / review lecture or lab materials", category: "admin", priority: "medium", dueOffsetDays: 0 },
      { title: "Hold office hours", category: "admin", priority: "medium", dueOffsetDays: 2 },
      { title: "Grade assignments / quizzes", category: "admin", priority: "high", dueOffsetDays: 4 },
      { title: "Post grades and feedback", category: "admin", priority: "medium", dueOffsetDays: 5 }
    ]
  },
  {
    id: "fellowship-grant-application",
    version: 1,
    name: "Fellowship / grant application",
    description: "A multi-week application with essays, forms, and letters.",
    anchorLabel: "Application deadline",
    tasks: [
      { title: "Confirm eligibility and requirements", category: "admin", priority: "high", kind: "external", dueOffsetDays: -45 },
      { title: "Request letters of recommendation", category: "admin", priority: "high", kind: "external", dueOffsetDays: -35 },
      { title: "Draft research statement / essay", category: "writing", priority: "high", dueOffsetDays: -21 },
      { title: "Get feedback on draft from advisor", category: "admin", priority: "medium", dueOffsetDays: -14 },
      { title: "Finalize essay and forms", category: "writing", priority: "medium", dueOffsetDays: -5 },
      { title: "Submit application", category: "admin", priority: "high", kind: "external", dueOffsetDays: 0 }
    ]
  },
  {
    id: "visa-admin-paperwork",
    version: 1,
    name: "Visa & admin paperwork",
    description: "Hard deadlines — forms, visas, and fees that don't count toward your workload plan.",
    anchorLabel: "Deadline / expiry date",
    tasks: [
      { title: "Gather required documents", category: "admin", priority: "high", kind: "external", dueOffsetDays: -21 },
      { title: "Complete and submit forms", category: "admin", priority: "high", kind: "external", dueOffsetDays: -14 },
      { title: "Pay any required fees", category: "admin", priority: "high", kind: "external", dueOffsetDays: -14 },
      { title: "Attend appointment / interview (if required)", category: "admin", priority: "high", kind: "external", dueOffsetDays: -7 },
      { title: "Confirm approval / collect documents", category: "admin", priority: "medium", kind: "external", dueOffsetDays: 0 }
    ]
  }
];

export function findBuiltinTaskPack(id: string) {
  return BUILTIN_TASK_PACKS.find((pack) => pack.id === id);
}
