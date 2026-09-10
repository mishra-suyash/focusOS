import type { ReadingGoalPayload } from "@/lib/templates/schema";
import type { GoalKind } from "@/types";

/** One preset "why am I reading this?" sentence per existing `goalKind` (plan §6.3). Filling the field in one click still leaves the user confirming/editing it, so the reading-goal gate's purpose survives. */
export const BUILTIN_READING_GOAL_PRESETS: Record<GoalKind, ReadingGoalPayload> = {
  survey: { id: "survey", version: 1, goalKind: "survey", text: "Mapping the space — understanding what approaches exist and how they relate." },
  method: { id: "method", version: 1, goalKind: "method", text: "Learning a method I might use or adapt for my own work." },
  baseline: { id: "baseline", version: 1, goalKind: "baseline", text: "Understanding a baseline I need to compare against." },
  "related-work": { id: "related-work", version: 1, goalKind: "related-work", text: "Related work for a paper or chapter I'm writing." },
  reproduce: { id: "reproduce", version: 1, goalKind: "reproduce", text: "Planning to reproduce or extend this paper's results." },
  critique: { id: "critique", version: 1, goalKind: "critique", text: "Evaluating this paper's claims carefully before relying on them." }
};
