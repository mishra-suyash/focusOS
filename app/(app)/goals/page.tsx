"use client";

import { orderBy } from "firebase/firestore";
import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState, focusSection } from "@/components/empty-state";
import { ModuleGate } from "@/components/module-gate";
import { MoreOptions } from "@/components/more-options";
import { SectionHeader } from "@/components/section-header";
import { useAuth } from "@/components/auth-provider";
import { useUserCollection } from "@/hooks/use-user-collection";
import { addDaysToKey, todayKey } from "@/lib/dates";
import { createGoal, deleteGoal, updateGoal } from "@/lib/firestore";
import { isGoalActiveForDate } from "@/lib/goals";
import { BUILTIN_GOAL_TEMPLATES } from "@/lib/templates/builtin/goal-templates";
import type { Course, Goal, GoalHorizon, GoalMilestone, NewGoal, ReviewCadence, Term } from "@/types";

const HORIZONS: GoalHorizon[] = ["week", "term", "break", "year", "phd"];
const CADENCES: ReviewCadence[] = ["weekly", "monthly"];

function GoalsPageContent() {
  const { user } = useAuth();
  const today = todayKey();
  const { items: goals } = useUserCollection<Goal>("goals", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: terms } = useUserCollection<Term>("terms", useMemo(() => [orderBy("startDate", "desc")], []));
  const { items: courses } = useUserCollection<Course>("courses", useMemo(() => [orderBy("createdAt", "desc")], []));

  if (!user) return null;

  return (
    <>
      <SectionHeader title="Goals" eyebrow="The long-horizon layer that survives term boundaries" />
      <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
        <section id="goal-new" className="card p-5">
          <h2 className="mb-4 text-lg font-semibold">New goal</h2>
          <div id="goal-template-picker">
            <GoalTemplatePicker onCreate={(goal) => createGoal(user.uid, goal)} />
          </div>
          <div id="goal-form">
            <GoalForm terms={terms} onCreate={(goal) => createGoal(user.uid, goal)} />
          </div>
        </section>
        <section className="space-y-4">
          {goals.length === 0 ? (
            <EmptyState
              sentence="Long-term aims like a chapter, an exam, or a submission."
              primary={{ label: "New goal", onClick: () => focusSection("goal-form") }}
              template={{ label: "Start from a template", onClick: () => focusSection("goal-template-picker") }}
            />
          ) : (
            goals.map((goal) => (
              <GoalCard
                key={goal.id}
                goal={goal}
                terms={terms}
                courses={courses}
                today={today}
                onUpdate={(patch) => updateGoal(user.uid, goal.id, patch)}
                onDelete={() => deleteGoal(user.uid, goal.id)}
              />
            ))
          )}
        </section>
      </div>
    </>
  );
}

/** "Start from a template" (plan §6.3) — prefills definitionOfDone/horizon/milestones from a built-in goal template, milestone due dates offset from a chosen anchor date. */
function GoalTemplatePicker({ onCreate }: { onCreate: (goal: NewGoal) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState(BUILTIN_GOAL_TEMPLATES[0].id);
  const [anchorDate, setAnchorDate] = useState(todayKey());
  const [saving, setSaving] = useState(false);
  const template = BUILTIN_GOAL_TEMPLATES.find((item) => item.id === templateId)!;

  async function apply() {
    setSaving(true);
    try {
      await onCreate({
        title: template.title,
        horizon: template.horizon,
        why: template.why,
        definitionOfDone: template.definitionOfDone,
        milestones: template.milestones.map((milestone) => ({
          id: crypto.randomUUID(),
          title: milestone.title,
          dueAt: typeof milestone.dueOffsetDays === "number" ? addDaysToKey(anchorDate, milestone.dueOffsetDays) : undefined,
          done: false
        })),
        linked: { courseIds: [], paperIds: [], taskIds: [], goalIds: [] },
        targetHoursPerWeek: template.targetHoursPerWeek,
        status: "active",
        reviewCadence: "weekly"
      });
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button className="btn-secondary mb-4 w-full py-1.5 text-xs" onClick={() => setOpen(true)}>
        Start from a template
      </button>
    );
  }

  return (
    <div className="mb-4 space-y-2 rounded-md border border-ink-200 p-3 dark:border-ink-800">
      <select className="input" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
        {BUILTIN_GOAL_TEMPLATES.map((item) => (
          <option key={item.id} value={item.id}>{item.name}</option>
        ))}
      </select>
      <p className="text-xs text-ink-500">{template.definitionOfDone}</p>
      <label className="block text-xs text-ink-500">
        Anchor date (milestones are offset from this)
        <input className="input mt-1" type="date" value={anchorDate} onChange={(event) => setAnchorDate(event.target.value)} />
      </label>
      <div className="flex gap-2">
        <button className="btn-primary flex-1 py-1.5 text-xs" onClick={apply} disabled={saving}>{saving ? "Adding..." : "Add goal"}</button>
        <button className="btn-secondary py-1.5 text-xs" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

function GoalForm({ terms, onCreate }: { terms: Term[]; onCreate: (goal: NewGoal) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [horizon, setHorizon] = useState<GoalHorizon>("term");
  const [termId, setTermId] = useState("");
  const [why, setWhy] = useState("");
  const [definitionOfDone, setDefinitionOfDone] = useState("");
  const [targetHoursPerWeek, setTargetHoursPerWeek] = useState("");
  const [reviewCadence, setReviewCadence] = useState<ReviewCadence>("weekly");
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !definitionOfDone.trim()) return;
    setSaving(true);
    try {
      await onCreate({
        title: title.trim(),
        horizon,
        termId: horizon === "break" ? termId || undefined : undefined,
        why: why.trim() || undefined,
        definitionOfDone: definitionOfDone.trim(),
        milestones: [],
        linked: { courseIds: [], paperIds: [], taskIds: [], goalIds: [] },
        targetHoursPerWeek: targetHoursPerWeek ? Number(targetHoursPerWeek) : undefined,
        status: "active",
        reviewCadence
      });
      setTitle("");
      setWhy("");
      setDefinitionOfDone("");
      setTargetHoursPerWeek("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <input className="input" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea
        className="input min-h-16"
        placeholder="Definition of done"
        value={definitionOfDone}
        onChange={(e) => setDefinitionOfDone(e.target.value)}
      />
      <MoreOptions>
        <select className="input" value={horizon} onChange={(e) => setHorizon(e.target.value as GoalHorizon)}>
          {HORIZONS.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        {horizon === "break" ? (
          <select className="input" value={termId} onChange={(e) => setTermId(e.target.value)}>
            <option value="">Select a break term...</option>
            {terms.filter((t) => t.kind === "break").map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        ) : null}
        <textarea className="input min-h-14" placeholder="Why (optional)" value={why} onChange={(e) => setWhy(e.target.value)} />
        <input
          className="input"
          type="number"
          min={0}
          placeholder="Target hours/week (optional — feeds Workload)"
          value={targetHoursPerWeek}
          onChange={(e) => setTargetHoursPerWeek(e.target.value)}
        />
        <select className="input" value={reviewCadence} onChange={(e) => setReviewCadence(e.target.value as ReviewCadence)}>
          {CADENCES.map((c) => (
            <option key={c} value={c}>
              {c} review
            </option>
          ))}
        </select>
      </MoreOptions>
      <button className="btn-primary w-full" disabled={saving || !title.trim() || !definitionOfDone.trim()}>
        <Plus className="h-4 w-4" />
        Add goal
      </button>
    </form>
  );
}

function GoalCard({
  goal,
  terms,
  courses,
  today,
  onUpdate,
  onDelete
}: {
  goal: Goal;
  terms: Term[];
  courses: Course[];
  today: string;
  onUpdate: (patch: Partial<Goal>) => Promise<void>;
  onDelete: () => void;
}) {
  const [milestoneTitle, setMilestoneTitle] = useState("");
  const [milestoneDue, setMilestoneDue] = useState("");
  const active = isGoalActiveForDate(goal, terms, today);
  const term = terms.find((t) => t.id === goal.termId);

  function toggleMilestone(milestone: GoalMilestone) {
    const milestones = goal.milestones.map((m) => (m.id === milestone.id ? { ...m, done: !m.done } : m));
    onUpdate({ milestones });
  }

  function deleteMilestone(id: string) {
    onUpdate({ milestones: goal.milestones.filter((m) => m.id !== id) });
  }

  function addMilestone() {
    if (!milestoneTitle.trim()) return;
    const milestone: GoalMilestone = { id: crypto.randomUUID(), title: milestoneTitle.trim(), dueAt: milestoneDue || undefined, done: false };
    onUpdate({ milestones: [...goal.milestones, milestone] });
    setMilestoneTitle("");
    setMilestoneDue("");
  }

  function toggleCourseLink(courseId: string) {
    const has = goal.linked.courseIds.includes(courseId);
    onUpdate({ linked: { ...goal.linked, courseIds: has ? goal.linked.courseIds.filter((id) => id !== courseId) : [...goal.linked.courseIds, courseId] } });
  }

  return (
    <div id={`goal-${goal.id}`} className="card space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">{goal.title}</p>
          <p className="text-xs text-ink-500">
            {goal.horizon}
            {term ? ` · ${term.name}` : ""} · {goal.reviewCadence} review
            {!active ? " · not counting toward Workload today" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select className="input py-1 text-xs" value={goal.status} onChange={(e) => onUpdate({ status: e.target.value as Goal["status"] })}>
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="achieved">achieved</option>
            <option value="dropped">dropped</option>
          </select>
          <button className="text-red-600 hover:underline dark:text-red-400" onClick={onDelete} aria-label="Delete goal">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <p className="text-sm text-ink-600 dark:text-ink-300">{goal.definitionOfDone}</p>
      {goal.why ? <p className="text-xs text-ink-500">Why: {goal.why}</p> : null}
      {goal.targetHoursPerWeek ? <p className="text-xs text-ink-500">{goal.targetHoursPerWeek}h/week target</p> : null}

      <div>
        <p className="label mb-1">Milestones</p>
        <ul className="space-y-1">
          {goal.milestones.map((m) => (
            <li key={m.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={m.done} onChange={() => toggleMilestone(m)} />
              <span className={m.done ? "flex-1 text-ink-400 line-through" : "flex-1"}>{m.title}</span>
              {m.dueAt ? <span className="text-xs text-ink-500">{m.dueAt}</span> : null}
              <button className="text-red-600 hover:underline dark:text-red-400" onClick={() => deleteMilestone(m.id)} aria-label="Remove milestone">
                <Trash2 className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex gap-2">
          <input className="input py-1 text-xs" placeholder="New milestone" value={milestoneTitle} onChange={(e) => setMilestoneTitle(e.target.value)} />
          <input className="input py-1 text-xs" type="date" value={milestoneDue} onChange={(e) => setMilestoneDue(e.target.value)} />
          <button className="btn-secondary px-2 py-1 text-xs" onClick={addMilestone} disabled={!milestoneTitle.trim()}>
            Add
          </button>
        </div>
      </div>

      {courses.length > 0 ? (
        <div>
          <p className="label mb-1">Linked courses</p>
          <div className="flex flex-wrap gap-2">
            {courses.map((course) => (
              <label key={course.id} className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={goal.linked.courseIds.includes(course.id)} onChange={() => toggleCourseLink(course.id)} />
                {course.name}
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function GoalsPage() {
  return (
    <ModuleGate moduleId="goals">
      <GoalsPageContent />
    </ModuleGate>
  );
}
