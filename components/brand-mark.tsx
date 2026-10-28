/**
 * The FocusOS mark: a moss rounded square with a white F. The same drawing as `app/icon.svg` (the
 * favicon; `app/favicon.ico` and `app/apple-icon.png` are renders of it), so keep the two in step.
 * Size it with `className` (e.g. `h-9 w-9`).
 */
export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden="true" className={`shrink-0 ${className}`}>
      <rect width="512" height="512" rx="104" fill="#3f7656" />
      <g fill="#fff">
        <rect x="178" y="112" width="72" height="288" rx="14" />
        <rect x="178" y="112" width="182" height="70" rx="14" />
        <rect x="178" y="226" width="146" height="66" rx="14" />
      </g>
    </svg>
  );
}
