"use client";

import { orderBy } from "firebase/firestore";
import { Search, X } from "lucide-react";
import { createContext, useContext, useMemo, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { ReadingGoalChips } from "@/components/reading-goal-chips";
import { useReadingSitting } from "@/components/reading-sitting";
import { useUserCollection } from "@/hooks/use-user-collection";
import { useUserSettings } from "@/hooks/use-user-settings";
import { addDaysToKey, todayKey } from "@/lib/dates";
import { createPaper, updatePaper } from "@/lib/firestore";
import { inboxPaper, looksLikeLink } from "@/lib/paper-capture";
import { harvestedSuggestions } from "@/lib/papergroups";
import {
  canStartReading,
  DEFAULT_SHELF_DAYS,
  dropPatch,
  isActivePaper,
  nextReadingPass,
  PASS_LABELS,
  paperShelfDate,
  passSessionMinutes,
  queuePatch,
  readingPickerSections,
  shelvePatch
} from "@/lib/papers";
import type { Paper, PaperGroup, PomodoroSession, ScheduleSlot } from "@/types";

type PickerOptions = {
  /** The planned sitting being filled — its coverage and 60% rule get the session. */
  slotId?: string;
  /** What's left of that sitting. */
  minutes?: number;
  /** A paper to put first (a pinned sitting whose Skim needs a goal). */
  focusPaperId?: string;
};

type ReadingPickerValue = {
  openPicker: (opts?: PickerOptions) => void;
  /**
   * plan/17 §5.4 — start a planned reading block: a sitting pinned to a paper that's still being read
   * starts straight away (timer + pass + reader); an open sitting, or one whose paper has since been
   * shelved or dropped, opens the picker.
   */
  startReadingSlot: (slot: ScheduleSlot, ctx: { papers: Paper[]; sessions: PomodoroSession[]; minutes?: number }) => Promise<void>;
};

const ReadingPickerContext = createContext<ReadingPickerValue | null>(null);

export function ReadingPickerProvider({ children }: { children: React.ReactNode }) {
  const [options, setOptions] = useState<PickerOptions | null>(null);
  const { startSitting } = useReadingSitting();

  async function startReadingSlot(slot: ScheduleSlot, ctx: { papers: Paper[]; sessions: PomodoroSession[]; minutes?: number }) {
    const ref = slot.objectiveRef;
    const paper = ref?.kind === "paper" ? ctx.papers.find((item) => item.id === ref.id) : undefined;
    if (paper && isActivePaper(paper)) {
      const result = await startSitting({ paper, library: ctx.papers, sessions: ctx.sessions, slotId: slot.id, minutes: ctx.minutes });
      if (result === "needsGoal") setOptions({ slotId: slot.id, minutes: ctx.minutes, focusPaperId: paper.id });
      return;
    }
    setOptions({ slotId: slot.id, minutes: ctx.minutes });
  }

  return (
    <ReadingPickerContext.Provider value={{ openPicker: (opts = {}) => setOptions(opts), startReadingSlot }}>
      {children}
      {/* Mounted only while open, so its subscriptions don't run on every page. */}
      {options ? <ReadingPickerDialog options={options} onClose={() => setOptions(null)} /> : null}
    </ReadingPickerContext.Provider>
  );
}

export function useReadingPicker() {
  const ctx = useContext(ReadingPickerContext);
  if (!ctx) throw new Error("useReadingPicker must be used within ReadingPickerProvider");
  return ctx;
}

const MAX_ROWS = 5;

/**
 * plan/17 §5.3 — "What should I read?". Asked when a sitting starts, not when it's planned, so the
 * habit never waits on the library: Continue, then Up next, then papers back from the shelf, then
 * suggestions harvested from your own reading, then the inbox — and when every section is empty, the
 * sitting becomes "Find a paper", a first-class way to spend reading time.
 */
function ReadingPickerDialog({ options, onClose }: { options: PickerOptions; onClose: () => void }) {
  const { user } = useAuth();
  const { settings } = useUserSettings();
  const { startSitting, startFindPaper, running } = useReadingSitting();
  const { items: papers, loading: papersLoading } = useUserCollection<Paper>("papers", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: sessions } = useUserCollection<PomodoroSession>("pomodoroSessions", useMemo(() => [orderBy("completedAt", "desc")], []));
  const { items: groups } = useUserCollection<PaperGroup>("paperGroups", useMemo(() => [], []));
  const [goalFor, setGoalFor] = useState<string | null>(options.focusPaperId ?? null);
  const [mode, setMode] = useState<"pick" | "find">("pick");
  const [showAll, setShowAll] = useState(false);
  const [message, setMessage] = useState("");
  const today = todayKey();

  const sections = readingPickerSections(papers, sessions, today);
  const suggestions = harvestedSuggestions(papers, groups).slice(0, 3);
  const focus = options.focusPaperId ? papers.find((paper) => paper.id === options.focusPaperId) : undefined;
  const rows: { section: string; paper?: Paper; suggestion?: (typeof suggestions)[number] }[] = [
    ...(focus ? [{ section: "This sitting", paper: focus }] : []),
    ...sections.continueReading.filter((paper) => paper.id !== focus?.id).map((paper) => ({ section: "Continue", paper })),
    ...sections.upNext.filter((paper) => paper.id !== focus?.id).map((paper) => ({ section: "Up next", paper })),
    ...sections.backFromShelf.map((paper) => ({ section: "Back from the shelf", paper })),
    ...suggestions.map((suggestion) => ({ section: "Suggested from your reading", suggestion })),
    ...sections.inbox.map((paper) => ({ section: "Inbox", paper }))
  ];
  const visible = showAll ? rows : rows.slice(0, MAX_ROWS);
  const empty = !papersLoading && rows.length === 0;

  async function start(paper: Paper) {
    setMessage("");
    const result = await startSitting({ paper, library: papers, sessions, slotId: options.slotId, minutes: options.minutes });
    if (result === "needsGoal") {
      setGoalFor(paper.id);
      return;
    }
    if (result === "busy") {
      setMessage("Another focus session is running — finish it first.");
      return;
    }
    onClose();
  }

  async function readFromShelf(paper: Paper) {
    if (!user) return;
    const patch = queuePatch(paper, new Date().toISOString());
    await updatePaper(user.uid, paper.id, patch);
    await start({ ...paper, ...patch } as Paper);
  }

  async function triage(paper: Paper) {
    if (!user) return;
    const patch = queuePatch(paper, new Date().toISOString());
    await updatePaper(user.uid, paper.id, patch);
    await start({ ...paper, ...patch } as Paper);
  }

  /** plan/17 §5.3 — a suggestion becomes a paper and a Skim sitting on it at once ("find and skim"). */
  async function startSuggestion(suggestion: (typeof suggestions)[number]) {
    if (!user) return;
    const fields = { ...inboxPaper({ title: suggestion.ref, source: { kind: "citation", fromPaperId: suggestion.citedByPaperIds[0] } }), inbox: undefined, status: "to_read" as const, queuedAt: new Date().toISOString() };
    const id = await createPaper(user.uid, fields);
    const now = new Date().toISOString();
    await start({ ...fields, id, progress: 0, groupIds: [], createdAt: now, updatedAt: now } as Paper);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-16" role="dialog" aria-modal="true" aria-label="What should I read?">
      <div className="card w-full max-w-lg p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{mode === "find" || empty ? "Find a paper" : "What should I read?"}</h2>
            {options.minutes ? <p className="text-xs text-ink-500">A {options.minutes}-minute sitting.</p> : null}
          </div>
          <button className="btn-secondary px-2 py-1" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {mode === "find" || empty ? (
          <FindPaperPanel
            sources={settings.readingHabit?.sources ?? []}
            libraryEmpty={empty}
            onStart={() => {
              const result = startFindPaper({ slotId: options.slotId, minutes: options.minutes });
              if (result === "busy") setMessage("Another focus session is running — finish it first.");
            }}
            running={running}
            onBack={empty ? undefined : () => setMode("pick")}
          />
        ) : (
          <>
            <div className="space-y-1">
              {visible.map((row, index) => {
                const header = index === 0 || visible[index - 1].section !== row.section ? <p className="label mb-1 mt-3 first:mt-0">{row.section}</p> : null;
                if (row.suggestion) {
                  const suggestion = row.suggestion;
                  const citedBy = papers.find((paper) => paper.id === suggestion.citedByPaperIds[0]);
                  return (
                    <div key={`s:${suggestion.ref}`}>
                      {header}
                      <div className="flex items-center gap-2 rounded-md bg-ink-50 px-3 py-2 text-sm dark:bg-ink-800">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{suggestion.ref}</span>
                          <span className="block truncate text-xs text-ink-500">
                            {suggestion.citedByPaperIds.length > 1 ? `Cited by ${suggestion.citedByPaperIds.length} of your papers` : `From ${citedBy?.title ?? "your reading"}`}
                          </span>
                        </span>
                        <button className="btn-secondary px-2 py-1 text-xs" onClick={() => startSuggestion(suggestion)} title="Adds it to your papers and starts a sitting to find and skim it">
                          Find &amp; skim
                        </button>
                      </div>
                    </div>
                  );
                }
                const paper = row.paper!;
                return (
                  <div key={`${row.section}:${paper.id}`}>
                    {header}
                    <PaperRow
                      paper={paper}
                      section={row.section}
                      sessions={sessions}
                      askGoal={goalFor === paper.id}
                      onStart={() => (row.section === "Back from the shelf" ? readFromShelf(paper) : row.section === "Inbox" ? triage(paper) : start(paper))}
                      onGoal={(goalKind, goal) => {
                        setGoalFor(null);
                        void start({ ...paper, goal, goalKind });
                      }}
                      onShelveAgain={() => user && updatePaper(user.uid, paper.id, shelvePatch(paper, addDaysToKey(today, DEFAULT_SHELF_DAYS)))}
                      onDrop={() => user && updatePaper(user.uid, paper.id, dropPatch(paper, new Date().toISOString()))}
                    />
                  </div>
                );
              })}
            </div>
            {rows.length > MAX_ROWS ? (
              <button className="mt-2 text-xs text-ink-500 underline" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show fewer" : `Show all ${rows.length}`}
              </button>
            ) : null}
            <button className="btn-secondary mt-4 w-full py-1.5 text-xs" onClick={() => setMode("find")}>
              <Search className="h-3.5 w-3.5" />
              None of these — spend this sitting finding a paper
            </button>
          </>
        )}
        {message ? <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">{message}</p> : null}
      </div>
    </div>
  );
}

function PaperRow({
  paper,
  section,
  sessions,
  askGoal,
  onStart,
  onGoal,
  onShelveAgain,
  onDrop
}: {
  paper: Paper;
  section: string;
  sessions: PomodoroSession[];
  askGoal: boolean;
  onStart: () => void;
  onGoal: (goalKind: NonNullable<Paper["goalKind"]>, goal: string) => void;
  onShelveAgain: () => void;
  onDrop: () => void;
}) {
  const passNo = nextReadingPass(paper);
  const pass = passNo === 1 ? paper.pass1 : passNo === 2 ? paper.pass2 : passNo === 3 ? paper.pass3 : undefined;
  const logged = passNo && pass?.status === "in_progress" ? passSessionMinutes(sessions, paper.id, passNo, pass.startedAt) : 0;
  const detail =
    section === "Back from the shelf"
      ? `Shelved until ${paperShelfDate(paper)}`
      : section === "Inbox"
        ? "Captured, not looked at yet"
        : passNo
          ? `${PASS_LABELS[passNo]}${logged > 0 ? ` · ${logged}m in` : " next"}${pass?.lastPage ? ` · from p. ${pass.lastPage}` : ""}${!paper.fileId ? " · link only" : ""}`
          : "";
  const needsGoal = passNo === 1 && !canStartReading(paper);
  return (
    <div className="rounded-md bg-ink-50 px-3 py-2 text-sm dark:bg-ink-800">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{paper.title}</span>
          <span className="block truncate text-xs text-ink-500">{detail}</span>
        </span>
        {section === "Back from the shelf" ? (
          <>
            <button className="px-1 text-xs text-ink-500 underline" onClick={onShelveAgain}>
              Shelve again
            </button>
            <button className="px-1 text-xs text-ink-500 underline" onClick={onDrop}>
              Drop
            </button>
          </>
        ) : null}
        <button className="btn-primary px-2 py-1 text-xs" onClick={onStart}>
          {section === "Back from the shelf" ? "Read now" : section === "Inbox" ? "Queue & start" : "Start"}
        </button>
      </div>
      {askGoal || (needsGoal && section === "This sitting") ? (
        <div className="mt-2 space-y-1">
          <p className="text-xs text-ink-500">Why are you reading this? One tap starts the Skim.</p>
          <ReadingGoalChips paper={paper} size="xs" onPicked={onGoal} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * plan/17 §5.3 — when there's nothing to read, finding something is the sitting. A short checklist,
 * your saved sources, and a box that drops candidates into the inbox; its minutes count toward the
 * habit (one a week toward the streak).
 */
function FindPaperPanel({
  sources,
  libraryEmpty,
  onStart,
  running,
  onBack
}: {
  sources: { label: string; url: string }[];
  libraryEmpty: boolean;
  onStart: () => void;
  running: boolean;
  onBack?: () => void;
}) {
  const { user } = useAuth();
  const [text, setText] = useState("");
  const [added, setAdded] = useState<string[]>([]);

  async function add() {
    const value = text.trim();
    if (!user || !value) return;
    const link = looksLikeLink(value);
    await createPaper(user.uid, inboxPaper({ title: link ? undefined : value, link: link ? value : undefined, source: { kind: link ? "link" : "manual" } }));
    setAdded((current) => [...current, value]);
    setText("");
  }

  return (
    <div className="space-y-3 text-sm">
      {libraryEmpty ? <p className="text-ink-500">Nothing is waiting to be read — so this sitting is for finding something.</p> : null}
      <ol className="list-inside list-decimal space-y-1 text-ink-600 dark:text-ink-300">
        <li>Open a source you trust{sources.length === 0 ? " (save your usual ones in Settings → Reading)" : ""}.</li>
        <li>Add 1–3 candidates to your inbox below.</li>
        <li>Skim one.</li>
      </ol>
      {sources.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {sources.map((source) => (
            <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="btn-secondary px-2 py-1 text-xs">
              {source.label}
            </a>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2">
        <input
          className="input flex-1 py-1 text-xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Paste a link (arXiv, DOI…) or a title"
        />
        <button className="btn-secondary px-2 py-1 text-xs" onClick={add} disabled={!text.trim()}>
          Add to inbox
        </button>
      </div>
      {added.length > 0 ? <p className="text-xs text-moss-700 dark:text-moss-400">Added: {added.join(" · ")}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary py-1.5 text-xs" onClick={onStart} disabled={running}>
          {running ? "A sitting is running" : "Start a Find-a-paper sitting"}
        </button>
        {onBack ? (
          <button className="text-xs text-ink-500 underline" onClick={onBack}>
            Back to the list
          </button>
        ) : null}
      </div>
    </div>
  );
}
