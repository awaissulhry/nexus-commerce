'use client'

/**
 * ACR.6 (R5) — the rows behind the margin.
 *
 * The Dashboard has printed "True margin (30d)" since ACR.0.5, with a coverage note explaining how
 * much of 30d revenue the figure covers. What it never had was the ledger underneath: which SKU, on
 * which day, at what cost, after which fees. That lived only on the legacy `/marketing/advertising/
 * profit` grid — 854 rows on prod, 160 of them inside the window this page summarises — so the one
 * number an operator is asked to trust had no drill-down anywhere in this console.
 *
 * This is a PANEL on the page that already states the headline, not a new rail entry: the number and
 * its evidence belong on one screen. Same endpoint the legacy grid read (`/advertising/profit/daily`),
 * same marketplace filter as the rest of the dashboard.
 *
 * Two honesty rules carried over from the legacy grid, both load-bearing:
 *   · `trueProfitCents === null` is NOT zero profit — it means no cost price is loaded for that
 *     product. It renders as a dash with the reason on hover, never as €0.
 *   · The coverage badge says which of the four fee components are real. A row at 25% coverage and a
 *     row at 100% print the same-looking profit, and only the badge distinguishes them.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { getBackendUrl } from '@/lib/backend-url'
import { eur2, intl } from '../_canvas/format'

interface ProfitRow {
  id: string
  productId: string
  marketplace: string
  date: string
  unitsSold: number
  grossRevenueCents: number
  cogsCents: number
  referralFeesCents: number
  fbaFulfillmentFeesCents: number
  fbaStorageFeesCents: number
  advertisingSpendCents: number
  returnsRefundsCents: number
  trueProfitCents: number | null
  trueProfitMarginPct: string | null
  coverage: { hasCostPrice?: boolean; hasReferralFee?: boolean; hasFbaFee?: boolean; hasAdSpend?: boolean } | null
  product: { id: string; sku: string; name: string } | null
}

const COVERAGE_FIELDS: Array<[keyof NonNullable<ProfitRow['coverage']>, string]> = [
  ['hasCostPrice', 'cost price'],
  ['hasReferralFee', 'referral fee'],
  ['hasFbaFee', 'FBA fee'],
  ['hasAdSpend', 'ad spend'],
]

function coverage(c: ProfitRow['coverage']): { pct: number; missing: string[] } {
  const missing = COVERAGE_FIELDS.filter(([k]) => !c?.[k]).map(([, label]) => label)
  return { pct: (COVERAGE_FIELDS.length - missing.length) / COVERAGE_FIELDS.length, missing }
}

const band = (m: number | null): 'good' | 'warn' | 'bad' | 'none' => {
  if (m == null) return 'none'
  if (m >= 0.15) return 'good'
  if (m >= 0) return 'warn'
  return 'bad'
}

const cents = (c: number) => eur2(c / 100)

export function ProfitPanel({ market }: { market: string }) {
  const [rows, setRows] = useState<ProfitRow[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    setRows(null)
    setError(false)
    const mp = market === 'all' ? '' : `&marketplace=${market}`
    fetch(`${getBackendUrl()}/api/advertising/profit/daily?limit=500${mp}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive) setRows(Array.isArray(d?.items) ? d.items : []) })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [market])

  const loading = rows == null && !error

  // Totals over every row fetched, not just the visible slice — a footer that only added up what
  // you can see would disagree with itself the moment you scrolled.
  const t = (rows ?? []).reduce(
    (a, r) => {
      a.revenue += r.grossRevenueCents
      a.cogs += r.cogsCents
      a.fees += r.referralFeesCents + r.fbaFulfillmentFeesCents + r.fbaStorageFeesCents
      a.adSpend += r.advertisingSpendCents
      if (r.trueProfitCents != null) { a.profit += r.trueProfitCents; a.priced += 1 }
      return a
    },
    { revenue: 0, cogs: 0, fees: 0, adSpend: 0, profit: 0, priced: 0 },
  )
  // Only claim a margin when at least one row could compute a profit — an all-null sum divided by
  // revenue is a confident 0%, which is the one number that reads as "measured, and it is zero".
  const totalMargin = t.priced > 0 && t.revenue > 0 ? t.profit / t.revenue : null

  return (
    <div className="dash-card">
      <div className="dash-card-h">
        True profit · per SKU, per day
        {rows != null && rows.length > 0 && (
          <span className="dash-pnl-count">
            {intl(rows.length)} row{rows.length === 1 ? '' : 's'}
            {t.priced < rows.length && ` · ${intl(rows.length - t.priced)} without a cost price`}
          </span>
        )}
      </div>

      {loading ? (
        <div className="dash-empty">Loading…</div>
      ) : error || rows == null ? (
        <div className="dash-empty">Could not load the profit ledger.</div>
      ) : rows.length === 0 ? (
        <div className="dash-empty">
          No P&amp;L rows yet — the true-profit rollup has not run for this market.
        </div>
      ) : (
        <>
          <div className="dash-pnl-tot">
            {([
              ['Revenue', cents(t.revenue)],
              ['COGS', cents(t.cogs)],
              ['Fees', cents(t.fees)],
              ['Ad spend', cents(t.adSpend)],
              ['True profit', cents(t.profit)],
              ['Margin', totalMargin != null ? `${(totalMargin * 100).toFixed(1)}%` : '—'],
            ] as const).map(([k, v]) => (
              <div className="dash-pnl-t" key={k}>
                <span className="k">{k}</span>
                <span className={`v${k === 'Margin' ? ` b-${band(totalMargin)}` : ''}`}>{v}</span>
              </div>
            ))}
          </div>

          <div className="dash-pnl-scroll">
            <table className="dash-pnl">
              <thead>
                <tr>
                  <th>Date</th><th>SKU</th><th>Mkt</th>
                  <th className="r">Units</th><th className="r">Revenue</th><th className="r">COGS</th>
                  <th className="r">Fees</th><th className="r">Ad spend</th><th className="r">Profit</th>
                  <th className="r">Margin</th><th>Coverage</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const margin = r.trueProfitMarginPct != null ? Number(r.trueProfitMarginPct) : null
                  const cov = coverage(r.coverage)
                  return (
                    <tr key={r.id}>
                      <td className="mono">{new Date(r.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</td>
                      <td>
                        {r.product ? (
                          <Link className="dash-pnl-sku" href={`/products/${r.product.id}`} title={r.product.name}>{r.product.sku}</Link>
                        ) : <span className="mono dim">—</span>}
                      </td>
                      <td className="mono">{r.marketplace}</td>
                      <td className="r">{intl(r.unitsSold)}</td>
                      <td className="r">{cents(r.grossRevenueCents)}</td>
                      <td className="r">{cents(r.cogsCents)}</td>
                      <td className="r">{cents(r.referralFeesCents + r.fbaFulfillmentFeesCents + r.fbaStorageFeesCents)}</td>
                      <td className="r">{cents(r.advertisingSpendCents)}</td>
                      <td
                        className={`r ${r.trueProfitCents == null ? 'dim' : r.trueProfitCents >= 0 ? 'pos' : 'neg'}`}
                        title={r.trueProfitCents == null ? 'No cost price loaded for this product — not the same as zero profit.' : undefined}
                      >
                        {r.trueProfitCents == null ? '—' : cents(r.trueProfitCents)}
                      </td>
                      <td className="r">
                        <span className={`dash-pnl-b b-${band(margin)}`}>{margin != null ? `${(margin * 100).toFixed(0)}%` : '—'}</span>
                      </td>
                      <td>
                        <span
                          className={`dash-pnl-cov ${cov.pct >= 0.75 ? 'ok' : cov.pct >= 0.5 ? 'part' : 'thin'}`}
                          title={cov.missing.length ? `Missing: ${cov.missing.join(', ')}` : 'All four components are real'}
                        >
                          {Math.round(cov.pct * 100)}%
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
