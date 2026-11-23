import { addDays, differenceInCalendarDays, format, parseISO } from "date-fns";
import type { Term } from "@/types";

/**
 * The term whose date range contains `dateKey`, if any. Terms may overlap (a mid-sem break inside a
 * semester), and the one that started latest wins. Decided here rather than by list order, because the
 * client reads terms sorted and the server reads them unsorted, and both must agree on a day.
 */
export function getActiveTerm(terms: Term[], dateKey: string): Term | undefined {
  let active: Term | undefined;
  for (const term of terms) {
    if (term.startDate > dateKey || dateKey > term.endDate) continue;
    if (!active || term.startDate > active.startDate || (term.startDate === active.startDate && term.endDate < active.endDate)) active = term;
  }
  return active;
}

/** True when there's no active term, or the active one is explicitly a break — no class blocks, reallocated focus. */
export function isBreakMode(terms: Term[], dateKey: string): boolean {
  const active = getActiveTerm(terms, dateKey);
  return !active || active.kind !== "semester";
}

export const termKindLabels: Record<Term["kind"], string> = {
  semester: "Semester",
  break: "Break",
  none: "Other"
};

/** Days a term covers, both ends included. */
export function termLengthDays(startDate: string, endDate: string): number {
  return differenceInCalendarDays(parseISO(endDate), parseISO(startDate)) + 1;
}

/** "17 weeks", "16 weeks, 3 days", "5 days". Always derived from the dates, never stored. */
export function termLengthLabel(startDate: string, endDate: string): string {
  const days = termLengthDays(startDate, endDate);
  const weeks = Math.floor(days / 7);
  const rest = days % 7;
  const parts = [weeks > 0 ? `${weeks} week${weeks === 1 ? "" : "s"}` : "", rest > 0 || weeks === 0 ? `${rest} day${rest === 1 ? "" : "s"}` : ""];
  return parts.filter(Boolean).join(", ");
}

/** The end date that makes a term `weeks` long from `startDate`. */
export function endDateForWeeks(startDate: string, weeks: number): string {
  return format(addDays(parseISO(startDate), weeks * 7 - 1), "yyyy-MM-dd");
}

export function formatTermDate(dateKey: string): string {
  return format(parseISO(dateKey), "d MMM yyyy");
}

/** What stops a term from being saved. Overlap isn't one: a break inside a semester is a real pattern. */
export function termFormErrors(draft: Pick<Term, "name" | "startDate" | "endDate">): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push("Give the term a name.");
  if (!draft.startDate || !draft.endDate) errors.push("Pick a start and an end date.");
  else if (draft.endDate < draft.startDate) errors.push("The end date is before the start date.");
  return errors;
}

/** The other terms a draft shares days with, for saying which one wins on those days. */
export function overlappingTerms(terms: Term[], draft: Pick<Term, "startDate" | "endDate">, ignoreId?: string): Term[] {
  return terms.filter((term) => term.id !== ignoreId && term.startDate <= draft.endDate && draft.startDate <= term.endDate);
}
