/**
 * CBN.3.2 — shared grid formatters. Mirror the Ad Manager grid exactly (en-IE euros,
 * ratio-or-percent ACoS) so every grid in the console renders numbers identically.
 */
export const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)

export const eur = (v: unknown): string => `€${num(v).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Percent that accepts either a fraction (0.25 → 25.00%) or an already-scaled value (25 → 25.00%). */
export const pct = (v: unknown): string => {
  if (v == null || v === '') return '—'
  const n = Number(v)
  return Number.isFinite(n) ? `${(n <= 1 ? n * 100 : n).toFixed(2)}%` : '—'
}

export const int = (v: unknown): string => num(v).toLocaleString()

export const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  ENABLED: { label: 'Enabled', cls: 'ok' },
  PAUSED: { label: 'Paused', cls: 'warn' },
  ARCHIVED: { label: 'Archived', cls: 'arch' },
}

/**
 * Canonical Helium-10 metric definitions — the SINGLE source for the (i) hover
 * tooltips shown on filter labels and column headers across every console grid
 * (Ad Groups, Search Terms, Ads, Negative Targets, and the Ad Manager). Wording
 * is transcribed verbatim from H10 so the copy matches pixel-for-pixel; change a
 * definition here and it updates everywhere. Keyed by the metric's filter/column key.
 */
export const METRIC_TIPS: Record<string, string> = {
  acos: '(Advertising Cost of Sales) is the percent of attributed sales spent on advertising within the specified timeframe due to clicks on your ads. This is calculated by dividing total PPC spend by total PPC sales',
  roas: 'Return on Ad Spend (ROAS) is the revenue you receive from your advertising investment. This is the inverse of ACoS and is calculated by dividing PPC sales by your PPC spend',
  spend: 'The total cost spent on clicks',
  sales: 'The total value of all products sold to shoppers within the specified timeframe. Note this could include sales for products other than what is being advertised in the PPC campaign',
  clicks: 'The number of times your ads were clicked',
  ppcOrders: 'The number of Amazon orders shoppers submitted after clicking on your ads. Note this could include orders for products other than what is being advertised in the PPC campaign',
  cpc: 'Cost-per-click (CPC) is the average amount you paid for each click on an ad',
  ctr: 'Click-through rate (CTR) is the ratio of how often shoppers click on your PPC ad when displayed. This is calculated as clicks divided by impressions',
  cvr: 'Conversion rate (CVR) is the percentage of shoppers who clicked on an ad and placed an order. This is calculated as orders divided by clicks',
  impressions: 'The number of times ads were displayed',
}

/** "June 18, 2026, 5:31 PM" from the latest sync stamp across rows (H10 "Latest Report"). */
export const latestReportLabel = (stamps: Array<string | null | undefined>): string => {
  let max = 0
  for (const s of stamps) { const t = s ? Date.parse(s) : 0; if (t > max) max = t }
  return max ? new Date(max).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'
}
