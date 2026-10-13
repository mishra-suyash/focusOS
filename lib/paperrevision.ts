import { addDays, format } from "date-fns";
import { createRevisionItem } from "@/lib/firestore";
import { DEFAULT_LADDER, ladderIndexForConfidence } from "@/lib/revision";
import type { Paper } from "@/types";

// plan/17 §9 — a shelved paper no longer gets a 180-day Revise item: it comes back through the
// reading picker on its own `shelvedUntil` date (lib/papers.ts). Revise items created for papers
// parked before plan/17 stay valid and are left alone (§10).

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
