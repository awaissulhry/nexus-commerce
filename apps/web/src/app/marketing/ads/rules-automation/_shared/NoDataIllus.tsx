/**
 * NoDataIllus — the Helium 10 "no data" empty-state mascot: a faint line-chart card with a
 * green "?" badge and a magnifier, replicated from the recording (campaign-picker empty panel +
 * Budget list empty state). Pure SVG, no deps. Colours sampled from the frame at native res.
 */
export function NoDataIllus({ size = 92 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.84} viewBox="0 0 120 100" fill="none" aria-hidden="true">
      {/* chart card */}
      <rect x="26" y="28" width="78" height="56" rx="7" fill="#f1f4f7" />
      {/* vertical gridlines */}
      {[42, 58, 74, 90].map((x) => <line key={x} x1={x} y1="34" x2={x} y2="78" stroke="#e3e8ee" strokeWidth="1.4" />)}
      {/* trend line + dots */}
      <path d="M33 70 L49 64 L65 68 L81 50 L97 40" fill="none" stroke="#c4ccd6" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      {[[33, 70], [49, 64], [65, 68], [81, 50], [97, 40]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="2.4" fill="#aeb8c4" />)}
      {/* tooltip pills on the line */}
      <rect x="44" y="54" width="11" height="7" rx="2" fill="#cfd6df" />
      <rect x="86" y="30" width="11" height="7" rx="2" fill="#cfd6df" />
      {/* baseline */}
      <line x1="30" y1="78" x2="100" y2="78" stroke="#dfe5ec" strokeWidth="2" strokeLinecap="round" />
      {/* green "?" badge */}
      <circle cx="34" cy="34" r="11" fill="#2cc38d" />
      <text x="34" y="39" textAnchor="middle" fontSize="14" fontWeight="700" fill="#fff" fontFamily="system-ui, sans-serif">?</text>
      {/* magnifier */}
      <circle cx="92" cy="68" r="13" fill="#fff" stroke="#27303a" strokeWidth="3.2" />
      <line x1="101" y1="77" x2="110" y2="86" stroke="#27303a" strokeWidth="3.6" strokeLinecap="round" />
    </svg>
  )
}
