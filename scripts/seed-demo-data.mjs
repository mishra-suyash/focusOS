#!/usr/bin/env node
/**
 * Creates (or reuses) a demo Firebase Auth user and populates every FocusOS
 * collection with realistic, internally-consistent sample data — terms,
 * courses with weekly sessions, checkpoints, class logs (which in turn create
 * topics and seed their revision items, replicating lib/classlog.ts's and
 * lib/revision.ts's logic by hand since this runs outside the browser bundle),
 * papers, tasks, a default day template, today's schedule, a week of `days`
 * docs (session/review/loadIndex), pomodoro sessions, and a weekly review.
 *
 * Usage: node scripts/seed-demo-data.mjs [--email=you@example.com] [--password=...]
 * Requires FIREBASE_SERVICE_ACCOUNT_BASE64 in the environment.
 */
import { cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { addDays, format, subDays } from "date-fns";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? true];
  })
);

const DEMO_EMAIL = args.email || "demo@focusos.test";
const DEMO_PASSWORD = args.password || "FocusDemo!2026";
const DEMO_NAME = "Demo Scholar";

const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!encoded) {
  console.error("FIREBASE_SERVICE_ACCOUNT_BASE64 is not set. Export it before running this script.");
  process.exit(1);
}

const serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
const app = initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });
const auth = getAuth(app);

const today = new Date();
const todayKey = (d = today) => format(d, "yyyy-MM-dd");
const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

// --- Replicates lib/revision.ts, kept in sync by hand since this script runs outside the app bundle. ---
const LADDER = [1, 3, 7, 16, 35, 70];
function ladderIndexForConfidence(confidence) {
  if (confidence >= 5) return 2;
  if (confidence >= 3) return 1;
  return 0;
}
function loadIndexBand(value) {
  if (value < 0.6) return "behind";
  if (value < 0.9) return "light";
  if (value <= 1.15) return "on_track";
  if (value <= 1.5) return "ahead";
  return "overrun";
}

async function main() {
  console.log(`Seeding demo data for ${DEMO_EMAIL} ...\n`);

  // 1. Auth user
  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(DEMO_EMAIL);
    console.log(`Reusing existing auth user ${userRecord.uid}`);
  } catch {
    userRecord = await auth.createUser({ email: DEMO_EMAIL, password: DEMO_PASSWORD, displayName: DEMO_NAME });
    console.log(`Created auth user ${userRecord.uid}`);
  }
  const uid = userRecord.uid;
  const users = db.collection("users").doc(uid);

  await users.set(
    { uid, displayName: DEMO_NAME, email: DEMO_EMAIL, createdAt: nowIso(), updatedAt: nowIso() },
    { merge: true }
  );

  // 2. Settings
  await users.collection("meta").doc("settings").set({
    theme: "light",
    hydrationMinutes: 60,
    breakMinutes: 50,
    maxRevisionsPerDay: 20,
    maxRevisionMinutesPerDay: 45,
    updatedAt: nowIso()
  });

  // 3. Terms
  const fallTerm = { id: uuid(), name: "Fall 2026", kind: "semester", startDate: todayKey(subDays(today, 40)), endDate: todayKey(addDays(today, 70)) };
  const breakTerm = { id: uuid(), name: "Winter Break 2026", kind: "break", startDate: todayKey(addDays(today, 71)), endDate: todayKey(addDays(today, 110)) };
  for (const term of [fallTerm, breakTerm]) {
    await users.collection("terms").doc(term.id).set({ ...term, createdAt: nowIso(), updatedAt: nowIso() });
  }
  console.log(`Created 2 terms.`);

  // 4. Courses
  const courses = [
    {
      id: uuid(),
      name: "Distributed Systems",
      code: "CS 719",
      instructor: "Prof. Rao",
      status: "active",
      termId: fallTerm.id,
      targetMinutesPerWeek: 300,
      sessions: [
        { id: uuid(), dayOfWeek: 1, startTime: "10:00", endTime: "11:30", location: "Room 204" },
        { id: uuid(), dayOfWeek: 3, startTime: "10:00", endTime: "11:30", location: "Room 204" }
      ],
      color: "#4f8b67"
    },
    {
      id: uuid(),
      name: "Advanced Algorithms",
      code: "CS 705",
      instructor: "Prof. Iyer",
      status: "active",
      termId: fallTerm.id,
      targetMinutesPerWeek: 240,
      sessions: [
        { id: uuid(), dayOfWeek: 2, startTime: "14:00", endTime: "15:30", location: "Room 118" },
        { id: uuid(), dayOfWeek: 4, startTime: "14:00", endTime: "15:30", location: "Room 118" }
      ],
      color: "#d39b40"
    },
    {
      id: uuid(),
      name: "Research Seminar",
      code: "CS 800",
      instructor: "Prof. Mehta",
      status: "active",
      termId: fallTerm.id,
      targetMinutesPerWeek: 120,
      sessions: [{ id: uuid(), dayOfWeek: 5, startTime: "15:00", endTime: "16:30", location: "Seminar Hall" }],
      color: "#8a5fd6"
    }
  ];
  for (const course of courses) {
    await users.collection("courses").doc(course.id).set({ ...course, createdAt: nowIso(), updatedAt: nowIso() });
  }
  console.log(`Created ${courses.length} courses.`);

  // 5. Checkpoints
  const checkpointDefaults = {
    quiz: { requiresPrep: true, prepLeadDays: 3, prepEstimateMin: 90 },
    lab: { requiresPrep: false, prepLeadDays: 2, prepEstimateMin: 60 },
    assignment: { requiresPrep: false, prepLeadDays: 5, prepEstimateMin: 180 },
    midsem: { requiresPrep: true, prepLeadDays: 10, prepEstimateMin: 600 },
    presentation: { requiresPrep: true, prepLeadDays: 7, prepEstimateMin: 240 }
  };
  const checkpointPlan = [
    { course: courses[0], type: "quiz", title: "Consensus & Replication Quiz", dueInDays: 3, weightPct: 10 },
    { course: courses[0], type: "assignment", title: "Build a Raft Simulator", dueInDays: 10, weightPct: 20 },
    { course: courses[0], type: "midsem", title: "Midsem Exam", dueInDays: 25, weightPct: 30 },
    { course: courses[1], type: "quiz", title: "Graph Algorithms Quiz", dueInDays: 5, weightPct: 10 },
    { course: courses[1], type: "assignment", title: "Approximation Algorithms Problem Set", dueInDays: 14, weightPct: 20 },
    { course: courses[2], type: "presentation", title: "Related Work Presentation", dueInDays: 20, weightPct: 25 }
  ];
  let checkpointCount = 0;
  for (const plan of checkpointPlan) {
    const defaults = checkpointDefaults[plan.type];
    await users
      .collection("courses")
      .doc(plan.course.id)
      .collection("checkpoints")
      .add({
        courseId: plan.course.id,
        type: plan.type,
        title: plan.title,
        dueAt: todayKey(addDays(today, plan.dueInDays)),
        weightPct: plan.weightPct,
        ...defaults,
        topicIds: [],
        status: "upcoming",
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
    checkpointCount += 1;
  }
  console.log(`Created ${checkpointCount} checkpoints.`);

  // 6. Class logs -> topics -> revision items (replicating lib/classlog.ts by hand)
  const classLogPlan = [
    { course: courses[0], daysAgo: 21, attendance: "attended", understanding: 4, topics: "Two-phase commit, Distributed transactions" },
    { course: courses[0], daysAgo: 14, attendance: "attended", understanding: 3, topics: "Raft leader election, Log replication" },
    { course: courses[0], daysAgo: 7, attendance: "missed", topics: "CAP theorem, Consistency models" },
    { course: courses[0], daysAgo: 2, attendance: "attended", understanding: 5, topics: "Byzantine fault tolerance" },
    { course: courses[1], daysAgo: 18, attendance: "attended", understanding: 3, topics: "Dynamic programming on trees, Steiner trees" },
    { course: courses[1], daysAgo: 11, attendance: "attended", understanding: 4, topics: "Max-flow min-cut, Bipartite matching" },
    { course: courses[1], daysAgo: 4, attendance: "self_study", understanding: 2, topics: "Approximation ratios, LP relaxation" },
    { course: courses[2], daysAgo: 9, attendance: "attended", understanding: 4, topics: "Survey methodology, Related work mapping" }
  ];

  let topicCount = 0;
  let revisionItemCount = 0;
  for (const entry of classLogPlan) {
    const date = todayKey(subDays(today, entry.daysAgo));
    const titles = entry.topics.split(",").map((t) => t.trim()).filter(Boolean);
    const confidence = entry.attendance === "missed" ? 1 : (entry.understanding ?? 3);
    const topicIds = [];

    for (const title of titles) {
      const topicId = uuid();
      const ladderIndex = ladderIndexForConfidence(confidence);
      const dueDate = todayKey(addDays(subDays(today, entry.daysAgo), LADDER[ladderIndex]));
      const revisionItemId = uuid();

      await users.collection("topics").doc(topicId).set({
        courseId: entry.course.id,
        title,
        firstSeenDate: date,
        classLogIds: [date],
        confidence,
        status: "active",
        revisionItemId,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
      await users.collection("revisionItems").doc(revisionItemId).set({
        kind: "topic",
        refId: topicId,
        courseId: entry.course.id,
        title,
        ladderIndex,
        dueDate,
        reps: 0,
        lapses: 0,
        suspended: false,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
      topicIds.push(topicId);
      topicCount += 1;
      revisionItemCount += 1;
    }

    await users
      .collection("courses")
      .doc(entry.course.id)
      .collection("classLogs")
      .doc(date)
      .set({
        courseId: entry.course.id,
        date,
        attendance: entry.attendance,
        topicIds,
        rawTopics: entry.topics,
        understanding: entry.attendance === "missed" ? undefined : entry.understanding,
        updatedAt: nowIso()
      });

    if (entry.attendance === "missed") {
      await users.collection("tasks").add({
        title: `Catch up: ${entry.course.name} — ${titles.join(", ")}`,
        status: "todo",
        priority: "high",
        category: "admin",
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
    }
  }
  console.log(`Created ${classLogPlan.length} class logs, ${topicCount} topics, ${revisionItemCount} revision items (several already due for /review).`);

  // 7. Papers (Phase 3 shape: goal/goalKind + structured pass1/pass2 output where the paper is past Pass 1)
  const doneAt = nowIso();
  const pass1Done = (verdict, contributions = []) => ({
    status: "done",
    startedAt: doneAt,
    completedAt: doneAt,
    minutes: 7,
    output: {
      steps: { titleAbstractIntro: true, headings: true, conclusions: true, references: true },
      contributions,
      referencesAlreadyRead: [],
      verdict,
      verdictReason: verdict === "continue" ? "proceeding" : verdict === "park" ? "outside-area-but-relevant-later" : "not-interested"
    }
  });
  const pass2Done = (summary) => ({
    status: "done",
    startedAt: doneAt,
    completedAt: doneAt,
    minutes: 55,
    output: { keyPoints: [], figures: [], unreadReferencesMarked: [], summary, unclear: [], outcome: "grasped" }
  });

  const papers = [
    {
      title: "In Search of an Understandable Consensus Algorithm (Raft)",
      authors: ["Diego Ongaro", "John Ousterhout"],
      venue: "USENIX ATC",
      year: 2014,
      priority: "high",
      tags: ["distributed-systems", "consensus"],
      goal: "Understand the leader-election protocol for the course simulator project.",
      goalKind: "method",
      pass1: pass1Done("continue", ["Understandable consensus via strong leadership", "Randomized election timeouts"]),
      pass2: pass2Done("Raft achieves consensus through a strong leader that handles all log replication, using randomized election timeouts to avoid split votes — designed explicitly for understandability over Paxos."),
      progress: 66,
      status: "read",
      readAt: doneAt,
      groupIds: []
    },
    {
      title: "The Byzantine Generals Problem",
      authors: ["Leslie Lamport", "Robert Shostak", "Marshall Pease"],
      venue: "TOPLAS",
      year: 1982,
      priority: "medium",
      tags: ["distributed-systems", "fault-tolerance"],
      goal: "Background for the fault-tolerance section of the seminar talk.",
      goalKind: "related-work",
      pass1: pass1Done("continue", ["Formalizes the Byzantine fault model", "3f+1 lower bound for f faulty generals"]),
      pass2: pass2Done("Reliable agreement among distributed generals is impossible with fewer than 3f+1 total participants when up to f can be arbitrarily (Byzantine) faulty — the foundational lower bound for fault-tolerant consensus."),
      progress: 66,
      status: "read",
      readAt: doneAt,
      groupIds: []
    },
    {
      title: "Dynamo: Amazon's Highly Available Key-value Store",
      authors: ["Giuseppe DeCandia", "et al."],
      venue: "SOSP",
      year: 2007,
      priority: "high",
      tags: ["distributed-systems", "storage"],
      relatedCourseId: courses[0].id,
      goal: "Understand strong-consistency distributed storage for my Dynamo chapter.",
      goalKind: "related-work",
      pass1: pass1Done("continue", ["Eventually-consistent key-value store", "Vector clocks for conflict resolution"]),
      progress: 33,
      status: "reading",
      groupIds: []
    },
    {
      title: "Spanner: Google's Globally-Distributed Database",
      authors: ["James C. Corbett", "et al."],
      venue: "OSDI",
      year: 2012,
      priority: "medium",
      tags: ["distributed-systems", "databases"],
      goal: "Understand strong-consistency distributed storage for my Dynamo chapter.",
      goalKind: "related-work",
      pass1: pass1Done("continue", ["TrueTime API for global consistency"]),
      progress: 33,
      status: "reading",
      groupIds: []
    },
    {
      title: "A Survey of Approximation Algorithms for Steiner Tree",
      authors: ["Various"],
      venue: "arXiv",
      year: 2020,
      priority: "medium",
      tags: ["algorithms", "approximation"],
      progress: 0,
      status: "to_read",
      groupIds: []
    },
    {
      title: "Randomized Algorithms for Matching Problems",
      authors: ["Various"],
      venue: "STOC",
      year: 2019,
      priority: "low",
      tags: ["algorithms"],
      progress: 0,
      status: "to_read",
      groupIds: []
    },
    {
      title: "How to Read a Paper",
      authors: ["S. Keshav"],
      venue: "SIGCOMM CCR",
      year: 2007,
      priority: "high",
      tags: ["methodology"],
      progress: 0,
      status: "to_read",
      groupIds: []
    },
    {
      title: "Attention Is All You Need",
      authors: ["Ashish Vaswani", "et al."],
      venue: "NeurIPS",
      year: 2017,
      priority: "low",
      tags: ["ml"],
      goal: "Checked relevance to my thesis — not directly applicable.",
      goalKind: "critique",
      pass1: pass1Done("drop"),
      progress: 0,
      status: "archived",
      groupIds: []
    }
  ];
  const paperIds = {};
  for (const paper of papers) {
    const ref = await users.collection("papers").add({ ...paper, createdAt: nowIso(), updatedAt: nowIso() });
    paperIds[paper.title] = ref.id;
  }
  console.log(`Created ${papers.length} papers.`);

  // A cluster group over the distributed-systems readings, with an active group-revision item so /review has a paperGroup card immediately.
  const groupPaperIds = [
    "In Search of an Understandable Consensus Algorithm (Raft)",
    "The Byzantine Generals Problem",
    "Dynamo: Amazon's Highly Available Key-value Store",
    "Spanner: Google's Globally-Distributed Database"
  ].map((title) => paperIds[title]);
  const groupRef = await users.collection("paperGroups").add({
    name: "Distributed systems core readings",
    kind: "cluster",
    paperIds: groupPaperIds,
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  const groupRevisionRef = await users.collection("revisionItems").add({
    kind: "paperGroup",
    refId: groupRef.id,
    title: "Distributed systems core readings",
    ladderIndex: 0,
    dueDate: todayKey(),
    reps: 0,
    lapses: 0,
    suspended: false,
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  await groupRef.set({ revisionItemId: groupRevisionRef.id }, { merge: true });
  console.log("Created 1 paper group with an active group-revision item.");

  // 8. Tasks
  const taskPlan = [
    { title: "Draft related-work section for seminar", category: "writing", priority: "high", status: "in_progress", dueDate: todayKey() },
    { title: "Fix flaky test in Raft simulator", category: "coding", priority: "high", status: "todo", dueDate: todayKey() },
    { title: "Read Dynamo paper, pass 2", category: "reading", priority: "medium", status: "todo", dueDate: todayKey(addDays(today, 1)) },
    { title: "Email advisor about committee date", category: "admin", priority: "medium", status: "todo", dueDate: todayKey(addDays(today, 2)) },
    { title: "Prepare quiz 1 study notes", category: "research", priority: "high", status: "todo", dueDate: todayKey(addDays(today, 2)) },
    { title: "Book dentist appointment", category: "personal", priority: "low", status: "todo" },
    { title: "Review Advanced Algorithms problem set draft", category: "research", priority: "medium", status: "todo", dueDate: todayKey(addDays(today, 6)) },
    { title: "Reproduce baseline results for seminar", category: "coding", priority: "high", status: "in_progress" },
    { title: "Weekly grocery run", category: "personal", priority: "low", status: "done", completedAt: subDays(today, 1).toISOString() },
    { title: "Submit reimbursement form", category: "admin", priority: "low", status: "done", completedAt: subDays(today, 2).toISOString() },
    { title: "Outline literature survey structure", category: "writing", priority: "medium", status: "todo" },
    { title: "Set up experiment tracking for simulator", category: "coding", priority: "medium", status: "todo" }
  ];
  const taskIds = [];
  for (const task of taskPlan) {
    const ref = await users.collection("tasks").add({
      description: undefined,
      estimatedPomodoros: undefined,
      ...task,
      createdAt: nowIso(),
      updatedAt: nowIso()
    });
    taskIds.push(ref.id);
  }
  console.log(`Created ${taskPlan.length} tasks.`);

  // 9. Default day template
  function slot(title, type, startTime, endTime, note) {
    return { id: uuid(), title, type, startTime, endTime, note, status: "upcoming" };
  }
  const templateSlots = [
    slot("Sleep", "sleep", "00:00", "06:30"),
    slot("Morning routine", "free", "06:30", "07:30"),
    slot("Gym", "gym", "07:30", "08:30"),
    slot("Breakfast", "meal", "08:30", "09:00"),
    slot("Deep work: primary research", "deep_work", "09:00", "11:30"),
    slot("Break", "break", "11:30", "12:00"),
    slot("Reading and notes", "deep_work", "12:00", "13:30"),
    slot("Lunch", "meal", "13:30", "14:15"),
    slot("Admin and email", "admin", "14:15", "15:00"),
    slot("Writing block", "deep_work", "15:00", "17:00"),
    slot("Open buffer", "free", "17:00", "18:30"),
    slot("Dinner", "meal", "18:30", "19:30"),
    slot("Review and tomorrow setup", "admin", "19:30", "20:00"),
    slot("Personal time", "free", "20:00", "22:30"),
    slot("Sleep", "sleep", "22:30", "23:59")
  ];
  const templateId = uuid();
  await users.collection("dayTemplates").doc(templateId).set({
    name: "Research weekday",
    description: "A balanced doctoral workday with deep work, meals, admin, gym, and evening review.",
    isDefault: true,
    slots: templateSlots,
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  console.log("Created default day template.");

  // 10. Today's schedule (template + today's class blocks)
  const todayDow = today.getDay();
  const classSlotsToday = courses.flatMap((course) =>
    course.sessions
      .filter((session) => session.dayOfWeek === todayDow)
      .map((session) => ({
        id: `course-${course.id}-${session.id}`,
        title: course.code ? `${course.code} · ${course.name}` : course.name,
        type: "class",
        startTime: session.startTime,
        endTime: session.endTime,
        note: session.location,
        status: "upcoming",
        color: course.color
      }))
  );
  const allTodaySlots = [...templateSlots, ...classSlotsToday].sort((a, b) => a.startTime.localeCompare(b.startTime));
  await users.collection("dailySchedules").doc(todayKey()).set({
    dateKey: todayKey(),
    templateId,
    slots: allTodaySlots,
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  console.log(`Created today's schedule (${classSlotsToday.length} class block(s) from today's courses).`);

  // 11. Pomodoro sessions + days docs for the last 7 days, plus today's pinned tasks/scratchpad
  const categories = ["research", "coding", "reading", "writing"];
  const dayBands = ["on_track", "on_track", "ahead", "light", "on_track", "overrun", "behind"];
  let sessionCount = 0;
  for (let i = 7; i >= 1; i -= 1) {
    const date = subDays(today, i);
    const dateKey = todayKey(date);
    const sessionsToday = 2 + (i % 4); // 2-5 sessions
    let focusedMinutes = 0;
    for (let s = 0; s < sessionsToday; s += 1) {
      const minutes = [25, 25, 45, 15][s % 4];
      const hour = 9 + s * 2;
      const completedAt = new Date(date);
      completedAt.setHours(hour, 15, 0, 0);
      focusedMinutes += minutes;
      await users.collection("pomodoroSessions").add({
        label: ["Reading notes", "Writing draft", "Debugging simulator", "Problem set"][s % 4],
        category: categories[s % categories.length],
        mode: "work",
        minutes,
        completedAt: completedAt.toISOString(),
        cycle: s + 1,
        productivityRating: 2 + (s % 4),
        comment: s % 3 === 0 ? "Good focus, no interruptions." : undefined,
        taskId: s === 0 ? taskIds[i % taskIds.length] : undefined
      });
      sessionCount += 1;
    }

    const band = dayBands[7 - i];
    const requiredMinutes = 240;
    const actualMinutes = { behind: 90, light: 160, on_track: 230, ahead: 320, overrun: 420 }[band];

    await users
      .collection("days")
      .doc(dateKey)
      .set({
        date: dateKey,
        session: {
          startedAt: new Date(new Date(date).setHours(9, 0, 0, 0)).toISOString(),
          endedAt: new Date(new Date(date).setHours(18, 30, 0, 0)).toISOString(),
          hydrationCount: 3 + (i % 3),
          breaksTaken: 2 + (i % 2)
        },
        pinnedTaskIds: [],
        scratchpad: i === 1 ? "Remember to email advisor about committee scheduling." : undefined,
        review: {
          done: "Made progress on coursework and reading.",
          blocked: i % 3 === 0 ? "Waiting on advisor feedback." : "",
          carryForward: "Continue simulator debugging tomorrow.",
          focusRating: 2 + (i % 4),
          energyRating: 2 + ((i + 1) % 4),
          submittedAt: new Date(new Date(date).setHours(20, 0, 0, 0)).toISOString()
        },
        loadIndex: {
          requiredMinutes,
          actualMinutes,
          value: Number((actualMinutes / requiredMinutes).toFixed(2)),
          band: loadIndexBand(actualMinutes / requiredMinutes),
          computedAt: new Date(new Date(date).setHours(18, 30, 0, 0)).toISOString()
        },
        updatedAt: nowIso()
      });
  }
  console.log(`Created ${sessionCount} pomodoro sessions and 7 days of history (with Load Index snapshots).`);

  // Today: a couple of pinned tasks + a scratchpad note, no session yet (let the demo user click "Start day" themselves)
  await users
    .collection("days")
    .doc(todayKey())
    .set(
      {
        date: todayKey(),
        pinnedTaskIds: taskIds.slice(0, 2),
        scratchpad: "First move tomorrow: rerun the Raft simulator with the new timeout values.",
        updatedAt: nowIso()
      },
      { merge: true }
    );

  // 12. Weekly review
  const weekStart = format(addDays(today, 1 - (((today.getDay() + 6) % 7) + 1)), "yyyy-MM-dd");
  await users.collection("weeklyReviews").doc(weekStart).set({
    weekStart,
    wins: "Finished the Raft leader-election module and read two consensus papers.",
    missedGoals: "Didn't get to the approximation-algorithms problem set.",
    blockers: "Advisor meeting got pushed, blocking committee planning.",
    nextWeekPriorities: "Quiz 1 prep, finish problem set, draft seminar related-work section.",
    averageFocusRating: 3.1,
    updatedAt: nowIso()
  });
  console.log("Created weekly review.");

  console.log(`\nDone. Sign in at /login with:\n  email:    ${DEMO_EMAIL}\n  password: ${DEMO_PASSWORD}\n  uid:      ${uid}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
