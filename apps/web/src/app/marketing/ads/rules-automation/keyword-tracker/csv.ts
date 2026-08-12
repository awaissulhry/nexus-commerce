/**
 * KT.3 — the Keyword Tracker's CSV, in its own module because it is pure and because the web test
 * runner cannot import a `.tsx` (jsx: preserve). The types are structural rather than imported so
 * this file has no dependency on the component.
 */

export type KtCsvRowState = 'measured' | 'no-row-this-period' | 'never-measured' | 'not-measurable-here'

export interface KtCsvRow {
  keyword: string
  marketplace: string
  marketVolume?: number | null
  marketRank?: number | null
  impressionShare?: number | null
  shareBound?: number | null
  bestAsin?: string | null
  asinsCompeting: number
  asOf?: string | null
  lastSeen?: string | null
  state?: KtCsvRowState
  measured: boolean
  branded: boolean
  deltaPP?: number | null
  deltaGapDays?: number | null
  priorShare?: number | null
  priorPeriod?: string | null
  spendCents?: number | null
  clicks?: number | null
  orders?: number | null
  ad?: { adAsins: number; coveredAdAsins: number } | null
}

export interface KtCsvPayload {
  scope: {
    market: string
    list: { name: string } | null
    resolved: { asins: number; asinsCovered?: number }
  }
  window: { period?: string | null; periodAgeDays?: number | null; truncated?: boolean }
  topOfSearch?: { avgShare: number; campaignsWithReading: number; campaignsInScope: number; asOf: string | null } | null
  rows: KtCsvRow[]
}

const sharePct = (v: number) => `${(v * 100).toFixed(2)}%`
/** Tolerates a response predating `state` (a KT.1-era payload). */
const rowState = (r: KtCsvRow): KtCsvRowState => r.state ?? (r.measured ? 'measured' : 'never-measured')

/**
 * KT.3 — the CSV, and the bounds that must travel with it.
 *
 * An export that loses the coverage denominator is the most dangerous artefact this page can
 * produce: it lands in a spreadsheet, gets forwarded, and nothing on it says the share was measured
 * across 18 of 250 ASINs in a week that is 24 days old. So the preamble carries the market, the
 * watchlist, the period, the truncation flag and the denominator, and every blank exports as its
 * WORDS — `never measured`, `no row this week`, `not measurable here` and `0.00%` are four different
 * facts, and a spreadsheet flattens them all to an empty cell otherwise.
 *
 * Pure so a test can pin it without a DOM.
 */
export function buildCsv(rows: KtCsvRow[], d: KtCsvPayload): string {
  const q = (v: string | number | null | undefined) => {
    const t = v == null ? '' : String(v)
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
  }
  const shareCell = (r: KtCsvRow) => {
    switch (rowState(r)) {
      case 'measured': return sharePct(r.impressionShare ?? 0)
      case 'no-row-this-period': return 'no row this week'
      case 'not-measurable-here': return 'not measurable here'
      default: return 'never measured'
    }
  }
  const pre: string[][] = [
    ['Nexus — Keyword Tracker export'],
    ['market', d.scope.market],
    ['watchlist', d.scope.list?.name ?? '(none)'],
    ['period this grid reads', d.window.period ?? '(none)', d.window.periodAgeDays != null ? `${d.window.periodAgeDays} days old` : ''],
    ['week complete?', d.window.truncated ? 'NO — truncated week, every share below is suspect' : 'yes'],
    ['coverage', d.scope.resolved.asinsCovered != null
      ? `share measured across ${d.scope.resolved.asinsCovered} of ${d.scope.resolved.asins} advertised ASINs`
      : `${d.scope.resolved.asins} ASINs in scope`],
    ['brand terms', d.rows.some((r) => r.branded) ? 'included' : 'excluded'],
    ['share column', "our BEST single ASIN's share; 'share bound' is an UPPER bound over our ASINs, not a total"],
    ['spend column', 'spend on the exact query text in the SAME week as the share; per TERM, not per ASIN'],
    ['top-of-search IS', d.topOfSearch
      ? `${(d.topOfSearch.avgShare * 100).toFixed(2)}% across ${d.topOfSearch.campaignsWithReading} of ${d.topOfSearch.campaignsInScope} campaigns (to ${d.topOfSearch.asOf})`
      : 'no reading'],
    ['exported rows', String(rows.length)],
    [],
  ]
  const head = ['keyword', 'market', 'market volume', 'market rank', 'best ASIN share', 'share bound',
    'best ASIN', 'our ASINs on query', 'delta pp', 'gap days', 'prior share', 'prior week',
    'spend EUR (that week)', 'clicks', 'orders', 'as of', 'last seen', 'state', 'branded',
    'advertised ASINs on term', 'covered advertised ASINs']
  const body = rows.map((r) => [
    r.keyword, r.marketplace, r.marketVolume ?? '', r.marketRank ?? '',
    shareCell(r), r.shareBound != null ? sharePct(r.shareBound) : '',
    r.bestAsin ?? '', r.asinsCompeting,
    r.deltaPP != null ? r.deltaPP.toFixed(2) : (rowState(r) === 'measured' ? 'no earlier week' : ''),
    r.deltaGapDays ?? '', r.priorShare != null ? sharePct(r.priorShare) : '', r.priorPeriod ?? '',
    r.spendCents != null && r.spendCents > 0 ? (r.spendCents / 100).toFixed(2) : '',
    r.clicks ?? '', r.orders ?? '',
    r.asOf ?? '', r.lastSeen ?? '', rowState(r), r.branded ? 'yes' : 'no',
    r.ad?.adAsins ?? '', r.ad?.coveredAdAsins ?? '',
  ])
  return [...pre, head, ...body].map((row) => row.map(q).join(',')).join('\n')
}
