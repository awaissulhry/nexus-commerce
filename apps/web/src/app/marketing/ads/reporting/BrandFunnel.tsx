'use client'

/**
 * BM.2 — the customer journey, as far as Amazon actually tells us.
 *
 * Helium 10 draws this as three semicircular gauges reading "Nth percentile". We
 * were going to copy that. BM.0 tested it first and it does not hold:
 *
 *   · A percentile rank must read ~0.500 for a brand sitting ON the category
 *     median. Measured across production rows, a brand at the median scores
 *     0.717 on awareness for detail page views, 0.587 for add to carts, and
 *     brand-customers-at-median gives a SALES index of 0.702. Nothing lands on
 *     0.50.
 *   · Spearman(index, log(ours ÷ category median)) is 0.5–0.7 for detail page
 *     views, add to carts AND brand customers against ALL THREE indices. They are
 *     collinear composite scores, not one metric ranked per stage.
 *   · Awareness and consideration track each other to within 0.022 but are never
 *     quite equal — two computations over nearly the same input.
 *
 * So these are rendered as what they are: Amazon's own 0–1 composite score per
 * stage. Calling a 0.6902 "the 69th percentile" would have been a precise,
 * plausible, wrong number on every row in the account.
 *
 * ── And no conversion rate between stages ───────────────────────────────────────
 *
 * 🔴 The counts under each stage are NOT one cohort flowing downward, and dividing
 * one by the next would invent a funnel Amazon never described. `viewedDetailPage
 * Only`, `brandedSearchesOnly` and `brandedSearchesAndDetailPageViews` partition
 * shoppers by WHICH engagement signal they produced — the two "Only"s are about
 * signal type, not about failing to convert — and Amazon publishes no mapping from
 * those to add-to-carts or to customers. The honest surface shows each count where
 * it belongs and computes nothing across the boundary.
 *
 * Every figure here is benchmarked against its category in the cards below; the
 * stage carries the bare count so the journey stays scannable and one number does
 * not appear twice with two different treatments.
 */
import { Info } from 'lucide-react'
import { HoverCard } from '../campaigns/FilterDropdown'

export interface FunnelStage {
  key: string
  label: string
  tip: string
  /** Amazon's 0–1 composite for this stage. null renders an em-dash and no bar. */
  index: number | null
  /** Display string for the index, formatted by the server's declared format. */
  indexLabel: string
  /** The counts Amazon reports in this region of the journey, already formatted. */
  counts: Array<{ label: string; value: string }>
}

export function BrandFunnel({ stages }: { stages: FunnelStage[] }) {
  return (
    <div className="rpt-bm-funnel">
      {stages.map((s) => (
        <div key={s.key} className="rpt-bm-stage">
          <div className="rpt-bm-stage-hd">
            <span>{s.label}</span>
            <HoverCard text={s.tip}>
              <Info size={12} aria-hidden />
            </HoverCard>
          </div>

          <div className="rpt-bm-stage-val">{s.indexLabel}</div>

          {/* The index is a 0–1 score, so the track IS the full domain — unlike the
              benchmark cards, whose scale is the category's top performer. */}
          <div className="rpt-bm-track">
            {s.index !== null && (
              <div className="rpt-bm-bar is-index">
                <i className="fill" style={{ width: `${Math.max(0, Math.min(100, s.index * 100))}%` }} />
              </div>
            )}
          </div>

          <dl className="rpt-bm-stage-counts">
            {s.counts.map((c) => (
              <div key={c.label}>
                <dt>{c.label}</dt>
                <dd>{c.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  )
}
