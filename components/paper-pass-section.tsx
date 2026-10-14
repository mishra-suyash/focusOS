"use client";

import { clsx } from "clsx";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { useFocusSession } from "@/components/focus-session-provider";
import { AddToInboxButton } from "@/components/add-to-inbox-button";
import { InfoHint } from "@/components/info-hint";
import { MoreOptions } from "@/components/more-options";
import { ReadingGoalChips } from "@/components/reading-goal-chips";
import { useReadingSitting } from "@/components/reading-sitting";
import { callAiTask } from "@/lib/ai/client";
import type { PassAssistOutput } from "@/lib/ai/schemas";
import { extractPdfOutline } from "@/lib/pdf-outline";
import { createPaper, updatePaper } from "@/lib/firestore";
import { createPass3RecallRevisionItem } from "@/lib/paperrevision";
import { inboxPaper } from "@/lib/paper-capture";
import {
  canStartReading,
  cancelPassPatch,
  DEFAULT_SHELF_DAYS,
  derivePaperFields,
  nextPassEstimateMinutes,
  PASS_LABELS,
  passSessionMinutes,
  passSittingCount
} from "@/lib/papers";
import { addDaysToKey, todayKey } from "@/lib/dates";
import type {
  FileRef,
  Pass1Output,
  Pass1Verdict,
  Pass1VerdictReason,
  Pass2Figure,
  Pass2Outcome,
  Pass2Output,
  Pass3Output,
  Paper,
  PassState,
  PomodoroSession
} from "@/types";

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function newFigure(): Pass2Figure {
  return { ref: "", note: "" };
}

function passKey(passNo: 1 | 2 | 3): "pass1" | "pass2" | "pass3" {
  return passNo === 1 ? "pass1" : passNo === 2 ? "pass2" : "pass3";
}

function getPass(paper: Paper, passNo: 1 | 2 | 3): PassState | undefined {
  return passNo === 1 ? paper.pass1 : passNo === 2 ? paper.pass2 : paper.pass3;
}

/** The default date a "Shelve" exit offers — editable in the exit itself (plan/17 §13 Q5). */
function defaultShelfDate(): string {
  return addDaysToKey(todayKey(), DEFAULT_SHELF_DAYS);
}

/**
 * One pass of the three, in whatever state it's in.
 *
 * plan/17 §5.4/§5.5 — a pass is a series of focus sittings, and the focus timer is its only clock.
 * Starting a pass starts a sitting (the timer, the pass, and the reader together); the minutes shown
 * here are the sum of that pass's focus sessions, never wall-clock time since it started; and
 * finishing a pass writes the pass, not a second session for time the focus timer already logged
 * (the double count F6 found in Today's history).
 */
export function PaperPassSection({
  paper,
  passNo,
  file,
  sessions = [],
  library = [],
  compact = false
}: {
  paper: Paper;
  passNo: 1 | 2 | 3;
  file: FileRef | null;
  sessions?: PomodoroSession[];
  library?: Paper[];
  /** The reader's side panel: no AI assist box, tighter spacing. */
  compact?: boolean;
}) {
  const { user } = useAuth();
  const focus = useFocusSession();
  const { startSitting } = useReadingSitting();
  const pass = getPass(paper, passNo);
  const [message, setMessage] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);

  // Running or paused: a paused sitting is still this pass's, and finishing the pass must log it.
  const sittingHere = focus.focusInProgress && focus.paperId === paper.id;
  const loggedMinutes = pass?.startedAt ? passSessionMinutes(sessions, paper.id, passNo, pass.startedAt) : 0;
  const sittings = pass?.startedAt ? passSittingCount(sessions, paper.id, passNo, pass.startedAt) : 0;
  const estimate = nextPassEstimateMinutes(paper, library.length > 0 ? library : [paper]);

  async function begin() {
    setMessage("");
    const result = await startSitting({ paper, library, sessions, navigate: !compact });
    if (result === "busy") setMessage("Another focus session is in progress — finish it first.");
    if (result === "needsGoal") setMessage("Pick why you're reading this first.");
  }

  async function finishPass(output: Pass1Output | Pass2Output | Pass3Output, extra: { shelvedUntil?: string; backgroundToRead?: string[] } = {}) {
    if (!user || !pass?.startedAt) return;
    // A sitting still running on this pass belongs to it: end it now so its minutes are logged, and
    // count them in the cached total rather than leaving the pass short by exactly that sitting.
    let runningMinutes = 0;
    if (sittingHere && focus.passNo === passNo) {
      runningMinutes = Math.round(focus.elapsedSeconds / 60);
      focus.finishNow();
    }
    const nextPass: PassState = {
      status: "done",
      startedAt: pass.startedAt,
      completedAt: new Date().toISOString(),
      minutes: loggedMinutes + runningMinutes,
      output,
      ...(pass.lastPage ? { lastPage: pass.lastPage } : {})
    };
    const shelf = extra.shelvedUntil ? { shelvedUntil: extra.shelvedUntil, queuedAt: undefined } : {};
    const merged: Paper = { ...paper, [passKey(passNo)]: nextPass, ...shelf };
    await updatePaper(user.uid, paper.id, { [passKey(passNo)]: nextPass, ...shelf, ...derivePaperFields(merged) });
    // plan/17 §5.2 — "Return later, after background reading": the background goes to the inbox as
    // papers to triage, where the picker can offer them, not into Tasks as generic to-dos.
    for (const title of extra.backgroundToRead ?? []) {
      await createPaper(user.uid, inboxPaper({ title, source: { kind: "background", fromPaperId: paper.id } }));
    }
  }

  async function cancelPass() {
    if (!user) return;
    if (sittingHere) focus.finishNow();
    const patch = cancelPassPatch(paper, passNo);
    if (patch) await updatePaper(user.uid, paper.id, patch);
    setConfirmCancel(false);
  }

  if (!pass || pass.status === "not_started") {
    const blocked = passNo === 1 && !canStartReading(paper);
    return (
      <div className="rounded-md border border-dashed border-ink-300 p-4 text-center dark:border-ink-700">
        {blocked ? (
          <div className="space-y-2">
            <p className="text-sm text-ink-500">Why are you reading this? Pick one to start Skim — you can edit the wording later.</p>
            <div className="flex justify-center">
              <ReadingGoalChips
                paper={paper}
                onPicked={(goalKind, goal) => {
                  void startSitting({ paper: { ...paper, goal, goalKind }, library, sessions, navigate: !compact });
                }}
              />
            </div>
          </div>
        ) : (
          <button className="btn-primary" onClick={begin}>
            Start {PASS_LABELS[passNo]}
          </button>
        )}
        {!blocked ? <p className="mt-2 text-xs text-ink-500">Starts a focus sitting and opens the paper.</p> : null}
        {message ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{message}</p> : null}
      </div>
    );
  }

  if (pass.status === "in_progress") {
    const forms = (
      <>
        {passNo === 1 ? <Pass1Form paper={paper} compact={compact} onFinish={(output, shelvedUntil) => finishPass(output, { shelvedUntil })} /> : null}
        {passNo === 2 ? (
          <Pass2Form paper={paper} compact={compact} onFinish={(output, shelvedUntil, backgroundToRead) => finishPass(output, { shelvedUntil, backgroundToRead })} />
        ) : null}
        {passNo === 3 ? <Pass3Form paper={paper} file={file} onFinish={(output) => finishPass(output)} /> : null}
      </>
    );
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-ink-50 px-3 py-2 text-xs dark:bg-ink-800">
          <span className="font-medium tabular-nums">
            {loggedMinutes}m logged{sittings > 0 ? ` over ${sittings} sitting${sittings === 1 ? "" : "s"}` : ""}
          </span>
          <span className="text-ink-500">· about {estimate}m usual</span>
          {pass.lastPage ? <span className="text-ink-500">· got to p. {pass.lastPage}</span> : null}
          <span className="ml-auto flex items-center gap-2">
            {sittingHere ? (
              <span className="tabular-nums text-moss-700 dark:text-moss-400">
                Sitting running · {Math.floor(focus.secondsLeft / 60)}:{String(focus.secondsLeft % 60).padStart(2, "0")} left
              </span>
            ) : (
              <button className="btn-secondary px-2 py-1 text-xs" onClick={begin}>
                Start a sitting
              </button>
            )}
            {confirmCancel ? (
              <>
                <button className="btn-secondary px-2 py-1 text-xs text-red-600" onClick={cancelPass}>
                  Yes, cancel {PASS_LABELS[passNo]}
                </button>
                <button className="px-1 text-xs text-ink-500 underline" onClick={() => setConfirmCancel(false)}>
                  Keep it
                </button>
              </>
            ) : (
              <button className="px-1 text-xs text-ink-500 underline decoration-dotted" onClick={() => setConfirmCancel(true)} title="Started by mistake? Its sittings stay logged as reading time on this paper.">
                Cancel pass
              </button>
            )}
          </span>
        </div>
        {message ? <p className="text-xs text-amber-700 dark:text-amber-400">{message}</p> : null}
        {forms}
      </div>
    );
  }

  // done
  return <PassSummary passNo={passNo} pass={pass} paperId={paper.id} />;
}

function PassSummary({ passNo, pass, paperId }: { passNo: 1 | 2 | 3; pass: PassState; paperId: string }) {
  return (
    <div className="rounded-md bg-moss-600/5 p-4 text-sm">
      <p className="mb-2 font-medium">
        {PASS_LABELS[passNo]} done{typeof pass.minutes === "number" ? ` · ${pass.minutes}m` : ""}
      </p>
      {passNo === 1 ? <Pass1Summary output={pass.output as Pass1Output} /> : null}
      {passNo === 2 ? <Pass2Summary output={pass.output as Pass2Output} paperId={paperId} /> : null}
      {passNo === 3 ? <Pass3Summary output={pass.output as Pass3Output} /> : null}
    </div>
  );
}

function Pass1Summary({ output }: { output: Pass1Output }) {
  return (
    <div className="space-y-1 text-ink-600 dark:text-ink-300">
      <p>
        Verdict: <span className="font-medium">{VERDICT_LABELS[output.verdict]}</span>
        {output.verdict === "park" || output.verdict === "drop" ? ` (${output.verdictReason.replace(/-/g, " ")})` : ""}
      </p>
      {output.contributions.length > 0 ? <p>Contributions: {output.contributions.join("; ")}</p> : null}
      {output.clarityRating ? <p>Clarity: {output.clarityRating}/5</p> : null}
    </div>
  );
}

function Pass2Summary({ output, paperId }: { output: Pass2Output; paperId: string }) {
  return (
    <div className="space-y-1 text-ink-600 dark:text-ink-300">
      {output.summary ? <p className="italic">&ldquo;{output.summary}&rdquo;</p> : null}
      {output.unreadReferencesMarked.length > 0 ? (
        <div>
          <p className="text-xs">References to read:</p>
          <ul className="list-disc pl-4 text-xs">
            {output.unreadReferencesMarked.map((ref) => (
              <li key={ref}>
                {ref}
                <AddToInboxButton title={ref} fromPaperId={paperId} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p>Outcome: {PASS2_OUTCOMES.find((item) => item.value === output.outcome)?.label ?? output.outcome}</p>
    </div>
  );
}

function Pass3Summary({ output }: { output: Pass3Output }) {
  return (
    <div className="space-y-1 text-ink-600 dark:text-ink-300">
      {output.structureRecall ? <p>Structure recall self-grade: {output.structureRecall.selfGrade}/5</p> : null}
      {output.strongPoints.length > 0 ? <p>Strong points: {output.strongPoints.join("; ")}</p> : null}
    </div>
  );
}

const VERDICT_REASONS: Record<Pass1Verdict, Pass1VerdictReason[]> = {
  continue: ["proceeding"],
  done: ["proceeding"],
  park: ["insufficient-background", "outside-area-but-relevant-later"],
  drop: ["not-interested", "invalid-assumptions"]
};

/** Plan §5 vocabulary — verdicts as the reader says them. "Save for later" is now "Shelve", because
 *  it does exactly what Shelve does everywhere else (plan/17 §5.2). */
const VERDICT_LABELS: Record<Pass1Verdict, string> = {
  continue: "Keep reading",
  done: "Skim was enough",
  park: "Shelve",
  drop: "Not relevant"
};

const VERDICT_HINTS: Record<Pass1Verdict, string> = {
  continue: "Read is next",
  done: "Finished — got what I needed",
  park: "Come back on a date",
  drop: "Stop here"
};

/**
 * paper.passAssist has no deterministic fallback (plan §9.3 table) — a failed
 * call surfaces an inline note instead of a stub result, which is the button's
 * equivalent of "hidden" without needing a pre-flight health check on every load.
 */
function AiAssistBox({ onAssist }: { onAssist: (rawNotes: string) => Promise<void> }) {
  const [rawNotes, setRawNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    if (!rawNotes.trim()) return;
    setLoading(true);
    setError("");
    try {
      await onAssist(rawNotes.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI assist unavailable.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-md border border-dashed border-ink-300 p-3 dark:border-ink-700">
      <p className="mb-2 text-xs text-ink-500">Paste raw notes and let AI suggest the fields below — still yours to edit before saving.</p>
      <textarea className="input mb-2 min-h-14 text-xs" value={rawNotes} onChange={(e) => setRawNotes(e.target.value)} placeholder="Paste notes, an abstract, or a rough summary..." />
      <button type="button" className="btn-secondary py-1 text-xs" onClick={run} disabled={loading || !rawNotes.trim()}>
        <Sparkles className="h-3.5 w-3.5" />
        {loading ? "Assisting..." : "AI assist"}
      </button>
      {error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}

/**
 * Plan §9.5, revised by plan/17 §5.2 — the four ways a Skim can end, all visible as buttons and none
 * pre-selected, so the most consequential choice on the form is a choice. "Shelve" asks for its date
 * right there. Clarity is recorded only if you actually set it (it used to save a default 3/5 as data).
 */
function Pass1Form({ paper, compact, onFinish }: { paper: Paper; compact?: boolean; onFinish: (output: Pass1Output, shelvedUntil?: string) => void }) {
  const { user } = useAuth();
  const [steps, setSteps] = useState({ titleAbstractIntro: false, headings: false, conclusions: false, references: false });
  const [category, setCategory] = useState("");
  const [context, setContext] = useState("");
  const [correctness, setCorrectness] = useState("");
  const [takeaway, setTakeaway] = useState("");
  const [contributions, setContributions] = useState("");
  const [clarityRating, setClarityRating] = useState<number | undefined>(undefined);
  const [clarityNote, setClarityNote] = useState("");
  const [referencesAlreadyRead, setReferencesAlreadyRead] = useState("");
  const [verdict, setVerdict] = useState<Pass1Verdict | null>(null);
  const [verdictReason, setVerdictReason] = useState<Pass1VerdictReason>("proceeding");
  const [shelvedUntil, setShelvedUntil] = useState(defaultShelfDate());

  async function assist(rawNotes: string) {
    if (!user) return;
    const { output } = await callAiTask<PassAssistOutput>(user, "paper.passAssist", { passNo: 1, title: paper.title, rawNotes });
    if (output.category) setCategory(output.category);
    if (output.context) setContext(output.context);
    if (output.correctness) setCorrectness(output.correctness);
    if (output.contributions?.length) setContributions(output.contributions.join("\n"));
    if (output.clarityNote) setClarityNote(output.clarityNote);
  }

  const allStepsChecked = Object.values(steps).every(Boolean);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!verdict) return;
    onFinish(
      {
        steps,
        category: category || undefined,
        context: context || undefined,
        correctness: correctness || undefined,
        contributions: [takeaway.trim(), ...lines(contributions)].filter(Boolean),
        ...(clarityRating !== undefined ? { clarityRating } : {}),
        clarityNote: clarityNote || undefined,
        referencesAlreadyRead: lines(referencesAlreadyRead),
        verdict,
        verdictReason
      },
      verdict === "park" ? shelvedUntil : undefined
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <input className="input" value={takeaway} onChange={(e) => setTakeaway(e.target.value)} placeholder="One-line takeaway" />
      <div>
        <p className="label mb-1">How does this Skim end?</p>
        <div className={clsx("grid gap-2", compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4")}>
          {(["continue", "done", "park", "drop"] as const).map((option) => (
            <div key={option} className="relative">
              <button
                type="button"
                aria-pressed={verdict === option}
                className={clsx("btn-secondary w-full flex-col py-1.5 text-xs", verdict === option && "ring-2 ring-moss-500")}
                onClick={() => {
                  setVerdict(option);
                  setVerdictReason(VERDICT_REASONS[option][0]);
                }}
              >
                <span className="font-medium">{VERDICT_LABELS[option]}</span>
                <span className="text-[10px] font-normal text-ink-500">{VERDICT_HINTS[option]}</span>
              </button>
              {option === "park" ? (
                <span className="absolute -right-1.5 -top-1.5 rounded-full bg-white dark:bg-ink-900">
                  <InfoHint term="saveForLater" />
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      {verdict === "park" ? (
        <label className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
          Back on
          <input className="input w-40 py-1 text-xs" type="date" value={shelvedUntil} min={todayKey()} onChange={(e) => setShelvedUntil(e.target.value)} required />
        </label>
      ) : null}
      {verdict === "park" || verdict === "drop" ? (
        <select className="input" value={verdictReason} onChange={(e) => setVerdictReason(e.target.value as Pass1VerdictReason)} aria-label="Reason">
          {VERDICT_REASONS[verdict].map((reason) => (
            <option key={reason} value={reason}>
              {reason.replace(/-/g, " ")}
            </option>
          ))}
        </select>
      ) : null}
      <MoreOptions>
        {!compact ? <AiAssistBox onAssist={assist} /> : null}
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {(
            [
              ["titleAbstractIntro", "Title, abstract, intro"],
              ["headings", "Section headings"],
              ["conclusions", "Conclusions"],
              ["references", "Skim references"]
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2">
              <input type="checkbox" checked={steps[key]} onChange={(e) => setSteps((current) => ({ ...current, [key]: e.target.checked }))} />
              {label}
            </label>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <input className="input" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Category (measurement, prototype...)" />
          <input className="input" value={context} onChange={(e) => setContext(e.target.value)} placeholder="Context / related theory" />
          <input className="input" value={correctness} onChange={(e) => setCorrectness(e.target.value)} placeholder="Do assumptions look valid?" />
        </div>
        <textarea className="input min-h-16" value={contributions} onChange={(e) => setContributions(e.target.value)} placeholder="Additional contributions, one per line" />
        <textarea
          className="input min-h-16"
          value={referencesAlreadyRead}
          onChange={(e) => setReferencesAlreadyRead(e.target.value)}
          placeholder="References you've already read, one per line (feeds Literature survey)"
        />
        <label className="block text-xs text-ink-500">
          Clarity: {clarityRating !== undefined ? `${clarityRating}/5` : "not rated"}
          <input className="mt-1 w-full accent-moss-600" type="range" min={1} max={5} value={clarityRating ?? 3} onChange={(e) => setClarityRating(Number(e.target.value))} />
        </label>
        <input className="input" value={clarityNote} onChange={(e) => setClarityNote(e.target.value)} placeholder="Clarity note (optional)" />
        {!allStepsChecked ? <p className="text-xs text-amber-700 dark:text-amber-400">Tip: an unticked step is the honest signal the pass wasn&apos;t actually done.</p> : null}
      </MoreOptions>
      <button className="btn-primary" disabled={!verdict}>
        {verdict ? `Finish Skim · ${VERDICT_LABELS[verdict]}` : "Choose how this Skim ends"}
      </button>
    </form>
  );
}

/** plan/17 §5.2/F4 — Read's four endings, as buttons. The outcome used to be a select hidden under
 *  "More options" that defaulted to "Grasped it", so typing a summary and saving finished the paper. */
const PASS2_OUTCOMES: { value: Pass2Outcome; label: string; hint: string }[] = [
  { value: "grasped", label: "Grasped it", hint: "Finished · Deep dive optional" },
  { value: "persevere", label: "Persevere", hint: "Deep dive is next" },
  { value: "set-aside", label: "Set aside", hint: "Shelve until a date" },
  { value: "return-later", label: "Return later", hint: "After background reading" }
];

function Pass2Form({
  paper,
  compact,
  onFinish
}: {
  paper: Paper;
  compact?: boolean;
  onFinish: (output: Pass2Output, shelvedUntil?: string, backgroundToRead?: string[]) => void;
}) {
  const { user } = useAuth();
  const [keyPoints, setKeyPoints] = useState("");
  const [figures, setFigures] = useState<Pass2Figure[]>([]);
  const [unreadReferencesMarked, setUnreadReferencesMarked] = useState("");
  const [summary, setSummary] = useState("");
  const [unclear, setUnclear] = useState("");
  const [outcome, setOutcome] = useState<Pass2Outcome | null>(null);
  const [backgroundToRead, setBackgroundToRead] = useState("");
  const [revisitOn, setRevisitOn] = useState(defaultShelfDate());

  async function assist(rawNotes: string) {
    if (!user) return;
    const { output } = await callAiTask<PassAssistOutput>(user, "paper.passAssist", { passNo: 2, title: paper.title, rawNotes });
    if (output.keyPoints?.length) setKeyPoints(output.keyPoints.join("\n"));
    if (output.summary) setSummary(output.summary);
    if (output.unclear?.length) setUnclear(output.unclear.join("\n"));
  }

  const summaryWords = summary.trim().split(/\s+/).filter(Boolean).length;
  const stops = outcome === "set-aside" || outcome === "return-later";
  // The summary is the exit test for having grasped the paper. Stopping because you *haven't* is a
  // legitimate ending that shouldn't demand one.
  const summaryRequired = outcome === "grasped" || outcome === "persevere";

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!outcome || (summaryRequired && !summary.trim())) return;
    const output: Pass2Output = {
      keyPoints: lines(keyPoints),
      figures: figures.filter((figure) => figure.ref.trim()),
      unreadReferencesMarked: lines(unreadReferencesMarked),
      summary: summary.trim(),
      unclear: lines(unclear),
      outcome,
      returnAfter: outcome === "return-later" ? { backgroundToRead: lines(backgroundToRead), revisitOn } : undefined
    };
    onFinish(output, stops ? revisitOn : undefined, outcome === "return-later" ? lines(backgroundToRead) : undefined);
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {!compact ? <AiAssistBox onAssist={assist} /> : null}
      <div>
        <textarea
          className="input min-h-20"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Summary you could give to someone who never opened the PDF (~60 words)"
        />
        <p className={`mt-1 text-xs ${summaryWords > 70 ? "text-amber-700 dark:text-amber-400" : "text-ink-400"}`}>{summaryWords} words</p>
      </div>
      <div>
        <p className="label mb-1">How does this Read end?</p>
        <div className={clsx("grid gap-2", compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4")}>
          {PASS2_OUTCOMES.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={outcome === option.value}
              className={clsx("btn-secondary w-full flex-col py-1.5 text-xs", outcome === option.value && "ring-2 ring-moss-500")}
              onClick={() => setOutcome(option.value)}
            >
              <span className="font-medium">{option.label}</span>
              <span className="text-[10px] font-normal text-ink-500">{option.hint}</span>
            </button>
          ))}
        </div>
      </div>
      {stops ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
            Back on
            <input className="input w-40 py-1 text-xs" type="date" value={revisitOn} min={todayKey()} onChange={(e) => setRevisitOn(e.target.value)} required />
          </label>
          {outcome === "return-later" ? (
            <textarea
              className="input min-h-14"
              value={backgroundToRead}
              onChange={(e) => setBackgroundToRead(e.target.value)}
              placeholder="Background to read first, one per line — each goes to your inbox"
            />
          ) : null}
        </div>
      ) : null}
      <MoreOptions>
        <textarea className="input min-h-16" value={keyPoints} onChange={(e) => setKeyPoints(e.target.value)} placeholder="Key points, one per line" />
        <div className="space-y-2">
          <p className="label">Figures</p>
          {figures.map((figure, index) => (
            <div key={index} className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-2 text-xs">
              <input
                className="input"
                value={figure.ref}
                onChange={(e) => setFigures((items) => items.map((item, i) => (i === index ? { ...item, ref: e.target.value } : item)))}
                placeholder="Figure ref (e.g. Fig. 3)"
              />
              {(["axesLabelled", "errorBars", "significanceOk"] as const).map((key) => (
                <label key={key} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={Boolean(figure[key])}
                    onChange={(e) => setFigures((items) => items.map((item, i) => (i === index ? { ...item, [key]: e.target.checked } : item)))}
                  />
                  {key === "axesLabelled" ? "Axes" : key === "errorBars" ? "Error bars" : "Sig."}
                </label>
              ))}
              <button type="button" className="text-ink-400 hover:text-red-600" onClick={() => setFigures((items) => items.filter((_, i) => i !== index))}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button type="button" className="btn-secondary py-1 text-xs" onClick={() => setFigures((items) => [...items, newFigure()])}>
            <Plus className="h-3 w-3" />
            Add figure
          </button>
        </div>
        <textarea
          className="input min-h-14"
          value={unreadReferencesMarked}
          onChange={(e) => setUnreadReferencesMarked(e.target.value)}
          placeholder="Relevant unread references, one per line (feeds Literature survey and reading suggestions)"
        />
        <textarea className="input min-h-14" value={unclear} onChange={(e) => setUnclear(e.target.value)} placeholder="What's unclear, one per line" />
      </MoreOptions>
      <button className="btn-primary" disabled={!outcome || (summaryRequired && !summary.trim())}>
        {!outcome
          ? "Choose how this Read ends"
          : summaryRequired && !summary.trim()
            ? "Write the summary to finish"
            : `Finish Read · ${PASS2_OUTCOMES.find((item) => item.value === outcome)!.label}`}
      </button>
    </form>
  );
}

function Pass3Form({ paper, file, onFinish }: { paper: Paper; file: FileRef | null; onFinish: (output: Pass3Output) => void }) {
  const { user } = useAuth();
  const [stage, setStage] = useState<"recall" | "compare">("recall");
  const [recalled, setRecalled] = useState("");
  const [actual, setActual] = useState<string[]>([]);
  const [actualManual, setActualManual] = useState("");
  const [loadingOutline, setLoadingOutline] = useState(false);
  const [selfGrade, setSelfGrade] = useState(3);

  const [assumptions, setAssumptions] = useState("");
  const [reImplementation, setReImplementation] = useState("");
  const [wouldPresentDifferently, setWouldPresentDifferently] = useState("");
  const [strongPoints, setStrongPoints] = useState("");
  const [weakPoints, setWeakPoints] = useState("");
  const [implicitAssumptions, setImplicitAssumptions] = useState("");
  const [missingCitations, setMissingCitations] = useState("");
  const [techniqueIssues, setTechniqueIssues] = useState("");
  const [futureWorkIdeas, setFutureWorkIdeas] = useState("");

  async function goToCompare() {
    if (file) {
      setLoadingOutline(true);
      try {
        const outline = await extractPdfOutline(file.url);
        setActual(outline);
      } catch {
        setActual([]);
      } finally {
        setLoadingOutline(false);
      }
    }
    setStage("compare");
  }

  async function finish() {
    if (!user) return;
    const finalActual = actual.length > 0 ? actual : lines(actualManual);
    const structureRecall = { recalled, actual: finalActual, selfGrade, at: new Date().toISOString() };
    const output: Pass3Output = {
      assumptionsChallenged: lines(assumptions).map((line) => {
        const [statement, challenge] = line.split("|").map((part) => part.trim());
        return { statement: statement ?? line, challenge: challenge ?? "" };
      }),
      reImplementation: reImplementation || undefined,
      wouldPresentDifferently: wouldPresentDifferently || undefined,
      strongPoints: lines(strongPoints),
      weakPoints: lines(weakPoints),
      implicitAssumptions: lines(implicitAssumptions),
      missingCitations: lines(missingCitations),
      techniqueIssues: lines(techniqueIssues),
      futureWorkIdeas: lines(futureWorkIdeas),
      structureRecall
    };
    onFinish(output);
    await createPass3RecallRevisionItem(user.uid, paper, selfGrade);
  }

  if (stage === "recall") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-ink-500">Close the PDF. Reproduce the section structure and main argument from memory.</p>
        <textarea className="input min-h-32" value={recalled} onChange={(e) => setRecalled(e.target.value)} placeholder="What you remember of the structure and argument..." />
        <button className="btn-primary" onClick={goToCompare} disabled={loadingOutline}>
          {loadingOutline ? "Loading outline..." : "Compare against the actual structure"}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md bg-ink-50 p-3 text-sm dark:bg-ink-800">
          <p className="label mb-1">What you recalled</p>
          <p className="whitespace-pre-wrap">{recalled}</p>
        </div>
        <div className="rounded-md bg-ink-50 p-3 text-sm dark:bg-ink-800">
          <p className="label mb-1">Actual structure</p>
          {actual.length > 0 ? (
            <ul className="list-inside list-disc">
              {actual.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          ) : (
            <textarea
              className="input min-h-20"
              value={actualManual}
              onChange={(e) => setActualManual(e.target.value)}
              placeholder={file ? "No outline found in the PDF — type the actual structure to compare against." : "No PDF attached — type the actual structure to compare against."}
            />
          )}
        </div>
      </div>
      <label className="block text-xs text-ink-500">
        Self-grade: {selfGrade}/5
        <input className="mt-1 w-full accent-moss-600" type="range" min={1} max={5} value={selfGrade} onChange={(e) => setSelfGrade(Number(e.target.value))} />
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <textarea className="input min-h-16" value={assumptions} onChange={(e) => setAssumptions(e.target.value)} placeholder="Assumptions challenged: one per line, statement | challenge" />
        <textarea className="input min-h-16" value={reImplementation} onChange={(e) => setReImplementation(e.target.value)} placeholder="How you'd rebuild it with the same assumptions" />
        <textarea className="input min-h-16" value={strongPoints} onChange={(e) => setStrongPoints(e.target.value)} placeholder="Strong points, one per line" />
        <textarea className="input min-h-16" value={weakPoints} onChange={(e) => setWeakPoints(e.target.value)} placeholder="Weak points, one per line" />
        <textarea className="input min-h-16" value={implicitAssumptions} onChange={(e) => setImplicitAssumptions(e.target.value)} placeholder="Implicit assumptions, one per line" />
        <textarea className="input min-h-16" value={missingCitations} onChange={(e) => setMissingCitations(e.target.value)} placeholder="Missing citations, one per line" />
        <textarea className="input min-h-16" value={techniqueIssues} onChange={(e) => setTechniqueIssues(e.target.value)} placeholder="Technique issues, one per line" />
        <textarea className="input min-h-16" value={futureWorkIdeas} onChange={(e) => setFutureWorkIdeas(e.target.value)} placeholder="Future work ideas, one per line" />
      </div>
      <input className="input" value={wouldPresentDifferently} onChange={(e) => setWouldPresentDifferently(e.target.value)} placeholder="What you'd present differently" />
      <button className="btn-primary" onClick={finish}>
        Save &amp; finish Deep dive
      </button>
    </div>
  );
}
