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
import { DataGrid, type Column } from '@/design-system/components'
import { eur2, intl } from '../_canvas/format'

/**
 * The per-SKU profit columns. `trueProfitCents == null` means no cost price was ever loaded for
 * that product — NOT zero profit — so it sorts as -Infinity and the cell keeps saying so.
 */
function profitColumns(): Array<Column<ProfitRow>> {
  const fees = (r: ProfitRow) => r.referralFeesCents + r.fbaFulfillmentFeesCents + r.fbaStorageFeesCents
  return [
    { key: 'date', label: 'Date', sortable: true, sortValue: (r) => r.date, render: (r) => <span className="mono">{new Date(r.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</span> },
    {
      key: 'sku', label: 'SKU', sortable: true, sortValue: (r) => r.product?.sku ?? '',
      render: (r) => (r.product
        ? <Link className="dash-pnl-sku" href={`/products/${r.product.id}`} title={r.product.name}>{r.product.sku}</Link>
        : <span className="mono dim">—</span>),
    },
    { key: 'mkt', label: 'Mkt', sortable: true, sortValue: (r) => r.marketplace, render: (r) => <span className="mono">{r.marketplace}</span> },
    { key: 'units', label: 'Units', align: 'right', sortable: true, sortValue: (r) => r.unitsSold, render: (r) => intl(r.unitsSold) },
    { key: 'revenue', label: 'Revenue', align: 'right', sortable: true, sortValue: (r) => r.grossRevenueCents, render: (r) => cents(r.grossRevenueCents) },
    { key: 'cogs', label: 'COGS', align: 'right', sortable: true, sortValue: (r) => r.cogsCents, render: (r) => cents(r.cogsCents) },
    { key: 'fees', label: 'Fees', align: 'right', sortable: true, sortValue: fees, render: (r) => cents(fees(r)) },
    { key: 'adspend', label: 'Ad spend', align: 'right', sortable: true, sortValue: (r) => r.advertisingSpendCents, render: (r) => cents(r.advertisingSpendCents) },
    {
      key: 'profit', label: 'Profit', align: 'right', sortable: true,
      sortValue: (r) => (r.trueProfitCents == null ? -Infinity : r.trueProfitCents),
      render: (r) => (
        <span
          className={r.trueProfitCents == null ? 'dim' : r.trueProfitCents >= 0 ? 'pos' : 'neg'}
          title={r.trueProfitCents == null ? 'No cost price loaded for this product — not the same as zero profit.' : undefined}
        >{r.trueProfitCents == null ? '—' : cents(r.trueProfitCents)}</span>
      ),
    },
    {
      key: 'margin', label: 'Margin', align: 'right', sortable: true,
      sortValue: (r) => (r.trueProfitMarginPct != null ? Number(r.trueProfitMarginPct) : -Infinity),
      render: (r) => {
        const m = r.trueProfitMarginPct != null ? Number(r.trueProfitMarginPct) : null
        return <span className={`dash-pnl-b b-${band(m)}`}>{m != null ? `${(m * 100).toFixed(0)}%` : '—'}</span>
      },
    },
    {
      key: 'coverage', label: 'Coverage', sortable: true, sortValue: (r) => coverage(r.coverage).pct,
      render: (r) => {
        const cov = coverage(r.coverage)
        return (
          <span
            className={`dash-pnl-cov ${cov.pct >= 0.75 ? 'ok' : cov.pct >= 0.5 ? 'part' : 'thin'}`}
            title={cov.missing.length ? `Missing: ${cov.missing.join(', ')}` : 'All four components are real'}
          >{Math.round(cov.pct * 100)}%</span>
        )
      },
    },
  ]
}

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

/**
 * THE WINDOW HAS TO MATCH THE KPI ABOVE IT.
 *
 * `/advertising/summary` computes "True margin (30d)" over `date >= now-30d`, across every row.
 * The first cut of this panel fetched `limit=500` with no date filter, which on prod meant the
 * most recent 500 of 854 lifetime rows — a different population, so its footer margin and the KPI
 * two inches above it would quote different percentages for the same account and both be "right".
 * That is the same defect shape as the 100-of-150 grid under an all-150 total found earlier in this
 * programme, and it is invisible to tsc.
 *
 * So: same 30 days, stated on the panel. 160 rows on prod, comfortably inside the cap — but the cap
 * is still reported if it ever binds, because a silently truncated ledger under a whole-account
 * headline is exactly what this comment exists to prevent.
 */
const WINDOW_DAYS = 30
const ROW_CAP = 500

export function ProfitPanel({ market }: { market: string }) {
  const [rows, setRows] = useState<ProfitRow[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    setRows(null)
    setError(false)
    const mp = market === 'all' ? '' : `&marketplace=${market}`
    const from = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10)
    fetch(`${getBackendUrl()}/api/advertising/profit/daily?limit=${ROW_CAP}&dateFrom=${from}${mp}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive) setRows(Array.isArray(d?.items) ? d.items : []) })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [market])

  const loading = rows == null && !error

  // Totals over every row fetched, not just the visible slice — a footer that only added up what
  // you can see would disagree with itself the moment you scrolled.
  //
  // `pricedRevenue` is tracked separately from `revenue` and it is the whole point. See below.
  const t = (rows ?? []).reduce(
    (a, r) => {
      a.revenue += r.grossRevenueCents
      a.cogs += r.cogsCents
      a.fees += r.referralFeesCents + r.fbaFulfillmentFeesCents + r.fbaStorageFeesCents
      a.adSpend += r.advertisingSpendCents
      if (r.trueProfitCents != null) {
        a.profit += r.trueProfitCents
        a.pricedRevenue += r.grossRevenueCents
        a.priced += 1
      }
      return a
    },
    { revenue: 0, cogs: 0, fees: 0, adSpend: 0, profit: 0, pricedRevenue: 0, priced: 0 },
  )

  /**
   * MARGIN IS PROFIT ÷ THE REVENUE THAT COULD BE PRICED — not ÷ all revenue.
   *
   * `/advertising/summary` does exactly this (ACR.0.5): it sums `trueProfitCents` and
   * `grossRevenueCents` over rows `WHERE trueProfitCents IS NOT NULL`, because dividing a partial
   * profit by total revenue understates margin in exact proportion to how much cost data is
   * missing. This panel divided by total revenue and therefore printed **16.1%** directly beneath
   * a KPI reading **37%** — measured on prod, both "right", neither trustworthy next to the other.
   *
   * With 268 of 500 rows carrying no cost price, that gap was not a rounding difference; it was the
   * panel silently answering a different question from the headline it sits under. Same window,
   * same denominator rule, and the coverage share is stated so a reader can see how much of the
   * account the figure actually speaks for.
   */
  const totalMargin = t.priced > 0 && t.pricedRevenue > 0 ? t.profit / t.pricedRevenue : null
  const coveredPct = t.revenue > 0 ? (t.pricedRevenue / t.revenue) * 100 : 0

  return (
    <div className="dash-card">
      <div className="dash-card-h">
        True profit · per SKU, per day · last {WINDOW_DAYS} days
        {rows != null && rows.length > 0 && (
          <span className="dash-pnl-count">
            {intl(rows.length)} row{rows.length === 1 ? '' : 's'}
            {t.priced < rows.length && ` · ${intl(rows.length - t.priced)} without a cost price`}
            {rows.length >= ROW_CAP && ` · capped at ${intl(ROW_CAP)}, totals cover only these`}
          </span>
        )}
      </div>

      {loading ? (
        <div className="dash-empty">Loading…</div>
      ) : error || rows == null ? (
        <div className="dash-empty">Could not load the profit ledger.</div>
      ) : rows.length === 0 ? (
        <div className="dash-empty">
          No P&amp;L rows in the last {WINDOW_DAYS} days for this market — the true-profit rollup has not run.
        </div>
      ) : (
        <>
          <div className="dash-pnl-tot">
            {([
              ['Revenue', cents(t.revenue), undefined],
              ['COGS', cents(t.cogs), undefined],
              ['Fees', cents(t.fees), undefined],
              ['Ad spend', cents(t.adSpend), undefined],
              ['True profit', cents(t.profit), t.priced < (rows?.length ?? 0) ? `over ${intl(t.priced)} priced row${t.priced === 1 ? '' : 's'}` : undefined],
              [
                'Margin',
                totalMargin != null ? `${(totalMargin * 100).toFixed(1)}%` : '—',
                // Same sentence the KPI above uses, for the same reason: a margin that covers
                // 40% of revenue and one that covers all of it must not look identical.
                totalMargin != null && coveredPct < 99.5 ? `covers ${coveredPct.toFixed(0)}% of revenue` : undefined,
              ],
            ] as const).map(([k, v, sub]) => (
              <div className="dash-pnl-t" key={k}>
                <span className="k">{k}</span>
                <span className={`v${k === 'Margin' ? ` b-${band(totalMargin)}` : ''}`}>{v}</span>
                {sub && <span className="s">{sub}</span>}
              </div>
            ))}
          </div>

          {/* Eleven columns of per-SKU profit — a real data grid, so it is the DS one. Sortable,
              which it was not: "which SKU is losing money" needed the profit column ordered. */}
          <DataGrid<ProfitRow>
            className="dash-pnl"
            rows={rows}
            rowKey={(r) => r.id}
            maxHeight={420}
            columns={profitColumns()}
          />
        </>
      )}
    </div>
  )
}
