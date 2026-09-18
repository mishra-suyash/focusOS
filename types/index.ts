export type TaskStatus = "todo" | "in_progress" | "done";
export type Priority = "low" | "medium" | "high";
export type Category = "research" | "coding" | "reading" | "writing" | "admin" | "personal";
export type TimerMode = "work" | "short_break" | "long_break";
export type ScheduleSlotType = "deep_work" | "reading" | "meal" | "free" | "admin" | "break" | "commute" | "sleep" | "gym" | "class" | "custom";
export type ScheduleSlotStatus = "upcoming" | "active" | "completed" | "skipped";
export type CourseStatus = "active" | "completed" | "dropped";
export type TermKind = "semester" | "break" | "none";
export type ClassAttendance = "attended" | "missed" | "cancelled" | "self_study";
export type TopicStatus = "active" | "retired";
export type CheckpointType = "quiz" | "lab" | "assignment" | "midsem" | "endsem" | "presentation" | "other";
export type CheckpointStatus = "upcoming" | "prepping" | "submitted" | "done" | "missed";
export type PaperStatus = "to_read" | "reading" | "read" | "archived";
export type AiProvider = "claude" | "gemini" | "ollama" | "fallback";
export type AiInsightSource = "manual" | "cron";
export type AiTaskId =
  | "course.splitTopics"
  | "plan.tomorrow"
  | "plan.generateDayTemplate"
  | "triage.actions"
  | "review.eod"
  | "paper.readingPlan"
  | "checkpoint.prepPlan"
  | "paper.passAssist"
  | "paper.layeredNotes"
  | "paper.highlightCandidates"
  | "group.synthesis"
  | "insight.daily";
export type AiTaskTier = "small" | "large";
export type AiJobStatus = "queued" | "running" | "partial" | "done" | "failed";
export type AlertSeverity = "critical" | "important" | "general";
export type AlertType =
  | "checkpoint.prep_overdue"
  | "checkpoint.prep_not_started"
  | "revision.backlog"
  | "load_index.low_streak"
  | "load_index.off_track"
  | "class.unlogged"
  | "paper.stale"
  | "goal.milestone_overdue"
  | "task.external_due";
export type RevisionKind = "topic" | "paper" | "paperGroup" | "checkpoint";
export type RevisionGrade = "again" | "hard" | "good" | "easy";
export type LoadIndexBand = "behind" | "light" | "on_track" | "ahead" | "overrun";
export type GoalKind = "survey" | "method" | "baseline" | "related-work" | "reproduce" | "critique";
export type PassStatus = "not_started" | "in_progress" | "done" | "skipped";
export type Pass1Verdict = "continue" | "park" | "drop";
export type Pass1VerdictReason = "not-interested" | "insufficient-background" | "invalid-assumptions" | "outside-area-but-relevant-later" | "proceeding";
export type Pass2Outcome = "grasped" | "set-aside" | "return-later" | "persevere";
export type PaperNoteKind = "quote" | "idea" | "question" | "critique" | "todo";
export type PaperGroupKind = "cluster" | "survey";

export type UserRole = "owner" | "admin" | "member" | "disabled";
export type UserStatus = "active" | "invited" | "disabled";

export interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  photoURL?: string;
  /** Which tiers/{tierId} doc governs this user's limits and allowed AI models. Unset = the tier marked isDefault, or hardcoded fallbacks if no tiers exist at all. */
  tierId?: string;
  /** Mirror of the Firebase custom claim — display/query data only, never the authorization source. Unset on pre-Phase-4.5 accounts, treated as "member". */
  role?: UserRole;
  status?: UserStatus;
  aiEnabled?: boolean;
  /** Per-user override on top of the assigned tier's limits.aiMonthlyBudgetUsd/blobQuotaMb — re-copied whenever the tier assignment changes. */
  monthlyBudgetUsd?: number;
  blobQuotaMb?: number;
  lastSeenAt?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TierLimits {
  maxRevisionsPerDay: number;
  maxRevisionMinutesPerDay: number;
  aiMonthlyBudgetUsd: number;
  blobQuotaMb: number;
}

/**
 * users/{uid}/... limits and AI-model access, admin-managed and dynamic — an
 * admin can create and delete tiers freely (this is not a hardcoded enum).
 * Lives at the top-level `tiers/{tierId}`, not nested under a user, since one
 * tier is shared by every user assigned to it. Writable only via the Admin
 * SDK (scripts today; the admin panel's API routes in Phase 4.5) — client
 * code only ever reads tiers, never writes them.
 */
export interface Tier {
  id: string;
  name: string;
  description?: string;
  /** Assigned to a user with no explicit tierId. Exactly one tier should hold this at a time. */
  isDefault: boolean;
  limits: TierLimits;
  /** Subset of AI providers this tier's users may call. An empty array means "no AI access on this tier." */
  allowedModels: AiProvider[];
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

export type NewTier = Omit<Tier, "id" | "createdAt" | "updatedAt">;

/** users/{uid}/aiRuns/{runId} — an audit entry for every AI call the provider chain attempts, success or failure. */
export interface AiRun {
  id: string;
  task: AiTaskId;
  provider: AiProvider;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
  at: string;
}

/** users/{uid}/aiJobs/{jobId} — a long-running (or simply job-tracked) AI task, polled/subscribed by the client. */
export interface AiJob {
  id: string;
  task: AiTaskId;
  refId?: string;
  status: AiJobStatus;
  steps: { name: string; status: AiJobStatus; output?: unknown }[];
  provider?: AiProvider;
  output?: unknown;
  error?: string;
  startedAt: string;
  updatedAt: string;
}

/** users/{uid}/alerts/{dedupeKey} — deduped, severity-tagged signals from lib/ai/triage.ts. */
export interface Alert {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  detail: string;
  refId?: string;
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: Priority;
  category: Category;
  dueDate?: string;
  estimatedPomodoros?: number;
  completedAt?: string;
  /** "external" (G6): a hard-deadline, non-study task (visa renewal, a form, a submission portal) — excluded from the Load Index's `required` term but still counts toward `actual` on completion. Unset/"internal" is every other task, unchanged. There's no separate `oneOff` flag: this app has no recurring-task concept at all, so every task is already one-off. */
  kind?: "internal" | "external";
  /** Only meaningful with kind "external" and a dueDate — days-before-due to surface a reminder (e.g. [7, 2, 0]). */
  reminderLeadDays?: number[];
  /** Plan §11.2 F5 — the status a task had right before it was last marked "done", so unchecking can restore it instead of always landing on "todo". */
  previousStatus?: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PomodoroSession {
  id: string;
  label: string;
  category: Category;
  mode: TimerMode;
  minutes: number;
  completedAt: string;
  cycle: number;
  taskId?: string;
  slotId?: string;
  productivityRating?: number;
  comment?: string;
  /** Set when this session was a paper-reading pass timer (category "reading"). */
  paperId?: string;
  passNo?: 1 | 2 | 3;
}

export interface ScheduleSlot {
  id: string;
  title: string;
  type: ScheduleSlotType;
  startTime: string;
  endTime: string;
  assignedTaskIds?: string[];
  note?: string;
  status: ScheduleSlotStatus;
  color?: string;
  /** Set on a class block or a materialized routine block (see `RoutineBlock`) — undraggable, unresizable, and undeletable in the timeline editor. Never set by hand; `type === "class"` alone already implies this for class blocks (`isLockedSlot`, lib/schedule.ts), so this field only actually needs to be `true` for routine-derived slots. */
  locked?: boolean;
}

/**
 * plan/FocusOS-v2-Routine-Blocks-and-AI-Templates.md §2 — a recurring personal-time anchor
 * (Sleep, a meal, Gym, or a custom one) configured once in Settings rather than re-typed into
 * every template. `lib/routine.ts`'s `routineSlotsForDate` turns the enabled ones into locked
 * `ScheduleSlot`s for a given date.
 */
export interface RoutineBlock {
  id: string;
  label: string;
  type: ScheduleSlotType;
  startTime: string;
  /** May be <= `startTime`, meaning this block crosses midnight (e.g. Sleep 23:00→07:00) — see `routineSlotsForDate`'s own doc comment for how that materializes. */
  endTime: string;
  enabled: boolean;
  /** 0 (Sun) – 6 (Sat); absent = every day. */
  daysOfWeek?: number[];
}

export interface DayTemplate {
  id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  slots: ScheduleSlot[];
  /** 'builtin:<id>' | 'org:<id>' — set when this template was materialized from a catalog entry (U1: builtin only). Absent = a template the user built from scratch. */
  sourceTemplateId?: string;
  /** The catalog entry's version at copy time, so a later catalog change can offer "Update available" without touching this copy. */
  sourceVersion?: number;
  createdAt: string;
  updatedAt: string;
}

export interface DailySchedule {
  id: string;
  dateKey: string;
  templateId?: string;
  slots: ScheduleSlot[];
  createdAt: string;
  updatedAt: string;
}

export interface WeeklyReview {
  id: string;
  weekStart: string;
  wins: string;
  missedGoals: string;
  blockers: string;
  nextWeekPriorities: string;
  averageFocusRating: number;
  updatedAt: string;
}

export interface CourseSession {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  location?: string;
}

export interface Term {
  id: string;
  name: string;
  kind: TermKind;
  startDate: string;
  endDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface Course {
  id: string;
  termId?: string;
  name: string;
  code?: string;
  instructor?: string;
  color?: string;
  /** @deprecated free-text term label from Phase 0, kept for old records; use termId. */
  term?: string;
  status: CourseStatus;
  /** Bounds the course is actually meeting; defaults to the term's dates when unset. */
  startDate?: string;
  endDate?: string;
  targetMinutesPerWeek?: number;
  sessions: CourseSession[];
  createdAt: string;
  updatedAt: string;
}

/** One class session's log, doc id = yyyy-MM-dd, nested under courses/{courseId}/classLogs. */
export interface ClassLog {
  id: string;
  courseId: string;
  date: string;
  attendance: ClassAttendance;
  topicIds: string[];
  rawTopics?: string;
  understanding?: number;
  notes?: string;
  durationMin?: number;
  updatedAt: string;
}

/** Flat, cross-course — the unit future revision reviews (Phase 2). */
export interface Topic {
  id: string;
  courseId: string;
  title: string;
  firstSeenDate: string;
  classLogIds: string[];
  confidence: number;
  status: TopicStatus;
  revisionItemId?: string;
  createdAt: string;
  updatedAt: string;
}

/** A quiz/lab/assignment/exam, nested under courses/{courseId}/checkpoints. */
export interface Checkpoint {
  id: string;
  courseId: string;
  type: CheckpointType;
  title: string;
  dueAt: string;
  weightPct?: number;
  requiresPrep: boolean;
  prepLeadDays: number;
  prepEstimateMin: number;
  topicIds: string[];
  status: CheckpointStatus;
  result?: { score: number; max: number; notes?: string };
  /** AI-generated (checkpoint.prepPlan task) or its deterministic fallback — scope topics sorted by lowest confidence. */
  prepPlan?: string[];
  createdAt: string;
  updatedAt: string;
}

/** Flat — the unit of spaced-repetition review (Phase 2 revision engine). */
export interface RevisionItem {
  id: string;
  kind: RevisionKind;
  refId: string;
  courseId?: string;
  title: string;
  ladderIndex: number;
  dueDate: string;
  lastReviewedAt?: string;
  reps: number;
  lapses: number;
  suspended: boolean;
  retiredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoadIndexSnapshot {
  requiredMinutes: number;
  actualMinutes: number;
  value: number;
  band: LoadIndexBand;
  computedAt: string;
}

export interface Pass1Output {
  steps: { titleAbstractIntro: boolean; headings: boolean; conclusions: boolean; references: boolean };
  category?: string;
  context?: string;
  correctness?: string;
  contributions: string[];
  clarityRating?: number;
  clarityNote?: string;
  /** Feeds the paper-group survey workflow's computable shared-citations check. */
  referencesAlreadyRead: string[];
  verdict: Pass1Verdict;
  verdictReason: Pass1VerdictReason;
}

export interface Pass2Figure {
  ref: string;
  axesLabelled?: boolean;
  errorBars?: boolean;
  significanceOk?: boolean;
  note?: string;
}

export interface Pass2Output {
  keyPoints: string[];
  figures: Pass2Figure[];
  /** Feeds the paper-group survey workflow's computable shared-citations check. */
  unreadReferencesMarked: string[];
  /** The exit test — must be fillable by a reader who never opened the PDF. */
  summary: string;
  unclear: string[];
  outcome: Pass2Outcome;
  returnAfter?: { backgroundToRead: string[]; revisitOn: string };
}

export interface StructureRecall {
  recalled: string;
  actual: string[];
  selfGrade: number;
  at: string;
}

export interface Pass3Output {
  assumptionsChallenged: { statement: string; challenge: string }[];
  reImplementation?: string;
  wouldPresentDifferently?: string;
  strongPoints: string[];
  weakPoints: string[];
  implicitAssumptions: string[];
  missingCitations: string[];
  techniqueIssues: string[];
  futureWorkIdeas: string[];
  /** The completion gate: reconstruct the paper's structure from memory before this pass counts as done. */
  structureRecall?: StructureRecall;
}

export interface PassState {
  status: PassStatus;
  startedAt?: string;
  completedAt?: string;
  minutes?: number;
  output?: Pass1Output | Pass2Output | Pass3Output;
}

export interface Paper {
  id: string;
  title: string;
  authors: string[];
  venue?: string;
  year?: number;
  link?: string;
  doi?: string;
  /** Optional attached PDF, uploaded via the files subsystem. Link-only papers have no fileId. */
  fileId?: string;
  /** Derived from pass completion — see lib/papers.ts. Kept on the doc for fast list rendering. */
  status: PaperStatus;
  priority: Priority;
  tags: string[];
  /** Required before pass1 may be started — see lib/papers.ts's startFirstPass gate. */
  goal?: string;
  goalKind?: GoalKind;
  /** AI-generated (paper.readingPlan task) or its deterministic fallback — a generic pass-by-pass checklist. */
  readingPlan?: string[];
  /** Cached Anthropic Files API id for this paper's PDF (Phase 5) — uploaded once, reused by every paper.layeredNotes/paper.highlightCandidates call so the bytes are never re-sent. Cleared if the attached fileId ever changes. */
  anthropicFileId?: string;
  /** AI-generated (paper.layeredNotes task, no fallback) — regenerating overwrites this field; aiRuns keeps the audit trail of prior generations. */
  layeredNotes?: LayeredNotes;
  pass1?: PassState;
  pass2?: PassState;
  pass3?: PassState;
  /** Derived 0/33/66/100 from pass completion — never set directly by a slider. */
  progress: number;
  groupIds: string[];
  revisionItemId?: string;
  relatedCourseId?: string;
  relatedTaskId?: string;
  citationKey?: string;
  readAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type NotesLayer = "L1" | "L2" | "L3";
export type HighlightCategory = "claim" | "method" | "result" | "limitation" | "definition" | "weakness";

/**
 * The `paper.layeredNotes` task's output (plan §8.6), stored directly on
 * `Paper.layeredNotes` — designed to be re-fed to a model later as compact
 * context (`promptPack`) instead of re-uploading the PDF. `relatedInLibrary`
 * from the original spec was deliberately cut: no similarity/embedding search
 * exists in this codebase, and a naive title-guessing version would just be
 * unreliable noise.
 */
export interface LayeredNotes {
  version: number;
  generatedAt: string;
  provider: AiProvider;
  model?: string;
  L0: string;
  L1: { problem: string; contribution: string; result: string; whyItMattersToMe: string };
  L2: { method: string[]; datasets: string[]; metrics: string[]; baselines: string[]; ablations: string[]; assumptions: string[] };
  L3: { formulation: string; hyperparameters: string; failureModes: string[]; reproductionChecklist: string[] };
  citationsToRead: string[];
  openQuestions: string[];
  claimsToVerify: string[];
  sourceRefs: { quote: string; page: number; layer: NotesLayer }[];
  /** <=1200 tokens — what a future AI call about this paper should inject instead of the PDF. */
  promptPack: string;
}

/** The `paper.highlightCandidates` task's raw output, before matching against the rendered PDF text. */
export interface HighlightCandidate {
  quote: string;
  category: HighlightCategory;
  note: string;
  layer: NotesLayer;
}

/** A quad in unscaled PDF page-space (points, origin bottom-left) — resolution-independent, used both for on-screen overlay (via pdf.js's viewport transform) and pdf-lib export (which operates in the same space). */
export interface HighlightQuad {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * users/{uid}/papers/{paperId}/annotations/{annotationId} — the source of
 * truth for the PDF highlight overlay (plan §8.7 step 5): non-destructive,
 * editable, and independent of any specific render. An AI-sourced highlight
 * that failed to match the rendered text (`matched: false`) has no `page`/
 * `quads` and surfaces as a plain note in the sidebar instead of disappearing.
 */
export interface Annotation {
  id: string;
  page?: number;
  quads?: HighlightQuad[];
  quote: string;
  category: HighlightCategory;
  note?: string;
  layer?: NotesLayer;
  source: "ai" | "manual";
  matched: boolean;
  createdAt: string;
}

export type NewAnnotation = Omit<Annotation, "id" | "createdAt">;

/** papers/{paperId}/notes/{noteId}. */
export interface PaperNote {
  id: string;
  paperId: string;
  passNo?: 1 | 2 | 3;
  kind: PaperNoteKind;
  body: string;
  anchorPage?: number;
  anchorQuote?: string;
  createdAt: string;
}

export interface SurveyState {
  stage: number;
  seedPapers: string[];
  surveyFound?: string;
  topVenues: string[];
  proceedingsScanned: { venue: string; year: number; at: string }[];
  iterationsDone: number;
}

export interface PaperGroup {
  id: string;
  name: string;
  purpose?: string;
  kind: PaperGroupKind;
  paperIds: string[];
  revisionItemId?: string;
  survey?: SurveyState;
  lastSynthesis?: { text: string; at: string };
  createdAt: string;
  updatedAt: string;
}

/** users/{uid}/files/{fileId} — Vercel Blob metadata; the bytes never touch Firestore. */
export interface FileRef {
  id: string;
  url: string;
  pathname: string;
  bytes: number;
  contentType: string;
  linkedTo: { type: "paper"; id: string };
  uploadedAt: string;
}

/** A single day's workday-session (clock in/out + hydration/break counters). Embedded on `Day`. */
export interface DaySession {
  startedAt: string;
  endedAt?: string;
  hydrationCount: number;
  breaksTaken: number;
  lastHydrationAt?: string;
  lastBreakPromptAt?: string;
}

/** The daily review, embedded on `Day`. */
export interface DayReview {
  done?: string;
  blocked?: string;
  carryForward?: string;
  focusRating?: number;
  energyRating?: number;
  submittedAt?: string;
}

/** Deterministic, no AI involved (plan §10.1) — a computed readout, always available. Written for `date` at the start of that day, by the morning cron or on-demand. */
export interface MorningBrief {
  generatedAt: string;
  revisionsDue: number;
  checkpointsInWindow: { id: string; title: string; dueAt: string }[];
  papersScheduled: { id: string; title: string }[];
  goalMilestonesThisWeek: { goalId: string; goalTitle: string; milestoneId: string; title: string; dueAt?: string }[];
  externalTasksInWindow: { id: string; title: string; dueDate: string }[];
  unresolvedCriticalAlerts: number;
  requiredMinutesTarget: number;
}

export interface ProposedTask {
  title: string;
  category: Category;
  estimatePomodoros: number;
  severity: AlertSeverity;
}

export interface ProposedSlot {
  title: string;
  type: ScheduleSlotType;
  startTime: string;
  endTime: string;
  refType?: "checkpoint" | "revision";
  refId?: string;
}

export type ProposalDecision = "accepted" | "dismissed";

/**
 * Written for `date` at end of day, comparing that day's plan vs. actual (plan
 * §10.1). `summary`/`improvements` come from the `review.eod` AI task (with
 * its existing numeric fallback); `proposedTasks`/`proposedSlots` are always
 * built deterministically (the same due-date-sorted logic `plan.tomorrow`'s
 * fallback already uses) so what's actually accept-able never depends on an
 * AI call succeeding — "no feature is AI-only" extends to the daily loop too.
 * Nothing here is ever auto-applied; `taskDecisions`/`slotDecisions` track
 * what you've already accepted/dismissed by array index, keyed as strings,
 * so re-opening the page doesn't re-offer a proposal you already acted on.
 */
export interface EveningRollup {
  generatedAt: string;
  provider: AiProvider;
  degraded?: boolean;
  summary: string;
  improvements: { text: string; severity: AlertSeverity }[];
  proposedTasks: ProposedTask[];
  proposedSlots: ProposedSlot[];
  unloggedClasses: string[];
  taskDecisions?: Record<string, ProposalDecision>;
  slotDecisions?: Record<string, ProposalDecision>;
}

/**
 * The merged per-day document (doc id = yyyy-MM-dd). Replaces the old separate
 * dailyPlans / dailyNotes / dailyReviews / workdaySessions collections so one
 * day view costs one Firestore read instead of four.
 */
export interface Day {
  id: string;
  date: string;
  session?: DaySession;
  pinnedTaskIds: string[];
  scratchpad?: string;
  review?: DayReview;
  loadIndex?: LoadIndexSnapshot;
  brief?: MorningBrief;
  rollup?: EveningRollup;
  updatedAt: string;
}

export type GoalHorizon = "week" | "term" | "break" | "year" | "phd";
export type GoalStatus = "active" | "paused" | "achieved" | "dropped";
export type ReviewCadence = "weekly" | "monthly";

export interface GoalMilestone {
  id: string;
  title: string;
  dueAt?: string;
  done: boolean;
}

/**
 * The long-horizon layer that survives term boundaries (plan §11.1). A goal
 * with `horizon: "break"` and a `termId` pointing at a break term only
 * contributes to the Load Index during that term — see `lib/goals.ts`.
 */
export interface Goal {
  id: string;
  title: string;
  horizon: GoalHorizon;
  termId?: string;
  why?: string;
  definitionOfDone: string;
  milestones: GoalMilestone[];
  linked: { courseIds: string[]; paperIds: string[]; taskIds: string[]; goalIds: string[] };
  targetHoursPerWeek?: number;
  status: GoalStatus;
  reviewCadence: ReviewCadence;
  lastReviewedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type NewGoal = Omit<Goal, "id" | "createdAt" | "updatedAt">;

export interface AiInsight {
  id: string;
  date: string;
  provider: AiProvider;
  summary: string;
  suggestions: string[];
  generatedAt: string;
  source: AiInsightSource;
  /** True when every real provider failed/was unavailable and this is the rule-based fallback. */
  degraded?: boolean;
}

export type PackId = "coursework" | "research" | "writing" | "everything" | "core";
export type OnboardingStatus = "pending" | "in_progress" | "done" | "skipped";
export type TimerPresetId = "classic" | "extended" | "short" | "custom";

/** Per-user preferences synced across devices (theme, reminder intervals). Doc id = "settings". */
export interface UserSettings {
  theme?: "light" | "dark";
  hydrationMinutes: number;
  breakMinutes: number;
  /** Template applied by "Start day" when no term is active or the active term is a break. */
  breakTemplateId?: string;
  maxRevisionsPerDay?: number;
  maxRevisionMinutesPerDay?: number;
  /** Focus timer lengths, minutes. Unset = the classic 25/5/15 defaults. */
  workMinutes?: number;
  shortBreakMinutes?: number;
  longBreakMinutes?: number;
  timerPresetId?: TimerPresetId;
  /** Which starter pack this account is on (plan §8.1). Absent = derived as "everything" for pre-onboarding accounts by the migration script. */
  packId?: PackId;
  /** Present = a custom module selection overriding the pack's defaults; absent = derived from packId. */
  enabledModules?: string[];
  onboarding?: {
    status: OnboardingStatus;
    step?: number;
    completedAt?: string;
    checklistDismissed?: boolean;
  };
  /** 'HH:mm' — used to shift built-in/day templates via shiftTemplateSlots. */
  dayStartTime?: string;
  dashboardWidgets?: string[];
  /** Rows shown in the floating focus widget (Document Picture-in-Picture) — see `lib/floating-widget.ts`. Same "absent = defaults, explicit list always wins" convention as `dashboardWidgets`. */
  floatingWidgetItems?: string[];
  /** Nudge keys (plan §11.1) that have been shown and dismissed — never shown again. */
  dismissedHints?: string[];
  /** The contextual nudge currently "locked in" for `shownDate` (plan §11.1: "one new per day") —
   * dismissing it adds its key to `dismissedHints` but leaves this in place so a different nudge
   * can't appear until the next day, even if more than one currently qualifies. */
  activeNudge?: { key: string; shownDate: string };
  /** One-time "We renamed a few things" notice (plan §10.2) has been shown and dismissed. */
  vocabularyRenameSeen?: boolean;
  /** Absent = `DEFAULT_ROUTINE_BLOCKS` (lib/routine.ts) — nothing is written here until the user actually edits something on `/settings/routine`, matching every other settings default in this interface. */
  routineBlocks?: RoutineBlock[];
  updatedAt: string;
}

export type NewTask = Omit<Task, "id" | "createdAt" | "updatedAt" | "completedAt"> & {
  completedAt?: string;
};

export type NewDayTemplate = Omit<DayTemplate, "id" | "createdAt" | "updatedAt">;
export type NewTerm = Omit<Term, "id" | "createdAt" | "updatedAt">;
export type NewCourse = Omit<Course, "id" | "createdAt" | "updatedAt">;
export type NewPaper = Omit<Paper, "id" | "createdAt" | "updatedAt" | "progress" | "groupIds"> & {
  progress?: number;
  groupIds?: string[];
};
export type NewClassLog = Omit<ClassLog, "id" | "updatedAt">;
export type NewTopic = Omit<Topic, "id" | "createdAt" | "updatedAt">;
export type NewCheckpoint = Omit<Checkpoint, "id" | "createdAt" | "updatedAt">;
export type NewRevisionItem = Omit<RevisionItem, "id" | "createdAt" | "updatedAt">;
export type NewPaperNote = Omit<PaperNote, "id" | "createdAt">;
export type NewPaperGroup = Omit<PaperGroup, "id" | "createdAt" | "updatedAt">;
export type NewFileRef = Omit<FileRef, "id">;

/** admin/settings — server-only (Admin SDK), never client-readable. Runtime switches + access policy. */
export interface AdminSettings {
  signupMode: "closed" | "invite" | "open";
  allowedEmailDomains: string[];
  maxActiveUsers: number;
  defaultUserBudgetUsd: number;
  defaultUserBlobMb: number;
  aiGloballyEnabled: boolean;
  cronEnabled: boolean;
  maintenanceMode: boolean;
  chainOrder: ("local" | "claude" | "gemini")[];
  signInMethods: {
    google: boolean;
    emailPassword: boolean;
    emailLink: boolean;
    anonymous: boolean;
  };
  ownerBootstrapped?: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

export type AuditAction =
  | "settings.update"
  | "ai.killswitch"
  | "cron.toggle"
  | "maintenance.toggle"
  | "chain.reorder"
  | "user.role.change"
  | "user.disable"
  | "user.enable"
  | "user.delete"
  | "user.budget.change"
  | "user.invite"
  | "user.export"
  | "ollama.config.change"
  | "ollama.address.heartbeat"
  | "ollama.toggle"
  | "signin.method.toggle"
  | "tier.create"
  | "tier.update"
  | "tier.delete"
  | "tier.set-default"
  | "user.tier.change"
  | "owner.bootstrap"
  | "template.create"
  | "template.update"
  | "template.publish"
  | "template.archive"
  | "template.import"
  | "template.pack-default.set"
  | "template.builtin.hide";

/** admin/auditLog/{entryId} — append-only, Admin SDK only. */
export interface AuditEntry {
  id: string;
  at: string;
  actorUid: string;
  actorEmail: string;
  action: AuditAction;
  targetType: "user" | "settings" | "ollama" | "tier" | "template";
  targetId: string;
  before?: unknown;
  after?: unknown;
}

export type AdminJobKind = "user.delete";
export type AdminJobStatus = "queued" | "running" | "done" | "failed";

/** adminJobs/{jobId} — resumable admin-triggered background work (currently just user deletion). */
export interface AdminJob {
  id: string;
  kind: AdminJobKind;
  targetUid: string;
  exportFirst: boolean;
  status: AdminJobStatus;
  exportUrl?: string;
  deletedCollections: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}
