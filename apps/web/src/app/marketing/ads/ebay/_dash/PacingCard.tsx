'use client'

/**
 * ER3.3 (delta 3) — budget pacing: MTD vs monthly ceiling per marketplace
 * with a straight-line month-end projection, plus the CPC daily-budget block
 * (yesterday's utilisation + Limited-by-budget deep link). Honesty footnote:
 * 72h reconciliation, 2×-daily / 30.4×-monthly spend semantics.
 */
import Link from 'next/link'
import { eurC, type PacingPayload } from '../_lib'

export function PacingCard({ pacing }: { pacing: PacingPayload | null }) {
  return (
    <div className="dash-card">
      <div className="dash-card-h"><span>Budget pacing</span></div>
      {pacing == null ? (
        <div className="h10-cd-skel" aria-busy="true"><div className="sk-line w40" /><div className="sk-block" /></div>
      ) : (
        <div className="eb-pacing">
          {pacing.ceilings.map((cl) => (
            <div key={cl.marketplace} className="eb-pace-row">
              <div className="eb-pace-head">
                <b>{cl.marketplace.replace('EBAY_', 'eBay ')}</b>
                <span>{eurC(cl.mtdCents)} MTD of {eurC(cl.capCents)} ceiling · {cl.pct}%</span>
              </div>
              <div className="eb-pace-bar" role="img" aria-label={`${cl.pct}% of monthly ceiling used`}>
                <span className={`fill ${cl.pct >= 80 ? 'warn' : ''}`} style={{ width: `${Math.min(100, cl.pct)}%` }} />
              </div>
              <p className="eb-pace-proj">Straight-line month-end: <b>{eurC(cl.projectedCents)}</b>{cl.projectedCents > cl.capCents ? ' — over the ceiling at this pace' : ''}</p>
            </div>
          ))}
          <div className="eb-pace-cpc">
            <div className="eb-pace-head"><b>CPC daily budgets</b>
              <span>{pacing.cpc.campaigns} running campaign{pacing.cpc.campaigns === 1 ? '' : 's'} · {eurC(pacing.cpc.dailyBudgetCents)}/day total</span>
            </div>
            <p className="eb-pace-proj">
              Yesterday: <b>{eurC(pacing.cpc.ydayFeesCents)}</b>{pacing.cpc.utilizationPct != null && <> · {pacing.cpc.utilizationPct}% of budget</>}
              {pacing.cpc.limitedCount > 0 && (
                <> · <Link className="h10-am-link" href="/marketing/ads/ebay/campaigns?status=LIMITED">{pacing.cpc.limitedCount} limited by budget →</Link></>
              )}
            </p>
          </div>
          <p className="eb-pace-note">Fees reconcile for ~72h; eBay may spend up to 2× a daily budget in one day (monthly cap = 30.4× daily).</p>
        </div>
      )}
    </div>
  )
}
