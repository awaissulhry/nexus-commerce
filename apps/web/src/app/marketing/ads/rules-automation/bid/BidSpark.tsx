'use client'

/**
 * BID.S2 — a step sparkline for a value that holds until something changes it.
 *
 * Built in `bid/` but with **no Bid-specific coupling**: it takes points and a width, and knows
 * nothing about bids, targets or currency. Placement and Rank both want one; offered in
 * session-locks §4 the way BID.S0 offered `onFilterChange`. Moving this file to `_shared/` is the
 * whole of the promotion.
 *
 * ── 🔴 Why STEP interpolation, not a line ───────────────────────────────────────────────────────
 *
 * A bid is a step function. It is set to €0.28 and stays at €0.28 until something writes a new
 * value — it does not drift between the two. A plain polyline draws a diagonal between points and
 * so shows a gradual climb that never happened; on this account the real shape is a nightly square
 * wave (floor at 00:00, restore at 08:00 — a measured curve reads `2 → 28 → 2 → 28 → …`), and a
 * smoothed version of that is a picture of something else entirely.
 *
 * ── 🔴 Why "no points" is a MARK and not a blank ────────────────────────────────────────────────
 *
 * Only **607 of 2,944** enabled targets (20.6%) have had a bid write in 60 days. Four cells in five
 * have nothing to draw. Three renderings were possible and two of them lie:
 *
 *   · blank            — reads as "the chart is broken" or "still loading"
 *   · a flat line      — reads as "this bid has been stable", which is a claim about a bid nobody
 *                        has ever touched, and an operator would take it as reassurance
 *   · a dotted rule    — reads as "there is nothing here", which is the truth ✅
 *
 * ── One more thing this cell must not imply ─────────────────────────────────────────────────────
 *
 * The curve population and the metrics population are DIFFERENT SETS: 247 rows have a curve and no
 * metrics, 163 have metrics and no curve. A busy sparkline beside five empty metric columns is not
 * a contradiction, and neither is the reverse.
 */

import { useId } from 'react'

export interface SparkPoint {
  /** ISO instant */
  at: string
  /** the value the write intended */
  to: number
  from: number | null
  /** 'SUCCESS' | 'FAILED' | 'PENDING' | null */
  delivered: string | null
}

const W = 88
const H = 22
const PAD = 2

export function BidSpark({
  points,
  label,
  format = (n: number) => String(n),
}: {
  points: SparkPoint[] | undefined
  /** what the row is, for the accessible description */
  label: string
  format?: (n: number) => string
}) {
  const clipId = useId()

  // Nothing ever changed this value. Say exactly that.
  if (!points || points.length === 0) {
    return (
      <span
        className="h10-bd-spark none"
        title={`No recorded bid change for ${label} in the last 60 days. 2,337 of the 2,944 enabled targets are in the same position — the bid has simply never been written, which is not the same as a bid that has been steady.`}
        aria-label="never changed"
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-hidden="true">
          <line x1={PAD} y1={H / 2} x2={W - PAD} y2={H / 2} strokeDasharray="2 3" />
        </svg>
      </span>
    )
  }

  const values = points.map((p) => p.to)
  // A single point is a real event, not a curve. Draw it as a dot at mid-height rather than
  // dividing by a zero range.
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min

  const x = (i: number) => PAD + (points.length === 1 ? (W - PAD * 2) / 2 : (i / (points.length - 1)) * (W - PAD * 2))
  const y = (v: number) => (range === 0 ? H / 2 : H - PAD - ((v - min) / range) * (H - PAD * 2))

  // Step-after: hold the previous value until the instant the new one was written.
  const d: string[] = []
  points.forEach((p, i) => {
    const px = x(i)
    const py = y(p.to)
    if (i === 0) d.push(`M ${px.toFixed(1)} ${py.toFixed(1)}`)
    else {
      d.push(`L ${px.toFixed(1)} ${y(points[i - 1].to).toFixed(1)}`)
      d.push(`L ${px.toFixed(1)} ${py.toFixed(1)}`)
    }
  })
  // Carry the last value to the right edge — it is still in force now.
  if (points.length > 1) d.push(`L ${(W - PAD).toFixed(1)} ${y(points[points.length - 1].to).toFixed(1)}`)

  const last = points[points.length - 1]
  const failed = points.filter((p) => p.delivered === 'FAILED').length
  const pending = points.filter((p) => p.delivered === 'PENDING').length

  const title = [
    `${points.length} recorded change${points.length === 1 ? '' : 's'} in 60 days`,
    `${format(min)} – ${format(max)}`,
    `now ${format(last.to)}`,
    // 🔴 The page study's §1 case: nineteen recorded cuts on a bid that never moved. If the writes
    // did not land, the curve is what we INTENDED and not what Amazon holds — the cell has to say
    // so, because the line looks identical either way.
    failed > 0 ? `⚠ ${failed} of these never reached Amazon — this is what we intended, not what Amazon holds` : '',
    pending > 0 ? `${pending} still in flight` : '',
  ].filter(Boolean).join(' · ')

  return (
    <span className={`h10-bd-spark${failed > 0 ? ' failed' : ''}`} title={`${label}: ${title}`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={title}>
        <clipPath id={clipId}><rect x="0" y="0" width={W} height={H} /></clipPath>
        <g clipPath={`url(#${clipId})`}>
          {points.length === 1
            ? <circle cx={x(0)} cy={y(points[0].to)} r={2} className="dot" />
            : <path d={d.join(' ')} fill="none" vectorEffect="non-scaling-stroke" />}
          {points.length > 1 && <circle cx={W - PAD} cy={y(last.to)} r={1.8} className="dot" />}
        </g>
      </svg>
    </span>
  )
}
