/**
 * CBN — Campaign Builder / AI Advertising illustrated icons, recreated as inline SVG
 * to pixel-match the Helium 10 source (each sits inside the light-blue `.h10-cb-ic`
 * circle the card draws). Shared so the Campaign-Builder type chooser and the
 * AI-Goal builder use one source of truth.
 */
import type { CSSProperties } from 'react'

type P = { size?: number; style?: CSSProperties }
const box = (size: number, style?: CSSProperties): CSSProperties => ({ width: size, height: size, display: 'block', ...style })

/* AI Goal — atom: two crossed elliptical orbits, blue→teal→purple gradient stroke. */
export function IconAtom({ size = 36, style }: P) {
  return (
    <svg viewBox="0 0 48 48" fill="none" style={box(size, style)} aria-hidden>
      <defs>
        <linearGradient id="cbAtom" x1="9" y1="9" x2="39" y2="39" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2f86e0" />
          <stop offset="0.5" stopColor="#2bb6b8" />
          <stop offset="1" stopColor="#8b3fd6" />
        </linearGradient>
      </defs>
      <g stroke="url(#cbAtom)" strokeWidth="3">
        <ellipse cx="24" cy="24" rx="6.4" ry="18.5" transform="rotate(45 24 24)" />
        <ellipse cx="24" cy="24" rx="6.4" ry="18.5" transform="rotate(-45 24 24)" />
      </g>
      <circle cx="24" cy="24" r="1.9" fill="url(#cbAtom)" />
    </svg>
  )
}

/* Quick — white cloud with a yellow lightning bolt punching through it. */
export function IconQuick({ size = 36, style }: P) {
  return (
    <svg viewBox="0 0 48 48" fill="none" style={box(size, style)} aria-hidden>
      <defs>
        <linearGradient id="cbBolt" x1="20" y1="8" x2="28" y2="42" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffd633" />
          <stop offset="1" stopColor="#f5b400" />
        </linearGradient>
      </defs>
      <g transform="translate(24 25) scale(1.16) translate(-24 -25)">
        {/* cloud */}
        <path d="M14.5 33c-3.6 0-6.5-2.8-6.5-6.3 0-3.2 2.5-5.9 5.7-6.3.9-3.8 4.4-6.6 8.5-6.6 3.6 0 6.7 2.2 8 5.3.5-.1 1-.2 1.6-.2 3.4 0 6.2 2.7 6.2 6 0 3.4-2.8 6.1-6.2 6.1H14.5Z" fill="#fff" />
        {/* lightning bolt */}
        <path d="M26 12 15 28.5h7l-3 12.5L34 21h-7.6l3.4-9H26Z" fill="url(#cbBolt)" />
      </g>
    </svg>
  )
}

/* isometric cube primitive — top diamond + left + right face. */
function Cube({ cx, cy, r = 8.4, h = 8.4, top, left, right }: { cx: number; cy: number; r?: number; h?: number; top: string; left: string; right: string }) {
  const hr = r / 2
  return (
    <g>
      <path d={`M${cx} ${cy - hr} L${cx + r} ${cy} L${cx} ${cy + hr} L${cx - r} ${cy} Z`} fill={top} />
      <path d={`M${cx - r} ${cy} L${cx} ${cy + hr} L${cx} ${cy + hr + h} L${cx - r} ${cy + h} Z`} fill={left} />
      <path d={`M${cx + r} ${cy} L${cx} ${cy + hr} L${cx} ${cy + hr + h} L${cx + r} ${cy + h} Z`} fill={right} />
    </g>
  )
}

/* Guided — three stacked isometric cubes (grey on top, light + dark blue below). */
export function IconCubes({ size = 36, style }: P) {
  return (
    <svg viewBox="0 0 48 48" fill="none" style={box(size, style)} aria-hidden>
      <Cube cx={15} cy={27} r={9.4} h={9.4} top="#d4e7fb" left="#a9cef4" right="#c2def8" />
      <Cube cx={33} cy={27} r={9.4} h={9.4} top="#3f8ae8" left="#1b50a4" right="#2c6fd8" />
      <Cube cx={24} cy={12.5} r={9.4} h={9.4} top="#dfe4ea" left="#b4bdc9" right="#c9d0da" />
    </svg>
  )
}

/* SP Super Wizard — blue rocket flying up-right with a yellow exhaust droplet. */
export function IconRocket({ size = 36, style }: P) {
  return (
    <svg viewBox="0 0 48 48" fill="none" style={box(size, style)} aria-hidden>
      <g transform="translate(24 24) scale(1.12) translate(-24 -24)">
      <g transform="rotate(45 24 24)">
        {/* body */}
        <path d="M24 6c4.2 4 6 10.6 6 17.4v3.2H18v-3.2C18 16.6 19.8 10 24 6Z" fill="#2f74de" />
        {/* nose highlight */}
        <path d="M24 6c2.4 2.3 4 5.6 5 9.4-1.6-1-3.3-1.5-5-1.5s-3.4.5-5 1.5c1-3.8 2.6-7.1 5-9.4Z" fill="#4f97ef" />
        {/* fins */}
        <path d="M18 23.5 13 30l5-1.6V23.5Zm12 0 5 6.5-5-1.6V23.5Z" fill="#1b50a4" />
        {/* window */}
        <circle cx="24" cy="17" r="3.1" fill="#fff" />
      </g>
      {/* exhaust droplet (lower-left) */}
      <path d="M14.2 31.6c-1.9 1.9-2.2 4.6-1.6 5.8.6.6 3.3.3 5.2-1.6 1.5-1.5 1.3-3.8 0-5.1-1.3-1.3-3.6-1.5-3.6.9Z" fill="#f5b400" />
      </g>
    </svg>
  )
}

/* Single Campaign — one solid blue isometric cube. */
export function IconCube({ size = 36, style }: P) {
  return (
    <svg viewBox="0 0 48 48" fill="none" style={box(size, style)} aria-hidden>
      <Cube cx={24} cy={13.5} r={14.5} h={14.5} top="#3f8ae8" left="#2c6fd8" right="#1b50a4" />
    </svg>
  )
}

/* ── AI-Goal "Select AI Target" icons (simple blue line glyphs in the same circle) ── */

/* Impression & Click — eye. */
export function IconEye({ size = 30, style }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#2f74de" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={box(size, style)} aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

/* Sales — bar chart with an upward trend arrow. */
export function IconBars({ size = 30, style }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#2f74de" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={box(size, style)} aria-hidden>
      <path d="M4 20V12M9 20V8M14 20v-5" />
      <path d="M3 9.5 9 5l4 3 7-5.5" />
      <path d="M17 2.5h3.5V6" />
    </svg>
  )
}

/* ROAS — jagged line chart trending up. */
export function IconLine({ size = 30, style }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#2f74de" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={box(size, style)} aria-hidden>
      <path d="M3 17 8 11l3.5 3.5L20 5" />
      <path d="M15.5 5H20v4.5" />
    </svg>
  )
}
