"use client";

/**
 * Plan §9.7 — every list page's empty state is one teaching sentence, one primary action, and
 * (where it exists) one template action, instead of a bare "nothing here yet."
 */
export function EmptyState({
  sentence,
  primary,
  template
}: {
  sentence: string;
  primary?: { label: string; onClick: () => void };
  template?: { label: string; onClick: () => void };
}) {
  return (
    <div className="rounded-md border border-dashed border-ink-300 p-8 text-center dark:border-ink-700">
      <p className="text-sm text-ink-600 dark:text-ink-300">{sentence}</p>
      {primary || template ? (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {primary ? (
            <button className="btn-primary px-3 py-1.5 text-xs" onClick={primary.onClick}>
              {primary.label}
            </button>
          ) : null}
          {template ? (
            <button className="btn-secondary px-3 py-1.5 text-xs" onClick={template.onClick}>
              {template.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Scrolls an already-visible form into view (and focuses its first field) instead of opening a separate dialog — used where the add form already lives in a sidebar. */
export function focusSection(id: string) {
  const section = document.getElementById(id);
  if (!section) return;
  section.scrollIntoView({ behavior: "smooth", block: "start" });
  const field = section.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
  field?.focus();
}
