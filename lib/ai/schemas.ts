import { z } from "zod";

/**
 * One zod schema per AI task's structured output (plan §9.1: "structured output
 * or nothing"). A response that fails `safeParse` is treated as a provider
 * failure and falls through to the next link in the chain, never rendered raw.
 */

export const splitTopicsSchema = z.object({
  topics: z.array(z.string().min(1)).max(30)
});
export type SplitTopicsOutput = z.infer<typeof splitTopicsSchema>;

export const planTomorrowSchema = z.object({
  summary: z.string(),
  items: z.array(z.string()).max(10)
});
export type PlanTomorrowOutput = z.infer<typeof planTomorrowSchema>;

export const triageActionsSchema = z.object({
  items: z.array(
    z.object({
      text: z.string(),
      severity: z.enum(["critical", "important", "general"])
    })
  )
});
export type TriageActionsOutput = z.infer<typeof triageActionsSchema>;

export const reviewEodSchema = z.object({
  summary: z.string(),
  wins: z.array(z.string()).max(5),
  watchouts: z.array(z.string()).max(5)
});
export type ReviewEodOutput = z.infer<typeof reviewEodSchema>;

export const readingPlanSchema = z.object({
  steps: z.array(z.string().min(1)).min(1).max(12)
});
export type ReadingPlanOutput = z.infer<typeof readingPlanSchema>;

export const prepPlanSchema = z.object({
  steps: z.array(z.string().min(1)).min(1).max(12)
});
export type PrepPlanOutput = z.infer<typeof prepPlanSchema>;

/** Suggested field values for whichever pass the caller is on — the form stays the source of truth, this only prefills it. */
export const passAssistSchema = z.object({
  category: z.string().optional(),
  context: z.string().optional(),
  correctness: z.string().optional(),
  contributions: z.array(z.string()).optional(),
  clarityNote: z.string().optional(),
  keyPoints: z.array(z.string()).optional(),
  summary: z.string().optional(),
  unclear: z.array(z.string()).optional()
});
export type PassAssistOutput = z.infer<typeof passAssistSchema>;

export const groupSynthesisSchema = z.object({
  synthesis: z.string().min(1)
});
export type GroupSynthesisOutput = z.infer<typeof groupSynthesisSchema>;

export const insightDailySchema = z.object({
  summary: z.string(),
  suggestions: z.array(z.string()).max(6)
});
export type InsightDailyOutput = z.infer<typeof insightDailySchema>;

const notesLayerSchema = z.enum(["L1", "L2", "L3"]);

/** plan §8.6 — `relatedInLibrary` deliberately cut (see types/index.ts's LayeredNotes doc comment). */
export const layeredNotesSchema = z.object({
  L0: z.string().min(1),
  L1: z.object({
    problem: z.string(),
    contribution: z.string(),
    result: z.string(),
    whyItMattersToMe: z.string()
  }),
  L2: z.object({
    method: z.array(z.string()),
    datasets: z.array(z.string()),
    metrics: z.array(z.string()),
    baselines: z.array(z.string()),
    ablations: z.array(z.string()),
    assumptions: z.array(z.string())
  }),
  L3: z.object({
    formulation: z.string(),
    hyperparameters: z.string(),
    failureModes: z.array(z.string()),
    reproductionChecklist: z.array(z.string())
  }),
  citationsToRead: z.array(z.string()),
  openQuestions: z.array(z.string()),
  claimsToVerify: z.array(z.string()),
  sourceRefs: z.array(z.object({ quote: z.string().min(1), page: z.number(), layer: notesLayerSchema })).max(20),
  promptPack: z.string().min(1)
});
export type LayeredNotesOutput = z.infer<typeof layeredNotesSchema>;

/** plan §8.7 step 3 — verbatim quotes only; the matcher (lib/pdf-annotate.ts) does the geometry, never the model. */
export const highlightCandidatesSchema = z.object({
  quotes: z
    .array(
      z.object({
        quote: z.string().min(10),
        category: z.enum(["claim", "method", "result", "limitation", "definition", "weakness"]),
        note: z.string(),
        layer: notesLayerSchema
      })
    )
    .max(40)
});
export type HighlightCandidatesOutput = z.infer<typeof highlightCandidatesSchema>;
