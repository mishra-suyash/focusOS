import { z } from "zod";
import { templateSlotSchema } from "@/lib/templates/schema";

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

// A paper with no baselines/datasets/etc. gives the model every reason to omit or null out that
// key rather than force an empty array — verified live: a real layeredNotes generation that
// otherwise looked fine failed `safeParse` outright with no diagnosable reason logged. Every list
// field below tolerates absent/null and normalizes to `[]` rather than rejecting the whole
// response over one inapplicable section.
const lenientStringArray = () =>
  z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? []);

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
    method: lenientStringArray(),
    datasets: lenientStringArray(),
    metrics: lenientStringArray(),
    baselines: lenientStringArray(),
    ablations: lenientStringArray(),
    assumptions: lenientStringArray()
  }),
  L3: z.object({
    formulation: z.string(),
    hyperparameters: z.string(),
    failureModes: lenientStringArray(),
    reproductionChecklist: lenientStringArray()
  }),
  citationsToRead: lenientStringArray(),
  openQuestions: lenientStringArray(),
  claimsToVerify: lenientStringArray(),
  // `page` coerced since a model will sometimes write it as "12" rather than 12.
  sourceRefs: z
    .array(z.object({ quote: z.string().min(1), page: z.coerce.number(), layer: notesLayerSchema }))
    .max(20)
    .nullish()
    .transform((value) => value ?? []),
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

/**
 * plan/FocusOS-v2-Routine-Blocks-and-AI-Templates.md §3.1 — reuses `templateSlotSchema`
 * (lib/templates/schema.ts) so an AI-generated template and a hand-built one are validated
 * identically.
 */
export const generateDayTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  slots: z.array(templateSlotSchema).min(1).max(16)
});
export type GenerateDayTemplateOutput = z.infer<typeof generateDayTemplateSchema>;
