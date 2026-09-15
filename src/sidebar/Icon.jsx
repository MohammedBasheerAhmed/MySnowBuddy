import React from 'react';

// Icon set for the React surfaces. Kept as JSX (not markup strings) so nothing
// here ever goes near dangerouslySetInnerHTML.
const PATHS = {
  send: <path d="M4 12l16-8-6 16-2.4-6z" strokeLinejoin="round" />,
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" strokeLinecap="round" />
    </>
  ),
  stop: <rect x="7" y="7" width="10" height="10" rx="2" />,
  download: (
    <path d="M12 4v10m0 0l-3.5-3.5M12 14l3.5-3.5M5 18h14" strokeLinecap="round" strokeLinejoin="round" />
  ),
  close: <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />,
  trash: (
    <path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" strokeLinecap="round" strokeLinejoin="round" />
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h8" strokeLinecap="round" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3l1.8 4.9L19 9.7l-4.4 2.5L13.8 17 12 14.2 10.2 17l-1.4-4.8L5 9.7l5.2-1.8z" strokeLinejoin="round" />
    </>
  ),
  chevron: <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />,
  refresh: (
    <path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v4h-4" strokeLinecap="round" strokeLinejoin="round" />
  ),
};

export default function Icon({ name, size = 16, className = '' }) {
  const path = PATHS[name];
  if (!path) return null;
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}
