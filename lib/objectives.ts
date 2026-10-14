import { taskBucketLabels } from "@/lib/options";
import { derivePaperStatus } from "@/lib/papers";
import { categoryForSlotType } from "@/lib/timeline";
import { sittingRemainingMinutes } from "@/lib/tracking";
import type { Category, Checkpoint, Course, Goal, Paper, PomodoroSession, ScheduleSlot, Task, TaskBucket } from "@/types";

/**
 * plan/16 §5.2 — what a block is FOR, and what a focus session started inside it should attribute
 * itself to.
 *
 * Deliberately a *derivation* rather than a fourth stored taxonomy. `TaskBucket`
 * (goal/assignment/backlog/revision), `Category`, and `ScheduleSlotType` already exist and already
 * overlap; adding an "objective" enum alongside them would mean a fifth axis to keep in sync and,
 * worse, would make "paper reading" a `TaskBucket` member that `bucketWeeklyTarget` would then need
 * a meaningless branch for. Paper reading is what it always was — `type: "reading"` plus a paper
 * reference — and this function is the one place that knows how to read all of it.
 */
export interface Objective {
  /** Short chip text: "Revision", "Assignment", "Paper reading", "Prep", "Spaced repetition". */
  label: string;
  /** Second line where there is one: the course name, the paper title, the checkpoint title. */
  detail?: string;
  /** Where the chip links, when the objective has a page of its own. */
  href?: string;
  /** Exactly `startFocus`'s context arguments (components/focus-session-provider.tsx), so a caller
   *  passes this straight through instead of re-deriving per objective kind. */
  attribution: { courseId?: string; bucket?: TaskBucket; taskId?: string; paperId?: string; passNo?: 1 | 2 | 3 };
}

type ObjectiveContext = {
  courses: Pick<Course, "id" | "name">[];
  /** The status fields are optional: given them, a sitting pinned to a paper that has since been
   *  shelved or dropped says so instead of offering to read it (plan/17 L2). */
  papers: (Pick<Paper, "id" | "title"> & Partial<Pick<Paper, "fileId" | "pass1" | "pass2" | "pass3" | "shelvedUntil" | "droppedAt" | "inbox">>)[];
  checkpoints: Pick<Checkpoint, "id" | "title">[];
  tasks: Pick<Task, "id" | "title" | "courseId" | "bucket">[];
  goals: Pick<Goal, "id" | "title" | "milestones">[];
};

function courseObjective(
  courseId: string,
  bucket: TaskBucket,
  ctx: Pick<ObjectiveContext, "courses">,
  extra: Objective["attribution"] = {}
): Objective {
  const course = ctx.courses.find((item) => item.id === courseId);
  return {
    label: taskBucketLabels[bucket],
    detail: course?.name,
    href: "/courses",
    attribution: { courseId, bucket, ...extra }
  };
}

/**
 * Resolution order, first match wins — the order matters and is the contract
 * scripts/verify-chunking.ts pins:
 *
 * 1. A class block. Checked before `courseId`/`bucket` because a class carries a `courseId` but is
 *    never a planned bucket (plan/14 §6.3) — resolving it as one would label a lecture "Revision".
 * 2. `objectiveRef`, the explicit case: a checkpoint, a paper, a goal milestone, the revision queue.
 * 3. `courseId` + `bucket`, already stored on every course-work block since plan/14 §6.1.
 * 4. The first assigned task, resolved to its own `courseId`/`bucket` — the case where a block was
 *    built from a task that knows its course but the block itself wasn't given one.
 * 5. A reading block with no reference at all: generic reading, still worth labeling.
 * 6. `null` — the block is only what its `type` says it is (a meal, a commute, a break).
 */
export function describeObjective(slot: ScheduleSlot, ctx: ObjectiveContext): Objective | null {
  if (slot.type === "class") {
    const course = slot.courseId ? ctx.courses.find((item) => item.id === slot.courseId) : undefined;
    return { label: "Class", detail: course?.name, href: "/courses", attribution: { courseId: slot.courseId } };
  }

  const ref = slot.objectiveRef;
  if (ref) {
    if (ref.kind === "checkpoint") {
      const checkpoint = ctx.checkpoints.find((item) => item.id === ref.id);
      return {
        label: "Prep",
        detail: checkpoint?.title,
        href: "/courses",
        attribution: { courseId: slot.courseId, bucket: slot.bucket }
      };
    }
    if (ref.kind === "paper") {
      const paper = ctx.papers.find((item) => item.id === ref.id);
      // plan/17 L2 — the paper was shelved or dropped after this sitting was planned: the time is
      // still reading time, so the sitting becomes an open one rather than a Start button for a paper
      // you've stopped.
      const stopped = paper && "pass1" in paper && ["shelved", "dropped", "read"].includes(derivePaperStatus(paper));
      if (stopped) {
        return { label: "Reading · pick at start", detail: `${paper.title} is ${derivePaperStatus(paper)}`, attribution: {} };
      }
      return {
        label: ref.passNo ? `Paper reading · Pass ${ref.passNo}` : "Paper reading",
        detail: paper?.title,
        // plan/17 F7 — the chip goes where you read: the reader when there's a PDF.
        href: paper?.fileId ? `/read/${ref.id}` : `/papers/${ref.id}`,
        attribution: { paperId: ref.id, passNo: ref.passNo }
      };
    }
    if (ref.kind === "goal") {
      const goal = ctx.goals.find((item) => item.id === ref.id);
      const milestone = ref.milestoneId ? goal?.milestones.find((item) => item.id === ref.milestoneId) : undefined;
      return {
        label: "Goal",
        detail: milestone ? `${goal?.title} · ${milestone.title}` : goal?.title,
        href: "/goals",
        attribution: { courseId: slot.courseId, bucket: slot.bucket }
      };
    }
    if (ref.kind === "readingHabit") {
      // plan/17 §5.1 — an open sitting: the time is planned, the paper is chosen when it starts.
      return { label: "Reading · pick at start", attribution: {} };
    }
    // revisionQueue — the spaced-repetition queue itself, which has no per-item reference: the block
    // is "work the queue", and which items come up is decided at review time, not planning time.
    return { label: "Spaced repetition", href: "/review", attribution: {} };
  }

  if (slot.courseId && slot.bucket) {
    return courseObjective(slot.courseId, slot.bucket, ctx, { taskId: slot.assignedTaskIds?.[0] });
  }

  const taskId = slot.assignedTaskIds?.[0];
  const task = taskId ? ctx.tasks.find((item) => item.id === taskId) : undefined;
  if (task?.courseId && task.bucket) {
    return courseObjective(task.courseId, task.bucket, ctx, { taskId: task.id });
  }
  if (task) {
    return { label: "Task", detail: task.title, href: "/tasks", attribution: { taskId: task.id } };
  }

  if (slot.type === "reading") {
    return { label: "Reading", attribution: {} };
  }

  return null;
}

/** plan/16 §5.2 — the chip a sitting shows: its objective plus its "3 of 7", whichever exist. */
export function objectiveChipText(slot: ScheduleSlot, objective: Objective | null): string | null {
  const parts: string[] = [];
  if (objective) parts.push(objective.detail ? `${objective.label} · ${objective.detail}` : objective.label);
  if (slot.chunk) parts.push(`${slot.chunk.index} of ${slot.chunk.total}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The one shape a focus session started *from a block* takes, for every surface that starts one —
 * the Now card's "Start focus", the focus timer's own Start, the floating widget's Play and its Next
 * card. Before this each built its own copy, and the floating widget's Play built none at all: it
 * toggled whatever the timer happened to hold (a stale break, or a settings-length session), so it
 * was never the same action as the "Start focus" button beside it.
 *
 * `minutes` is what is *left* of the sitting (plan/16 §5.5) — its planned minutes less real logged
 * coverage, from the caller's same-day sessions — and `undefined` once it is covered, which arms the
 * settings length. `startFocus` still clamps it to the sitting bounds; nothing here re-clamps.
 * A block with exactly one assigned task credits it; zero or several is ambiguous (plan/13 A7).
 */
export function sittingStartArgs(
  slot: ScheduleSlot,
  objective: Objective | null,
  sameDaySessions: Pick<PomodoroSession, "slotId" | "mode" | "minutes">[]
): SittingStartArgs {
  const assigned = slot.assignedTaskIds ?? [];
  const left = sittingRemainingMinutes(slot, sameDaySessions);
  return {
    label: slot.title,
    category: categoryForSlotType(slot.type),
    slotId: slot.id,
    taskId: assigned.length === 1 ? assigned[0] : undefined,
    courseId: slot.courseId,
    bucket: slot.bucket,
    paperId: objective?.attribution.paperId,
    passNo: objective?.attribution.passNo,
    minutes: left > 0 ? left : undefined
  };
}

/** Exactly `startFocus`'s parameter shape (components/focus-session-provider.tsx). */
export interface SittingStartArgs {
  label: string;
  category: Category;
  slotId?: string;
  taskId?: string;
  courseId?: string;
  bucket?: TaskBucket;
  paperId?: string;
  passNo?: 1 | 2 | 3;
  minutes?: number;
}
