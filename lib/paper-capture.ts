import type { NewPaper, Paper } from "@/types";

/**
 * plan/17 §5.6 — capture: a paper you've heard of but not looked at yet goes to the inbox, not
 * straight into the reading queue. The title falls back to the link itself until it's edited
 * (automatic arXiv/DOI metadata lookup is plan/17 §13 Q4, not built).
 */
export function inboxPaper(params: { title?: string; link?: string; source: NonNullable<Paper["source"]> }): NewPaper {
  const title = params.title?.trim() || params.link?.trim() || "Untitled paper";
  return {
    title,
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
