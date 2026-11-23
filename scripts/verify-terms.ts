#!/usr/bin/env tsx
/**
 * Unit-test stand-in for lib/terms.ts and lib/term-change.ts: editing a term's dates — same pattern as
 * scripts/verify-routine.ts, since this repo has no test runner.
 */
import { coursesByTerm } from "../lib/courses";
import { classLayerForDate, coursesFollowingTerm, resyncClassesOnDay, templatesFollowingCourses } from "../lib/term-change";
import { endDateForWeeks, getActiveTerm, isBreakMode, termFormErrors, termLengthLabel } from "../lib/terms";
import type { Course, RecurringTaskTemplate, ScheduleSlot, Term } from "../types";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures.push(detail ? `${label}: ${detail}` : label);
}

const stamp = { createdAt: "", updatedAt: "" };
const term = (id: string, startDate: string, endDate: string, kind: Term["kind"] = "semester"): Term => ({ id, name: id, kind, startDate, endDate, ...stamp });
const course = (id: string, patch: Partial<Course> = {}): Course =>
  ({ id, name: id, status: "active", sessions: [{ id: "s", dayOfWeek: 3, startTime: "10:00", endTime: "11:00" }], ...stamp, ...patch }) as Course;

// ---- which term a day belongs to ----
{
  const sem = term("sem", "2026-08-01", "2026-11-30");
  const midBreak = term("mid", "2026-10-01", "2026-10-07", "break");
  check("a nested break wins over its semester, whatever the order", getActiveTerm([sem, midBreak], "2026-10-03")?.id === "mid" && getActiveTerm([midBreak, sem], "2026-10-03")?.id === "mid");
  check("outside the break the semester counts", getActiveTerm([midBreak, sem], "2026-10-08")?.id === "sem");
  check("a day no term covers is a break", isBreakMode([sem], "2026-12-01"));
  check("end day is inside the term", !isBreakMode([sem], "2026-11-30"));
}

// ---- form rules and the derived length ----
{
  check("end before start is refused", termFormErrors({ name: "x", startDate: "2026-08-10", endDate: "2026-08-01" }).length === 1);
  check("a nameless term is refused", termFormErrors({ name: " ", startDate: "2026-08-01", endDate: "2026-08-10" }).length === 1);
  check("a one-day term is allowed", termFormErrors({ name: "x", startDate: "2026-08-01", endDate: "2026-08-01" }).length === 0);
  check("whole weeks read as weeks", termLengthLabel("2026-08-03", "2026-11-29") === "17 weeks", termLengthLabel("2026-08-03", "2026-11-29"));
  check("a remainder reads as days", termLengthLabel("2026-08-03", "2026-08-12") === "1 week, 3 days", termLengthLabel("2026-08-03", "2026-08-12"));
  check("weeks set the end date", endDateForWeeks("2026-08-03", 17) === "2026-11-29");
}

// ---- courses and their templates follow a term's copied dates ----
{
  const sem = term("sem", "2026-08-01", "2026-11-30");
  const copied = course("copied", { termId: "sem", startDate: "2026-08-01", endDate: "2026-11-30" });
  const ownEnd = course("own", { termId: "sem", startDate: "2026-08-01", endDate: "2026-11-15" });
  const other = course("other", { termId: "x", startDate: "2026-08-01", endDate: "2026-11-30" });
  const moved = coursesFollowingTerm([copied, ownEnd, other], sem, { startDate: "2026-08-01", endDate: "2026-12-14" });
  check("a course on the term's dates moves with it", moved.length === 1 && moved[0].item.id === "copied" && moved[0].after.endDate === "2026-12-14" && moved[0].after.startDate === undefined);
  const both = coursesFollowingTerm([copied, ownEnd], sem, { startDate: "2026-07-25", endDate: "2026-11-30" });
  check("a hand-set end stays while the copied start moves", both.length === 2 && both.every((patch) => patch.after.startDate === "2026-07-25" && patch.after.endDate === undefined));

  const template = (id: string, courseId: string, startDate?: string, endDate?: string) => ({ id, courseId, startDate, endDate }) as RecurringTaskTemplate;
  const templates = templatesFollowingCourses([template("rev", "copied", "2026-08-01", "2026-11-30"), template("ta", "copied", "2026-09-01", "2026-11-20"), template("x", "own", "2026-08-01", "2026-11-15")], moved);
  check("a template on the course's dates follows; one with its own stays", templates.length === 1 && templates[0].item.id === "rev" && templates[0].after.endDate === "2026-12-14");
}

// ---- saved days ----
{
  const at = (id: string, startTime: string, endTime: string, patch: Partial<ScheduleSlot> = {}): ScheduleSlot => ({ id, title: id, type: "deep_work", startTime, endTime, status: "upcoming", ...patch });
  const clock = { todayKey: "2026-11-23", nowMinutes: 12 * 60, sessions: [] };
  const wednesday = "2026-12-02";
  const c = course("c");
  const shortTerm = [term("sem", "2026-08-01", "2026-11-30")];
  const longTerm = [term("sem", "2026-08-01", "2026-12-14")];
  const lecture = classLayerForDate(longTerm, [c], wednesday)[0];
  const run = (slots: ScheduleSlot[], before: Term[], after: Term[], routine: ScheduleSlot[] = []) =>
    resyncClassesOnDay({ dateKey: wednesday, slots, before: classLayerForDate(before, [c], wednesday), after: classLayerForDate(after, [c], wednesday), routine, clock });
  const shape = (slots: ScheduleSlot[]) => slots.map((s) => `${s.id} ${s.startTime}`).join();

  check("a class appears once the term covers the day", classLayerForDate(longTerm, [c], wednesday).length === 1 && classLayerForDate(shortTerm, [c], wednesday).length === 0);
  check("a day the change doesn't reach is left alone", run([at("a", "14:00", "15:00")], longTerm, longTerm) === null);

  const extended = run([at("a", "14:00", "15:00")], shortTerm, longTerm);
  check("lengthening the term adds the class", extended !== null && shape(extended.slots) === "course-c-s 10:00,a 14:00", extended ? shape(extended.slots) : undefined);

  const sitting = at("p", "09:30", "10:30", { objectiveRef: { kind: "checkpoint", id: "cp" } });
  const overSitting = run([sitting], shortTerm, longTerm);
  check("a planner sitting under the new class is released", overSitting !== null && overSitting.released.length === 1 && shape(overSitting.slots) === "course-c-s 10:00");

  const mine = at("mine", "10:00", "11:00", { assignedTaskIds: ["t"] });
  const overMine = run([mine], shortTerm, longTerm);
  check("a block placed by hand stays and is reported", overMine !== null && overMine.released.length === 0 && overMine.clashes.length === 1 && overMine.slots.length === 2);

  const lunch = at("routine-lunch", "10:30", "11:30", { type: "meal", locked: true });
  const overRoutine = run([lunch], shortTerm, longTerm);
  check("routine steps aside for an arriving class", overRoutine !== null && shape(overRoutine.slots) === "course-c-s 10:00" && overRoutine.clashes.length === 0);

  const shortened = run([lecture, at("a", "14:00", "15:00")], longTerm, shortTerm, [lunch]);
  check("shortening the term removes the class and brings routine back", shortened !== null && shape(shortened.slots) === "routine-lunch 10:30,a 14:00", shortened ? shape(shortened.slots) : undefined);

  const toBreak = [term("sem", "2026-08-01", "2026-12-14", "break")];
  const flipped = run([lecture], longTerm, toBreak);
  check("turning the term into a break removes the class", flipped !== null && flipped.slots.length === 0);

  const otherFixed = at("commitment-ta", "10:00", "11:00");
  const overFixed = run([otherFixed], shortTerm, longTerm);
  check("a class landing on another fixed item keeps both", overFixed !== null && overFixed.slots.length === 2 && overFixed.clashes.length === 0 && overFixed.released.length === 0);
}

// ---- the course list, semester by semester ----
{
  const autumn = term("autumn", "2026-08-01", "2026-12-15");
  const spring = term("spring", "2026-01-05", "2026-05-10");
  const groups = coursesByTerm([course("a", { termId: "spring" }), course("b"), course("c", { termId: "autumn" }), course("d", { termId: "gone" })], [spring, autumn]);
  check(
    "latest term first, then everything without a live term",
    groups.map((group) => `${group.term?.id ?? "none"}:${group.courses.map((c) => c.id).join("")}`).join() === "autumn:c,spring:a,none:bd",
    groups.map((group) => `${group.term?.id ?? "none"}:${group.courses.map((c) => c.id).join("")}`).join()
  );
  check("a term with no courses shown gets no group", coursesByTerm([course("b")], [autumn]).length === 1);
}

if (failures.length > 0) {
  console.error(`verify-terms: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("verify-terms: all lib/terms.ts and lib/term-change.ts checks passed.");
