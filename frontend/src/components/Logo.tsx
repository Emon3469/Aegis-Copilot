import clsx from "clsx";

export function Logo({ className, glow = false }: { className?: string; glow?: boolean }) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      className={clsx(className, glow && "drop-shadow-[0_0_14px_rgba(67,208,108,0.55)]")}
    >
      <defs>
        <linearGradient id="aegis-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8ef4ad" />
          <stop offset="1" stopColor="#25a852" />
        </linearGradient>
      </defs>
      <path d="M32 6 52 14v15c0 13.4-8.5 23.7-20 28.5C20.5 52.7 12 42.4 12 29V14l20-8Z" fill="url(#aegis-logo)" />
      <path
        d="m23.5 32.5 6 6 11.5-13"
        fill="none"
        stroke="#0c0f0d"
        strokeWidth="4.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
