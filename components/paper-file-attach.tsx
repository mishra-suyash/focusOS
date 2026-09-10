"use client";

import { FileText, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { deletePaperPdf, uploadPaperPdf } from "@/lib/files-client";
import { formatBytes } from "@/lib/files";
import { updatePaper } from "@/lib/firestore";
import type { FileRef } from "@/types";

export function PaperFileAttach({ paperId, fileId, file }: { paperId: string; fileId?: string; file: FileRef | null }) {
  const { user } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = "";
    if (!selected || !user) return;
    setBusy(true);
    setError("");
    try {
      const uploaded = await uploadPaperPdf(user, selected, paperId);
      await updatePaper(user.uid, paperId, { fileId: uploaded.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    if (!user || !fileId || !file) return;
    setBusy(true);
    setError("");
    try {
      await deletePaperPdf(user, fileId, file.bytes);
      await updatePaper(user.uid, paperId, { fileId: undefined });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove file.");
    } finally {
      setBusy(false);
    }
  }

  if (file) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-ink-200 p-2 text-sm dark:border-ink-800">
        <a href={file.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-2 text-moss-700 hover:underline dark:text-moss-400">
          <FileText className="h-4 w-4 shrink-0" />
          <span className="truncate">{formatBytes(file.bytes)} PDF</span>
        </a>
        <button className="btn-secondary px-2 py-1" onClick={handleRemove} disabled={busy} aria-label="Remove PDF">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div>
      <input ref={inputRef} type="file" accept="application/pdf" className="hidden" onChange={handleFile} />
      <button className="btn-secondary" onClick={() => inputRef.current?.click()} disabled={busy}>
        <Upload className="h-3.5 w-3.5" />
        {busy ? "Uploading..." : "Attach PDF (optional)"}
      </button>
      {error ? <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
