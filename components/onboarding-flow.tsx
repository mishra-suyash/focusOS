"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { useWorkdaySession } from "@/components/workday-session-provider";
import { useTemplateCatalog } from "@/hooks/use-template-catalog";
import { useUserSettings } from "@/hooks/use-user-settings";
import { createDayTemplate } from "@/lib/firestore";
import { materializeSlots, shiftTemplateSlots } from "@/lib/schedule";
import { BUILTIN_TIMER_PRESETS } from "@/lib/templates/builtin/timer-presets";
import { resolveBreakDayTemplate, resolveWorkdayTemplate, type ResolvedPackTemplate } from "@/lib/templates/resolve";
import { resolvePackTimerPreset } from "@/lib/templates/builtin";
import type { PackId, TimerPresetId } from "@/types";

/**
 * The ≤60-second first-run stepper (plan §8.2). Guest accounts skip the
 * Welcome and timer-rhythm steps. Every step is skippable via the header's
 * "Skip setup" control, which finalizes immediately with whatever's already
 * chosen (unset pack -> "core", the §8.1 skip-onboarding default).
 */
const ORDER = ["welcome", "pack", "daystart", "timer", "done"] as const;
type StepId = (typeof ORDER)[number];

const PACK_CARDS: { id: PackId; title: string; blurb: string }[] = [
  { id: "coursework", title: "I'm taking courses", blurb: "Class days, assessments, revising lecture topics, a reading list." },
  { id: "research", title: "I'm reading and doing research", blurb: "Research-day schedule, staged reading, focus sessions, a couple of goals." },
  { id: "writing", title: "I'm writing my thesis", blurb: "Writing-day schedule, thesis-chapter goals with milestones, weekly check-in." },
  { id: "everything", title: "Show me all features", blurb: "Every module, right away." }
];

function nowIso() {
  return new Date().toISOString();
}

export function OnboardingFlow({ onDone }: { onDone: () => void }) {
  const { user } = useAuth();
  const { settings, update: updateSettings } = useUserSettings();
  const { catalog } = useTemplateCatalog();
  const { start } = useWorkdaySession();
  const guest = Boolean(user?.isAnonymous);

  const visibleSteps: StepId[] = ORDER.filter((step) => !(guest && (step === "welcome" || step === "timer")));

  const [index, setIndex] = useState(() => Math.min(settings.onboarding?.step ?? 0, visibleSteps.length - 1));
  const [pack, setPack] = useState<PackId | "">("");
  const [dayStart, setDayStart] = useState("09:00");
  const [timerPresetId, setTimerPresetId] = useState<TimerPresetId>("classic");
  const [finalizing, setFinalizing] = useState(false);
  const [ready, setReady] = useState(false);
  const finalizedRef = useRef(false);
  const step = visibleSteps[index];

  useEffect(() => {
    setTimerPresetId(resolvePackTimerPreset(pack || undefined));
  }, [pack]);

  function persistProgress(nextIndex: number) {
    if (!user) return;
    updateSettings({ onboarding: { status: "in_progress", step: nextIndex } });
  }

  function goTo(nextIndex: number) {
    const clamped = Math.min(Math.max(nextIndex, 0), visibleSteps.length - 1);
    setIndex(clamped);
    persistProgress(clamped);
  }

  async function finalize(status: "done" | "skipped") {
    if (!user || finalizedRef.current) return;
    finalizedRef.current = true;
    setFinalizing(true);
    const resolvedPack = pack || "core";

    const workday: ResolvedPackTemplate = resolveWorkdayTemplate(resolvedPack === "core" ? undefined : resolvedPack, catalog);
    const workdaySlots = materializeSlots(workday.slots);
    const startShift = dayStart && dayStart !== workdaySlots[0]?.startTime ? shiftTemplateSlots(workdaySlots, dayStart) : workdaySlots;
    const finalWorkdaySlots = (startShift ?? workdaySlots).map((slot) => ({ ...slot, id: crypto.randomUUID(), status: "upcoming" as const }));

    const workdayTemplateId = await createDayTemplate(user.uid, {
      name: workday.name,
      description: workday.description,
      isDefault: true,
      slots: finalWorkdaySlots,
      sourceTemplateId: `${workday.source}:${workday.id}`,
      sourceVersion: workday.version
    });

    const breakDay = resolveBreakDayTemplate(resolvedPack === "core" ? undefined : resolvedPack, catalog);
    let breakTemplateId: string | undefined;
    if (breakDay) {
      const breakSlots = materializeSlots(breakDay.slots).map((slot) => ({ ...slot, id: crypto.randomUUID(), status: "upcoming" as const }));
      breakTemplateId = await createDayTemplate(user.uid, {
        name: breakDay.name,
        description: breakDay.description,
        isDefault: false,
        slots: breakSlots,
        sourceTemplateId: `${breakDay.source}:${breakDay.id}`,
        sourceVersion: breakDay.version
      });
    }

    const preset = timerPresetId !== "custom" ? BUILTIN_TIMER_PRESETS[timerPresetId] : undefined;

    await updateSettings({
      packId: resolvedPack,
      dayStartTime: dayStart || undefined,
      timerPresetId,
      workMinutes: preset?.workMinutes,
      shortBreakMinutes: preset?.shortBreakMinutes,
      longBreakMinutes: preset?.longBreakMinutes,
      breakTemplateId,
      onboarding: { status, step: visibleSteps.length - 1, completedAt: nowIso() }
    });

    void workdayTemplateId; // Start day (below) re-resolves the default template itself; nothing else needs the id.
    setFinalizing(false);
    setReady(true);
  }

  useEffect(() => {
    if (step === "done" && !finalizedRef.current) finalize("done");
  }, [step]);

  function skipSetup() {
    finalize("skipped");
  }

  async function startMyDay() {
    await start();
    onDone();
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-white p-4 dark:bg-ink-950">
      <div className="w-full max-w-lg">
        {step !== "done" ? (
          <div className="mb-4 flex justify-end">
            <button className="text-xs text-ink-500 underline-offset-2 hover:underline" onClick={skipSetup}>
              Skip setup
            </button>
          </div>
        ) : null}

        {step === "welcome" ? (
          <div className="space-y-4 text-center">
            <h1 className="text-2xl font-semibold">Welcome, {user?.displayName ?? "there"}.</h1>
            <p className="text-ink-600 dark:text-ink-300">Plan your research days, focus, and keep track of what you read.</p>
            <button className="btn-primary mx-auto" onClick={() => goTo(index + 1)}>Continue</button>
          </div>
        ) : null}

        {step === "pack" ? (
          <div className="space-y-4">
            <h1 className="text-center text-2xl font-semibold">Where are you in your PhD?</h1>
            <div className="grid gap-3 sm:grid-cols-2">
              {PACK_CARDS.map((card) => (
                <button
                  key={card.id}
                  className="rounded-lg border border-ink-200 p-4 text-left transition hover:border-moss-500 dark:border-ink-800"
                  onClick={() => {
                    setPack(card.id);
                    goTo(index + 1);
                  }}
                >
                  <p className="font-medium">{card.title}</p>
                  <p className="mt-1 text-sm text-ink-500">{card.blurb}</p>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {step === "daystart" ? (
          <DayStartStep
            pack={pack || undefined}
            dayStart={dayStart}
            onChange={setDayStart}
            onContinue={() => goTo(index + 1)}
          />
        ) : null}

        {step === "timer" ? (
          <div className="space-y-4">
            <h1 className="text-center text-2xl font-semibold">Pick your focus rhythm</h1>
            <div className="grid gap-3 sm:grid-cols-3">
              {Object.entries(BUILTIN_TIMER_PRESETS).map(([id, preset]) => (
                <button
                  key={id}
                  className={`rounded-lg border p-4 text-left transition hover:border-moss-500 ${
                    timerPresetId === id ? "border-moss-500 bg-moss-600/5" : "border-ink-200 dark:border-ink-800"
                  }`}
                  onClick={() => {
                    setTimerPresetId(id as TimerPresetId);
                    goTo(index + 1);
                  }}
                >
                  <p className="font-medium">{preset.name}</p>
                  <p className="mt-1 text-xs text-ink-500">{preset.description}</p>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {step === "done" ? (
          <div className="space-y-4 text-center">
            <h1 className="text-2xl font-semibold">{finalizing ? "Setting things up..." : "Your day is ready."}</h1>
            {ready ? (
              <div className="flex flex-col items-center gap-2">
                <button className="btn-primary" onClick={startMyDay}>Start my day</button>
                <button className="text-sm text-ink-500 underline-offset-2 hover:underline" onClick={onDone}>Look around first</button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DayStartStep({
  pack,
  dayStart,
  onChange,
  onContinue
}: {
  pack: PackId | undefined;
  dayStart: string;
  onChange: (value: string) => void;
  onContinue: () => void;
}) {
  const { catalog } = useTemplateCatalog();
  const template = resolveWorkdayTemplate(pack, catalog);
  const slots = materializeSlots(template.slots);
  const shifted = dayStart && dayStart !== slots[0]?.startTime ? shiftTemplateSlots(slots, dayStart) : slots;
  const previewSlots = shifted ?? slots;
  const invalidShift = shifted === null;

  return (
    <div className="space-y-4">
      <h1 className="text-center text-2xl font-semibold">When does your day usually start?</h1>
      <div className="flex justify-center">
        <input className="input w-32" type="time" value={dayStart} onChange={(event) => onChange(event.target.value)} />
      </div>
      {invalidShift ? (
        <p className="text-center text-xs text-red-600">That start time would push a block past midnight — try an earlier time.</p>
      ) : (
        <div className="mx-auto max-w-sm space-y-1 rounded-md border border-ink-200 p-3 text-xs dark:border-ink-800">
          <p className="mb-1 font-medium">{template.name}</p>
          {previewSlots.slice(0, 4).map((slot, idx) => (
            <p key={idx} className="text-ink-500">
              {slot.startTime}-{slot.endTime} {slot.title}
            </p>
          ))}
          {previewSlots.length > 4 ? <p className="text-ink-400">+{previewSlots.length - 4} more</p> : null}
        </div>
      )}
      <p className="text-center text-xs text-ink-500">You can browse more templates anytime in Plan → Templates.</p>
      <div className="flex justify-center">
        <button className="btn-primary" onClick={onContinue}>Continue</button>
      </div>
    </div>
  );
}
