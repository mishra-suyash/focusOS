/**
 * Assessment (Checkpoint) defaults by type, shared by the form (components/checkpoint-form.tsx) and the
 * MCP server's create_checkpoint (plan/19), so an assessment made either way starts out the same.
 */
import type { CheckpointType } from "@/types";

/** Defaults by type — quiz/midsem/endsem/presentation need prep, lab/assignment don't. */
export const CHECKPOINT_TYPE_DEFAULTS: Record<CheckpointType, { requiresPrep: boolean; prepLeadDays: number; prepEstimateMin: number }> = {
  quiz: { requiresPrep: true, prepLeadDays: 3, prepEstimateMin: 90 },
  lab: { requiresPrep: false, prepLeadDays: 2, prepEstimateMin: 60 },
  assignment: { requiresPrep: false, prepLeadDays: 5, prepEstimateMin: 180 },
  midsem: { requiresPrep: true, prepLeadDays: 10, prepEstimateMin: 600 },
  endsem: { requiresPrep: true, prepLeadDays: 21, prepEstimateMin: 1500 },
  presentation: { requiresPrep: true, prepLeadDays: 7, prepEstimateMin: 240 },
  other: { requiresPrep: false, prepLeadDays: 3, prepEstimateMin: 60 }
};

export function checkpointDefaultsForType(type: CheckpointType) {
  return CHECKPOINT_TYPE_DEFAULTS[type];
}
