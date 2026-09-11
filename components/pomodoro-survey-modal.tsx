"use client";

import { clsx } from "clsx";
import { useState } from "react";
import { MoreOptions } from "@/components/more-options";

const RATINGS = [1, 2, 3, 4, 5];

/** Plan §9.5 — a single row of 1-5 buttons with the comment collapsed behind "More options"; Skip stays. */
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
        <div className="mt-4 grid grid-cols-5 gap-2">
          {RATINGS.map((value) => (
            <button
              key={value}
              type="button"
              className={clsx("btn-secondary py-2 text-sm", rating === value && "ring-2 ring-moss-500")}
              onClick={() => setRating(value)}
              aria-label={`Productivity ${value}`}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="mt-4">
          <MoreOptions label="Add a comment">
            <textarea
              className="input min-h-20"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Blockers, what worked, next step..."
            />
          </MoreOptions>
        </div>
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
