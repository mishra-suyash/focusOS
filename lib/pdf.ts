import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { friendlyDate } from "@/lib/dates";
import { slotTypeLabels, sortedSlots } from "@/lib/schedule";
import type { ScheduleSlot, Task } from "@/types";

interface DailyFrameInput {
  date: string;
  priorities: string[];
  slots: ScheduleSlot[];
  tasks: Task[];
}

function finalY(doc: jsPDF): number {
  return (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 60;
}

export function downloadDailyFramePdf({ date, priorities, slots, tasks }: DailyFrameInput) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });

  doc.setFontSize(18);
  doc.text("FocusOS — Daily Frame", 40, 40);
  doc.setFontSize(11);
  doc.setTextColor(90);
  doc.text(friendlyDate(date), 40, 58);
  doc.setTextColor(0);

  let y = 78;
  doc.setFontSize(13);
  doc.text("Top priorities", 40, y);
  doc.setFontSize(11);
  const activePriorities = priorities.filter((item) => item.trim().length > 0);
  if (activePriorities.length === 0) {
    y += 18;
    doc.text("No priorities set for today.", 40, y);
  } else {
    activePriorities.forEach((priority, index) => {
      y += 18;
      doc.text(`${index + 1}. ${priority}`, 40, y);
    });
  }

  autoTable(doc, {
    startY: y + 16,
    head: [["Time", "Slot", "Type", "Note"]],
    body: sortedSlots(slots).map((slot) => [`${slot.startTime}-${slot.endTime}`, slot.title, slotTypeLabels[slot.type], slot.note ?? ""]),
    theme: "striped",
    headStyles: { fillColor: [55, 96, 63] },
    styles: { fontSize: 9 }
  });

  autoTable(doc, {
    startY: finalY(doc) + 20,
    head: [["Done", "Task", "Priority"]],
    body: tasks.map((task) => [task.status === "done" ? "[x]" : "[ ]", task.title, task.priority]),
    theme: "grid",
    headStyles: { fillColor: [55, 96, 63] },
    styles: { fontSize: 9 }
  });

  doc.save(`focusos-daily-frame-${date}.pdf`);
}
