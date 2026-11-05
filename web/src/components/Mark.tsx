import { useId } from "react";

/** Original blob mark: glossy body, two slanted eyes. Not a copy of any product asset. */
export function Mark({ size = 28, thinking = false, color = false }: { size?: number; thinking?: boolean; color?: boolean }) {
  const raw = useId().replace(/:/g, "");
  return (
    <span className={`mascot ${color ? "color" : ""} ${thinking ? "thinking" : ""}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 64 64">
        <defs>
          <linearGradient id={raw} x1="20%" y1="0%" x2="80%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="55%" stopColor="#f4f4f6" />
            <stop offset="100%" stopColor="#d9d9de" />
          </linearGradient>
        </defs>
        <path
          fill={`url(#${raw})`}
          d="M34 8c9.5 1 18 7 20.5 16.2 2.4 8.6-.2 16.2-5.6 21.6-6.2 6.2-15 9.4-23.2 7.2C15.2 50.6 8 41.4 8 31.2 8 17.8 19.2 6.6 34 8Z"
        />
        <ellipse cx="24" cy="20" rx="9" ry="5" fill="#fff" opacity="0.7" />
        <g className="eyes" fill="#16161a">
          <ellipse cx="26" cy="34" rx="3.1" ry="6.4" transform="rotate(-16 26 34)" />
          <ellipse cx="40" cy="31.5" rx="2.8" ry="5.6" transform="rotate(-16 40 31.5)" />
        </g>
      </svg>
    </span>
  );
}
