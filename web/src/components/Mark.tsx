export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <circle cx="16" cy="11.5" r="4.1" fill="var(--on-accent)" />
      <circle cx="11.2" cy="15.6" r="3.15" fill="var(--on-accent)" opacity="0.92" />
      <circle cx="20.8" cy="15.6" r="3.15" fill="var(--on-accent)" opacity="0.92" />
      <path d="M16 18.2V25" stroke="var(--on-accent)" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
