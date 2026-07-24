export type TaskStatus = "todo" | "in_progress" | "done";
export type Priority = "low" | "medium" | "high";
export type Category = "research" | "coding" | "reading" | "writing" | "admin" | "personal";
export type TimerMode = "work" | "short_break" | "long_break";
export type ScheduleSlotType = "deep_work" | "meal" | "free" | "admin" | "break" | "commute" | "sleep" | "gym" | "custom";
export type ScheduleSlotStatus = "upcoming" | "active" | "completed" | "skipped";
export type ThoughtSourceType = "quote" | "self_note" | "principle" | "reminder";

export interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  photoURL?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: Priority;
  category: Category;
  dueDate?: string;
  estimatedPomodoros?: number;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PomodoroSession {
  id: string;
  label: string;
  category: Category;
  mode: TimerMode;
  minutes: number;
  completedAt: string;
  cycle: number;
}

export interface DailyPlan {
  id: string;
  date: string;
  priorities: string[];
  schedule: TimeBlock[];
  updatedAt: string;
}

export interface TimeBlock {
  id: string;
  start: string;
  end: string;
  title: string;
}

export interface ScheduleSlot {
  id: string;
  title: string;
  type: ScheduleSlotType;
  startTime: string;
  endTime: string;
  assignedTaskIds?: string[];
  note?: string;
  status: ScheduleSlotStatus;
  color?: string;
}

export interface DayTemplate {
  id: string;
  name: string;
  description?: string;
  slots: ScheduleSlot[];
  createdAt: string;
  updatedAt: string;
}

export interface DailySchedule {
  id: string;
  dateKey: string;
  templateId?: string;
  slots: ScheduleSlot[];
  createdAt: string;
  updatedAt: string;
}

export interface Thought {
  id: string;
  text: string;
  author?: string;
  category?: string;
  sourceType: ThoughtSourceType;
  isFavorite?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ThoughtSelection {
  id: string;
  dateKey: string;
  thoughtId: string;
  updatedAt: string;
}

export interface DailyNote {
  id: string;
  date: string;
  content: string;
  updatedAt: string;
}

export interface DailyReview {
  id: string;
  date: string;
  done: string;
  blocked: string;
  carryForward: string;
  focusRating: number;
  energyRating: number;
  updatedAt: string;
}

export interface WeeklyGoal {
  id: string;
  weekStart: string;
  title: string;
  type: "goal" | "must_finish" | "can_move";
  day?: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WeeklyReview {
  id: string;
  weekStart: string;
  wins: string;
  missedGoals: string;
  blockers: string;
  nextWeekPriorities: string;
  averageFocusRating: number;
  updatedAt: string;
}

export type NewTask = Omit<Task, "id" | "createdAt" | "updatedAt" | "completedAt"> & {
  completedAt?: string;
};

export type NewThought = Omit<Thought, "id" | "createdAt" | "updatedAt">;
export type NewDayTemplate = Omit<DayTemplate, "id" | "createdAt" | "updatedAt">;
