// Brand mark and the small stroke icons used in the shell.
export function Logo() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <g strokeLinejoin="round">
        <path fill="#F26A21" stroke="#F26A21" strokeWidth="3" d="M12 7 26 19H38L52 7 54 31 32 56 10 31Z" />
        <path fill="#B94C17" stroke="#B94C17" strokeWidth="1.5" d="M15 13 23.5 20.5 16 25ZM49 13 40.5 20.5 48 25Z" />
        <path fill="#DD5A18" d="M26 19 32 30 38 19Z" />
        <path fill="#FFF4EA" stroke="#FFF4EA" strokeWidth="1.5" d="M11.5 32 24 35 32 44.5V54.5Z" />
        <path fill="#F1E1D1" stroke="#F1E1D1" strokeWidth="1.5" d="M52.5 32 40 35 32 44.5V54.5Z" />
        <path fill="#22160F" stroke="#22160F" strokeWidth="1.5" d="M19 27.5 26 30 20.5 31ZM45 27.5 38 30 43.5 31ZM29.5 50H34.5L32 53.5Z" />
      </g>
    </svg>
  );
}

const PATHS = {
  database: "M4 5c0 1.7 3.6 3 8 3s8-1.3 8-3-3.6-3-8-3-8 1.3-8 3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  history: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  saved: "M6 3h12v18l-6-4-6 4z",
  tools: "M12 3v12M7 10l5 5 5-5M4 15v4h16v-4",
  diagram: "M3 3h7v6H3zM14 15h7v6h-7zM14 3h7v6h-7zM10 6h4M17.5 9v6",
  theme: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  sidebar: "M3 4h18v16H3zM9 4v16",
  chevron: "M7 10l5 5 5-5",
  plus: "M12 5v14M5 12h14",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  table: "M3 4h18v16H3zM3 10h18M9 10v10",
  view: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  diff: "M8 4v16M16 4v16M4 9h8M12 15h8",
  notebook: "M6 3h13v18H6zM3 7h3M3 12h3M3 17h3M10 8h6M10 12h6",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  folder: "M3 6h6l2 2h10v11H3z",
  play: "M7 4l12 8-12 8z",
  playAll: "M4 5l8 7-8 7zM13 5l8 7-8 7z",
  stop: "M6 6h12v12H6z",
  explain: "M4 4h6v5H4zM14 15h6v5h-6zM7 9v8h7",
  save: "M4 4h13l3 3v13H4zM8 4v5h8V4M7 14h10v6H7z",
  format: "M4 6h16M4 10h10M4 14h16M4 18h10",
  download: "M12 4v11M7 10l5 5 5-5M4 19h16",
  copy: "M8 8h12v12H8zM4 16V4h12",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  duplicate: "M8 8h12v12H8zM4 16V4h12M14 11v6M11 14h6",
  sparkle: "M12 3v6M12 15v6M3 12h6M15 12h6",
  filter: "M3 5h18l-7 8v6l-4 2v-8z",
  sort: "M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4",
  check: "M4 12l5 5L20 6",
  x: "M6 6l12 12M18 6L6 18",
  pin: "M9 3h6l-1 6 4 4H6l4-4zM12 13v8",
  chart: "M4 20V10M10 20V4M16 20v-7M2 20h20",
  image: "M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 6M15 8h2v2h-2z",
  arrowRight: "M4 12h15M13 6l6 6-6 6",
  arrowLeft: "M20 12H5M11 6l-6 6 6 6",
  columns: "M3 4h18v16H3zM3 9h18M3 14h18",
  fit: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
  code: "M8 6l-6 6 6 6M16 6l6 6-6 6",
  users: "M5 4h8v8H5zM2 21v-5h14v5M17 5h4v6h-4M19 15h3v6",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
  keyboard: "M2 6h20v12H2zM6 10h1M10 10h1M14 10h1M18 10h1M7 14h10",
  columnAdd: "M3 4h10v16H3zM8 4v16M18 9v8M14 13h8",
  power: "M12 3v9M7 5.5A8 8 0 1 0 17 5.5",
  gear: "M18.79 10.31L21.35 10.33L21.35 13.67L18.79 13.69L18 15.61L19.79 17.43L17.43 19.79L15.61 18L13.69 18.79L13.67 21.35L10.33 21.35L10.31 18.79L8.39 18L6.57 19.79L4.21 17.43L6 15.61L5.21 13.69L2.65 13.67L2.65 10.33L5.21 10.31L6 8.39L4.21 6.57L6.57 4.21L8.39 6L10.31 5.21L10.33 2.65L13.67 2.65L13.69 5.21L15.61 6L17.43 4.21L19.79 6.57L18 8.39ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  bug: "M8 8h8v10H8zM12 8V5M5 11h3M16 11h3M5 16h3M16 16h3M9 4l1.5 2M15 4l-1.5 2",
  shield: "M12 3l8 3v6c0 4.5-3.5 7.5-8 9-4.5-1.5-8-4.5-8-9V6z",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7v1.5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
