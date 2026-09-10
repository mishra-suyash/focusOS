import { addDays, format } from "date-fns";
import { createRevisionItem } from "@/lib/firestore";
import { DEFAULT_LADDER, RESURFACE_AFTER_DAYS, ladderIndexForConfidence } from "@/lib/revision";
import type { Paper } from "@/types";

/** A parked paper (pass1 verdict "park", not "drop") gets a one-off resurfacing item 180 days out — the plan's "revisit someday" mechanism. */
export async function createParkedPaperRevisionItem(uid: string, paper: Pick<Paper, "id" | "title">) {
  const dueDate = format(addDays(new Date(), RESURFACE_AFTER_DAYS), "yyyy-MM-dd");
  await createRevisionItem(uid, {
    kind: "paper",
    refId: paper.id,
    title: paper.title,
    ladderIndex: 0,
    dueDate,
    reps: 0,
    lapses: 0,
    suspended: false
  });
}

/** Pass 3's structure-recall self-grade seeds a normal ladder revision item, same as a logged class topic. */
export async function createPass3RecallRevisionItem(uid: string, paper: Pick<Paper, "id" | "title">, selfGrade: number) {
  const ladderIndex = ladderIndexForConfidence(selfGrade);
  const dueDate = format(addDays(new Date(), DEFAULT_LADDER[ladderIndex]), "yyyy-MM-dd");
  await createRevisionItem(uid, {
    kind: "paper",
    refId: paper.id,
    title: paper.title,
    ladderIndex,
    dueDate,
    reps: 0,
    lapses: 0,
    suspended: false
  });
}
