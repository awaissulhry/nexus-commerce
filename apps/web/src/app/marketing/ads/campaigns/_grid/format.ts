/**
 * CBN.3.2 — shared grid formatters. Mirror the Ad Manager grid exactly (en-IE euros,
 * fraction ACoS) so every grid in the console renders numbers identically.
 */
export const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)

export const eur = (v: unknown): string => `€${num(v).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * THE percent formatter of the ads console: a FRACTION in, a percent out — 0.25 → "25.00%",
 * 1.5 → "150.00%", -0.05 → "-5.00%". `dp` is the number of decimals (2 in grids).
 *
 * 🔴 AM-4 — this used to GUESS (`n <= 1 ? n * 100 : n`): any value above 1 was taken as "already a
 * percent", so an eBay ACOS of 150% (fraction 1.5) printed "1.50%" — the worst row showing the
 * best-looking number. The Amazon grid dropped the same guess in ADM-H P7. No guessing now: every
 * API field states its unit next to its type, and a caller holding PERCENT POINTS (25 for 25%)
 * divides by 100 at the call site, where the unit is visible (`pct(r.acosPct / 100)`).
 */
export const pct = (v: unknown, dp = 2): string => {
  if (v == null || v === '') return '—'
  const n = Number(v)
  return Number.isFinite(n) ? `${(n * 100).toFixed(dp)}%` : '—'
}

/**
 * The sort/filter value of "spent money, no sales": worse than every real ACoS. Finite on
 * purpose — `a - b` of two of them is 0, never NaN, so a comparator stays a comparator.
 */
export const NO_SALES_ACOS = Number.MAX_VALUE

/**
 * AM-11 — ONE rule for sorting and filtering ACoS in every ads grid, in PERCENT POINTS (the unit
 * the ACoS filter box takes: "max 30" means 30 %).
 *
 *  · a real ACoS → its percent: the API's FRACTION × 100 when it sent one, else spend ÷ sales × 100;
 *  · spend and no sales → `NO_SALES_ACOS`: the WORST value. Last on "lowest first", first on
 *    "highest first", and never inside "ACoS max N %". It used to be 0 % — the best possible
 *    value — so "ACoS max 30 %" kept every campaign that spent and sold nothing;
 *  · nothing spent and nothing sold → `null`: there is no ACoS at all. It sorts as a blank (the
 *    grid sinks blanks in both directions) and matches no ACoS range.
 *
 * `spend` and `sales` only need the SAME unit as each other (euros, or cents).
 */
export function acosRank(acosFraction: number | string | null | undefined, spend: number, sales: number): number | null {
  if (acosFraction != null && acosFraction !== '') {
    const f = Number(acosFraction)
    if (Number.isFinite(f)) return f * 100
  }
  if (sales > 0) return (spend / sales) * 100
  if (spend > 0) return NO_SALES_ACOS
  return null
}

/**
 * `acosRank` for a range filter. The shared grid's filter reads NaN as "not measured" and never
 * lets such a row match a set range (`filterRows` rule 1), so "no ACoS" is NaN here, not 0.
 */
export const acosFilterValue = (acosFraction: number | string | null | undefined, spend: number, sales: number): number =>
  acosRank(acosFraction, spend, sales) ?? Number.NaN

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

/** ER1 (C7) — currency-aware money from integer cents; the eBay side's ONLY
 *  money formatter on rebuilt surfaces (never hardcode €). `eur` above stays
 *  for the Amazon console's decimal payloads. */
export const money = (cents: number | null | undefined, currency = 'EUR'): string =>
  cents == null ? '—' : (cents / 100).toLocaleString('en-IE', { style: 'currency', currency })
