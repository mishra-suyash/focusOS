"use client";

import { useState } from "react";
import { checkpointDefaultsForType } from "@/lib/checkpoints";
import type { CheckpointType, NewCheckpoint } from "@/types";

const CHECKPOINT_TYPES: CheckpointType[] = ["quiz", "lab", "assignment", "midsem", "endsem", "presentation", "other"];

export const checkpointTypeLabels: Record<CheckpointType, string> = {
  quiz: "Quiz",
  lab: "Lab",
  assignment: "Assignment",
  midsem: "Midsem",
  endsem: "Endsem",
  presentation: "Presentation",
  other: "Other"
};

export function CheckpointForm({ courseId, onCreate }: { courseId: string; onCreate: (checkpoint: NewCheckpoint) => Promise<void> }) {
  const [type, setType] = useState<CheckpointType>("assignment");
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [weightPct, setWeightPct] = useState("");
  const defaults = checkpointDefaultsForType(type);
  const [requiresPrep, setRequiresPrep] = useState(defaults.requiresPrep);

  function changeType(next: CheckpointType) {
    setType(next);
    setRequiresPrep(checkpointDefaultsForType(next).requiresPrep);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !dueAt) return;
    const typeDefaults = checkpointDefaultsForType(type);
    await onCreate({
      courseId,
      type,
      title: title.trim(),
      dueAt,
      weightPct: weightPct ? Number(weightPct) : undefined,
      requiresPrep,
      prepLeadDays: typeDefaults.prepLeadDays,
      prepEstimateMin: typeDefaults.prepEstimateMin,
      topicIds: [],
      status: "upcoming"
    });
    setTitle("");
    setDueAt("");
    setWeightPct("");
  }

  return (
    <form onSubmit={submit} className="grid grid-cols-2 gap-2 sm:grid-cols-[110px_1fr_140px_90px_auto]">
      <select className="input" value={type} onChange={(e) => changeType(e.target.value as CheckpointType)}>
        {CHECKPOINT_TYPES.map((item) => (
          <option key={item} value={item}>
            {checkpointTypeLabels[item]}
          </option>
        ))}
      </select>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
      <input className="input" type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
      <input className="input" type="number" min={0} max={100} value={weightPct} onChange={(e) => setWeightPct(e.target.value)} placeholder="Wt %" />
      <button className="btn-secondary">Add</button>
      <label className="col-span-2 flex items-center gap-2 text-xs text-ink-500 sm:col-span-5">
        <input type="checkbox" checked={requiresPrep} onChange={(e) => setRequiresPrep(e.target.checked)} />
        Needs prep ({defaults.prepLeadDays}d lead, ~{defaults.prepEstimateMin}min)
      </label>
    </form>
  );
}
