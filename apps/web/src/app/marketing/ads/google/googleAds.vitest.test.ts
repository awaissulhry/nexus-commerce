/**
 * Google Ads steps 1a and 1b — the rules of /marketing/ads/google, in the node-only web suite (the page, its tabs and the
 * campaign window are thin over `googleAds.ts`, `googleAttention.ts` and `googleGrains.ts`). Fixtures are made up: no
 * business names, numbers or ids (the repo is public).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { GoogleAccount, GoogleDay, GoogleMetrics, GoogleOverview } from '@/lib/google-ads/contract'
import {
  CAMPAIGN_COLUMN_ORDER,
  METRIC_COLUMN_KEYS,
  NOT_READ,
  biddingLabel,
  budgetText,
  campaignStatusHint,
  campaignStatusLabel,
  campaignTypeLabel,
  changeRows,
  changesNote,
  comparedWindow,
  chartHasMoney,
  chartPoints,
  coverageNote,
  currencyExponent,
  dataLine,
  dayRows,
  formatDay,
  formatMoney,
  formatWindow,
  googlePageState,
  metricColumns,
  metricTiles,
  metricsView,
  missingDaysText,
  provisionalDays,
  provisionalNote,
  ratiosOf,
  readNowNote,
  servingText,
  settingsReadText,
  sumMetrics,
  toMinor,
  withoutEmails,
  ymd,
} from './googleAds'
import { GoogleAdsHttpError } from '@/lib/google-ads/contract'
import {
  GOOGLE_READ_CACHE_MAX,
  GOOGLE_READ_TTL_MS,
  cachedGoogleRead,
  failedStatus,
  forgetGoogleReads,
  googleReadCacheKey,
  googleReadKey,
  listenGoogleRead,
  reloadGoogleRead,
  rememberGoogleRead,
  sharedGoogleRead,
} from './useGoogleRead'

function account(over: Partial<GoogleAccount> = {}): GoogleAccount {
  return {
    connectionId: 'conn_1',
    label: 'Google sign-in',
    state: 'ok',
    stateText: '',
    authStatus: 'connected',
    missingProducts: [],
    ads: { customerId: '1112223333', name: 'Shop One', currency: 'EUR', timeZone: 'Europe/Rome', isTest: false },
    manager: null,
    merchantCenter: null,
    analytics: null,
    read: { lastReadAt: '2026-10-13T06:30:00.000Z', lastDataDay: '2026-10-12', nextReadAt: '2026-10-14T06:25:00.000Z', lastError: null },
    ...over,
  }
}

const read = (date: string, spendCents: number, valueCents: number, provisional = false): GoogleDay => ({
  date, provisional, read: true, impressions: 1000, clicks: 50, spendCents, conversions: 2.5, conversionValueCents: valueCents,
})
const unread = (date: string): GoogleDay => ({ date, provisional: false, read: false, impressions: null, clicks: null, spendCents: null, conversions: null, conversionValueCents: null })

function overview(over: Partial<GoogleOverview> = {}): GoogleOverview {
  const a = account()
  return {
    accounts: [a],
    account: a,
    window: { from: '2026-10-10', to: '2026-10-12', provisionalFrom: '2026-10-12' },
    currency: 'EUR',
    timeZone: 'Europe/Rome',
    dataAsOf: '2026-10-13T06:30:00.000Z',
    coverage: { daysInWindow: 3, daysRead: 2, missingDays: ['2026-10-11'] },
    totals: { impressions: 2000, clicks: 100, spendCents: 12_345, conversions: 5, conversionValueCents: 49_380, ctr: 0.05, avgCpcCents: 123, roas: 4, costPerConversionCents: 2469 },
    previous: null,
    days: [read('2026-10-10', 6000, 24_000), unread('2026-10-11'), read('2026-10-12', 6345, 25_380, true)],
    reads: [],
    ...over,
  }
}

describe('googlePageState — no number, chart or grid outside ok', () => {
  const states: Array<[GoogleAccount['state'], RegExp]> = [
    ['sign_in_needed', /new sign-in/],
    ['permission_missing', /did not give Nexus access to Google Ads/],
    ['choose_account', /Choose the Google Ads account/],
    ['first_read_pending', /has not finished reading Shop One yet/],
  ]
  it.each(states)('%s shows words and no data', (state, title) => {
    const v = googlePageState({ loading: false, error: null, overview: overview({ account: account({ state }) }), timeZone: 'UTC' })
    expect(v.kind).toBe(state)
    expect(v.showData).toBe(false)
    expect(v.title).toMatch(title)
  })

  it('not connected: no account at all, a way to Settings › Channels', () => {
    const v = googlePageState({ loading: false, error: null, overview: overview({ accounts: [], account: null }) })
    expect(v).toMatchObject({ kind: 'not_connected', showData: false, canReadNow: false, action: { href: '/settings/channels?tab=connect' } })
  })

  it('first read pending says when Nexus read last and reads next', () => {
    const v = googlePageState({ loading: false, error: null, overview: overview({ account: account({ state: 'first_read_pending', read: { lastReadAt: null, lastDataDay: null, nextReadAt: '2026-10-14T06:25:00.000Z', lastError: null } }) }), timeZone: 'UTC' })
    expect(v.text).toBe('Campaigns appear when it does. Last read: not yet. Next read: 14 Oct 2026, 06:25.')
    expect(v.canReadNow).toBe(true)
  })

  it('a failed read with an earlier good one shows that data under a banner with its newest day', () => {
    const v = googlePageState({ loading: false, error: null, overview: overview({ account: account({ state: 'read_failed', read: { lastReadAt: '2026-10-12T06:30:00Z', lastDataDay: '2026-10-11', nextReadAt: null, lastError: 'Google did not answer.' } }) }), timeZone: 'UTC' })
    expect(v).toMatchObject({ kind: 'read_failed', showData: true })
    expect(v.banner?.text).toContain('Google did not answer. The numbers below are from the last good read; its newest day is 11 Oct 2026.')
  })

  it('a failed read with nothing read before shows no data', () => {
    const v = googlePageState({ loading: false, error: null, overview: overview({ account: account({ state: 'read_failed', read: { lastReadAt: null, lastDataDay: null, nextReadAt: null, lastError: 'Token expired.' } }) }) })
    expect(v).toMatchObject({ kind: 'read_failed', showData: false })
    expect(v.text).toContain('Token expired.')
  })

  it('ok shows data', () => {
    expect(googlePageState({ loading: false, error: null, overview: overview() })).toMatchObject({ kind: 'ok', showData: true, canReadNow: true })
  })

  it('loading and a failed load show no data', () => {
    expect(googlePageState({ loading: true, error: null, overview: null })).toMatchObject({ kind: 'loading', showData: false })
    expect(googlePageState({ loading: false, error: 'HTTP 500', overview: null })).toMatchObject({ kind: 'load_error', showData: false, text: 'HTTP 500' })
  })
})

describe('money: minor units of the account currency, never converted', () => {
  it('knows each currency’s decimals', () => {
    expect(currencyExponent('EUR')).toBe(2)
    expect(currencyExponent('JPY')).toBe(0)
    expect(currencyExponent('KWD')).toBe(3)
  })

  it('EUR minor units print with two decimals; JPY minor units are whole yen', () => {
    expect(formatMoney(123_456, 'EUR')).toBe('€1,234.56')
    expect(formatMoney(1235, 'JPY')).toMatch(/^(JP)?¥1,235$/)
    expect(toMinor(12.345, 'EUR')).toBe(1235)
    expect(toMinor(1235, 'JPY')).toBe(1235)
  })

  it('missing money is "—", never €0.00', () => {
    expect(formatMoney(null, 'EUR')).toBe('—')
    expect(formatMoney(undefined, 'EUR')).toBe('—')
    expect(formatMoney(100, null)).toBe('—')
    expect(formatMoney(0, 'EUR')).toBe('€0.00')
  })
})

describe('null is not 0', () => {
  it('sums leave unread entries out, and nothing read is no total at all', () => {
    expect(sumMetrics([null, null])).toBeNull()
    const s = sumMetrics([{ impressions: 10, clicks: 1, spendCents: 100, conversions: 0.5, conversionValueCents: 400, ctr: null }, null])
    expect(s).toEqual({ impressions: 10, clicks: 1, spendCents: 100, conversions: 0.5, conversionValueCents: 400 })
  })

  it('money hidden for the role stays hidden in the sum', () => {
    expect(sumMetrics([{ impressions: 10, clicks: 1, conversions: 1, ctr: null }])?.spendCents).toBeNull()
  })

  it('ratios come from the sums and are null when the denominator is 0', () => {
    expect(ratiosOf({ impressions: 0, clicks: 0, spendCents: 0, conversions: 0, conversionValueCents: 0 })).toEqual({ ctr: null, avgCpcCents: null, roas: null, costPerConversionCents: null })
    expect(ratiosOf({ impressions: 200, clicks: 10, spendCents: 500, conversions: 2, conversionValueCents: 2000 })).toEqual({ ctr: 0.05, avgCpcCents: 50, roas: 4, costPerConversionCents: 250 })
  })

  it('a campaign with no read day has no numbers', () => {
    expect(metricsView(null)).toBeNull()
  })

  it('an unread day is a gap in the chart, never a point at 0', () => {
    const pts = chartPoints(overview().days, 'EUR')
    expect(pts[1]).toEqual({ day: '11 Oct' })
    expect(pts[0]).toEqual({ day: '10 Oct', cost: 60, value: 240 })
  })

  it('an unread day says "Not read" in the day table and shows no number', () => {
    const rows = dayRows(overview().days, 'EUR')
    expect(rows.map((r) => r.id)).toEqual(['2026-10-12', '2026-10-11', '2026-10-10'])
    expect(rows[1]!.cells).toEqual(['11 Oct 2026', NOT_READ, '—', '—', '—', '—', '—'])
    expect(rows[0]!.cells[1]).toBe('Can still change')
    expect(rows[2]!.cells).toEqual(['10 Oct 2026', 'Read', '1,000', '50', '€60.00', '2.50', '€240.00'])
  })

  it('no money to draw (hidden for the role) means no chart', () => {
    expect(chartHasMoney([{ ...read('2026-10-10', 1, 1), spendCents: undefined, conversionValueCents: undefined }])).toBe(false)
    expect(chartHasMoney([unread('2026-10-10')])).toBe(false)
  })
})

describe('coverage and provisional days', () => {
  it('names the days without numbers, as ranges', () => {
    expect(missingDaysText(['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-09'])).toBe('3 Oct – 5 Oct 2026, 9 Oct 2026')
    expect(coverageNote(overview())).toBe('No Google numbers for 11 Oct 2026; totals leave it out.')
    expect(coverageNote(overview({ coverage: { daysInWindow: 3, daysRead: 3, missingDays: [] } }))).toBeNull()
  })

  it('counts the read days Google may still change', () => {
    expect(provisionalDays(overview().days, '2026-10-12')).toBe(1)
    expect(provisionalDays(overview().days, '2026-10-10')).toBe(2)
    expect(provisionalNote(1)).toBe('The last day can still change: Google adds late conversions.')
    expect(provisionalNote(3)).toBe('The last 3 days can still change: Google adds late conversions.')
    expect(provisionalNote(0)).toBeNull()
  })

  it('the data line names the newest day, the time zone, the window and the currency', () => {
    expect(dataLine(overview(), account())).toEqual(['newest day 12 Oct 2026', 'days in Europe/Rome', 'showing 10 Oct – 12 Oct 2026', 'amounts in EUR, as Google reports them'])
  })
})

describe('tiles', () => {
  it('six tiles in Google’s words, ratios from the sums', () => {
    const tiles = metricTiles(overview())
    expect(tiles.map((t) => [t.label, t.value])).toEqual([
      ['Cost', '€123.45'],
      ['Conversion value', '€493.80'],
      ['Return on ad spend', '4.00'],
      ['Conversions', '5.00'],
      ['Clicks', '100'],
      ['Impressions', '2,000'],
    ])
    expect(tiles.every((t) => t.delta === undefined)).toBe(true)
  })

  const prev = { impressions: 1000, clicks: 50, spendCents: 9_876, conversions: 5, conversionValueCents: 49_380, ctr: null, from: '2026-10-07', to: '2026-10-09' }
  const full = { daysInWindow: 3, daysRead: 3, missingDays: [] }

  it('compares only with a previous window the server returned (both read in full); more cost is not "good"', () => {
    const tiles = metricTiles(overview({ previous: prev, coverage: full }))
    expect(tiles[0]!.delta).toEqual({ text: '▲ 25.0%', good: false })
    expect(tiles[5]!.delta).toEqual({ text: '▲ 100.0%', good: true })
    expect(comparedWindow(overview({ previous: prev, coverage: full }))).toEqual(prev)
  })

  it('a window with a day not read is never compared, even when a previous window is there: no arrow, no "compare with" line', () => {
    const partial = overview({ previous: prev })
    expect(partial.coverage.daysRead).toBeLessThan(partial.coverage.daysInWindow)
    expect(comparedWindow(partial)).toBeNull()
    expect(metricTiles(partial).every((t) => t.delta === undefined)).toBe(true)
    expect(comparedWindow(overview({ previous: null, coverage: full }))).toBeNull()
  })

  it('no totals: every tile is "—"', () => {
    expect(metricTiles(overview({ totals: null })).every((t) => t.value === '—')).toBe(true)
  })
})

describe('campaign words', () => {
  it('types', () => {
    expect(['SEARCH', 'SHOPPING', 'PERFORMANCE_MAX', 'DISPLAY', 'VIDEO', 'DEMAND_GEN', 'HOTEL', ''].map(campaignTypeLabel))
      .toEqual(['Search', 'Shopping', 'Performance Max', 'Display', 'Video', 'Demand Gen', 'Other', 'Other'])
  })

  it('status and serving', () => {
    expect(campaignStatusLabel('ENABLED')).toBe('Enabled')
    expect(campaignStatusLabel('REMOVED')).toBe('Removed')
    const c = { status: 'ENABLED' as const, servingStatus: 'SERVING', primaryStatus: null }
    expect(servingText(c)).toBe('Serving')
    expect(servingText({ ...c, primaryStatus: 'LIMITED' })).toBe('Limited')
    expect(servingText({ ...c, status: 'PAUSED', primaryStatus: 'PAUSED' })).toBeNull()
    expect(servingText({ ...c, status: 'REMOVED' })).toBeNull()
  })

  it('a campaign Nexus has numbers for but whose settings it has not read: "Not read yet", never a status or a read time it does not have', () => {
    expect(campaignStatusLabel(null)).toBe('Not read yet')
    // Its type is not known either (the API says UNKNOWN): "—", never "Other", which would claim Google said so.
    expect(campaignTypeLabel('UNKNOWN')).toBe('—')
    expect(campaignStatusHint(null)).toMatch(/has not read its settings from Google yet/)
    expect(campaignStatusHint('REMOVED')).toBeNull()
    expect(servingText({ status: null, servingStatus: null, primaryStatus: null })).toBeNull()
    expect(settingsReadText({ status: null, settingsReadAt: '2026-10-12T06:29:00Z' })).toBe('Not read yet')
    expect(settingsReadText({ status: 'REMOVED', settingsReadAt: '2026-10-12T06:29:00Z' }, 'UTC')).toBe('12 Oct 2026, 06:29')
    // Removed before Nexus first read the account: a status, but its settings were never read.
    expect(settingsReadText({ status: 'REMOVED', settingsReadAt: null }, 'UTC')).toBe('Not read yet')
  })

  it('bidding and budget', () => {
    expect(biddingLabel('MAXIMIZE_CONVERSION_VALUE')).toBe('Maximize conversion value')
    expect(biddingLabel('SOME_NEW_STRATEGY')).toBe('Some new strategy')
    expect(biddingLabel(null)).toBe('—')
    expect(budgetText({ dailyBudgetCents: 5000, budgetShared: true }, 'EUR')).toBe('€50.00 a day (shared)')
    expect(budgetText({ dailyBudgetCents: null, budgetShared: false }, 'EUR')).toBe('—')
  })
})

describe('changes (R4)', () => {
  it('newest first, source in words, never an e-mail', () => {
    const rows = changeRows([
      { changedAt: '2026-10-01T10:00:00Z', resourceType: 'CAMPAIGN_BUDGET', operation: 'UPDATE', changedFields: ['amount_micros'], source: 'google_ads_web', sourceText: 'Google Ads website', summary: 'Budget changed by someone@example.com' },
      { changedAt: '2026-10-05T10:00:00Z', resourceType: 'CAMPAIGN', operation: 'UPDATE', changedFields: ['status'], source: 'google_automatic', sourceText: 'Google, automatically', summary: 'Status changed' },
    ], 'UTC')
    expect(rows.map((r) => r.cells)).toEqual([
      ['5 Oct 2026, 10:00', 'Google, automatically', 'Status changed'],
      ['1 Oct 2026, 10:00', 'Google Ads website', 'Budget changed by a person'],
    ])
    expect(withoutEmails('a.b+c@d.co.uk wrote')).toBe('a person wrote')
  })

  it('says the span the history covers, from its start to where reading stopped — never "since"', () => {
    const span = { coveredFrom: '2026-09-13T22:00:00.000Z', coveredThrough: '2026-10-09T06:00:00.000Z' }
    expect(changesNote({ coveredFrom: null, coveredThrough: null }, 0)).toBe('Nexus has not read this campaign’s change history from Google yet.')
    expect(changesNote(span, 0, 'UTC')).toBe('No changes between 13 Sep 2026, 22:00 and 9 Oct 2026, 06:00, the span Nexus has read. Google keeps 30 days; Nexus keeps what it has read.')
    expect(changesNote(span, 2, 'UTC')).toBe('Changes read from 13 Sep 2026, 22:00 to 9 Oct 2026, 06:00, as Google records them. Google keeps 30 days; Nexus keeps what it has read.')
    // Reading stopped before the last 30 days: where it stopped, and that none of them is read.
    expect(changesNote({ coveredFrom: null, coveredThrough: '2026-09-01T00:00:00.000Z' }, 0, 'UTC')).toBe('Nexus last read this campaign’s change history up to 1 Sep 2026, 00:00: it has read none of the last 30 days.')
    for (const n of [0, 2]) expect(changesNote(span, n, 'UTC')).not.toMatch(/since/)
  })
})

describe('Read now says what happened', () => {
  it('queued, refused with a reason, refused without one, failed', () => {
    expect(readNowNote({ queued: true, reason: null }).tone).toBe('success')
    expect(readNowNote({ queued: false, reason: 'A read ran less than an hour ago.' })).toEqual({ tone: 'info', text: 'Nexus did not start a new read: A read ran less than an hour ago.' })
    expect(readNowNote({ queued: false, reason: null }).text).toBe('Nexus did not start a new read.')
    expect(readNowNote({ error: 'HTTP 500' })).toEqual({ tone: 'danger', text: 'Nexus could not ask for a new read: HTTP 500' })
  })
})

describe('dates', () => {
  it('a local picker day stays that day (never shifted through UTC)', () => {
    expect(ymd(new Date(2026, 9, 13, 0, 0, 0))).toBe('2026-10-13')
  })
  it('windows and days in words', () => {
    expect(formatDay('2026-10-13')).toBe('13 Oct 2026')
    expect(formatWindow('2026-09-14', '2026-10-13')).toBe('14 Sep – 13 Oct 2026')
    expect(formatWindow('2025-12-30', '2026-01-02')).toBe('30 Dec 2025 – 2 Jan 2026')
  })
})

describe('the grid, the charts and the day table', () => {
  const src = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')

  it('money first, as Google Ads shows it: what a campaign cost and brought in come right after its status and type', () => {
    expect(CAMPAIGN_COLUMN_ORDER).toEqual(['status', 'type', 'cost', 'value', 'roas', 'conversions', 'cpa', 'clicks', 'impressions', 'ctr', 'cpc', 'budget', 'bidding'])
    expect(src('./GoogleAdsClient.tsx')).toMatch(/return CAMPAIGN_COLUMN_ORDER\.map\(\(key\) => byKey\[key\]\)/)
    // The campaign grid's nine metric columns are the shared ones, in the same order.
    expect(CAMPAIGN_COLUMN_ORDER.filter((k) => (METRIC_COLUMN_KEYS as readonly string[]).includes(k))).toEqual([...METRIC_COLUMN_KEYS])
    expect(src('./GoogleAdsClient.tsx')).toMatch(/metricColumns<GoogleCampaign>\(\(r\) => r\.metrics, currency\)/)
  })

  it('no row checkboxes: nothing on this page acts on a selection', () => {
    const client = src('./GoogleAdsClient.tsx')
    expect(client).toMatch(/selectable=\{false\}/)
    expect(client).not.toMatch(/selectionActions/)
  })

  it.each(['./GoogleAdsClient.tsx', './GoogleCampaignModal.tsx'])('%s: both chart axes say what they measure, in the account currency', (file) => {
    const chart = src(file)
    expect(chart.match(/axisLabel: `Cost \(\$\{\w+\}\)`/g)).toHaveLength(1)
    expect(chart.match(/axisLabel: `Conversion value \(\$\{\w+\}\)`/g)).toHaveLength(1)
  })

  it('the day table\'s headers never break inside a word (a day row stays on one line; the table scrolls sideways)', () => {
    const css = src('./google.css')
    expect(css).toMatch(/\.gads-table \.nds-summary-table \{\s*table-layout: auto;/)
    expect(css).toMatch(/\.gads-table \.nds-summary-table th,\s*\.gads-days \.nds-summary-table td \{\s*white-space: nowrap;/)
    expect(src('./GoogleCampaignModal.tsx')).toMatch(/className="gads-table gads-days"[^>]*aria-label="Days table"/)
  })
})

describe('metricColumns: the nine metric columns every Google grid uses', () => {
  type Row = { id: string; m: GoogleMetrics | null }
  const rows: Row[] = [
    { id: 'a', m: { impressions: 1000, clicks: 50, spendCents: 5_000, conversions: 2, conversionValueCents: 20_000, ctr: null } },
    { id: 'b', m: { impressions: 1000, clicks: 0, spendCents: 0, conversions: 0, conversionValueCents: 0, ctr: null } },
    { id: 'c', m: null },
  ]
  const cols = metricColumns<Row>((r) => r.m, 'EUR')
  const col = (key: string) => cols.find((c) => c.key === key)!
  const total = (key: string, vr: Row[] = rows) => (col(key).total as (vr: Row[]) => unknown)(vr)

  it('the same nine, in Google Ads’ order, with the same labels as the campaign grid', () => {
    expect(cols.map((c) => c.key)).toEqual([...METRIC_COLUMN_KEYS])
    expect(cols.map((c) => c.label)).toEqual(['Cost', 'Conversion value', 'Return on ad spend', 'Conversions', 'Cost per conversion', 'Clicks', 'Impressions', 'Click rate', 'Avg. cost per click'])
    // Numbers on the right: no metric column says otherwise.
    expect(cols.every((c) => c.metric !== false && c.align !== 'left')).toBe(true)
  })

  it('ratios per row from the row’s own sums; "—" over 0, never a made-up ratio', () => {
    expect(col('roas').render(rows[0]!)).toBe('4.00')
    expect(col('cpc').render(rows[0]!)).toBe('€1.00')
    expect(col('cpa').render(rows[1]!)).toBe('—')
    expect(col('roas').render(rows[1]!)).toBe('—')
    expect(col('cost').render(rows[1]!)).toBe('€0.00')
  })

  it('a row Nexus read no day of is "—" everywhere and sorts as a blank, never 0', () => {
    for (const c of cols) expect(c.render(rows[2]!)).toBe('—')
    for (const c of cols) expect(c.sortValue!(rows[2]!)).toBeNull()
  })

  it('totals from the sums of the rows shown (ratios from those sums), leaving rows not read out', () => {
    expect(total('cost')).toBe('€50.00')
    expect(total('clicks')).toBe('50')
    expect(total('impressions')).toBe('2,000')
    expect(total('ctr')).toBe('2.50%')
    expect(total('roas')).toBe('4.00')
    expect(total('cost', [rows[2]!])).toBe('—')
  })

  it('money hidden for the role stays "—" in the rows and the totals', () => {
    const hidden: Row = { id: 'h', m: { impressions: 10, clicks: 1, conversions: 1, ctr: null } }
    expect(col('cost').render(hidden)).toBe('—')
    expect(total('cost', [hidden, rows[0]!])).toBe('—')
    expect(col('clicks').render(hidden)).toBe('1')
  })
})

/**
 * The guards of the whole folder — the page, its tabs, the campaign window and the grain grids (step 1b, WA and WB):
 * every file present is read, so a file added later is held to the same rules without being listed here.
 */
describe('every Google Ads screen file', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url))
  const all = readdirSync(dir).filter((f) => /\.(ts|tsx|css)$/.test(f) && !/\.vitest\.test\.ts$/.test(f)).sort()
  const code = all.filter((f) => /\.tsx?$/.test(f))
  const tsx = all.filter((f) => f.endsWith('.tsx'))
  const read = (f: string) => readFileSync(`${dir}/${f}`, 'utf8')
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

  it('the step-1b files are here (the guards below read them)', () => {
    for (const f of ['GoogleAdsClient.tsx', 'GoogleAlertsCard.tsx', 'GoogleActsPanel.tsx', 'GoogleRecommendationsTab.tsx', 'GoogleDisapprovalsTab.tsx', 'GoogleCampaignModal.tsx', 'googleAttention.ts', 'useGoogleRead.ts', 'google.css']) {
      expect(all).toContain(f)
    }
  })

  // The words the Amazon screens use for sales-side numbers, and the claim that something is running from Nexus.
  it.each(code)('%s: Google’s words only (never ACoS, Sales, Orders or Live)', (file) => {
    expect(strip(read(file))).not.toMatch(/\b(ACoS|ACOS|Sales|Orders|Live)\b/)
  })

  // Google's own state words ("Paused") live in the .ts models; a .tsx holding them would look like a control.
  it.each(tsx)('%s: no write control and no write route', (file) => {
    expect(read(file)).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'|\/mutate|\/budget|Pause|Resume|Enable campaign|Apply recommendation|\bDismiss\b/)
  })

  it.each(code)('%s: reads only (no write call of the contract)', (file) => {
    expect(read(file)).not.toMatch(/saveGoogleSelection|method:\s*'(PUT|PATCH|DELETE)'/)
  })

  it.each(tsx)('%s: every grid has no row checkboxes (nothing acts on a selection)', (file) => {
    const src = strip(read(file))
    const grids = (src.match(/<AdsDataGrid\b/g) ?? []).length
    expect((src.match(/selectable=\{false\}/g) ?? []).length).toBe(grids)
    expect(src).not.toMatch(/selectionActions/)
  })

  it.each(all)('%s: no emoji and no help cursor', (file) => {
    const src = read(file)
    expect(src).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(src).not.toMatch(/cursor:\s*help|cursor:\s*['"]help/)
  })

  it.each(tsx)('%s: no Tailwind classes (feature classes and the DS only)', (file) => {
    const classes = [...read(file).matchAll(/className="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/).filter(Boolean))
    for (const c of classes) expect(c).toMatch(/^(gads-|h10-am$|nds-)/)
  })

  it.each(all.filter((f) => f.endsWith('.css')))('%s: semantic tokens only (no raw colour)', (file) => {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
    expect(css).not.toMatch(/--nds-(grey|blue|red|green|amber|orange)-\d/)
  })
})

describe('useGoogleRead: the read cache never crosses a business or a person, and forgets', () => {
  it('a key names every parameter; undefined and null are the same', () => {
    expect(googleReadKey('alerts', null)).toBe(googleReadKey('alerts', undefined))
    expect(googleReadKey('overview', 'c1', '2026-10-01', '2026-10-12')).not.toBe(googleReadKey('overview', 'c1', '2026-10-01', '2026-10-13'))
  })

  it('the same key in another business, or for another person, is another entry', () => {
    const k = googleReadKey('alerts', null)
    expect(googleReadCacheKey(k, 'ws_a', 'u1')).not.toBe(googleReadCacheKey(k, 'ws_b', 'u1'))
    expect(googleReadCacheKey(k, 'ws_a', 'u1')).not.toBe(googleReadCacheKey(k, 'ws_a', 'u2'))
  })

  it('keeps an answer for a few minutes, then reads again', () => {
    forgetGoogleReads()
    const k = googleReadCacheKey(googleReadKey('t-ttl'), 'ws_a', 'u1')
    rememberGoogleRead(k, { n: 1 }, 1_000)
    expect(cachedGoogleRead(k, 1_000 + GOOGLE_READ_TTL_MS)).toEqual({ n: 1 })
    expect(cachedGoogleRead(k, 1_001 + GOOGLE_READ_TTL_MS)).toBeUndefined()
    expect(cachedGoogleRead(k, 1_000)).toBeUndefined()
  })

  it('past the cap the oldest answer goes; forgetting one key or all', () => {
    forgetGoogleReads()
    const key = (i: number) => googleReadCacheKey(googleReadKey('t-cap', i), 'ws_a', 'u1')
    for (let i = 0; i <= GOOGLE_READ_CACHE_MAX; i++) rememberGoogleRead(key(i), i, 5_000)
    expect(cachedGoogleRead(key(0), 5_000)).toBeUndefined()
    expect(cachedGoogleRead(key(GOOGLE_READ_CACHE_MAX), 5_000)).toBe(GOOGLE_READ_CACHE_MAX)
    forgetGoogleReads(key(1))
    expect(cachedGoogleRead(key(1), 5_000)).toBeUndefined()
    expect(cachedGoogleRead(key(2), 5_000)).toBe(2)
    forgetGoogleReads()
    expect(cachedGoogleRead(key(2), 5_000)).toBeUndefined()
  })

  it('two callers while one read runs share one request; a failed read is not kept', async () => {
    const k = googleReadCacheKey(googleReadKey('t-shared'), 'ws_a', 'u1')
    const load = vi.fn(async () => 'answer')
    const [a, b] = await Promise.all([sharedGoogleRead(k, load), sharedGoogleRead(k, load)])
    expect([a, b]).toEqual(['answer', 'answer'])
    expect(load).toHaveBeenCalledTimes(1)
    await sharedGoogleRead(k, load)
    expect(load).toHaveBeenCalledTimes(2)
    const fail = vi.fn(async () => { throw new Error('Google did not answer.') })
    await expect(sharedGoogleRead(k, fail)).rejects.toThrow('Google did not answer.')
    await expect(sharedGoogleRead(k, load)).resolves.toBe('answer')
  })

  it('Try again reads again for every part of the screen on that key, and forgets its answer', () => {
    forgetGoogleReads()
    const k = googleReadCacheKey(googleReadKey('t-reload'), 'ws_a', 'u1')
    const other = googleReadCacheKey(googleReadKey('t-reload-other'), 'ws_a', 'u1')
    const card = vi.fn()
    const tab = vi.fn()
    const elsewhere = vi.fn()
    const stopCard = listenGoogleRead(k, card)
    listenGoogleRead(k, tab)
    listenGoogleRead(other, elsewhere)
    rememberGoogleRead(k, 'old answer', Date.now())
    reloadGoogleRead(k)
    expect(card).toHaveBeenCalledTimes(1)
    expect(tab).toHaveBeenCalledTimes(1)
    expect(elsewhere).not.toHaveBeenCalled()
    expect(cachedGoogleRead(k)).toBeUndefined()
    stopCard()
    reloadGoogleRead(k)
    expect(card).toHaveBeenCalledTimes(1)
    expect(tab).toHaveBeenCalledTimes(2)
  })

  it('a refused read keeps its HTTP status (404: not in this business); no answer or a bad body has none', () => {
    expect(failedStatus(new GoogleAdsHttpError(404, 'Campaign not found'))).toBe(404)
    expect(failedStatus(new GoogleAdsHttpError(500, 'Nexus could not load this (HTTP 500).'))).toBe(500)
    expect(failedStatus(new GoogleAdsHttpError(200, 'Nexus answered with nothing it could read.'))).toBeNull()
    expect(failedStatus(new TypeError('Failed to fetch'))).toBeNull()
  })
})
