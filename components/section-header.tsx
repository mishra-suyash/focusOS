export function SectionHeader({
  title,
  eyebrow,
  children
}: {
  title: string;
  eyebrow?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {eyebrow ? <p className="label mb-1">{eyebrow}</p> : null}
        <h1 className="text-2xl font-semibold tracking-tight text-ink-950 dark:text-ink-50">{title}</h1>
      </div>
      {children}
    </div>
  );
}
