export function FishIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      className={className}
      width="40"
      height="24"
      viewBox="0 0 40 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12c6-8.5 18-9.5 26 0-8 9.5-20 8.5-26 0z" />
      <path d="M29 12l8-6.5v13z" />
      <circle cx="10" cy="10.5" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}
