'use client'

/**
 * KT.4 — one term over time: share above, spend below, on ONE time-proportional axis.
 *
 * ── Why this is hand-rolled SVG and not one of the three things already here ──────────────────────
 *
 * The house rule is to check before hand-rolling, so all three were checked:
 *
 *   · **`bid/BidSpark.tsx`** — the closest thing, and deliberately decoupled ("takes points and a
 *     width, knows nothing about bids"). It does not fit for two reasons, both semantic: it is
 *     **step-interpolated**, because a bid holds its value until something writes a new one, and a
 *     weekly share is a *sampled measurement* that does no such holding — drawing it as a step
 *     claims the share was constant between readings. And it is 88×22 with no axis, no dates and no
 *     gap handling: a grid-cell sparkline, not a drawer chart.
 *   · **`_schedule/DaypartingChart.tsx`** — right scale (880×220, axes, two series) and the wrong
 *     x-axis: `xAt(i, n)` spaces points by INDEX, because 24 hours and 7 weekdays are categorical and
 *     evenly spaced. Weeks are not. 46 of IT's 97 measured terms have a span longer than 7 days
 *     somewhere in their history, and index-spacing renders every one of those gaps as an ordinary
 *     step — the exact "a missing week is not a zero" defect, moved from the value axis to the time
 *     axis.
 *   · **`recharts`** (a dependency, used by four ads pages) — not by either chart in THIS section.
 *     Both charts in Rules & Automation are hand-rolled SVG, so reaching for recharts here would add
 *     a third charting idiom to one section rather than removing one.
 *
 * So: the same inline-SVG idiom as its two neighbours, with the one thing neither has — a real time
 * axis. Promoting a shared time-series chart out of these three is a reconciliation job, not this
 * session's, and it is offered in the build record.
 *
 * ── The three rules this chart must not break ─────────────────────────────────────────────────────
 *   1. **A gap is a gap.** x is proportional to the date, and the line BREAKS across any span longer
 *      than 7 days rather than joining across it.
 *   2. **Fewer than 3 readings is not a line.** Dated points only — you cannot see a trend in two
 *      observations, and 19 IT terms plus 4 DE terms have exactly one.
 *   3. **The share series ends where it ends.** It stops 22–29 days before the spend series. Nothing
 *      is extended, interpolated or right-aligned; the empty stretch is the feed's silence at scale,
 *      and it is shaded and named.
 */

import { useId } from 'react'

export interface TermPoint {
  week: string
  share: number | null
  clickShare: number | null
  asins: number | null
  spendCents: number | null
  clicks: number | null
  orders: number | null
}

const W = 840
const H_SHARE = 132
const H_SPEND = 74
const PAD_L = 46
const PAD_R = 12
const PAD_T = 12
const GAP = 26

const pctLabel = (v: number) => `${(v * 100).toFixed(2)}%`
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const dayMonth = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`)
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`
}

export function TermChart({
  points, lastShareWeek, shareWeeks, market,
}: {
  points: TermPoint[]
  lastShareWeek: string | null
  shareWeeks: number
  market: string
}) {
  const clip = useId()
  if (points.length === 0) {
    return <p className="h10-kt-tc-none">No weekly reading and no spend for this term in {market}.</p>
  }

  const t = (w: string) => Date.parse(w)
  const t0 = t(points[0].week)
  const t1 = t(points[points.length - 1].week)
  const span = Math.max(1, t1 - t0)
  const innerW = W - PAD_L - PAD_R
  const x = (w: string) => PAD_L + ((t(w) - t0) / span) * innerW

  const shares = points.filter((p) => p.share != null)
  const maxShare = Math.max(...shares.map((p) => p.share!), 0.0001)
  const yShare = (v: number) => PAD_T + (H_SHARE - PAD_T - 18) * (1 - v / maxShare)

  const spends = points.filter((p) => (p.spendCents ?? 0) > 0)
  const maxSpend = Math.max(...spends.map((p) => p.spendCents!), 1)
  const spendTop = H_SHARE + GAP
  const ySpend = (v: number) => spendTop + (H_SPEND - 16) * (1 - v / maxSpend)

  // Rule 1 — break the path wherever the span exceeds 7 days, so a gap reads as a gap.
  const segments: TermPoint[][] = []
  let run: TermPoint[] = []
  for (const p of shares) {
    if (run.length && (t(p.week) - t(run[run.length - 1].week)) / 86_400_000 > 7) { segments.push(run); run = [] }
    run.push(p)
  }
  if (run.length) segments.push(run)
  const gapCount = segments.length - 1

  // Rule 3 — the stretch where spend continues and share has stopped.
  const silenceFrom = lastShareWeek && t(points[points.length - 1].week) > t(lastShareWeek) ? lastShareWeek : null

  const barW = Math.max(3, Math.min(16, innerW / Math.max(points.length, 1) - 3))
  const H = spendTop + H_SPEND

  return (
    <div className="h10-kt-tc">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" preserveAspectRatio="xMidYMid meet"
        aria-label={`${shareWeeks} weekly share readings and weekly spend for this term in ${market}`}>
        <clipPath id={clip}><rect x="0" y="0" width={W} height={H} /></clipPath>

        {/* the feed's silence, shaded before anything is drawn over it */}
        {silenceFrom && (
          <g className="silence">
            <rect x={x(silenceFrom)} y={PAD_T - 6} width={W - PAD_R - x(silenceFrom)} height={H - PAD_T} />
            <text x={x(silenceFrom) + 6} y={PAD_T + 6}>no Brand Analytics reading after {dayMonth(silenceFrom)}</text>
          </g>
        )}

        {/* share panel */}
        <g className="axis">
          <line x1={PAD_L} y1={yShare(maxShare)} x2={W - PAD_R} y2={yShare(maxShare)} />
          <line x1={PAD_L} y1={yShare(0)} x2={W - PAD_R} y2={yShare(0)} />
          <text x={PAD_L - 6} y={yShare(maxShare) + 4} textAnchor="end">{pctLabel(maxShare)}</text>
          <text x={PAD_L - 6} y={yShare(0) + 4} textAnchor="end">0%</text>
        </g>
        <g clipPath={`url(#${clip})`}>
          {/* Rule 2 — a line needs 3 readings; below that, dated points only */}
          {shareWeeks >= 3 && segments.map((seg, i) => (
            seg.length > 1 && (
              <path key={i} className="share-line" fill="none" vectorEffect="non-scaling-stroke"
                d={seg.map((p, j) => `${j === 0 ? 'M' : 'L'} ${x(p.week).toFixed(1)} ${yShare(p.share!).toFixed(1)}`).join(' ')} />
            )
          ))}
          {shares.map((p) => (
            <circle key={p.week} className="share-dot" cx={x(p.week)} cy={yShare(p.share!)} r={shareWeeks >= 3 ? 2.6 : 3.4}>
              <title>{`${dayMonth(p.week)}: ${pctLabel(p.share!)}${p.asins ? ` · ${p.asins} of our ASINs` : ''}${p.clickShare ? ` · click share ${pctLabel(p.clickShare)}` : ''}`}</title>
            </circle>
          ))}
        </g>

        {/* spend panel */}
        <g className="axis">
          <line x1={PAD_L} y1={ySpend(0)} x2={W - PAD_R} y2={ySpend(0)} />
          <text x={PAD_L - 6} y={ySpend(maxSpend) + 4} textAnchor="end">{eur(maxSpend)}</text>
        </g>
        <g clipPath={`url(#${clip})`}>
          {spends.map((p) => (
            <rect key={p.week} className="spend-bar"
              x={x(p.week) - barW / 2} y={ySpend(p.spendCents!)}
              width={barW} height={Math.max(1, ySpend(0) - ySpend(p.spendCents!))}>
              <title>{`${dayMonth(p.week)}: ${eur(p.spendCents!)}${p.clicks ? ` · ${p.clicks} clicks` : ''}${p.orders ? ` · ${p.orders} orders` : ''}`}</title>
            </rect>
          ))}
        </g>

        {/* the time axis — first, last, and the share's final reading */}
        <g className="ticks">
          <text x={PAD_L} y={H - 2}>{dayMonth(points[0].week)}</text>
          <text x={W - PAD_R} y={H - 2} textAnchor="end">{dayMonth(points[points.length - 1].week)}</text>
        </g>
      </svg>

      <p className="h10-kt-tc-legend">
        <span className="k share">share (weekly)</span>
        <span className="k spend">spend (weekly total)</span>
        {shareWeeks < 3 && (
          <span className="note">
            {shareWeeks === 0 ? 'no share reading' : `${shareWeeks} reading${shareWeeks === 1 ? '' : 's'} — too few to draw a line, so the point${shareWeeks === 1 ? '' : 's'} stand alone`}
          </span>
        )}
        {gapCount > 0 && <span className="note">{gapCount} gap{gapCount === 1 ? '' : 's'} — the feed skipped {gapCount === 1 ? 'a week' : 'weeks'}, so the line breaks rather than joining across</span>}
      </p>
    </div>
  )
}
