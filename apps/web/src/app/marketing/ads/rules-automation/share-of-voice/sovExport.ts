/**
 * SOV.6 — the CSV, and the header block that stops it outliving its caveat.
 *
 * A share of voice number is meaningless without the week it came from and how complete that week
 * was. On screen the page states both, loudly. A CSV that carried only the rows would strip exactly
 * the context this page exists to supply — and unlike the page, a file gets mailed around for weeks.
 * So the header block is the substance of this file; the row writer is the easy part.
 *
 * 🔴 EXPORTS ARE FORMATTERS, and this page has now been bitten twice by a formatter undoing a
 * decision the API made carefully:
 *   · `toFixed(2)` turned 2/93,869 into `0.00%`, indistinguishable from a real zero (SOV.0)
 *   · `AdsDataGrid` re-sorted past the server's confidence rank (SOV.1)
 * So: every share is written BOTH raw and formatted, and no non-zero value is ever allowed to
 * format as `0.00`.
 *
 * 🔴 And the five blank states survive as TOKENS, not as empty cells. `never-measured`,
 * `no-row-this-period`, `not-covered`, `delta-no-prior` and a real zero are five different facts;
 * a spreadsheet that renders them all as blank throws away the page's central distinction. They are
 * legended in the header so a reader who never saw the page can still tell them apart.
 */

export interface SovExportRow {
  query: string
  marketplace: string
  marketVolume: number | null
  marketRank: number | null
  marketImpressions: number | null
  ourImpressions: number | null
  share: number | null
  clickShare?: number | null
  marketClicks?: number | null
  ourClicks?: number | null
  deltaPt?: number | null
  deltaState?: string
  priorShare?: number | null
  adSpendCents?: number | null
  adCpcCents?: number | null
  adShare?: number | null
  signal?: string | null
  asinsCompeting: number
  state: string
  lastSeen?: string | null
  lowConfidence?: boolean
  lowConfidenceClicks?: boolean
  branded: boolean
  onList: boolean
}

/** The token a blank carries into the file. Never an empty cell — see the header note. */
export const BLANK_TOKENS: Record<string, string> = {
  measured: '',
  'not-covered': 'NOT_COVERED',
  'no-row-this-period': 'NO_ROW_THIS_WEEK',
  'never-measured': 'NEVER_MEASURED',
  'delta-no-prior': 'NO_PRIOR_WEEK',
}

const csvCell = (v: unknown): string => {
  if (v == null) return ''
  const s = String(v)
  // A leading =, +, - or @ makes a spreadsheet evaluate the cell. Our queries are user-supplied
  // Amazon search terms, so this is not hypothetical.
  const guarded = /^[=+\-@]/.test(s) ? `'${s}` : s
  return /[",\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

/**
 * A share as a percentage string, with the SAME guard the page uses: a non-zero value that would
 * round to `0.00` renders `<0.01` instead, because "we are barely present" and "we hold none of
 * this market" are different findings and a file must not merge them.
 */
export const fmtPct = (v: number | null | undefined): string => {
  if (v == null) return ''
  if (v === 0) return '0.00'
  const p = v * 100
  return p > 0 && p < 0.005 ? '<0.01' : p.toFixed(2)
}
export const fmtPt = (v: number | null | undefined): string => {
  if (v == null) return ''
  if (v === 0) return '0.00'
  const a = Math.abs(v)
  return `${v > 0 ? '+' : '-'}${a < 0.005 ? '<0.01' : a.toFixed(2)}`
}
const eur = (cents: number | null | undefined) => (cents == null ? '' : (cents / 100).toFixed(2))

export interface SovExportContext {
  market: string
  periodAsOf: string | null
  periodAgeDays: number | null
  periodRows: number
  periodThreshold: number
  periodBaseline: number
  periodComplete: boolean
  overrideActive: string | null
  overridePctOfBar: number | null
  rejectionAsOf?: string | null
  rejectionRows?: number
  rejectionShortBy?: number
  adWindowDays: number | null
  adLatest: string | null
  adAgeDays: number | null
  priorAsOf: string | null
  priorGapDays: number | null
  scopeLabel: string
  campaignsResolved: number
  campaignsInMarket: number
  asins: number
  asinsWithRows: number
  filters: Record<string, string>
  rowsExported: number
  rowsInScope: number
}

/**
 * The header block. Every line is a `#` comment so a spreadsheet keeps it in column A and a parser
 * can skip it, and every claim the page makes on screen is repeated here in full.
 */
export function buildSovCsv(rows: SovExportRow[], ctx: SovExportContext): string {
  const H: string[] = []
  H.push('# Share of Voice — Amazon Brand Analytics market share')
  H.push(`# Exported ${new Date().toISOString()}`)
  H.push(`# Market: ${ctx.market} · Scope: ${ctx.scopeLabel}`)
  H.push(`# Reach: ${ctx.campaignsResolved} of ${ctx.campaignsInMarket} campaigns · `
    + `${ctx.asinsWithRows} of ${ctx.asins} ASINs have Brand Analytics rows`)
  H.push('#')
  H.push('# THE SHARE COLUMNS COME FROM ONE WEEK:')
  H.push(`#   Period: week of ${ctx.periodAsOf ?? '(none)'} · ${ctx.periodAgeDays ?? '?'} days old`)
  H.push(`#   Completeness: ${ctx.periodRows} rows against a ${ctx.periodBaseline}-row normal week `
    + `(threshold ${ctx.periodThreshold}) — ${ctx.periodComplete ? 'COMPLETE' : 'INCOMPLETE'}`)
  if (ctx.overrideActive) {
    H.push(`#   🔴 OVERRIDE: this export was taken with ?period=${ctx.overrideActive}, a week the`)
    H.push(`#      completeness gate DECLINED (${ctx.overridePctOfBar ?? '?'}% of the bar).`)
    H.push('#      EVERY SHARE BELOW UNDER-REPORTS. It is not comparable with a default export.')
  } else if (ctx.rejectionAsOf) {
    H.push(`#   Note: a newer week (${ctx.rejectionAsOf}) exists and was declined — `
      + `${ctx.rejectionRows} rows, short by ${ctx.rejectionShortBy}. This file uses the complete week.`)
  }
  H.push('#')
  H.push('# THE AD COLUMNS COME FROM A DIFFERENT, DAILY WINDOW:')
  H.push(`#   Ad window: last ${ctx.adWindowDays ?? '?'} days · feed current to ${ctx.adLatest ?? '?'} `
    + `(${ctx.adAgeDays ?? '?'} days old)`)
  H.push('#   The two grains are NOT aligned and must not be compared row-wise as if they were.')
  H.push('#')
  H.push(`# Δ compares against the week of ${ctx.priorAsOf ?? '(none — no comparable prior week)'}`
    + (ctx.priorGapDays != null ? ` · ${ctx.priorGapDays} days earlier` : ''))
  H.push('#   Δ is in PERCENTAGE POINTS, not a percentage of a percentage.')
  H.push('#')
  H.push(`# Filters: ${Object.entries(ctx.filters).map(([k, v]) => `${k}=${v}`).join(' · ') || '(none)'}`)
  H.push(`# Rows: ${ctx.rowsExported} exported of ${ctx.rowsInScope} in scope`
    + (ctx.rowsExported !== ctx.rowsInScope ? '  ⚠ THESE DIFFER — the export is not the whole scope' : ''))
  H.push('#')
  H.push('# BLANKS ARE NOT ZEROS. A blank share cell carries one of these tokens in `state`:')
  H.push('#   NOT_COVERED       the market has this query this week; Brand Analytics reports on none of our scoped ASINs')
  H.push('#   NO_ROW_THIS_WEEK  the feed has this query here, but not in this week (see last_seen)')
  H.push('#   NEVER_MEASURED    the feed has never reported this query in this market')
  H.push('#   NO_PRIOR_WEEK     (delta_state) measured now, but absent from the comparable prior week')
  H.push('#   a real 0.00       we ARE measured and hold none of a real market — a finding, not a blank')
  H.push('#   low_confidence    the denominator is below this week\'s median; the percentage is real but the sample is not rankable')
  H.push('#')

  const cols = [
    'query', 'market', 'market_volume', 'market_rank', 'market_impressions', 'our_impressions',
    'share_pct', 'share_raw', 'state',
    'delta_pt', 'delta_raw', 'delta_state', 'prior_share_pct',
    'click_share_pct', 'click_share_raw', 'market_clicks', 'our_clicks',
    'ad_spend_eur', 'ad_cpc_eur', 'ad_spend_share_pct',
    'signal', 'asins_competing', 'last_seen', 'low_confidence', 'low_confidence_clicks',
    'branded', 'on_watchlist',
  ]
  const body = rows.map((r) => [
    r.query, r.marketplace, r.marketVolume, r.marketRank, r.marketImpressions, r.ourImpressions,
    // formatted AND raw: the formatted one is readable, the raw one is the only thing that
    // survives arithmetic without the rounding this page has twice been bitten by.
    r.state === 'measured' ? fmtPct(r.share) : '', r.state === 'measured' && r.share != null ? r.share : '',
    BLANK_TOKENS[r.state] ?? r.state,
    fmtPt(r.deltaPt), r.deltaPt ?? '', BLANK_TOKENS[r.deltaState ?? ''] ?? (r.deltaState ?? ''), fmtPct(r.priorShare),
    fmtPct(r.clickShare), r.clickShare ?? '', r.marketClicks ?? '', r.ourClicks ?? '',
    eur(r.adSpendCents), eur(r.adCpcCents), fmtPct(r.adShare),
    r.signal ?? '', r.asinsCompeting, r.lastSeen ?? '',
    r.lowConfidence ? 'yes' : '', r.lowConfidenceClicks ? 'yes' : '',
    r.branded ? 'yes' : '', r.onList ? 'yes' : '',
  ].map(csvCell).join(','))

  return `${H.join('\n')}\n${cols.join(',')}\n${body.join('\n')}\n`
}

/** market · the week the shares came from · when it was taken. */
export const sovCsvFilename = (market: string, periodAsOf: string | null) =>
  `share-of-voice_${market}_week-${periodAsOf ?? 'none'}_${new Date().toISOString().slice(0, 10)}.csv`
