"use client";

import { orderBy } from "firebase/firestore";
import { Copy, Plus, Star, Trash2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { DayTimelineEditor } from "@/components/plan/day-timeline-editor";
import { EmptyState } from "@/components/empty-state";
import { InfoHint } from "@/components/info-hint";
import { MoreOptions } from "@/components/more-options";
import { SectionHeader } from "@/components/section-header";
import { TemplateGalleryDialog } from "@/components/template-gallery";
import { useAuth } from "@/components/auth-provider";
import { useFeatures } from "@/hooks/use-features";
import { useTemplateCatalog } from "@/hooks/use-template-catalog";
import { useUserCollection } from "@/hooks/use-user-collection";
import { useUserSettings } from "@/hooks/use-user-settings";
import { courseSlotsForDate } from "@/lib/courses";
import {
  createDayTemplate,
  deleteDayTemplate,
  duplicateDayTemplate,
  saveDailySchedule,
  setDefaultTemplate,
  updateDayTemplate
} from "@/lib/firestore";
import {
  createSlot,
  materializeSlots,
  minutesFromTime,
  scheduleFromTemplate,
  slotTypeLabels,
  slotTypes,
  sortedSlots,
  validateSlots
} from "@/lib/schedule";
import { DEFAULT_ROUTINE_BLOCKS, routineSlotsForDate } from "@/lib/routine";
import { isBreakMode } from "@/lib/terms";
import { rangeOverlapsSlots } from "@/lib/timeline";
import { friendlyDate, todayKey } from "@/lib/dates";
import type { DayTemplatePayload, PublicCatalog } from "@/lib/templates/schema";
import type { Course, DailySchedule, DayTemplate, ScheduleSlot, ScheduleSlotType, Task, Term } from "@/types";

type CatalogDayEntry = PublicCatalog["templates"][number] & { payload: DayTemplatePayload };

export default function DayPlannerPage() {
  return (
    <Suspense fallback={null}>
      <DayPlannerContent />
    </Suspense>
  );
}

function DayPlannerContent() {
  const { user } = useAuth();
  const { isEnabled } = useFeatures();
  const timelineEditorEnabled = isEnabled("planDayTimeline");
  const searchParams = useSearchParams();
  const [dateKey, setDateKey] = useState(todayKey());
  const { items: schedules, loading: schedulesLoading } = useUserCollection<DailySchedule>("dailySchedules", useMemo(() => [orderBy("updatedAt", "desc")], []));
  const { items: templates } = useUserCollection<DayTemplate>("dayTemplates", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: tasks } = useUserCollection<Task>("tasks", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: courses, loading: coursesLoading } = useUserCollection<Course>("courses", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: terms, loading: termsLoading } = useUserCollection<Term>("terms", useMemo(() => [orderBy("startDate", "desc")], []));
  const { settings, loaded: settingsLoaded } = useUserSettings();
  const { catalog } = useTemplateCatalog();
  const schedule = schedules.find((item) => item.dateKey === dateKey);
  // Routine-Blocks-and-AI-Templates spec §2.4 — this date's class + enabled routine blocks,
  // always passed to `DayTimelineEditor` (which merges in whichever aren't already on the saved
  // day — see its own `wantedLockedSlots` doc comment), not just when nothing is saved yet.
  // Classes win on conflict: a lecture is a fixed external commitment, a routine anchor isn't.
  const wantedLockedSlots = useMemo(() => {
    const classSlots = isBreakMode(terms, dateKey) ? [] : courseSlotsForDate(courses, dateKey);
    const routineSlots = routineSlotsForDate(settings.routineBlocks ?? DEFAULT_ROUTINE_BLOCKS, dateKey).filter(
      (slot) => !rangeOverlapsSlots(minutesFromTime(slot.startTime), minutesFromTime(slot.endTime), classSlots)
    );
    return [...classSlots, ...routineSlots];
  }, [terms, courses, settings.routineBlocks, dateKey]);
  const [slots, setSlots] = useState<ScheduleSlot[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [templateDescription, setTemplateDescription] = useState("");
  const [galleryOpen, setGalleryOpen] = useState(false);
  const errors = validateSlots(slots);

  useEffect(() => {
    setDateKey(searchParams.get("date") ?? todayKey());
  }, [searchParams]);

  useEffect(() => {
    setSlots(sortedSlots(schedule?.slots ?? []));
  }, [schedule]);

  async function saveDay() {
    if (!user || errors.length > 0) return;
    await saveDailySchedule(user.uid, { dateKey, templateId: schedule?.templateId, slots: sortedSlots(slots) });
  }

  async function applyTemplate(template: DayTemplate) {
    if (!user) return;
    if (slots.length > 0 && !window.confirm(`${friendlyDate(dateKey)} already has a plan. Replace it with "${template.name}"?`)) return;
    const nextSchedule = scheduleFromTemplate(template, dateKey);
    setSlots(nextSchedule.slots);
    await saveDailySchedule(user.uid, nextSchedule);
  }

  /** An org-sourced copy (`sourceTemplateId: "org:<id>"`) with a newer version published in the catalog — "Update available" (plan §7.4). Publishing/editing never touches the copy on its own; this is the explicit opt-in. */
  function orgUpdateFor(template: DayTemplate): CatalogDayEntry | null {
    if (!template.sourceTemplateId?.startsWith("org:") || typeof template.sourceVersion !== "number") return null;
    const orgId = template.sourceTemplateId.slice(4);
    const match = catalog?.templates.find((item) => item.id === orgId && item.kind === "day") as CatalogDayEntry | undefined;
    if (!match || match.version <= template.sourceVersion) return null;
    return match;
  }

  async function updateFromOrg(template: DayTemplate, match: CatalogDayEntry) {
    if (!user) return;
    await updateDayTemplate(user.uid, template.id, {
      slots: materializeSlots(match.payload.slots).map((slot) => ({ ...slot, id: crypto.randomUUID(), status: "upcoming" })),
      sourceVersion: match.version
    });
  }

  async function createTemplateFromCurrent() {
    if (!user || !templateName.trim() || errors.length > 0) return;
    await createDayTemplate(user.uid, {
      name: templateName.trim(),
      description: templateDescription.trim() || undefined,
      isDefault: templates.length === 0,
      slots: sortedSlots(slots)
    });
    setTemplateName("");
    setTemplateDescription("");
  }

  return (
    <>
      <SectionHeader title="Day" eyebrow={friendlyDate(dateKey)}>
        <input className="input max-w-48" type="date" value={dateKey} onChange={(event) => setDateKey(event.target.value)} />
      </SectionHeader>
      <div className={timelineEditorEnabled ? "grid gap-6" : "grid gap-6 xl:grid-cols-[320px_1fr]"}>
        {!timelineEditorEnabled ? (
          <aside className="space-y-6">
            <section className="card p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">Templates</h2>
                <button className="btn-secondary py-1.5 text-xs" onClick={() => setGalleryOpen(true)}>Browse templates</button>
              </div>
              <div className="space-y-3">
                {templates.map((template) => (
                  <article key={template.id} className="rounded-md border border-ink-200 p-3 dark:border-ink-800">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium">{template.name}</h3>
                      {template.isDefault ? (
                        <span className="rounded-md bg-moss-600/10 px-1.5 py-0.5 text-[11px] font-medium text-moss-700 dark:text-moss-400">Default</span>
                      ) : null}
                    </div>
                    {template.description ? <p className="mt-1 text-sm text-ink-500">{template.description}</p> : null}
                    <p className="mt-2 text-xs text-ink-500">{template.slots.length} blocks</p>
                    {orgUpdateFor(template) ? (
                      <div className="mt-2 flex items-center gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-1.5 text-xs text-sky-800 dark:text-sky-200">
                        <span>Update available from your group</span>
                        <button className="btn-secondary py-1 text-[11px]" onClick={() => updateFromOrg(template, orgUpdateFor(template)!)}>
                          Update my copy
                        </button>
                      </div>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button className="btn-primary py-1.5 text-xs" onClick={() => applyTemplate(template)}>Apply</button>
                      {!template.isDefault ? (
                        <button
                          className="btn-secondary px-2 py-1.5"
                          onClick={() => user && setDefaultTemplate(user.uid, templates, template.id)}
                          aria-label="Set as workday template"
                          title="Set as workday template — used automatically by Start day"
                        >
                          <Star className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                      <button className="btn-secondary px-2 py-1.5" onClick={() => user && duplicateDayTemplate(user.uid, template)} aria-label="Duplicate template">
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      <button className="btn-secondary px-2 py-1.5" onClick={() => user && deleteDayTemplate(user.uid, template.id)} aria-label="Delete template">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </article>
                ))}
                {templates.length === 0 ? <p className="text-sm text-ink-500">Create a template from today or browse the built-in catalog.</p> : null}
              </div>
            </section>
            <section className="card p-5">
              <h2 className="mb-4 text-lg font-semibold">Save as template</h2>
              <div className="space-y-3">
                <input className="input" value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="Template name" />
                <textarea className="input min-h-20" value={templateDescription} onChange={(event) => setTemplateDescription(event.target.value)} placeholder="Optional description" />
                <button className="btn-primary w-full" onClick={createTemplateFromCurrent} disabled={slots.length === 0 || errors.length > 0}>
                  Save template
                </button>
              </div>
            </section>
          </aside>
        ) : null}
        <section className="card p-5">
          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">24-hour timeline</h2>
              <p className="mt-1 text-sm text-ink-500">Gaps are allowed as implicit free time. Overlaps are blocked.</p>
            </div>
            <div className="flex items-center gap-2">
              {!timelineEditorEnabled ? (
                <span className="inline-flex items-center gap-1">
                  <button className="btn-secondary" onClick={() => setSlots((items) => sortedSlots([...items, createSlot()]))}>
                    <Plus className="h-4 w-4" />
                    Add block
                  </button>
                  <InfoHint term="block" />
                </span>
              ) : null}
              {!timelineEditorEnabled ? (
                <button className="btn-primary" onClick={saveDay} disabled={errors.length > 0}>Save day</button>
              ) : null}
            </div>
          </div>
          {!timelineEditorEnabled && errors.length > 0 ? (
            <div className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              {errors.map((error) => <p key={error}>{error}</p>)}
            </div>
          ) : null}
          {timelineEditorEnabled ? (
            // `DayTimelineEditor` seeds its undo stack and autosave baseline from `schedule` (merged
            // with `wantedLockedSlots`) once, on mount — mounting it before the
            // `dailySchedules`/`courses`/`terms`/settings snapshots have all arrived would seed from
            // stale/incomplete data (an empty day, or one missing class/routine blocks) that no later
            // snapshot arrival can ever correct: the undo stack would start wrong, and the autosave
            // baseline would then read the real doc as a foreign, newer "another tab" change —
            // "Keep mine" on that banner would overwrite the real saved day with the wrong one.
            schedulesLoading || coursesLoading || termsLoading || !settingsLoaded ? (
              <p className="text-sm text-ink-500">Loading…</p>
            ) : (
              <DayTimelineEditor
                key={dateKey}
                uid={user!.uid}
                dateKey={dateKey}
                schedule={schedule ?? null}
                wantedLockedSlots={wantedLockedSlots}
                tasks={tasks}
                onSlotsChange={setSlots}
              />
            )
          ) : (
            <div className="space-y-3">
              {slots.map((slot, index) => (
                <SlotEditor
                  key={slot.id}
                  slot={slot}
                  index={index}
                  tasks={tasks}
                  onChange={(next) => setSlots((items) => items.map((item) => (item.id === slot.id ? next : item)))}
                  onDelete={() => setSlots((items) => items.filter((item) => item.id !== slot.id))}
                  onMove={(direction) => {
                    setSlots((items) => {
                      const copy = [...items];
                      const target = direction === "up" ? index - 1 : index + 1;
                      if (target < 0 || target >= copy.length) return items;
                      [copy[index], copy[target]] = [copy[target], copy[index]];
                      return copy;
                    });
                  }}
                />
              ))}
              {slots.length === 0 ? (
                <EmptyState
                  sentence="Your day, block by block."
                  primary={{ label: "Use a template", onClick: () => setGalleryOpen(true) }}
                  template={{ label: "Add a block", onClick: () => setSlots((items) => sortedSlots([...items, createSlot()])) }}
                />
              ) : null}
            </div>
          )}
          {templates.length > 0 ? (
            <div className="mt-6">
              <h3 className="mb-3 text-sm font-semibold">Update existing template from this day</h3>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <select id="template-update-select" className="input" defaultValue="">
                  <option value="" disabled>Select template</option>
                  {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                </select>
                <button
                  className="btn-secondary"
                  onClick={() => {
                    const select = document.getElementById("template-update-select") as HTMLSelectElement | null;
                    const template = templates.find((item) => item.id === select?.value);
                    if (user && template && errors.length === 0) updateDayTemplate(user.uid, template.id, { slots: sortedSlots(slots) });
                  }}
                >
                  Update template blocks
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </div>
      {galleryOpen ? (
        <TemplateGalleryDialog
          uid={user!.uid}
          dateKey={dateKey}
          userTemplates={templates}
          hasExistingPlan={slots.length > 0}
          onApplied={(nextSlots) => setSlots(nextSlots)}
          onClose={() => setGalleryOpen(false)}
        />
      ) : null}
    </>
  );
}

function SlotEditor({
  slot,
  index,
  tasks,
  onChange,
  onDelete,
  onMove
}: {
  slot: ScheduleSlot;
  index: number;
  tasks: Task[];
  onChange: (slot: ScheduleSlot) => void;
  onDelete: () => void;
  onMove: (direction: "up" | "down") => void;
}) {
  const selectedTaskIds = new Set(slot.assignedTaskIds ?? []);
  return (
    <article className="rounded-md border border-ink-200 p-4 dark:border-ink-800">
      <div className="grid gap-3 lg:grid-cols-[1fr_120px_120px]">
        <input className="input" value={slot.title} onChange={(event) => onChange({ ...slot, title: event.target.value })} />
        <input className="input" type="time" value={slot.startTime} onChange={(event) => onChange({ ...slot, startTime: event.target.value })} />
        <input className="input" type="time" value={slot.endTime} onChange={(event) => onChange({ ...slot, endTime: event.target.value })} />
      </div>
      <div className="mt-3">
        <MoreOptions>
          <select className="input" value={slot.type} onChange={(event) => onChange({ ...slot, type: event.target.value as ScheduleSlotType })}>
            {slotTypes.map((type) => <option key={type} value={type}>{slotTypeLabels[type]}</option>)}
          </select>
          <div className="grid gap-3 lg:grid-cols-[1fr_180px]">
            <textarea className="input min-h-20" value={slot.note ?? ""} onChange={(event) => onChange({ ...slot, note: event.target.value })} placeholder="Optional note" />
            <select className="input" value={slot.status} onChange={(event) => onChange({ ...slot, status: event.target.value as ScheduleSlot["status"] })}>
              <option value="upcoming">Upcoming</option>
              <option value="completed">Completed</option>
              <option value="skipped">Skipped</option>
            </select>
          </div>
          <div>
            <p className="label mb-2">Assigned tasks</p>
            <div className="grid max-h-44 gap-2 overflow-auto rounded-md bg-ink-50 p-3 dark:bg-ink-800 sm:grid-cols-2">
              {tasks.filter((task) => task.status !== "done").map((task) => (
                <label key={task.id} className="flex items-start gap-2 text-sm">
                  <input
                    className="mt-1"
                    type="checkbox"
                    checked={selectedTaskIds.has(task.id)}
                    onChange={(event) => {
                      const next = new Set(selectedTaskIds);
                      if (event.target.checked) next.add(task.id);
                      else next.delete(task.id);
                      onChange({ ...slot, assignedTaskIds: Array.from(next) });
                    }}
                  />
                  <span>{task.title}</span>
                </label>
              ))}
              {tasks.filter((task) => task.status !== "done").length === 0 ? <p className="text-sm text-ink-500">No open tasks to assign.</p> : null}
            </div>
          </div>
        </MoreOptions>
      </div>
      <div className="mt-3 flex flex-wrap justify-between gap-2">
        <div className="flex gap-2">
          <button className="btn-secondary py-1.5 text-xs" onClick={() => onMove("up")} disabled={index === 0}>Move up</button>
          <button className="btn-secondary py-1.5 text-xs" onClick={() => onMove("down")}>Move down</button>
        </div>
        <button className="btn-secondary py-1.5 text-xs text-red-600" onClick={onDelete}>Delete block</button>
      </div>
    </article>
  );
}
