"use client";

import { Sparkles } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { InfoHint } from "@/components/info-hint";
import { generateLayeredNotes } from "@/lib/ai/client";
import { updatePaper } from "@/lib/firestore";
import type { LayeredNotes } from "@/types";

function Field({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div>
      <p className="label">{label}</p>
      <p className="text-sm">{value}</p>
    </div>
  );
}

function ListField({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="label">{label}</p>
      <ul className="list-disc space-y-0.5 pl-4 text-sm">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function LayeredNotesCard({ paperId, layeredNotes }: { paperId: string; layeredNotes?: LayeredNotes }) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function generate() {
    if (!user) return;
    setBusy(true);
    setError("");
    try {
      const notes = await generateLayeredNotes(user, paperId);
      await updatePaper(user.uid, paperId, { layeredNotes: notes });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate the layered summary.");
    } finally {
      setBusy(false);
    }
  }

  async function copyPromptPack() {
    if (!layeredNotes) return;
    await navigator.clipboard.writeText(layeredNotes.promptPack);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="card space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="label flex items-center gap-1">
            Layered summary
            <InfoHint term="layeredSummary" />
          </p>
          {layeredNotes ? <p className="text-xs text-ink-500">v{layeredNotes.version} · {layeredNotes.provider}{layeredNotes.model ? ` (${layeredNotes.model})` : ""}</p> : null}
        </div>
        <button className="btn-secondary py-1.5 text-xs" onClick={generate} disabled={busy}>
          <Sparkles className="h-3.5 w-3.5" />
          {busy ? "Reading PDF..." : layeredNotes ? "Regenerate" : "Generate"}
        </button>
      </div>
      {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      {!layeredNotes ? (
        <p className="text-xs text-ink-500">
          Reads the attached PDF once (via Claude&apos;s Files API) and produces a structured L0-L3 summary you can re-use as
          context later instead of re-uploading the paper. No fallback — needs Claude configured.
        </p>
      ) : (
        <div className="space-y-3">
          <p className="rounded-md bg-moss-600/10 px-3 py-2 text-sm font-medium text-moss-800 dark:text-moss-300">{layeredNotes.L0}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Problem" value={layeredNotes.L1.problem} />
            <Field label="Contribution" value={layeredNotes.L1.contribution} />
            <Field label="Result" value={layeredNotes.L1.result} />
            <Field label="Why it matters to me" value={layeredNotes.L1.whyItMattersToMe} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ListField label="Method" items={layeredNotes.L2.method} />
            <ListField label="Datasets" items={layeredNotes.L2.datasets} />
            <ListField label="Metrics" items={layeredNotes.L2.metrics} />
            <ListField label="Baselines" items={layeredNotes.L2.baselines} />
            <ListField label="Ablations" items={layeredNotes.L2.ablations} />
            <ListField label="Assumptions" items={layeredNotes.L2.assumptions} />
          </div>
          <Field label="Formulation" value={layeredNotes.L3.formulation} />
          <Field label="Hyperparameters" value={layeredNotes.L3.hyperparameters} />
          <ListField label="Failure modes" items={layeredNotes.L3.failureModes} />
          <ListField label="Reproduction checklist" items={layeredNotes.L3.reproductionChecklist} />
          <ListField label="Citations to read" items={layeredNotes.citationsToRead} />
          <ListField label="Open questions" items={layeredNotes.openQuestions} />
          <ListField label="Claims to verify" items={layeredNotes.claimsToVerify} />
          {layeredNotes.sourceRefs.length > 0 ? (
            <div>
              <p className="label">Source quotes</p>
              <ul className="space-y-1 text-xs text-ink-500">
                {layeredNotes.sourceRefs.map((ref, i) => (
                  <li key={i}>
                    [{ref.layer}, p.{ref.page}] &ldquo;{ref.quote}&rdquo;
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div>
            <div className="flex items-center justify-between">
              <p className="label">Prompt pack (future context, not the PDF)</p>
              <button className="text-xs text-moss-700 hover:underline dark:text-moss-400" onClick={copyPromptPack}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="rounded-md bg-ink-50 p-2 text-xs text-ink-600 dark:bg-ink-800 dark:text-ink-300">{layeredNotes.promptPack}</p>
          </div>
        </div>
      )}
    </section>
  );
}
