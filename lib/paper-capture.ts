import type { NewPaper, Paper } from "@/types";
import { splitCitation } from "@/lib/papers";

/**
 * plan/17 §5.6 — capture: a paper you've heard of but not looked at yet goes to the inbox, not
 * straight into the reading queue. The title falls back to the link itself until it's edited
 * (automatic arXiv/DOI metadata lookup is plan/17 §13 Q4, not built).
 */
export function inboxPaper(params: { title?: string; link?: string; source: NonNullable<Paper["source"]> }): NewPaper {
  // A reference pasted as the title keeps its citation text apart, so the title stays the paper's own.
  const split = params.title?.trim() ? splitCitation(params.title) : null;
  const title = split?.title || params.link?.trim() || "Untitled paper";
  return {
    title,
    ...(split?.citation ? { citation: split.citation } : {}),
    authors: [],
    ...(params.link?.trim() ? { link: params.link.trim() } : {}),
    status: "inbox",
    inbox: true,
    priority: "medium",
    tags: [],
    source: params.source
  };
}

/** True when a string is a link rather than a title — what decides whether "Add" captured a URL. */
export function looksLikeLink(text: string): boolean {
  return /^(https?:\/\/|doi:|10\.\d{4,}\/|arxiv:)/i.test(text.trim());
}
