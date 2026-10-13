/**
 * Google Ads step 1a, W2 — the rules of /marketing/ads/google, in the node-only web suite (the page and its modal are
 * thin over `googleAds.ts`). Fixtures are made up: no business names, numbers or ids (the repo is public).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { GoogleAccount, GoogleDay, GoogleOverview } from '@/lib/google-ads/contract'
import {
  CAMPAIGN_COLUMN_ORDER,
  NOT_READ,
  biddingLabel,
  budgetText,
  campaignStatusHint,
  campaignStatusLabel,
  campaignTypeLabel,
  changeRows,
  changesNote,
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

  it('compares only with a previous window the server returned (read in full); more cost is not "good"', () => {
    const prev = { impressions: 1000, clicks: 50, spendCents: 9_876, conversions: 5, conversionValueCents: 49_380, ctr: null, from: '2026-10-07', to: '2026-10-09' }
    const tiles = metricTiles(overview({ previous: prev }))
    expect(tiles[0]!.delta).toEqual({ text: '▲ 25.0%', good: false })
    expect(tiles[5]!.delta).toEqual({ text: '▲ 100.0%', good: true })
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
    expect(settingsReadText({ status: 'REMOVED', settingsReadAt: '2026-10-12T06:29:00Z' }, 'UTC')).not.toBe('Not read yet')
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

  it('says what the history covers', () => {
    expect(changesNote(null, 0)).toMatch(/has not read this campaign’s change history/)
    expect(changesNote('2026-09-13', 0)).toMatch(/^No changes since 13 Sep 2026/)
    expect(changesNote('2026-09-13', 2)).toMatch(/^Changes since 13 Sep 2026/)
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

describe('Google’s words only', () => {
  // The words the Amazon screens use for sales-side numbers, and the claim that something is running from Nexus.
  const FORBIDDEN = /\b(ACoS|ACOS|Sales|Orders|Live)\b/
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  it.each(['./googleAds.ts', './GoogleAdsClient.tsx', './GoogleCampaignModal.tsx'])('%s never says ACoS, Sales, Orders or Live', (file) => {
    const src = strip(readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8'))
    expect(src).not.toMatch(FORBIDDEN)
  })

  it('the page has no write control and does not call a write route', () => {
    for (const file of ['./GoogleAdsClient.tsx', './GoogleCampaignModal.tsx']) {
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
      expect(src).not.toMatch(/method:\s*'(PUT|PATCH|DELETE)'|\/mutate|\/budget|Pause|Resume|Enable campaign/)
    }
  })
})

describe('the grid, the charts and the day table', () => {
  const src = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')

  it('money first, as Google Ads shows it: what a campaign cost and brought in come right after its status and type', () => {
    expect(CAMPAIGN_COLUMN_ORDER).toEqual(['status', 'type', 'cost', 'value', 'roas', 'conversions', 'cpa', 'clicks', 'impressions', 'ctr', 'cpc', 'budget', 'bidding'])
    expect(src('./GoogleAdsClient.tsx')).toMatch(/return CAMPAIGN_COLUMN_ORDER\.map\(\(key\) => byKey\[key\]\)/)
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
