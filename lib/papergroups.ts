import type { Pass1Output, Pass2Output, Paper } from "@/types";

function citationsFor(paper: Paper): string[] {
  const pass1 = paper.pass1?.output as Pass1Output | undefined;
  const pass2 = paper.pass2?.output as Pass2Output | undefined;
  return [...(pass1?.referencesAlreadyRead ?? []), ...(pass2?.unreadReferencesMarked ?? [])];
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

/** True if `ref` looks like a paper already tracked somewhere in the library (by loose title match). */
function alreadyInLibrary(ref: string, allPapers: Paper[]): boolean {
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
