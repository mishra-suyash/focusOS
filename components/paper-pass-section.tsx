"use client";

import { Plus, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { PassTimer, elapsedMinutesSince } from "@/components/pass-timer";
import { callAiTask } from "@/lib/ai/client";
import type { PassAssistOutput } from "@/lib/ai/schemas";
import { extractPdfOutline } from "@/lib/pdf-outline";
import { createTask, savePomodoro, updatePaper } from "@/lib/firestore";
import { createParkedPaperRevisionItem, createPass3RecallRevisionItem } from "@/lib/paperrevision";
import { canStartReading, derivePaperFields, PASS_SEED_MINUTES } from "@/lib/papers";
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
  PassState
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

export function PaperPassSection({ paper, passNo, file }: { paper: Paper; passNo: 1 | 2 | 3; file: FileRef | null }) {
  const { user } = useAuth();
  const pass = getPass(paper, passNo);
  const seedMinutes = PASS_SEED_MINUTES[passNo];

  async function startPass() {
    if (!user) return;
    if (passNo === 1 && !canStartReading(paper)) return;
    const nextPass: PassState = { status: "in_progress", startedAt: new Date().toISOString() };
    const merged: Paper = { ...paper, [passKey(passNo)]: nextPass };
    const patch: Record<string, unknown> = { [passKey(passNo)]: nextPass, ...derivePaperFields(merged) };
    await updatePaper(user.uid, paper.id, patch);
  }

  async function finishPass(output: Pass1Output | Pass2Output | Pass3Output, extra?: { backgroundTasks?: string[] }) {
    if (!user || !pass?.startedAt) return;
    const minutes = elapsedMinutesSince(pass.startedAt);
    const nextPass: PassState = { status: "done", startedAt: pass.startedAt, completedAt: new Date().toISOString(), minutes, output };
    const merged: Paper = { ...paper, [passKey(passNo)]: nextPass };
    const patch: Record<string, unknown> = { [passKey(passNo)]: nextPass, ...derivePaperFields(merged) };
    await updatePaper(user.uid, paper.id, patch);
    await savePomodoro(user.uid, {
      label: `Pass ${passNo}: ${paper.title}`,
      category: "reading",
      mode: "work",
      minutes,
      completedAt: new Date().toISOString(),
      cycle: passNo,
      paperId: paper.id,
      passNo
    });
    if (passNo === 1 && (output as Pass1Output).verdict === "park") {
      await createParkedPaperRevisionItem(user.uid, paper);
    }
    if (extra?.backgroundTasks) {
      for (const title of extra.backgroundTasks) {
        await createTask(user.uid, { title: `Background reading: ${title}`, status: "todo", priority: "medium", category: "reading" });
      }
    }
  }

  if (!pass || pass.status === "not_started") {
    const blocked = passNo === 1 && !canStartReading(paper);
    return (
      <div className="rounded-md border border-dashed border-ink-300 p-4 text-center dark:border-ink-700">
        {blocked ? (
          <p className="text-sm text-ink-500">Set a reading goal and goal type above before starting Pass 1.</p>
        ) : (
          <button className="btn-primary" onClick={startPass}>
            Start Pass {passNo}
          </button>
        )}
      </div>
    );
  }

  if (pass.status === "in_progress") {
    return (
      <div className="space-y-3">
        <PassTimer startedAt={pass.startedAt!} seedMinutes={seedMinutes} />
        {passNo === 1 ? <Pass1Form paper={paper} onFinish={(output) => finishPass(output)} /> : null}
        {passNo === 2 ? <Pass2Form paper={paper} onFinish={(output, backgroundTasks) => finishPass(output, { backgroundTasks })} /> : null}
        {passNo === 3 ? <Pass3Form paper={paper} file={file} onFinish={(output) => finishPass(output)} /> : null}
      </div>
    );
  }

  // done
  return <PassSummary passNo={passNo} pass={pass} />;
}

function PassSummary({ passNo, pass }: { passNo: 1 | 2 | 3; pass: PassState }) {
  return (
    <div className="rounded-md bg-moss-600/5 p-4 text-sm">
      <p className="mb-2 font-medium">
        Pass {passNo} done · {pass.minutes}m
      </p>
      {passNo === 1 ? <Pass1Summary output={pass.output as Pass1Output} /> : null}
      {passNo === 2 ? <Pass2Summary output={pass.output as Pass2Output} /> : null}
      {passNo === 3 ? <Pass3Summary output={pass.output as Pass3Output} /> : null}
    </div>
  );
}

function Pass1Summary({ output }: { output: Pass1Output }) {
  return (
    <div className="space-y-1 text-ink-600 dark:text-ink-300">
      <p>
        Verdict: <span className="font-medium">{output.verdict}</span> ({output.verdictReason})
      </p>
      {output.contributions.length > 0 ? <p>Contributions: {output.contributions.join("; ")}</p> : null}
      {output.clarityRating ? <p>Clarity: {output.clarityRating}/5</p> : null}
    </div>
  );
}

function Pass2Summary({ output }: { output: Pass2Output }) {
  return (
    <div className="space-y-1 text-ink-600 dark:text-ink-300">
      <p className="italic">&ldquo;{output.summary}&rdquo;</p>
      <p>Outcome: {output.outcome}</p>
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
  park: ["insufficient-background", "outside-area-but-relevant-later"],
  drop: ["not-interested", "invalid-assumptions"]
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

function Pass1Form({ paper, onFinish }: { paper: Paper; onFinish: (output: Pass1Output) => void }) {
  const { user } = useAuth();
  const [steps, setSteps] = useState({ titleAbstractIntro: false, headings: false, conclusions: false, references: false });
  const [category, setCategory] = useState("");
  const [context, setContext] = useState("");
  const [correctness, setCorrectness] = useState("");
  const [contributions, setContributions] = useState("");
  const [clarityRating, setClarityRating] = useState(3);
  const [clarityNote, setClarityNote] = useState("");
  const [referencesAlreadyRead, setReferencesAlreadyRead] = useState("");
  const [verdict, setVerdict] = useState<Pass1Verdict>("continue");
  const [verdictReason, setVerdictReason] = useState<Pass1VerdictReason>("proceeding");

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
    onFinish({
      steps,
      category: category || undefined,
      context: context || undefined,
      correctness: correctness || undefined,
      contributions: lines(contributions),
      clarityRating,
      clarityNote: clarityNote || undefined,
      referencesAlreadyRead: lines(referencesAlreadyRead),
      verdict,
      verdictReason
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <AiAssistBox onAssist={assist} />
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
      <textarea className="input min-h-16" value={contributions} onChange={(e) => setContributions(e.target.value)} placeholder="Contributions, one per line" />
      <textarea
        className="input min-h-16"
        value={referencesAlreadyRead}
        onChange={(e) => setReferencesAlreadyRead(e.target.value)}
        placeholder="References you've already read, one per line (feeds group survey mode)"
      />
      <label className="block text-xs text-ink-500">
        Clarity: {clarityRating}/5
        <input className="mt-1 w-full accent-moss-600" type="range" min={1} max={5} value={clarityRating} onChange={(e) => setClarityRating(Number(e.target.value))} />
      </label>
      <input className="input" value={clarityNote} onChange={(e) => setClarityNote(e.target.value)} placeholder="Clarity note (optional)" />
      <div className="grid gap-2 sm:grid-cols-2">
        <select
          className="input"
          value={verdict}
          onChange={(e) => {
            const next = e.target.value as Pass1Verdict;
            setVerdict(next);
            setVerdictReason(VERDICT_REASONS[next][0]);
          }}
        >
          <option value="continue">Continue to Pass 2</option>
          <option value="park">Park — may be relevant later</option>
          <option value="drop">Drop</option>
        </select>
        <select className="input" value={verdictReason} onChange={(e) => setVerdictReason(e.target.value as Pass1VerdictReason)}>
          {VERDICT_REASONS[verdict].map((reason) => (
            <option key={reason} value={reason}>
              {reason.replace(/-/g, " ")}
            </option>
          ))}
        </select>
      </div>
      {!allStepsChecked ? <p className="text-xs text-amber-700 dark:text-amber-400">Tip: an unticked step is the honest signal the pass wasn&apos;t actually done.</p> : null}
      <button className="btn-primary">Save &amp; finish Pass 1</button>
    </form>
  );
}

function Pass2Form({ paper, onFinish }: { paper: Paper; onFinish: (output: Pass2Output, backgroundTasks?: string[]) => void }) {
  const { user } = useAuth();
  const [keyPoints, setKeyPoints] = useState("");
  const [figures, setFigures] = useState<Pass2Figure[]>([]);
  const [unreadReferencesMarked, setUnreadReferencesMarked] = useState("");
  const [summary, setSummary] = useState("");
  const [unclear, setUnclear] = useState("");
  const [outcome, setOutcome] = useState<Pass2Outcome>("grasped");
  const [backgroundToRead, setBackgroundToRead] = useState("");
  const [revisitOn, setRevisitOn] = useState("");

  async function assist(rawNotes: string) {
    if (!user) return;
    const { output } = await callAiTask<PassAssistOutput>(user, "paper.passAssist", { passNo: 2, title: paper.title, rawNotes });
    if (output.keyPoints?.length) setKeyPoints(output.keyPoints.join("\n"));
    if (output.summary) setSummary(output.summary);
    if (output.unclear?.length) setUnclear(output.unclear.join("\n"));
  }

  const summaryWords = summary.trim().split(/\s+/).filter(Boolean).length;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!summary.trim()) return;
    const output: Pass2Output = {
      keyPoints: lines(keyPoints),
      figures: figures.filter((figure) => figure.ref.trim()),
      unreadReferencesMarked: lines(unreadReferencesMarked),
      summary: summary.trim(),
      unclear: lines(unclear),
      outcome,
      returnAfter: outcome === "return-later" ? { backgroundToRead: lines(backgroundToRead), revisitOn } : undefined
    };
    onFinish(output, outcome === "return-later" ? lines(backgroundToRead) : undefined);
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <AiAssistBox onAssist={assist} />
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
        placeholder="Relevant unread references, one per line (feeds group survey mode)"
      />
      <div>
        <textarea
          className="input min-h-20"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Summary you could give to someone who never opened the PDF (~60 words)"
          required
        />
        <p className={`mt-1 text-xs ${summaryWords > 70 ? "text-amber-700 dark:text-amber-400" : "text-ink-400"}`}>{summaryWords} words</p>
      </div>
      <textarea className="input min-h-14" value={unclear} onChange={(e) => setUnclear(e.target.value)} placeholder="What's unclear, one per line" />
      <select className="input" value={outcome} onChange={(e) => setOutcome(e.target.value as Pass2Outcome)}>
        <option value="grasped">Grasped it</option>
        <option value="set-aside">Set aside</option>
        <option value="return-later">Return later, after background reading</option>
        <option value="persevere">Persevere to Pass 3</option>
      </select>
      {outcome === "return-later" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <textarea className="input min-h-14" value={backgroundToRead} onChange={(e) => setBackgroundToRead(e.target.value)} placeholder="Background to read first, one per line" />
          <input className="input" type="date" value={revisitOn} onChange={(e) => setRevisitOn(e.target.value)} />
        </div>
      ) : null}
      <button className="btn-primary">Save &amp; finish Pass 2</button>
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
        Save &amp; finish Pass 3
      </button>
    </div>
  );
}
