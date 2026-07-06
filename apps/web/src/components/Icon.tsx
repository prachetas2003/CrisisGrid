/** Minimal inline icon set — no icon library dependency. */

const PATHS: Record<string, string> = {
  message: "M4 4h16v12H7l-3 3V4z",
  cloud: "M6 18a4 4 0 0 1-.4-8A6 6 0 0 1 17 7.5 4.5 4.5 0 0 1 17.5 18H6z",
  zap: "M13 2 4 14h6l-1 8 9-12h-6l1-8z",
  route: "M5 20a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm14-12a2 2 0 1 1 0-4 2 2 0 0 1 0 4zM7 18h8a4 4 0 0 0 0-8H9a4 4 0 0 1 0-8", 
  home: "M3 11 12 3l9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9z",
  shield: "M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z",
  check: "M20 6 9 17l-5-5",
  megaphone: "M3 10v4l4 1 11 5V4L7 9l-4 1zm15-1v6",
  file: "M6 2h9l5 5v15H6V2zm9 0v5h5",
  bot: "M8 7h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3zm4-5v5M9 13h.01M15 13h.01",
  hospital: "M4 21V7l8-4 8 4v14H4zm8-12v6m-3-3h6",
  substation: "M13 2 4 14h6l-1 8 9-12h-6l1-8z",
  water: "M12 2s7 8 7 13a7 7 0 0 1-14 0c0-5 7-13 7-13z",
  staging: "M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6",
  play: "M6 4l14 8-14 8V4z",
  pause: "M7 4h4v16H7zM13 4h4v16h-4z",
  x: "M6 6l12 12M18 6 6 18",
  arrowRight: "M5 12h14m-6-6 6 6-6 6",
  alert: "M12 2 1 21h22L12 2zm0 8v4m0 3h.01",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-14v6l4 2",
  gavel: "M14 4l6 6m-9-3 6 6M4 20l7-7m-1-5 6 6",
  scale: "M12 3v18M8 21h8M6 7l-3 6a3.5 3.5 0 0 0 6 0L6 7zm12 0-3 6a3.5 3.5 0 0 0 6 0l-3-6zM4 7h16",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  phone: "M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm3 17h4",
  download: "M12 3v12m-5-5 5 5 5-5M4 21h16",
  flask: "M9 3h6M10 3v6l-6 9a2 2 0 0 0 1.7 3h12.6A2 2 0 0 0 20 18l-6-9V3",
  layers: "M12 2 2 8l10 6 10-6-10-6zM2 14l10 6 10-6",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-14h.01M11 12h1v5h1",
};

export function Icon({
  name,
  size = 16,
  className = "",
  color,
}: {
  name: string;
  size?: number;
  className?: string;
  color?: string;
}) {
  const d = PATHS[name] ?? PATHS.bot!;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? "currentColor"}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}
