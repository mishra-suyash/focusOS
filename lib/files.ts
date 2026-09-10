export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB — Claude's Files API request ceiling, per the plan.
export const SOFT_ACCOUNT_CAP_MB = 800; // Vercel Blob gives 1 GB on Hobby; warn well before it. Overridable per-tier — see lib/tiers.ts.
export const SOFT_ACCOUNT_CAP_BYTES = SOFT_ACCOUNT_CAP_MB * 1024 * 1024;

export interface FileValidationResult {
  ok: boolean;
  error?: string;
}

/** Client-side pre-flight checks before ever calling the upload-token route — reject fast, never touch the network for an obviously-bad file. */
export function validatePdfFile(file: File): FileValidationResult {
  if (file.type !== "application/pdf") {
    return { ok: false, error: "Only PDF files can be attached to a paper." };
  }
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, error: `File is ${(file.size / (1024 * 1024)).toFixed(1)} MB — the per-file limit is 20 MB.` };
  }
  return { ok: true };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Non-blocking — a warning banner, not a hard wall, per the plan ("soft
 * account cap with a warning banner"). `capMb` defaults to the global
 * 800 MB constant but is meant to be the caller's resolved tier limit
 * (see lib/tiers.ts's `limits.blobQuotaMb`) once tiers are in play.
 */
export function isNearSoftCap(totalBytes: number, capMb: number = SOFT_ACCOUNT_CAP_MB): boolean {
  return totalBytes >= capMb * 1024 * 1024 * 0.9;
}

export function isOverSoftCap(totalBytes: number, capMb: number = SOFT_ACCOUNT_CAP_MB): boolean {
  return totalBytes >= capMb * 1024 * 1024;
}
