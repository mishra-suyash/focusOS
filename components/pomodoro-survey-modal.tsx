"use client";

import { useState } from "react";

export function PomodoroSurveyModal({
  label,
  onSave,
  onSkip
}: {
  label: string;
  onSave: (rating: number, comment: string) => void;
  onSkip: () => void;
}) {
  const [rating, setRating] = useState(3);
  const [comment, setComment] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-sm p-5">
        <h2 className="text-lg font-semibold">How did &ldquo;{label}&rdquo; go?</h2>
        <label className="mt-4 block">
          <span className="label mb-2 block">Productivity: {rating}</span>
          <input className="w-full accent-moss-600" type="range" min={1} max={5} value={rating} onChange={(e) => setRating(Number(e.target.value))} />
        </label>
        <label className="mt-4 block">
          <span className="label mb-2 block">Comments (optional)</span>
          <textarea
            className="input min-h-20"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Blockers, what worked, next step..."
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onSkip}>
            Skip
          </button>
          <button className="btn-primary" onClick={() => onSave(rating, comment.trim())}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
