"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { adminFetch } from "@/lib/admin-client";
import { SectionHeader } from "@/components/section-header";
import { BUILTIN_DAY_TEMPLATES } from "@/lib/templates/builtin";
import { categories, priorities } from "@/lib/options";
import { slotTypeLabels, slotTypes, sortedSlots, validateSlots } from "@/lib/schedule";
import type {
  DayTemplatePayload,
  GoalPayload,
  OrgTemplate,
  ReadingGoalPayload,
  TaskPackPayload,
  TemplateKind,
  TemplatePayload,
  TimerPayload
} from "@/lib/templates/schema";
import type { Category, GoalHorizon, GoalKind, PackId, Priority, ScheduleSlotType } from "@/types";

const KIND_LABELS: Record<TemplateKind, string> = { day: "Day template", taskPack: "Task pack", goal: "Goal template", readingGoal: "Reading-goal preset", timer: "Timer preset" };
const PACK_IDS: PackId[] = ["coursework", "research", "writing", "everything", "core"];
const HORIZONS: GoalHorizon[] = ["week", "term", "break", "year", "phd"];
const GOAL_KINDS: GoalKind[] = ["survey", "method", "baseline", "related-work", "reproduce", "critique"];

function slugify(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || crypto.randomUUID();
}

interface EditingState {
  id?: string;
  kind: TemplateKind;
  name: string;
  description: string;
  payload: Record<string, unknown>;
}

function emptyPayload(kind: TemplateKind): Record<string, unknown> {
  if (kind === "day") return { slots: [] } satisfies Partial<DayTemplatePayload>;
  if (kind === "taskPack") return { anchorLabel: "Anchor date", tasks: [] } satisfies Partial<TaskPackPayload>;
  if (kind === "goal") return { title: "", horizon: "term", definitionOfDone: "", milestones: [] } satisfies Partial<GoalPayload>;
  if (kind === "readingGoal") return { goalKind: "survey", text: "" } satisfies Partial<ReadingGoalPayload>;
  return { workMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15 } satisfies Partial<TimerPayload>;
}

export default function AdminTemplatesPage() {
  const { user } = useAuth();
  const [templates, setTemplates] = useState<OrgTemplate[]>([]);
  const [packDefaults, setPackDefaults] = useState<Partial<Record<PackId, { workdayTemplateId?: string; breakDayTemplateId?: string }>>>({});
  const [hiddenBuiltInIds, setHiddenBuiltInIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [myDayTemplates, setMyDayTemplates] = useState<{ id: string; name: string }[] | null>(null);
  const [importSelection, setImportSelection] = useState("");

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const result = await adminFetch<{ templates: OrgTemplate[]; packDefaults: typeof packDefaults; hiddenBuiltInIds: string[] }>(user, "/api/admin/templates");
      setTemplates(result.templates);
      setPackDefaults(result.packDefaults ?? {});
      setHiddenBuiltInIds(result.hiddenBuiltInIds ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load templates.");
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  async function openImportPicker() {
    if (!user) return;
    if (myDayTemplates === null) {
      const result = await adminFetch<{ dayTemplates: { id: string; name: string }[] }>(user, "/api/admin/templates/my-day-templates");
      setMyDayTemplates(result.dayTemplates);
    } else {
      setMyDayTemplates(null); // toggle closed
    }
  }

  async function runImport() {
    if (!user || !importSelection) return;
    try {
      await adminFetch(user, "/api/admin/templates/import", { method: "POST", body: { dayTemplateId: importSelection } });
      setMyDayTemplates(null);
      setImportSelection("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    }
  }

  async function save() {
    if (!user || !editing?.name.trim()) return;
    const payload = { ...editing.payload, id: (editing.payload.id as string) ?? slugify(editing.name), version: (editing.payload.version as number) ?? 1 };
    try {
      if (editing.id) {
        await adminFetch(user, `/api/admin/templates/${editing.id}`, {
          method: "PATCH",
          body: { name: editing.name, description: editing.description || undefined, payload }
        });
      } else {
        await adminFetch(user, "/api/admin/templates", {
          method: "POST",
          body: { kind: editing.kind, name: editing.name, description: editing.description || undefined, payload }
        });
      }
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    }
  }

  async function publish(id: string) {
    if (!user) return;
    try {
      await adminFetch(user, `/api/admin/templates/${id}/publish`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publish failed.");
    }
  }

  async function archive(id: string) {
    if (!user || !confirm("Archive this template? It disappears from the catalog for new copies; existing user copies are unaffected.")) return;
    try {
      await adminFetch(user, `/api/admin/templates/${id}/archive`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Archive failed.");
    }
  }

  async function setPackDefault(packId: PackId, slot: "workdayTemplateId" | "breakDayTemplateId", templateId: string) {
    if (!user) return;
    try {
      await adminFetch(user, "/api/admin/templates/pack-defaults", { method: "POST", body: { packId, slot, templateId: templateId || null } });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set pack default.");
    }
  }

  async function toggleBuiltinHidden(builtinId: string, hidden: boolean) {
    if (!user) return;
    try {
      await adminFetch(user, "/api/admin/templates/hide-builtin", { method: "POST", body: { builtinId, hidden } });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update visibility.");
    }
  }

  const publishedDayTemplates = templates.filter((t) => t.kind === "day" && t.status === "published");

  return (
    <>
      <SectionHeader title="Templates" eyebrow="Admin panel — shared with every member (visibility, not security)">
        <div className="flex gap-2">
          <button className="btn-secondary py-1.5 text-xs" onClick={openImportPicker}>Import from my templates</button>
          <button className="btn-primary py-1.5 text-xs" onClick={() => setEditing({ kind: "day", name: "", description: "", payload: emptyPayload("day") })}>
            New template
          </button>
        </div>
      </SectionHeader>
      {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}
      <p className="mb-4 text-xs text-ink-500">
        The catalog document is readable by any signed-in member — never put anything sensitive in a template.
      </p>

      {myDayTemplates !== null ? (
        <div className="card mb-6 space-y-3 p-4">
          <h2 className="text-sm font-semibold">Import from my day templates</h2>
          {myDayTemplates.length === 0 ? (
            <p className="text-sm text-ink-500">You have no day templates of your own yet — build one in Plan first.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <select className="input" value={importSelection} onChange={(e) => setImportSelection(e.target.value)}>
                <option value="">Select a template...</option>
                {myDayTemplates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <button className="btn-primary py-1.5 text-xs" onClick={runImport} disabled={!importSelection}>Publish it</button>
            </div>
          )}
        </div>
      ) : null}

      <div className="mb-6 space-y-3">
        {templates.map((template) => (
          <div key={template.id} className="card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-medium">
                  {template.name}{" "}
                  <span className="ml-1 rounded bg-ink-100 px-1.5 py-0.5 text-xs text-ink-600 dark:bg-ink-800 dark:text-ink-300">{KIND_LABELS[template.kind]}</span>{" "}
                  <span
                    className={`ml-1 rounded px-1.5 py-0.5 text-xs ${
                      template.status === "published"
                        ? "bg-moss-600/10 text-moss-700 dark:text-moss-400"
                        : template.status === "archived"
                          ? "bg-ink-200 text-ink-600 dark:bg-ink-700 dark:text-ink-300"
                          : "bg-amberline/15 text-amber-700 dark:text-amber-300"
                    }`}
                  >
                    {template.status} · v{template.version}
                  </span>
                </p>
                {template.description ? <p className="mt-1 text-xs text-ink-500">{template.description}</p> : null}
                {template.packIds.length > 0 ? <p className="mt-1 text-xs text-ink-500">Recommended for: {template.packIds.join(", ")}</p> : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn-secondary px-2 py-1 text-xs"
                  onClick={() => setEditing({ id: template.id, kind: template.kind, name: template.name, description: template.description ?? "", payload: template.payload })}
                >
                  Edit
                </button>
                {template.status !== "archived" ? (
                  <button className="btn-secondary px-2 py-1 text-xs" onClick={() => publish(template.id)}>
                    {template.status === "published" ? "Re-publish" : "Publish"}
                  </button>
                ) : null}
                {template.status !== "archived" ? (
                  <button className="btn-secondary px-2 py-1 text-xs text-red-600" onClick={() => archive(template.id)}>
                    Archive
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ))}
        {templates.length === 0 ? <p className="text-sm text-ink-500">No templates yet.</p> : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">Pack defaults</h2>
          <p className="mb-3 text-xs text-ink-500">Overrides the built-in default for new onboardings only — existing users are unaffected.</p>
          <div className="space-y-3">
            {PACK_IDS.map((packId) => (
              <div key={packId} className="grid grid-cols-[80px_1fr_1fr] items-center gap-2 text-xs">
                <span className="font-medium capitalize">{packId}</span>
                <select
                  className="input py-1 text-xs"
                  value={packDefaults[packId]?.workdayTemplateId ?? ""}
                  onChange={(e) => setPackDefault(packId, "workdayTemplateId", e.target.value)}
                >
                  <option value="">Built-in default</option>
                  {publishedDayTemplates.map((t) => <option key={t.id} value={t.id}>{t.name} (workday)</option>)}
                </select>
                <select
                  className="input py-1 text-xs"
                  value={packDefaults[packId]?.breakDayTemplateId ?? ""}
                  onChange={(e) => setPackDefault(packId, "breakDayTemplateId", e.target.value)}
                >
                  <option value="">Built-in default</option>
                  {publishedDayTemplates.map((t) => <option key={t.id} value={t.id}>{t.name} (break)</option>)}
                </select>
              </div>
            ))}
          </div>
        </section>

        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">Hide built-in day templates</h2>
          <p className="mb-3 text-xs text-ink-500">Hidden built-ins disappear from every member&apos;s gallery — a hidden template already in use is unaffected.</p>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {BUILTIN_DAY_TEMPLATES.map((builtin) => (
              <label key={builtin.id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={hiddenBuiltInIds.includes(builtin.id)}
                  onChange={(e) => toggleBuiltinHidden(builtin.id, e.target.checked)}
                />
                {builtin.name}
              </label>
            ))}
          </div>
        </section>
      </div>

      {editing ? <TemplateEditorDialog editing={editing} onChange={setEditing} onCancel={() => setEditing(null)} onSave={save} /> : null}
    </>
  );
}

function TemplateEditorDialog({
  editing,
  onChange,
  onCancel,
  onSave
}: {
  editing: EditingState;
  onChange: (next: EditingState) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-10">
      <div className="w-full max-w-2xl space-y-3 rounded-lg bg-white p-5 dark:bg-ink-900">
        <h2 className="text-lg font-semibold">{editing.id ? "Edit template" : `New ${KIND_LABELS[editing.kind].toLowerCase()}`}</h2>
        {!editing.id ? (
          <select
            className="input"
            value={editing.kind}
            onChange={(e) => {
              const kind = e.target.value as TemplateKind;
              onChange({ ...editing, kind, payload: emptyPayload(kind) });
            }}
          >
            {(Object.keys(KIND_LABELS) as TemplateKind[]).map((kind) => (
              <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>
            ))}
          </select>
        ) : null}
        <input className="input" placeholder="Name" value={editing.name} onChange={(e) => onChange({ ...editing, name: e.target.value })} />
        <input className="input" placeholder="Description (optional)" value={editing.description} onChange={(e) => onChange({ ...editing, description: e.target.value })} />

        {editing.kind === "day" ? <DayPayloadEditor payload={editing.payload as unknown as DayTemplatePayload} onChange={(payload) => onChange({ ...editing, payload })} /> : null}
        {editing.kind === "taskPack" ? <TaskPackPayloadEditor payload={editing.payload as unknown as TaskPackPayload} onChange={(payload) => onChange({ ...editing, payload })} /> : null}
        {editing.kind === "goal" ? <GoalPayloadEditor payload={editing.payload as unknown as GoalPayload} onChange={(payload) => onChange({ ...editing, payload })} /> : null}
        {editing.kind === "readingGoal" ? <ReadingGoalPayloadEditor payload={editing.payload as unknown as ReadingGoalPayload} onChange={(payload) => onChange({ ...editing, payload })} /> : null}
        {editing.kind === "timer" ? <TimerPayloadEditor payload={editing.payload as unknown as TimerPayload} onChange={(payload) => onChange({ ...editing, payload })} /> : null}

        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn-primary" onClick={onSave} disabled={!editing.name.trim()}>Save draft</button>
        </div>
      </div>
    </div>
  );
}

function DayPayloadEditor({ payload, onChange }: { payload: Partial<DayTemplatePayload>; onChange: (payload: Record<string, unknown>) => void }) {
  const slots = payload.slots ?? [];
  const errors = validateSlots(sortedSlots(slots.map((slot, index) => ({ ...slot, id: String(index), status: "upcoming" as const }))));

  function updateSlot(index: number, patch: Partial<DayTemplatePayload["slots"][number]>) {
    onChange({ ...payload, slots: slots.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)) });
  }

  return (
    <div className="space-y-2 rounded-md border border-ink-200 p-3 dark:border-ink-800">
      <div className="flex items-center justify-between">
        <p className="label">Blocks</p>
        <button
          className="btn-secondary py-1 text-xs"
          onClick={() => onChange({ ...payload, slots: [...slots, { title: "New block", type: "deep_work" as ScheduleSlotType, startTime: "09:00", endTime: "10:00" }] })}
        >
          Add block
        </button>
      </div>
      {errors.length > 0 ? (
        <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {errors.map((err) => <p key={err}>{err}</p>)}
        </div>
      ) : null}
      <div className="space-y-2">
        {slots.map((slot, index) => (
          <div key={index} className="grid grid-cols-[1fr_120px_90px_90px_auto] items-center gap-2">
            <input className="input py-1 text-xs" value={slot.title} onChange={(e) => updateSlot(index, { title: e.target.value })} />
            <select className="input py-1 text-xs" value={slot.type} onChange={(e) => updateSlot(index, { type: e.target.value as ScheduleSlotType })}>
              {slotTypes.map((type) => <option key={type} value={type}>{slotTypeLabels[type]}</option>)}
            </select>
            <input className="input py-1 text-xs" type="time" value={slot.startTime} onChange={(e) => updateSlot(index, { startTime: e.target.value })} />
            <input className="input py-1 text-xs" type="time" value={slot.endTime} onChange={(e) => updateSlot(index, { endTime: e.target.value })} />
            <button className="text-red-600" onClick={() => onChange({ ...payload, slots: slots.filter((_, i) => i !== index) })}>Remove</button>
          </div>
        ))}
        {slots.length === 0 ? <p className="text-xs text-ink-500">No blocks yet.</p> : null}
      </div>
    </div>
  );
}

function TaskPackPayloadEditor({ payload, onChange }: { payload: Partial<TaskPackPayload>; onChange: (payload: Record<string, unknown>) => void }) {
  const tasks = payload.tasks ?? [];
  return (
    <div className="space-y-2 rounded-md border border-ink-200 p-3 dark:border-ink-800">
      <input className="input" placeholder="Anchor label (e.g. Submission deadline)" value={payload.anchorLabel ?? ""} onChange={(e) => onChange({ ...payload, anchorLabel: e.target.value })} />
      <div className="flex items-center justify-between">
        <p className="label">Tasks</p>
        <button
          className="btn-secondary py-1 text-xs"
          onClick={() => onChange({ ...payload, tasks: [...tasks, { title: "New task", category: "research" as Category, priority: "medium" as Priority, dueOffsetDays: 0 }] })}
        >
          Add task
        </button>
      </div>
      <div className="space-y-2">
        {tasks.map((task, index) => (
          <div key={index} className="grid grid-cols-[1fr_100px_90px_80px_auto] items-center gap-2">
            <input
              className="input py-1 text-xs"
              value={task.title}
              onChange={(e) => onChange({ ...payload, tasks: tasks.map((t, i) => (i === index ? { ...t, title: e.target.value } : t)) })}
            />
            <select
              className="input py-1 text-xs"
              value={task.category}
              onChange={(e) => onChange({ ...payload, tasks: tasks.map((t, i) => (i === index ? { ...t, category: e.target.value as Category } : t)) })}
            >
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select
              className="input py-1 text-xs"
              value={task.priority}
              onChange={(e) => onChange({ ...payload, tasks: tasks.map((t, i) => (i === index ? { ...t, priority: e.target.value as Priority } : t)) })}
            >
              {priorities.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <input
              className="input py-1 text-xs"
              type="number"
              title="Days offset from the anchor date"
              value={task.dueOffsetDays ?? 0}
              onChange={(e) => onChange({ ...payload, tasks: tasks.map((t, i) => (i === index ? { ...t, dueOffsetDays: Number(e.target.value) } : t)) })}
            />
            <button className="text-red-600" onClick={() => onChange({ ...payload, tasks: tasks.filter((_, i) => i !== index) })}>Remove</button>
          </div>
        ))}
        {tasks.length === 0 ? <p className="text-xs text-ink-500">No tasks yet.</p> : null}
      </div>
    </div>
  );
}

function GoalPayloadEditor({ payload, onChange }: { payload: Partial<GoalPayload>; onChange: (payload: Record<string, unknown>) => void }) {
  const milestones = payload.milestones ?? [];
  return (
    <div className="space-y-2 rounded-md border border-ink-200 p-3 dark:border-ink-800">
      <input className="input" placeholder="Goal title" value={payload.title ?? ""} onChange={(e) => onChange({ ...payload, title: e.target.value })} />
      <select className="input" value={payload.horizon ?? "term"} onChange={(e) => onChange({ ...payload, horizon: e.target.value as GoalHorizon })}>
        {HORIZONS.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
      <textarea className="input min-h-14" placeholder="Why (optional)" value={payload.why ?? ""} onChange={(e) => onChange({ ...payload, why: e.target.value })} />
      <textarea className="input min-h-14" placeholder="Definition of done" value={payload.definitionOfDone ?? ""} onChange={(e) => onChange({ ...payload, definitionOfDone: e.target.value })} />
      <input
        className="input"
        type="number"
        placeholder="Target hours/week (optional)"
        value={payload.targetHoursPerWeek ?? ""}
        onChange={(e) => onChange({ ...payload, targetHoursPerWeek: e.target.value ? Number(e.target.value) : undefined })}
      />
      <div className="flex items-center justify-between">
        <p className="label">Milestones</p>
        <button className="btn-secondary py-1 text-xs" onClick={() => onChange({ ...payload, milestones: [...milestones, { title: "New milestone", dueOffsetDays: 0 }] })}>
          Add milestone
        </button>
      </div>
      {milestones.map((milestone, index) => (
        <div key={index} className="grid grid-cols-[1fr_90px_auto] items-center gap-2">
          <input
            className="input py-1 text-xs"
            value={milestone.title}
            onChange={(e) => onChange({ ...payload, milestones: milestones.map((m, i) => (i === index ? { ...m, title: e.target.value } : m)) })}
          />
          <input
            className="input py-1 text-xs"
            type="number"
            title="Days offset from the anchor date"
            value={milestone.dueOffsetDays ?? 0}
            onChange={(e) => onChange({ ...payload, milestones: milestones.map((m, i) => (i === index ? { ...m, dueOffsetDays: Number(e.target.value) } : m)) })}
          />
          <button className="text-red-600" onClick={() => onChange({ ...payload, milestones: milestones.filter((_, i) => i !== index) })}>Remove</button>
        </div>
      ))}
    </div>
  );
}

function ReadingGoalPayloadEditor({ payload, onChange }: { payload: Partial<ReadingGoalPayload>; onChange: (payload: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-2 rounded-md border border-ink-200 p-3 dark:border-ink-800">
      <select className="input" value={payload.goalKind ?? "survey"} onChange={(e) => onChange({ ...payload, goalKind: e.target.value as GoalKind })}>
        {GOAL_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
      </select>
      <textarea className="input min-h-16" placeholder="Preset sentence" value={payload.text ?? ""} onChange={(e) => onChange({ ...payload, text: e.target.value })} />
    </div>
  );
}

function TimerPayloadEditor({ payload, onChange }: { payload: Partial<TimerPayload>; onChange: (payload: Record<string, unknown>) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2 rounded-md border border-ink-200 p-3 dark:border-ink-800">
      <label className="text-xs text-ink-500">
        Work
        <input className="input mt-1" type="number" value={payload.workMinutes ?? 25} onChange={(e) => onChange({ ...payload, workMinutes: Number(e.target.value) })} />
      </label>
      <label className="text-xs text-ink-500">
        Short break
        <input className="input mt-1" type="number" value={payload.shortBreakMinutes ?? 5} onChange={(e) => onChange({ ...payload, shortBreakMinutes: Number(e.target.value) })} />
      </label>
      <label className="text-xs text-ink-500">
        Long break
        <input className="input mt-1" type="number" value={payload.longBreakMinutes ?? 15} onChange={(e) => onChange({ ...payload, longBreakMinutes: Number(e.target.value) })} />
      </label>
    </div>
  );
}
