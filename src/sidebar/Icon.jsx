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
  book: (
    <path
      d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  star: (
    <path d="M12 4l2.4 5 5.4.7-4 3.8 1 5.4L12 16.3 7.2 18.9l1-5.4-4-3.8 5.4-.7z" strokeLinejoin="round" />
  ),
  command: (
    <path
      d="M9 9V7a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v10a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2zM9 9h6v6H9z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  refresh: (
    <path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v4h-4" strokeLinecap="round" strokeLinejoin="round" />
  ),
  monitor: (
    <path d="M4 5h16v11H4zM9 20h6M12 16v4" strokeLinecap="round" strokeLinejoin="round" />
  ),
  sun: (
    <path
      d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  eye: (
    <>
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  form: (
    <>
      <rect x="4" y="3.5" width="16" height="17" rx="2" />
      <path d="M8 8.5h8M8 12h8M8 15.5h5" strokeLinecap="round" />
    </>
  ),
  table: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M3.5 10h17M10 10v9" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="2.8" />
      <path d="M5 6v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6M5 12v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-6" />
    </>
  ),
  code: <path d="M8.5 8L4 12l4.5 4M15.5 8L20 12l-4.5 4M13.5 5.5l-3 13" strokeLinecap="round" strokeLinejoin="round" />,
  layers: <path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8zM3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5" strokeLinejoin="round" strokeLinecap="round" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" strokeLinecap="round" />
    </>
  ),
  log: <path d="M6 4h12v16H6zM9 8.5h6M9 12h6M9 15.5h3.5" strokeLinecap="round" strokeLinejoin="round" />,
  shield: (
    <>
      <path d="M12 3l7.5 3v5.5c0 4.6-3.1 8.1-7.5 9.5-4.4-1.4-7.5-4.9-7.5-9.5V6z" strokeLinejoin="round" />
      <path d="M9 12l2.2 2.2L15.5 10" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  flask: (
    <>
      <path d="M9.5 3.5h5M10.5 3.5v6L5 19a1.6 1.6 0 0 0 1.4 2.4h11.2A1.6 1.6 0 0 0 19 19l-5.5-9.5v-6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 15h8" strokeLinecap="round" />
    </>
  ),
  play: <path d="M8 5.5v13l11-6.5z" strokeLinejoin="round" />,
  edit: <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19zM14.5 6.5l3 3" strokeLinecap="round" strokeLinejoin="round" />,
  save: <path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6" strokeLinejoin="round" />,
  undo: <path d="M9 7L4 11.5 9 16M4.5 11.5H15a4.5 4.5 0 0 1 0 8.5h-3" strokeLinecap="round" strokeLinejoin="round" />,
  cursor: <path d="M6 4l12 6.5-5.2 1.6L10.5 18z" strokeLinejoin="round" />,
  tool: <path d="M14.7 6.3a4 4 0 0 0 5.1 5.1L21 12l-9 9-3-3 9-9z" strokeLinejoin="round" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />,
  alert: <path d="M12 4l9 16H3zM12 10v4.5M12 17.2h.01" strokeLinecap="round" strokeLinejoin="round" />,
  ban: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 6l12 12" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" strokeLinecap="round" />
    </>
  ),
  bolt: <path d="M13 3L5 13.5h6L10 21l9-11h-6z" strokeLinejoin="round" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  braces: <path d="M9 4C6.5 4 7.5 9 5 12c2.5 3 1.5 8 4 8M15 4c2.5 0 1.5 5 4 8-2.5 3-1.5 8-4 8" strokeLinecap="round" strokeLinejoin="round" />,
  plug: <path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0zM12 17v4" strokeLinecap="round" strokeLinejoin="round" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" strokeLinecap="round" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" strokeLinecap="round" strokeLinejoin="round" />,
  briefcase: <path d="M4 8h16v11H4zM9 8V5.5h6V8M4 13h16" strokeLinecap="round" strokeLinejoin="round" />,
  upload: <path d="M12 15.5V4.5M7.5 9L12 4.5 16.5 9M5 15v4.5h14V15" strokeLinecap="round" strokeLinejoin="round" />,
  pulse: <path d="M3 12h4l2.5-6.5 4.5 13 2.5-6.5H21" strokeLinecap="round" strokeLinejoin="round" />,
  xray: <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M4 12h16" strokeLinecap="round" strokeLinejoin="round" />,
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
