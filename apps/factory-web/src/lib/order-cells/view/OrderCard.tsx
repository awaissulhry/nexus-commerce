'use client'

import type { ReactNode } from 'react'
import '../order-cells.css'

/**
 * pg-w1 (portal grid plan § 2, D3; 18-lead-settles Z1) — the phone card's block under the number, ONE frame for both faces (the
 * customer page's Work card, cw fx5 / fx6, moved here): the picture at the left (when there is one: a request has none), and beside
 * it its lines — the sub line (the PO, or a request's subject), the chips (the status chip and its marks, wrapping whole), and the
 * Promised line with the pieces. The card's top row (the number, its door, the bubble) is the list frame's own. The host draws each
 * line in its own words; the frame only lays them out (layout only, tokens only). It fetches nothing.
 */
export function OrderCard({ picture, sub, chips, promise }: { picture?: ReactNode; sub: ReactNode; chips: ReactNode; promise: ReactNode }) {
  return (
    <span className="fw-sheet-card">
      {picture !== undefined && <span className="fw-sheet-card-pic">{picture}</span>}
      <span className="fw-sheet-card-lines">
        {sub}
        <span className="fw-sheet-card-chips">{chips}</span>
        <span className="fw-sheet-card-promise">{promise}</span>
      </span>
    </span>
  )
}
