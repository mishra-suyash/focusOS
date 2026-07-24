"use client";

import { orderBy } from "firebase/firestore";
import { useMemo, useState } from "react";
import { SectionHeader } from "@/components/section-header";
import { useAuth } from "@/components/auth-provider";
import { useUserCollection } from "@/hooks/use-user-collection";
import { saveDailyReview } from "@/lib/firestore";
import { todayKey } from "@/lib/dates";
import type { DailyReview } from "@/types";

export default function DailyReviewPage() {
  const { user } = useAuth();
  const { items: reviews } = useUserCollection<DailyReview>("dailyReviews", useMemo(() => [orderBy("updatedAt", "desc")], []));
  const [date, setDate] = useState(todayKey());
  const existing = reviews.find((review) => review.date === date);
  const [done, setDone] = useState("");
  const [blocked, setBlocked] = useState("");
  const [carryForward, setCarryForward] = useState("");
  const [focusRating, setFocusRating] = useState(3);
  const [energyRating, setEnergyRating] = useState(3);

  async function save() {
    if (!user) return;
    await saveDailyReview(user.uid, {
      date,
      done: done || existing?.done || "",
      blocked: blocked || existing?.blocked || "",
      carryForward: carryForward || existing?.carryForward || "",
      focusRating,
      energyRating
    });
  }

  return (
    <>
      <SectionHeader title="Daily Review" eyebrow="Close the loop" />
      <section className="card max-w-3xl p-5">
        <input className="input mb-4 max-w-52" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <ReviewTextarea label="What got done?" value={done || existing?.done || ""} onChange={setDone} />
        <ReviewTextarea label="What was blocked?" value={blocked || existing?.blocked || ""} onChange={setBlocked} />
        <ReviewTextarea label="What should carry forward?" value={carryForward || existing?.carryForward || ""} onChange={setCarryForward} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Rating label="Focus" value={focusRating} onChange={setFocusRating} />
          <Rating label="Energy" value={energyRating} onChange={setEnergyRating} />
        </div>
        <button className="btn-primary mt-5" onClick={save}>Save review</button>
      </section>
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
