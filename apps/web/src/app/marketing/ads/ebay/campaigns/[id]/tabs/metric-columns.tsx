'use client'

/**
 * ER1 — shared metric GridColumns for the detail tabs (C2/C7/C8/D2): one
 * definition of Impressions/Clicks/CTR/Spend/Sales/ACOS/ROAS/Sold with
 * Amazon-style names, currency-aware money(), and pinned totals.
 */
import type { GridColumn } from '../../../../campaigns/_grid/AdsDataGrid'
import { int, pct, money } from '../../../../campaigns/_grid/format'
import { mapMetrics, type Derived } from '../../../_lib'

export function metricColumns<T extends { metrics: Derived }>(rows: T[], currency: string): GridColumn<T>[] {
  const m = (r: T) => mapMetrics(r.metrics)
  const sum = (f: (x: ReturnType<typeof mapMetrics>) => number) => rows.reduce((a, r) => a + f(m(r)), 0)
  const totSpend = sum((x) => x.spendCents)
  const totSales = sum((x) => x.salesCents)
  return [
    { key: 'impressions', label: 'Impressions', render: (r) => int(m(r).impressions), sortValue: (r) => m(r).impressions, filterValue: (r) => m(r).impressions, total: int(sum((x) => x.impressions)) },
    { key: 'clicks', label: 'Clicks', render: (r) => int(m(r).clicks), sortValue: (r) => m(r).clicks, filterValue: (r) => m(r).clicks, total: int(sum((x) => x.clicks)) },
    { key: 'ctr', label: 'CTR', render: (r) => (m(r).ctr != null ? pct(m(r).ctr! / 100) : '—'), sortValue: (r) => m(r).ctr ?? -1 },
    { key: 'spend', label: 'Ad Fees', tip: 'eBay ad fees in the window (CPS: charged on attributed sales; CPC: charged per click).', render: (r) => money(m(r).spendCents, currency), sortValue: (r) => m(r).spendCents, filterValue: (r) => m(r).spendCents / 100, total: money(totSpend, currency) },
    { key: 'sales', label: 'Ad Sales', tip: 'Any-click attributed sales (a fee applies when any buyer clicks and any buyer purchases within 30 days).', render: (r) => money(m(r).salesCents, currency), sortValue: (r) => m(r).salesCents, filterValue: (r) => m(r).salesCents / 100, total: money(totSales, currency) },
    { key: 'acos', label: 'ACOS', tip: 'Ad fees ÷ attributed sales. Post-any-click this trends high by construction — judge vs break-even, not vs Amazon norms.', render: (r) => (m(r).acos != null ? pct(m(r).acos! / 100) : '—'), sortValue: (r) => m(r).acos ?? -1, total: totSales > 0 ? pct(totSpend / totSales) : '—' },
    { key: 'roas', label: 'ROAS', tip: 'Attributed sales ÷ ad fees.', render: (r) => (m(r).roas != null ? `${m(r).roas!.toFixed(2)}` : '—'), sortValue: (r) => m(r).roas ?? -1, total: totSpend > 0 ? (totSales / totSpend).toFixed(2) : '—' },
    { key: 'sold', label: 'Sold', render: (r) => int(m(r).sold), sortValue: (r) => m(r).sold, total: int(sum((x) => x.sold)) },
  ]
}
