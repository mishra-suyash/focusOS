# FocusOS

FocusOS is a production-oriented productivity planner for a PhD scholar. It combines pomodoro tracking, task planning, daily notes, weekly planning, reviews, and lightweight analytics in a calm Next.js dashboard.

## Stack

- Next.js App Router with TypeScript
- Tailwind CSS
- Firebase Authentication with Google sign-in and anonymous guest/dev fallback
- Firebase Firestore as the persistent source of truth
- Recharts for lightweight analytics
- Vercel-friendly environment variable configuration

## Features

- Authenticated research dashboard with Pomodoro tracking, task completion metrics, top priorities, notes, and schedule awareness
- Full-day schedule progress widget from `00:00` to `23:59`, including active slot, next slot, day progress, slot progress, and deep work totals
- Day planner at `/planner/day` with editable timeline slots, overlap validation, task assignment, reusable templates, duplicate/delete/apply flows, and a sample research weekday template
- Thought of the day widget backed by Firestore thoughts, with deterministic daily selection, manual next thought override, favorites, and a management page at `/thoughts`
- Task management, weekly planner, daily review, weekly review, analytics, settings, dark mode, and responsive navigation

## Local Setup

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

Open `http://localhost:3000`.

## Firebase Setup

Create a Firebase project, enable Authentication providers for Google and Anonymous, then create a Firestore database. Add a web app in Firebase and copy the config values into `.env.local`.

Required environment variables:

```bash
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
```

## Firestore Schema

FocusOS stores user-owned records under each user document:

```text
users/{uid}
users/{uid}/tasks/{taskId}
users/{uid}/pomodoroSessions/{sessionId}
users/{uid}/dailyPlans/{yyyy-MM-dd}
users/{uid}/dailyNotes/{yyyy-MM-dd}
users/{uid}/dailyReviews/{yyyy-MM-dd}
users/{uid}/weeklyGoals/{goalId}
users/{uid}/weeklyReviews/{weekStart}
users/{uid}/dayTemplates/{templateId}
users/{uid}/dailySchedules/{yyyy-MM-dd}
users/{uid}/thoughts/{thoughtId}
users/{uid}/thoughtSelections/{yyyy-MM-dd}
```

Core task fields include title, optional description, status, priority, category, optional due date, estimated pomodoros, completion time, and timestamps.

Daily schedules embed ordered `slots[]` on the schedule document for fast dashboard reads. Each slot has `id`, `title`, `type`, `startTime`, `endTime`, optional `assignedTaskIds`, optional `note`, `status`, and optional `color`. Templates use the same slot shape and can be applied to a date without mutating the source template. Thought selections store a daily override when the user clicks next thought; otherwise the dashboard uses deterministic date-based selection from the thoughts collection.

Suggested Firestore rules:

```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
      match /{document=**} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }
  }
}
```

## Vercel Deployment

1. Push the repository to GitHub.
2. Import the project in Vercel.
3. Add the six `NEXT_PUBLIC_FIREBASE_*` environment variables in Project Settings.
4. Deploy with the default Next.js settings.
5. Add the Vercel domain to Firebase Authentication authorized domains.

## Architecture

The app uses client components for authenticated Firebase workflows and keeps reusable logic in `lib`, `hooks`, `types`, and `components`. Protected routes live under `app/(app)`, while `/login` is public. Firestore helper functions centralize collection paths and mutations so Phase 3 features like paper tracking and experiment tracking can add new subcollections without changing the app shell.

Schedule logic lives in `lib/schedule.ts`, including time parsing, overlap validation, active slot detection, progress calculations, deep work summaries, template generation, and stable thought selection. The dashboard widgets are reusable client components that subscribe through the existing `useUserCollection` hook.

## Development Notes

- Firestore is the production database; localStorage is used only for the UI theme.
- Guest sign-in still persists to Firestore through Firebase anonymous auth.
- The current analytics are intentionally lightweight and derived client-side from the user's recent records.
- Future improvements: server-side aggregate documents for larger datasets, notification/sound polish for timer completion, drag-and-drop day planning with keyboard parity, richer task progress prompts after deep work blocks, paper and experiment tracking modules.
# focusOS
