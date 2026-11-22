import type { ReactNode } from 'react'
import './no-break.css'

/**
 * os-fx7 (W-18; 10-design P0-B6 "the number never breaks inside"): a title's record numbers ("SEED-SH-0004", "SO-2026-0088") kept
 * whole — each in a span that does not wrap; the rest of the title wraps as it likes. The text is unchanged (copy, search, names).
 */
const CODE = /([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)/g

export function noBreak(text: string): ReactNode {
  const parts = text.split(CODE)
  if (parts.length === 1) return text
  return parts.map((part, index) => (index % 2 === 1 ? <span key={index} className="fw-nb">{part}</span> : part))
}
