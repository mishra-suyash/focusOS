import type { Category, Priority, TaskBucket, TaskStatus } from "@/types";

export const categories: Category[] = ["research", "coding", "reading", "writing", "admin", "personal"];
export const priorities: Priority[] = ["low", "medium", "high"];
export const statuses: TaskStatus[] = ["todo", "in_progress", "done"];
export const taskBuckets: TaskBucket[] = ["assignment", "backlog", "revision", "goal"];

export const categoryLabels: Record<Category, string> = {
  research: "Research",
  coding: "Coding",
  reading: "Reading",
  writing: "Writing",
  admin: "Admin",
  personal: "Personal"
};

export const taskBucketLabels: Record<TaskBucket, string> = {
  goal: "Goal",
  assignment: "Assignment",
  backlog: "Backlog",
  revision: "Revision"
};
