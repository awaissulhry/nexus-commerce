import { zoneOf, type BodyZone } from '@nexus/factory-domain/sales/measure-link/rules'

/**
 * Where the tape goes (design sec:points "picture showing where the tape goes"; video Later, SAL-453): a plain front figure
 * with the tape drawn for the point's code — a girth as a loop, a length as a line — composed in the app (no DS part draws
 * bodies). A code the figure does not know shows its body zone shaded; the point's own words say the rest. Decorative for a
 * screen reader beside the point's name (aria-hidden), or an image with its name in the guide.
 */

type Tape = { readonly kind: 'loop'; readonly cx: number; readonly cy: number; readonly rx: number } | { readonly kind: 'line'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }

const loop = (cx: number, cy: number, rx: number): Tape => ({ kind: 'loop', cx, cy, rx })
const line = (x1: number, y1: number, x2: number, y2: number): Tape => ({ kind: 'line', x1, y1, x2, y2 })

const TAPES: Readonly<Record<string, Tape>> = {
  neck: loop(60, 40, 8),
  chest: loop(60, 68, 26),
  bust: loop(60, 68, 26),
  underbust: loop(60, 80, 24),
  waist: loop(60, 100, 21),
  belly: loop(60, 106, 23),
  hip: loop(60, 124, 26),
  hips: loop(60, 124, 26),
  seat: loop(60, 124, 26),
  shoulder: line(36, 52, 84, 52),
  shoulders: line(36, 52, 84, 52),
  shoulder_width: line(36, 52, 84, 52),
  back_width: line(38, 62, 82, 62),
  back_length: line(60, 44, 60, 102),
  nape_to_waist: line(60, 44, 60, 102),
  front_length: line(60, 48, 60, 130),
  torso: line(60, 48, 60, 130),
  torso_length: line(60, 48, 60, 130),
  jacket_length: line(60, 48, 60, 134),
  sleeve: line(36, 52, 18, 140),
  sleeve_length: line(36, 52, 18, 140),
  arm: line(36, 52, 18, 140),
  arm_length: line(36, 52, 18, 140),
  reach: line(36, 52, 18, 140),
  arm_reach: line(36, 52, 18, 140),
  bicep: loop(30, 78, 7),
  biceps: loop(30, 78, 7),
  upper_arm: loop(30, 78, 7),
  elbow: loop(26, 98, 6),
  forearm: loop(23, 116, 6),
  wrist: loop(19, 138, 5),
  hand: loop(18, 150, 6),
  crotch: line(60, 100, 60, 134),
  rise: line(60, 100, 60, 134),
  inside_leg: line(55, 136, 50, 244),
  inseam: line(55, 136, 50, 244),
  leg_length: line(55, 136, 50, 244),
  outside_leg: line(80, 112, 76, 244),
  outseam: line(80, 112, 76, 244),
  thigh: loop(48, 152, 11),
  knee: loop(49, 188, 8),
  knee_bend: loop(49, 188, 8),
  calf: loop(50, 212, 8),
  ankle: loop(50, 240, 6),
}

const ZONE_BAND: Readonly<Record<BodyZone, { y: number; height: number }>> = {
  UPPER: { y: 30, height: 100 },
  ARMS: { y: 50, height: 105 },
  LEGS: { y: 120, height: 130 },
  RIDING: { y: 30, height: 220 },
  OTHER: { y: 20, height: 235 },
}

const normal = (code: string): string => code.trim().toLowerCase().replace(/[\s-]+/g, '_')

/** The tape of a point code ("riding_knee" reads as "knee"), or null when the figure does not know it. */
export function tapeOf(code: string): Tape | null {
  const key = normal(code)
  return TAPES[key] ?? TAPES[key.replace(/^riding_/, '')] ?? null
}

export function BodyFigure({ code, label, size = 'sm' }: { code: string; label?: string; size?: 'sm' | 'lg' }) {
  const tape = tapeOf(code)
  const band = ZONE_BAND[zoneOf(code)]
  const accessible = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true }
  return (
    <svg className="fw-ms-figure" data-size={size} viewBox="0 0 120 260" focusable="false" {...accessible}>
      <g className="fw-ms-figure-body">
        <circle cx="60" cy="20" r="13" />
        <rect x="55" y="32" width="10" height="10" rx="3" />
        <path d="M36 48 Q60 40 84 48 L86 102 Q84 128 82 134 L38 134 Q36 128 34 102 Z" />
        <path d="M36 50 L18 142" />
        <path d="M84 50 L102 142" />
        <path d="M50 132 L48 246" />
        <path d="M70 132 L72 246" />
      </g>
      {tape === null ? <rect className="fw-ms-figure-zone" x="8" y={band.y} width="104" height={band.height} rx="10" /> : null}
      {tape?.kind === 'loop' ? <ellipse className="fw-ms-figure-tape" cx={tape.cx} cy={tape.cy} rx={tape.rx} ry={Math.max(3, tape.rx / 4)} /> : null}
      {tape?.kind === 'line' ? (
        <g className="fw-ms-figure-tape">
          <line x1={tape.x1} y1={tape.y1} x2={tape.x2} y2={tape.y2} />
          <circle cx={tape.x1} cy={tape.y1} r="2.5" />
          <circle cx={tape.x2} cy={tape.y2} r="2.5" />
        </g>
      ) : null}
    </svg>
  )
}
