import type { z } from "zod";
import {
  groupSynthesisSchema,
  highlightCandidatesSchema,
  insightDailySchema,
  layeredNotesSchema,
  passAssistSchema,
  planTomorrowSchema,
  prepPlanSchema,
  readingPlanSchema,
  reviewEodSchema,
  splitTopicsSchema,
  triageActionsSchema,
  type GroupSynthesisOutput,
  type HighlightCandidatesOutput,
  type InsightDailyOutput,
  type LayeredNotesOutput,
  type PassAssistOutput,
  type PlanTomorrowOutput,
  type PrepPlanOutput,
  type ReadingPlanOutput,
  type ReviewEodOutput,
  type SplitTopicsOutput,
  type TriageActionsOutput
} from "@/lib/ai/schemas";
import { splitTopics as ruleSplitTopics } from "@/lib/classlog";
import type { AiTaskId, AiTaskTier } from "@/types";

export interface AiTaskDef<Payload, Output> {
  id: AiTaskId;
  tier: AiTaskTier;
  preferLocal: boolean;
  maxTokens: number;
  schema: z.ZodType<Output>;
  buildPrompt: (payload: Payload) => { system?: string; prompt: string; fileId?: string };
  /** No fallback means the button is hidden client-side when no provider is available — never rendered as a stub. */
  fallback?: (payload: Payload) => Output;
  /**
   * Restricts the provider chain to Claude only (lib/ai/run.ts) — set for
   * tasks whose prompt references an Anthropic file_id. Gemini/Ollama have no
   * equivalent mechanism, and silently ignoring the reference would risk a
   * hallucinated-but-schema-valid response being trusted as if it read the PDF.
   */
  requiresAnthropicFile?: boolean;
}

// --- course.splitTopics ---------------------------------------------------
export interface SplitTopicsPayload {
  raw: string;
}
const splitTopicsTask: AiTaskDef<SplitTopicsPayload, SplitTopicsOutput> = {
  id: "course.splitTopics",
  tier: "small",
  preferLocal: true,
  maxTokens: 300,
  schema: splitTopicsSchema,
  buildPrompt: ({ raw }) => ({
    system: "You split messy freeform class notes into a clean list of distinct topic titles. Respond with ONLY JSON: {\"topics\": string[]}.",
    prompt: raw
  }),
  fallback: ({ raw }) => ({ topics: ruleSplitTopics(raw) })
};

// --- plan.tomorrow ---------------------------------------------------------
export interface PlanTomorrowPayload {
  dueTasks: { title: string; dueDate?: string; priority: string }[];
  dueCheckpoints: { title: string; dueAt: string }[];
  dueRevisionCount: number;
}
const planTomorrowTask: AiTaskDef<PlanTomorrowPayload, PlanTomorrowOutput> = {
  id: "plan.tomorrow",
  tier: "small",
  preferLocal: true,
  maxTokens: 400,
  schema: planTomorrowSchema,
  buildPrompt: ({ dueTasks, dueCheckpoints, dueRevisionCount }) => ({
    system: "You draft a short plan for tomorrow from a PhD student's due items. Respond with ONLY JSON: {\"summary\": string, \"items\": string[]} (items = 3-6 concrete steps, sorted by deadline urgency).",
    prompt: `Tasks due:\n${dueTasks.map((t) => `- ${t.title}${t.dueDate ? ` (${t.dueDate}, ${t.priority})` : ""}`).join("\n") || "None"}\n\nCheckpoints due:\n${dueCheckpoints.map((c) => `- ${c.title} (${c.dueAt})`).join("\n") || "None"}\n\nRevision items due: ${dueRevisionCount}`
  }),
  fallback: ({ dueTasks, dueCheckpoints, dueRevisionCount }) => {
    const items = [
      ...dueCheckpoints.sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1)).map((c) => `Prep: ${c.title} (due ${c.dueAt})`),
      ...dueTasks.sort((a, b) => (a.dueDate ?? "9999") < (b.dueDate ?? "9999") ? -1 : 1).map((t) => t.title)
    ].slice(0, 6);
    if (dueRevisionCount > 0) items.push(`Review ${dueRevisionCount} due revision item${dueRevisionCount === 1 ? "" : "s"}`);
    return { summary: `${items.length} item${items.length === 1 ? "" : "s"} lined up, sorted by deadline.`, items };
  }
};

// --- triage.actions ---------------------------------------------------------
export interface TriageActionsPayload {
  items: { text: string; severity: "critical" | "important" | "general" }[];
}
const triageActionsTask: AiTaskDef<TriageActionsPayload, TriageActionsOutput> = {
  id: "triage.actions",
  tier: "small",
  preferLocal: true,
  maxTokens: 400,
  schema: triageActionsSchema,
  buildPrompt: ({ items }) => ({
    system: "You may re-word these alerts for clarity and re-order within the same severity band, but you must NEVER change or downgrade a severity. Respond with ONLY JSON: {\"items\": [{\"text\": string, \"severity\": \"critical\"|\"important\"|\"general\"}]} covering exactly the input items.",
    prompt: JSON.stringify(items)
  }),
  fallback: ({ items }) => ({ items })
};

// --- review.eod --------------------------------------------------------------
export interface ReviewEodPayload {
  today: { pomodoros: number; focusedMinutes: number; tasksCompleted: number; loadIndex?: number };
  yesterday: { pomodoros: number; focusedMinutes: number; tasksCompleted: number; loadIndex?: number } | null;
}
const reviewEodTask: AiTaskDef<ReviewEodPayload, ReviewEodOutput> = {
  id: "review.eod",
  tier: "small",
  preferLocal: true,
  maxTokens: 400,
  schema: reviewEodSchema,
  buildPrompt: ({ today, yesterday }) => ({
    system: "You write a short, honest end-of-day rollup for a PhD student. Respond with ONLY JSON: {\"summary\": string, \"wins\": string[], \"watchouts\": string[]}.",
    prompt: `Today: ${JSON.stringify(today)}\nYesterday: ${JSON.stringify(yesterday)}`
  }),
  fallback: ({ today, yesterday }) => {
    const diff = (key: "pomodoros" | "focusedMinutes" | "tasksCompleted") => today[key] - (yesterday?.[key] ?? 0);
    const wins: string[] = [];
    const watchouts: string[] = [];
    if (diff("focusedMinutes") >= 0) wins.push(`${today.focusedMinutes} focused minutes (${diff("focusedMinutes") >= 0 ? "+" : ""}${diff("focusedMinutes")} vs yesterday)`);
    else watchouts.push(`Focused minutes down ${Math.abs(diff("focusedMinutes"))} vs yesterday`);
    if (diff("tasksCompleted") >= 0) wins.push(`${today.tasksCompleted} tasks completed`);
    else watchouts.push(`Fewer tasks completed than yesterday`);
    if (today.loadIndex !== undefined && today.loadIndex < 0.6) watchouts.push(`Load Index at ${today.loadIndex} — behind today's target`);
    return { summary: `${today.pomodoros} pomodoros, ${today.focusedMinutes} focused minutes today.`, wins, watchouts };
  }
};

// --- paper.readingPlan --------------------------------------------------------
export interface ReadingPlanPayload {
  title: string;
  goal?: string;
  goalKind?: string;
}
const GENERIC_READING_CHECKLIST = [
  "Pass 1: title, abstract, intro, section headings, conclusions, skim references (~10-15 min)",
  "Decide verdict: continue, park, or drop",
  "Pass 2: read for content, note key points and figures (~1 hour)",
  "Write a summary you could hand to someone who never opened the paper",
  "Decide outcome: grasped, set aside, return later, or persevere to Pass 3",
  "Pass 3 (optional): re-implement mentally, challenge assumptions, recall structure from memory"
];
const readingPlanTask: AiTaskDef<ReadingPlanPayload, ReadingPlanOutput> = {
  id: "paper.readingPlan",
  tier: "small",
  preferLocal: true,
  maxTokens: 400,
  schema: readingPlanSchema,
  buildPrompt: ({ title, goal, goalKind }) => ({
    system: "You draft a short, concrete reading plan for one paper, tailored to the reader's stated goal. Respond with ONLY JSON: {\"steps\": string[]} (4-8 steps).",
    prompt: `Paper: ${title}\nGoal: ${goal ?? "unspecified"}\nGoal type: ${goalKind ?? "unspecified"}`
  }),
  fallback: () => ({ steps: GENERIC_READING_CHECKLIST })
};

// --- checkpoint.prepPlan --------------------------------------------------------
export interface PrepPlanPayload {
  title: string;
  type: string;
  dueAt: string;
  topics: { title: string; confidence: number }[];
}
const prepPlanTask: AiTaskDef<PrepPlanPayload, PrepPlanOutput> = {
  id: "checkpoint.prepPlan",
  tier: "large",
  preferLocal: false,
  maxTokens: 500,
  schema: prepPlanSchema,
  buildPrompt: ({ title, type, dueAt, topics }) => ({
    system: "You draft a concrete prep plan for a course checkpoint, prioritising the reader's weakest topics first. Respond with ONLY JSON: {\"steps\": string[]}.",
    prompt: `${type}: ${title} (due ${dueAt})\nScoped topics (confidence 1-5): ${topics.map((t) => `${t.title}:${t.confidence}`).join(", ") || "none linked"}`
  }),
  fallback: ({ topics }) => ({
    steps:
      topics.length > 0
        ? [...topics].sort((a, b) => a.confidence - b.confidence).map((t) => `Review "${t.title}" (confidence ${t.confidence}/5)`)
        : ["No topics linked to this checkpoint yet — link topics from a class log to get a scoped prep plan."]
  })
};

// --- paper.passAssist (no fallback) ---------------------------------------------
export interface PassAssistPayload {
  passNo: 1 | 2 | 3;
  title: string;
  rawNotes: string;
}
const passAssistTask: AiTaskDef<PassAssistPayload, PassAssistOutput> = {
  id: "paper.passAssist",
  tier: "large",
  preferLocal: false,
  maxTokens: 700,
  schema: passAssistSchema,
  buildPrompt: ({ passNo, title, rawNotes }) => ({
    system:
      passNo === 1
        ? "From raw notes on a paper's title/abstract/intro/conclusions, suggest structured Pass-1 fields. Respond with ONLY JSON: {\"category\":string,\"context\":string,\"correctness\":string,\"contributions\":string[],\"clarityNote\":string}."
        : "From raw notes on a paper, suggest structured Pass-2 fields. Respond with ONLY JSON: {\"keyPoints\":string[],\"summary\":string,\"unclear\":string[]}.",
    prompt: `Paper: ${title}\nRaw notes:\n${rawNotes}`
  })
};

// --- group.synthesis (no fallback) ------------------------------------------------
export interface GroupSynthesisPayload {
  groupName: string;
  purpose?: string;
  papers: { title: string; summary?: string; keyPoints?: string[] }[];
}
const groupSynthesisTask: AiTaskDef<GroupSynthesisPayload, GroupSynthesisOutput> = {
  id: "group.synthesis",
  tier: "large",
  preferLocal: false,
  maxTokens: 800,
  schema: groupSynthesisSchema,
  buildPrompt: ({ groupName, purpose, papers }) => ({
    system: "You write a short synthesis (~150 words) across a group of related papers a PhD student has read, connecting their findings and pointing out agreements/tensions. Respond with ONLY JSON: {\"synthesis\": string}.",
    prompt: `Group: ${groupName}${purpose ? ` (${purpose})` : ""}\n\n${papers.map((p) => `- ${p.title}${p.summary ? `: ${p.summary}` : ""}${p.keyPoints?.length ? `\n  Key points: ${p.keyPoints.join("; ")}` : ""}`).join("\n")}`
  })
};

// --- paper.layeredNotes (no fallback, requires an Anthropic file_id) ---------------
export interface LayeredNotesPayload {
  fileId: string;
  title: string;
  goal?: string;
  notes: string[];
  pass1Summary?: string;
  pass2Summary?: string;
}
const layeredNotesTask: AiTaskDef<LayeredNotesPayload, LayeredNotesOutput> = {
  id: "paper.layeredNotes",
  tier: "large",
  preferLocal: false,
  // The full L0-L3 shape plus a <=1200-token promptPack routinely exceeds 2000
  // output tokens — verified live: a real call hit exactly maxTokens, produced
  // truncated (invalid) JSON, and fell through to this no-fallback task's 503.
  maxTokens: 4000,
  schema: layeredNotesSchema,
  requiresAnthropicFile: true,
  buildPrompt: ({ fileId, title, goal, notes, pass1Summary, pass2Summary }) => ({
    system:
      'You produce "Layered Notes" for a paper — a structured, compact artifact designed to be re-used as future context ' +
      "instead of re-reading the paper. Base every claim on the attached PDF, not on the title alone. Respond with ONLY JSON " +
      'matching this exact shape: {"L0": string (<=25 words, one line), ' +
      '"L1": {"problem": string, "contribution": string, "result": string, "whyItMattersToMe": string}, ' +
      '"L2": {"method": string[], "datasets": string[], "metrics": string[], "baselines": string[], "ablations": string[], "assumptions": string[]}, ' +
      '"L3": {"formulation": string, "hyperparameters": string, "failureModes": string[], "reproductionChecklist": string[]}, ' +
      '"citationsToRead": string[], "openQuestions": string[], "claimsToVerify": string[], ' +
      '"sourceRefs": [{"quote": string (verbatim from the PDF), "page": number, "layer": "L1"|"L2"|"L3"}] (at least 3), ' +
      '"promptPack": string (<=1200 tokens, a dense compressed summary of everything above, written as future context for other ' +
      "questions about this paper — do not just repeat L0-L3 verbatim).",
    prompt: `Paper title: ${title}\nReading goal: ${goal ?? "unspecified"}\n\nMy own notes:\n${notes.join("\n") || "(none yet)"}\n\nPass 1 summary: ${pass1Summary ?? "(not done)"}\nPass 2 summary: ${pass2Summary ?? "(not done)"}\n\nwhyItMattersToMe must reflect my stated reading goal above, not a generic one.`,
    fileId
  })
};

// --- paper.highlightCandidates (no fallback, requires an Anthropic file_id) ---------
export interface HighlightCandidatesPayload {
  fileId: string;
  title: string;
}
const highlightCandidatesTask: AiTaskDef<HighlightCandidatesPayload, HighlightCandidatesOutput> = {
  id: "paper.highlightCandidates",
  tier: "large",
  preferLocal: false,
  // Up to 20 quotes with notes/category/layer each — same truncation risk as
  // paper.layeredNotes on a longer paper, so the same safety margin applies.
  maxTokens: 3000,
  schema: highlightCandidatesSchema,
  requiresAnthropicFile: true,
  buildPrompt: ({ fileId, title }) => ({
    system:
      "You find verbatim quotes worth highlighting in the attached PDF for active recall. Each quote must be copied EXACTLY " +
      "as it appears in the PDF (at least 6 words) — do not paraphrase, summarize, or fix typos, since it will be matched " +
      'character-for-character against the extracted PDF text. Respond with ONLY JSON: {"quotes": [{"quote": string, ' +
      '"category": "claim"|"method"|"result"|"limitation"|"definition"|"weakness", "note": string (why this quote matters, one sentence), ' +
      '"layer": "L1"|"L2"|"L3"}]} with 8-20 quotes spread across categories.',
    prompt: `Paper title: ${title}`,
    fileId
  })
};

// --- insight.daily — the pre-registry AiInsight feature, ported (plan Phase 4: "delete the old AI_PROVIDER path") ---
export interface InsightDailyPayload {
  prompt: string;
  fallbackSummary: string;
  fallbackSuggestions: string[];
}
const insightDailyTask: AiTaskDef<InsightDailyPayload, InsightDailyOutput> = {
  id: "insight.daily",
  tier: "small",
  preferLocal: true,
  maxTokens: 700,
  schema: insightDailySchema,
  buildPrompt: ({ prompt }) => ({ prompt }),
  fallback: ({ fallbackSummary, fallbackSuggestions }) => ({ summary: fallbackSummary, suggestions: fallbackSuggestions })
};

export const AI_TASKS = {
  "course.splitTopics": splitTopicsTask,
  "plan.tomorrow": planTomorrowTask,
  "triage.actions": triageActionsTask,
  "review.eod": reviewEodTask,
  "paper.readingPlan": readingPlanTask,
  "checkpoint.prepPlan": prepPlanTask,
  "paper.passAssist": passAssistTask,
  "paper.layeredNotes": layeredNotesTask,
  "paper.highlightCandidates": highlightCandidatesTask,
  "group.synthesis": groupSynthesisTask,
  "insight.daily": insightDailyTask
} as const satisfies Record<AiTaskId, AiTaskDef<never, unknown>>;

export type AnyAiTaskDef = (typeof AI_TASKS)[keyof typeof AI_TASKS];
