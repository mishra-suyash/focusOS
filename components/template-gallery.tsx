"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Star, X } from "lucide-react";
import { clsx } from "clsx";
import { DayStrip } from "@/components/plan/day-strip";
import { InfoHint } from "@/components/info-hint";
import { createDayTemplate, saveDailySchedule, setDefaultTemplate } from "@/lib/firestore";
import { friendlyDate } from "@/lib/dates";
import { formatMinutes, materializeSlots, scheduleFromTemplate, shiftTemplateSlots, slotDuration, slotTypeLabels, slotTypeStyles, sortedSlots } from "@/lib/schedule";
import { BUILTIN_DAY_TEMPLATES, materializeBuiltinDayTemplate, type BuiltinDayTemplate } from "@/lib/templates/builtin";
import { useTemplateCatalog } from "@/hooks/use-template-catalog";
import type { DayTemplatePayload, PublicCatalog } from "@/lib/templates/schema";

type CatalogDayTemplate = PublicCatalog["templates"][number] & { payload: DayTemplatePayload };
import type { DailySchedule, DayTemplate, ScheduleSlot } from "@/types";

/**
 * The template gallery (plan §6.4) — "Your templates" + "Built-in" (an admin
 * "From your group" section arrives with U2). Every card offers Preview,
 * Use for today, and Make workday template.
 */
export function TemplateGalleryDialog({
  uid,
  dateKey,
  userTemplates,
  hasExistingPlan,
  onApplied,
  onClose
}: {
  uid: string;
  dateKey: string;
  userTemplates: DayTemplate[];
  hasExistingPlan: boolean;
  onApplied: (slots: ScheduleSlot[]) => void;
  onClose: () => void;
}) {
  const [dayStart, setDayStart] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const { catalog } = useTemplateCatalog();
  const orgDayTemplates = (catalog?.templates.filter((t) => t.kind === "day") ?? []) as CatalogDayTemplate[];
  const visibleBuiltins = BUILTIN_DAY_TEMPLATES.filter((builtin) => !catalog?.hiddenBuiltInIds.includes(builtin.id));

  async function applySlots(slots: ScheduleSlot[], templateId?: string) {
    if (hasExistingPlan && !window.confirm(`${friendlyDate(dateKey)} already has a plan. Replace it with this template?`)) return;
    const schedule: Omit<DailySchedule, "id" | "createdAt" | "updatedAt"> = { dateKey, templateId, slots: sortedSlots(slots) };
    await saveDailySchedule(uid, schedule);
    onApplied(sortedSlots(slots));
    onClose();
  }

  async function applyUserTemplate(template: DayTemplate) {
    await applySlots(scheduleFromTemplate(template, dateKey).slots, template.id);
  }

  function shiftedBuiltinSlots(builtin: BuiltinDayTemplate): ScheduleSlot[] | null {
    const materialized = materializeBuiltinDayTemplate(builtin).slots;
    if (!dayStart) return materialized;
    const shifted = shiftTemplateSlots(materialized, dayStart);
    return shifted;
  }

  async function applyBuiltinTemplate(builtin: BuiltinDayTemplate) {
    const slots = shiftedBuiltinSlots(builtin);
    if (!slots) {
      setSavedNotice("That start time would push a block past midnight — pick an earlier start.");
      return;
    }
    await applySlots(slots.map((slot) => ({ ...slot, id: crypto.randomUUID() })));
  }

  async function makeWorkdayTemplate(builtin: BuiltinDayTemplate) {
    const slots = shiftedBuiltinSlots(builtin);
    if (!slots) {
      setSavedNotice("That start time would push a block past midnight — pick an earlier start.");
      return;
    }
    const id = await createDayTemplate(uid, {
      name: builtin.name,
      description: builtin.description,
      isDefault: true,
      slots: slots.map((slot) => ({ ...slot, id: crypto.randomUUID(), status: "upcoming" })),
      sourceTemplateId: `builtin:${builtin.id}`,
      sourceVersion: builtin.version
    });
    // The new copy is already isDefault: true; this only needs to unset the flag on whichever
    // of the user's existing templates was previously default, so exactly one stays starred.
    await setDefaultTemplate(uid, userTemplates, id);
    setSavedNotice(`"${builtin.name}" saved — Start day will use this on workdays.`);
  }

  function materializeOrgSlots(template: CatalogDayTemplate): ScheduleSlot[] {
    return materializeSlots(template.payload.slots);
  }

  async function applyOrgTemplate(template: CatalogDayTemplate) {
    await applySlots(materializeOrgSlots(template).map((slot) => ({ ...slot, id: crypto.randomUUID() })));
  }

  async function makeWorkdayTemplateFromOrg(template: CatalogDayTemplate) {
    const id = await createDayTemplate(uid, {
      name: template.name,
      description: template.description,
      isDefault: true,
      slots: materializeOrgSlots(template).map((slot) => ({ ...slot, id: crypto.randomUUID(), status: "upcoming" })),
      sourceTemplateId: `org:${template.id}`,
      sourceVersion: template.version
    });
    await setDefaultTemplate(uid, userTemplates, id);
    setSavedNotice(`"${template.name}" saved — Start day will use this on workdays.`);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-10 sm:pt-16" onClick={onClose}>
      <div className="card w-full max-w-3xl p-5" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Browse templates</h2>
            <p className="mt-1 text-sm text-ink-500">Preview writes nothing. Applying to a day that already has a plan asks first.</p>
          </div>
          <button className="btn-secondary px-2 py-1.5" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="mb-4 flex items-center gap-2 text-sm text-ink-600 dark:text-ink-300">
          My day starts at
          <input className="input w-32" type="time" value={dayStart} onChange={(event) => setDayStart(event.target.value)} />
          <span className="text-xs text-ink-500">(shifts built-in templates below; leave blank to use them as-is)</span>
        </label>

        {savedNotice ? (
          <div className="mb-4 rounded-md border border-moss-600/40 bg-moss-600/10 p-3 text-sm text-moss-700 dark:text-moss-400">{savedNotice}</div>
        ) : null}

        {userTemplates.length > 0 ? (
          <section className="mb-6">
            <h3 className="mb-2 text-sm font-semibold text-ink-500">Your templates</h3>
            <div className="space-y-2">
              {userTemplates.map((template) => (
                <TemplateCard
                  key={template.id}
                  id={`user-${template.id}`}
                  name={template.name}
                  description={template.description}
                  slots={template.slots}
                  expanded={expandedId === `user-${template.id}`}
                  onToggle={() => setExpandedId((current) => (current === `user-${template.id}` ? null : `user-${template.id}`))}
                  onUse={() => applyUserTemplate(template)}
                />
              ))}
            </div>
          </section>
        ) : null}

        {orgDayTemplates.length > 0 ? (
          <section className="mb-6">
            <h3 className="mb-2 text-sm font-semibold text-ink-500">From your group</h3>
            <div className="space-y-2">
              {orgDayTemplates.map((template) => (
                <TemplateCard
                  key={template.id}
                  id={`org-${template.id}`}
                  name={template.name}
                  description={template.description}
                  slots={materializeOrgSlots(template)}
                  expanded={expandedId === `org-${template.id}`}
                  onToggle={() => setExpandedId((current) => (current === `org-${template.id}` ? null : `org-${template.id}`))}
                  onUse={() => applyOrgTemplate(template)}
                  onMakeDefault={() => makeWorkdayTemplateFromOrg(template)}
                />
              ))}
            </div>
          </section>
        ) : null}

        <section>
          <h3 className="mb-2 text-sm font-semibold text-ink-500">Built-in</h3>
          <div className="space-y-2">
            {visibleBuiltins.map((builtin) => (
              <TemplateCard
                key={builtin.id}
                id={`builtin-${builtin.id}`}
                name={builtin.name}
                description={builtin.description}
                slots={materializeBuiltinDayTemplate(builtin).slots}
                expanded={expandedId === `builtin-${builtin.id}`}
                onToggle={() => setExpandedId((current) => (current === `builtin-${builtin.id}` ? null : `builtin-${builtin.id}`))}
                onUse={() => applyBuiltinTemplate(builtin)}
                onMakeDefault={() => makeWorkdayTemplate(builtin)}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function TemplateCard({
  id,
  name,
  description,
  slots,
  expanded,
  onToggle,
  onUse,
  onMakeDefault
}: {
  id: string;
  name: string;
  description?: string;
  slots: ScheduleSlot[];
  expanded: boolean;
  onToggle: () => void;
  onUse: () => void;
  onMakeDefault?: () => void;
}) {
  const ordered = sortedSlots(slots);
  const focusMinutes = ordered.filter((slot) => slot.type === "deep_work").reduce((sum, slot) => sum + slotDuration(slot), 0);
  return (
    <article className="rounded-md border border-ink-200 p-3 dark:border-ink-800" id={id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="font-medium">{name}</h4>
          {description ? <p className="mt-0.5 text-sm text-ink-500">{description}</p> : null}
        </div>
        <span className="whitespace-nowrap text-xs text-ink-500">{formatMinutes(focusMinutes)} deep work</span>
      </div>
      <div className="mt-2">
        <DayStrip variant="mini" slots={ordered} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn-secondary py-1.5 text-xs" onClick={onToggle}>
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          {expanded ? "Hide preview" : "Preview"}
        </button>
        <button className="btn-primary py-1.5 text-xs" onClick={onUse}>Use for today</button>
        {onMakeDefault ? (
          <span className="inline-flex items-center gap-1">
            <button className="btn-secondary py-1.5 text-xs" onClick={onMakeDefault}>
              <Star className="h-3.5 w-3.5" />
              Make workday template
            </button>
            <InfoHint term="workdayTemplate" />
          </span>
        ) : null}
      </div>
      {expanded ? (
        <div className="mt-3 space-y-1 border-t border-ink-200 pt-3 text-xs dark:border-ink-800">
          {ordered.map((slot, index) => (
            <div key={index} className="flex items-center gap-2">
              <span className="font-mono text-ink-500">{slot.startTime}-{slot.endTime}</span>
              <span className={clsx("rounded border px-1.5 py-0.5", slotTypeStyles[slot.type])}>{slotTypeLabels[slot.type]}</span>
              <span>{slot.title}</span>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}
