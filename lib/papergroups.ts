import type { Pass1Output, Pass2Output, Paper, PaperGroup } from "@/types";

function citationsFor(paper: Paper): string[] {
  const pass1 = paper.pass1?.output as Pass1Output | undefined;
  const pass2 = paper.pass2?.output as Pass2Output | undefined;
  return [...(pass1?.referencesAlreadyRead ?? []), ...(pass2?.unreadReferencesMarked ?? [])];
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

/** True if `ref` looks like a paper already tracked somewhere in the library (by loose title match). */
export function alreadyInLibrary(ref: string, allPapers: Paper[]): boolean {
  const normalizedRef = normalize(ref);
  return allPapers.some((paper) => {
    const title = normalize(paper.title);
    return title.length > 0 && (normalizedRef.includes(title) || title.includes(normalizedRef));
  });
}

export interface SharedCitation {
  ref: string;
  citedByPaperIds: string[];
  inLibrary: boolean;
}

/**
 * Stage 2 of the survey workflow, and the highest-leverage automated
 * suggestion in the papers subsystem per the plan — a set intersection over
 * citations, computed client-side with no model call, because Pass 1's
 * referencesAlreadyRead and Pass 2's unreadReferencesMarked are already
 * populated checklist fields.
 */
export function computeSharedCitations(groupPapers: Paper[], allPapers: Paper[]): SharedCitation[] {
  const byRef = new Map<string, { ref: string; paperIds: Set<string> }>();
  for (const paper of groupPapers) {
    for (const ref of citationsFor(paper)) {
      const key = normalize(ref);
      if (!key) continue;
      const entry = byRef.get(key) ?? { ref, paperIds: new Set() };
      entry.paperIds.add(paper.id);
      byRef.set(key, entry);
    }
  }
  return Array.from(byRef.values())
    .filter((entry) => entry.paperIds.size >= 2)
    .map((entry) => ({ ref: entry.ref, citedByPaperIds: Array.from(entry.paperIds), inLibrary: alreadyInLibrary(entry.ref, allPapers) }))
    .sort((a, b) => b.citedByPaperIds.length - a.citedByPaperIds.length);
}

export interface RepeatedAuthor {
  name: string;
  paperIds: string[];
}

export function computeRepeatedAuthors(groupPapers: Paper[]): RepeatedAuthor[] {
  const byName = new Map<string, { name: string; paperIds: Set<string> }>();
  for (const paper of groupPapers) {
    for (const author of paper.authors) {
      const key = normalize(author);
      if (!key) continue;
      const entry = byName.get(key) ?? { name: author, paperIds: new Set() };
      entry.paperIds.add(paper.id);
      byName.set(key, entry);
    }
  }
  return Array.from(byName.values())
    .filter((entry) => entry.paperIds.size >= 2)
    .map((entry) => ({ name: entry.name, paperIds: Array.from(entry.paperIds) }))
    .sort((a, b) => b.paperIds.length - a.paperIds.length);
}

/** Stage 5's "did everyone converge" check is the same computation with a stricter threshold — every seed paper must share the citation. */
export function findConvergedMissingCitations(groupPapers: Paper[], allPapers: Paper[]): SharedCitation[] {
  return computeSharedCitations(groupPapers, allPapers).filter(
    (citation) => !citation.inLibrary && citation.citedByPaperIds.length === groupPapers.length
  );
}

export interface HarvestedSuggestion {
  /** The reference as written where it was found. */
  ref: string;
  /** Library papers whose reading turned it up, most relevant first. */
  citedByPaperIds: string[];
  /** Where it came from, for the row's subtitle. */
  sources: ("unread-reference" | "citation-to-read" | "background" | "shared-citation")[];
}

/**
 * plan/17 §5.3 / F2 — "read this next" data the app already holds and used to throw away: references
 * marked unread in a Read, a layered summary's citations to read, background a Return-later named
 * (before plan/17 sent those to the inbox itself), and a paper set's shared citations. De-duplicated
 * against the library with the same loose title match the survey panel uses, so a reference you've
 * already added never comes back as a suggestion. Ranked by how many of your papers point at it.
 */
export function harvestedSuggestions(allPapers: Paper[], groups: Pick<PaperGroup, "paperIds">[] = []): HarvestedSuggestion[] {
  const byRef = new Map<string, { ref: string; paperIds: Set<string>; sources: Set<HarvestedSuggestion["sources"][number]> }>();
  const add = (ref: string, paperId: string, source: HarvestedSuggestion["sources"][number]) => {
    const key = normalize(ref);
    if (key.length < 4) return;
    const entry = byRef.get(key) ?? { ref: ref.trim(), paperIds: new Set(), sources: new Set() };
    entry.paperIds.add(paperId);
    entry.sources.add(source);
    byRef.set(key, entry);
  };
  for (const paper of allPapers) {
    const pass2 = paper.pass2?.output as Pass2Output | undefined;
    for (const ref of pass2?.unreadReferencesMarked ?? []) add(ref, paper.id, "unread-reference");
    for (const ref of pass2?.returnAfter?.backgroundToRead ?? []) add(ref, paper.id, "background");
    for (const ref of paper.layeredNotes?.citationsToRead ?? []) add(ref, paper.id, "citation-to-read");
  }
  for (const group of groups) {
    const groupPapers = allPapers.filter((paper) => group.paperIds.includes(paper.id));
    for (const citation of computeSharedCitations(groupPapers, allPapers)) {
      for (const paperId of citation.citedByPaperIds) add(citation.ref, paperId, "shared-citation");
    }
  }
  return [...byRef.values()]
    .filter((entry) => !alreadyInLibrary(entry.ref, allPapers))
    .map((entry) => ({ ref: entry.ref, citedByPaperIds: [...entry.paperIds], sources: [...entry.sources] }))
    .sort((a, b) => b.citedByPaperIds.length - a.citedByPaperIds.length);
}
