"use client";

import { useEffect, useState } from "react";
import { SectionHeader } from "@/components/section-header";
import { EveningRollupCard } from "@/components/evening-rollup-card";
import { useAuth } from "@/components/auth-provider";
import { useDay } from "@/hooks/use-day";
import { saveDayFields } from "@/lib/firestore";
import { todayKey } from "@/lib/dates";

export default function DailyReviewPage() {
  const { user } = useAuth();
  const [date, setDate] = useState(todayKey());
  const { day } = useDay(date);
  const review = day?.review;
  const [done, setDone] = useState("");
  const [blocked, setBlocked] = useState("");
  const [carryForward, setCarryForward] = useState("");
  const [focusRating, setFocusRating] = useState(3);
  const [energyRating, setEnergyRating] = useState(3);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setDone(review?.done ?? "");
    setBlocked(review?.blocked ?? "");
    setCarryForward(review?.carryForward ?? "");
    setFocusRating(review?.focusRating ?? 3);
    setEnergyRating(review?.energyRating ?? 3);
    setMessage("");
  }, [review, date]);

  async function save() {
    if (!user) return;
    setSaving(true);
    try {
      await saveDayFields(user.uid, date, {
        "review.done": done,
        "review.blocked": blocked,
        "review.carryForward": carryForward,
        "review.focusRating": focusRating,
        "review.energyRating": energyRating,
        "review.submittedAt": new Date().toISOString()
      });
      setMessage("Daily wrap-up saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <SectionHeader title="Daily wrap-up" eyebrow="Close the loop" />
      <section className="card max-w-3xl p-5">
        <input className="input mb-4 max-w-52" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <ReviewTextarea label="What got done?" value={done} onChange={setDone} />
        <ReviewTextarea label="What was blocked?" value={blocked} onChange={setBlocked} />
        <ReviewTextarea label="What should carry forward?" value={carryForward} onChange={setCarryForward} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Rating label="Focus" value={focusRating} onChange={setFocusRating} />
          <Rating label="Energy" value={energyRating} onChange={setEnergyRating} />
        </div>
        <div className="mt-5 flex items-center gap-3">
          <button className="btn-primary" onClick={save} disabled={saving}>{saving ? "Saving..." : "Save review"}</button>
          {message ? <p className="text-sm text-moss-700 dark:text-moss-400">{message}</p> : null}
        </div>
      </section>
      {date === todayKey() ? <EveningRollupCard date={date} rollup={day?.rollup} /> : null}
    </>
  );
}

function ReviewTextarea({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="mb-4 block">
      <span className="label mb-2 block">{label}</span>
      <textarea className="input min-h-28" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Rating({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label>
      <span className="label mb-2 block">{label} rating: {value}</span>
      <input className="w-full accent-moss-600" type="range" min={1} max={5} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
