import type { Term } from "@/types";

/** The term whose date range contains `dateKey`, if any. */
export function getActiveTerm(terms: Term[], dateKey: string): Term | undefined {
  return terms.find((term) => term.startDate <= dateKey && dateKey <= term.endDate);
}

/** True when there's no active term, or the active one is explicitly a break — no class blocks, reallocated focus. */
export function isBreakMode(terms: Term[], dateKey: string): boolean {
  const active = getActiveTerm(terms, dateKey);
  return !active || active.kind !== "semester";
}
