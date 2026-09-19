"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { PaperReadingWindow } from "@/components/paper-reading-window";
import { subscribeDoc } from "@/lib/firestore";
import type { FileRef, Paper } from "@/types";

/**
 * Deliberately outside `app/(app)/` — a page nested inside that route group
 * inherits `ProtectedLayout` -> `AppShell` no matter what CSS is applied,
 * since Next.js route groups only affect URL shape, not layout nesting. This
 * mirrors `/login` and `/privacy-policy`, the two existing routes that already
 * escape the app shell while still getting `AuthProvider`/`ThemeProvider` from
 * the root layout. See plan/12.FocusOS-v2-Paper-Reading-Window-Plan.md §5.
 */
export default function ReadPaperPage() {
  const params = useParams<{ paperId: string }>();
  const { user, loading } = useAuth();
  const [paper, setPaper] = useState<Paper | null>(null);
  const [file, setFile] = useState<FileRef | null>(null);

  useEffect(() => {
    if (!user) return;
    return subscribeDoc<Paper>(user.uid, "papers", params.paperId, setPaper);
  }, [user, params.paperId]);

  useEffect(() => {
    if (!user || !paper?.fileId) {
      setFile(null);
      return;
    }
    return subscribeDoc<FileRef>(user.uid, "files", paper.fileId, setFile);
  }, [user, paper?.fileId]);

  // The same body-scroll-lock trick AppShell's mobile nav drawer already uses
  // (components/app-shell.tsx) — keeps the toolbar/sidebar chrome fixed rather
  // than letting the body itself scroll behind them.
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  if (loading || (!paper && user)) {
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-white text-sm text-ink-500 dark:bg-ink-950">
        Loading...
      </main>
    );
  }

  if (!user || !paper) {
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-white text-sm text-ink-500 dark:bg-ink-950">
        Paper not found.
      </main>
    );
  }

  if (!file) {
    return (
      <main className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-white text-sm text-ink-500 dark:bg-ink-950">
        <p>This paper has no PDF attached yet.</p>
        <Link href={`/papers/${paper.id}`} className="btn-secondary">
          Back to paper
        </Link>
      </main>
    );
  }

  return <PaperReadingWindow paper={paper} pdfUrl={file.url} />;
}
