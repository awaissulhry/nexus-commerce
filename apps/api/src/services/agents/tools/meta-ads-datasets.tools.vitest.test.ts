/**
 * Meta ads step 11 — meta-datasets. Every view, check and scope sends a fixed request the real gateway lets through;
 * every pixel read is the chosen ad account's (its only one by default); in the portfolio's list another pixel is its id
 * only, and the flag when it is connected to an ad account another business in Nexus uses; the D2 check (view sources)
 * answers browser AND server yes / no / unknown from Meta's counts and deduplication, and the gap; money goes in minor
 * units under restricted keys; an ad set of another account is its id only; debug feeds never carry a page's query or
 * Meta's raw event body. Meta and the database are stubbed; made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown> }
const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ operation: string; path: string; query?: Record<string, unknown> }>,
  answer: null as null | ((req: { operation: string; path: string; query?: Record<string, unknown> }) => unknown),
  rowsFor: null as null | ((req: { operation: string; path: string; query?: Record<string, unknown> }) => unknown),
  taken: [] as Array<{ id: string }>,
  knownAdSets: new Set<string>(),
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../marketing/meta-ads/read-client.js', async () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: Req) => {
    h.calls.push(req)
    const body = h.answer?.(req)
    if (body instanceof Error) throw body
    return { body: body ?? {}, calls: 1 }
  }),
  metaReadAll: vi.fn(async (_t: unknown, req: Req, onRows: (rows: Record<string, unknown>[]) => void) => {
    h.calls.push(req)
    const rows = h.rowsFor?.(req) ?? []
    if (rows instanceof Error) throw rows
    onRows(rows as Record<string, unknown>[])
    return { rows: (rows as unknown[]).length, calls: 1, truncated: false }
  }),
}))
vi.mock('../../../db.js', () => ({
  default: {
    metaAdsCampaign: { findFirst: vi.fn(async () => null) },
    metaAdsAdSet: { findFirst: vi.fn(async ({ where }: { where: { adSetId?: string } }) => (where.adSetId && h.knownAdSets.has(where.adSetId) ? { id: 'x' } : null)) },
    metaAdsAd: { findFirst: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => h.taken),
  },
}))

import { META_ADS_DATASETS_TOOLS } from './meta-ads-datasets.tools.js'
import { CONVERSION_SCOPES, currencyCents, DATASET_VIEWS, DIAGNOSTIC_CHECKS, sendersVerdict, statsWindows } from '../../marketing/meta-ads/live-datasets.js'
import { MetaReadError, type MetaFailure } from '../../marketing/meta-ads/errors.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem } from '../../gateway/meta-calls.js'

const tool = META_ADS_DATASETS_TOOLS[0]
const ctx = { can: () => true, via: 'claude' as const }
const run = (args: Record<string, unknown>) => tool.handler(tool.input.parse(args), ctx as never)
const data = (res: { data?: unknown }) => res.data as Record<string, any>
const OWN = '1234567890'
const BIZ = '9876543210'
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok',
  adAccount: { adAccountId: OWN, name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: BIZ },
  page: { pageId: '120000000000010' }, instagram: { instagramId: '170000000000001' }, read: {},
}
const PIXEL = '120000000000501'
const OTHER_PIXEL = '120000000000502'
const OTHER_ACCOUNT = '5555555555'
const CC = '120000000000701'
const NOW = new Date('2026-10-21T00:00:00Z')
const metaError = (code: string, extra: Partial<MetaFailure> = {}) => new MetaReadError({
  origin: 'meta', httpStatus: 400, code, authLost: false, throttled: false, permissionDenied: false, notFound: false, sentence: `Meta refused the read (${code}).`, ...extra,
}, 'test')
const refusedCalls = () => h.calls
  .map((c) => [c.path, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })])
  .filter(([, problem]) => problem)
/** Hourly stats results: one bucket per entry of counts. */
const stats = (counts: Record<string, number>) => [{ aggregation: 'event', start_time: '2026-10-20T00:00:00+0000', data: Object.entries(counts).map(([value, count]) => ({ value, count })) }]

let pixels: Array<Record<string, unknown>>
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  h.connections = [CHOSEN]; h.calls.length = 0; h.taken = []; h.knownAdSets = new Set()
  pixels = [{ id: PIXEL, name: 'Shop A pixel', owner_business: { id: BIZ } }]
  h.answer = (req) => {
    if (req.operation === 'datasets.conversionOwner') return { account_id: req.path === CC ? OWN : OTHER_ACCOUNT }
    if (req.path === 'dataset_quality') return { web: [{ event_name: 'Purchase' }], offline: [{ event_name: 'Purchase', composite: { score: 6.6 } }] }
    return { id: req.path, name: 'x', account_id: OWN }
  }
  h.rowsFor = (req) => {
    if (req.path === `act_${OWN}/adspixels`) return pixels
    return []
  }
})

describe('the tool is a read', () => {
  it('read only, open world, ads.view; spend, conversion value and US-dollar amounts are money-restricted', () => {
    expect([tool.name, tool.readOnly, tool.openWorld, tool.execute, tool.requires]).toEqual(['meta-datasets', true, true, undefined, ['ads.view']])
    expect(tool.restrictedFields).toEqual({ spendCents: 'financials.adspend.view', defaultValueCents: 'financials.adspend.view', usdAmounts: 'financials.adspend.view' })
  })
  it('a business without Meta is told who connects it — before any call', async () => {
    h.connections = []
    expect((await run({ view: 'sources' })).error).toMatch(/Settings › Channels › Meta/)
    expect(h.calls).toHaveLength(0)
  })
})

describe('every view, check and scope — only what the real gateway lets through', () => {
  const VIEWS: Array<[string, Record<string, unknown>, string]> = [
    ['list', {}, `act_${OWN}/adspixels`],
    ['portfolio', { list: 'all', search: 'shop' }, `${BIZ}/adspixels`],
    ['detail', {}, `${PIXEL}/audiences`],
    ['access', {}, `${PIXEL}/assigned_users`],
    ['stats', { aggregation: 'custom_data_field', event: 'Purchase', eventSource: 'server_only', agentName: 'shop', hours: 24 }, `${PIXEL}/stats`],
    ['sources', { agentName: 'shop' }, 'dataset_quality'],
    ['quality', { agentName: 'shop' }, 'dataset_quality'],
    ['quality-offline', {}, 'dataset_quality'],
    ['quality-legacy', { agentName: 'shop' }, `${PIXEL}/integration_quality`],
    ['diagnostics', {}, `${PIXEL}/ads_signal_diagnostic_issues`],
    ['gateway', {}, `${BIZ}/openbridge_configurations`],
    ['custom-conversions', {}, `act_${OWN}/customconversions`],
    ['event-setup', { currentDomain: 'https://shop.example' }, `${PIXEL}/extractors`],
    ['legacy-offline', { pixelId: PIXEL, hours: 48, sortBy: 'creation_time', order: 'descending', uploadTag: 't' }, `${BIZ}/offline_conversion_data_sets`],
  ]
  it('covers every view', () => { expect(VIEWS.map(([v]) => v).sort()).toEqual([...DATASET_VIEWS].sort()) })
  it.each(VIEWS)('view %s', async (view, args, path) => {
    const res = await run({ view, ...args })
    expect(res.ok, String(res.error)).toBe(true)
    expect(h.calls.map((c) => c.path)).toContain(path)
    expect(refusedCalls()).toEqual([])
  })
  const CHECKS: Array<[string, Record<string, unknown>, string]> = [
    ['issues', {}, 'ads_signal_diagnostic_issues'],
    ['events-last-fired', { event: 'Purchase' }, 'event_last_fired_time'],
    ['domains-last-fired', { domains: ['shop.example'] }, 'domain_last_fired_time'],
    ['recent-events', { event: 'Purchase', lookbackSeconds: 3600 }, 'recent_events'],
    ['event-log', { hours: 2 }, 'real_time_event_log'],
    ['raw-fires', { event: 'Purchase', filterType: 'host', filter: 'shop.example' }, 'raw_fires'],
    ['delivery-recommendations', {}, 'pixel_delivery_recommendations'],
    ['item-prices', {}, 'item_price_stats'],
    ['microdata', { catalogId: '120000000000801' }, 'microdata_stats'],
    ['collaborative-ads', { actionSource: 'website' }, 'cpas_events_debugging_info'],
  ]
  it('covers every diagnostics check', () => { expect(CHECKS.map(([c]) => c).sort()).toEqual([...DIAGNOSTIC_CHECKS].sort()) })
  it.each(CHECKS)('diagnostics %s', async (check, args, edge) => {
    const res = await run({ view: 'diagnostics', check, ...args })
    expect(res.ok, String(res.error)).toBe(true)
    expect(h.calls.at(-1)?.path).toBe(`${PIXEL}/${edge}`)
    expect(refusedCalls()).toEqual([])
  })
  const SCOPES: Array<[string, Record<string, unknown>, string]> = [
    ['account', {}, `act_${OWN}/customconversions`],
    ['business', {}, `${BIZ}/owned_custom_conversions`],
    ['dataset', {}, `${PIXEL}/customconversions`],
    ['one', { customConversionId: CC }, CC],
    ['stats', { customConversionId: CC, conversionAggregation: 'usd_amount', hours: 24 }, `${CC}/stats`],
  ]
  it('covers every custom-conversions scope', () => { expect(SCOPES.map(([s]) => s).sort()).toEqual([...CONVERSION_SCOPES].sort()) })
  it.each(SCOPES)('custom-conversions %s', async (scope, args, path) => {
    const res = await run({ view: 'custom-conversions', scope, ...args })
    expect(res.ok, String(res.error)).toBe(true)
    expect(h.calls.map((c) => c.path)).toContain(path)
    expect(refusedCalls()).toEqual([])
  })
})

describe('only the chosen ad account\'s pixels', () => {
  it('the only pixel is the default; with several, or none, the person is asked; another pixel is refused', async () => {
    expect((await run({ view: 'detail' })).ok).toBe(true)
    pixels = [{ id: PIXEL }, { id: OTHER_PIXEL }]
    expect((await run({ view: 'detail' })).error).toMatch(/has 2 pixels: name one/)
    pixels = []
    expect((await run({ view: 'detail' })).error).toMatch(/has no pixel/)
    pixels = [{ id: PIXEL }]
    h.calls.length = 0
    expect((await run({ view: 'quality', pixelId: OTHER_PIXEL })).error).toMatch(/not on the ad account this business chose/)
    expect(h.calls.some((c) => c.path === 'dataset_quality')).toBe(false)
  })
  it('portfolio: a pixel not on the chosen account is its id only, and the flag when another business\'s account uses it', async () => {
    h.taken = [{ id: OTHER_ACCOUNT }]
    h.rowsFor = (req) => {
      if (req.path === `act_${OWN}/adspixels`) return [{ id: PIXEL }]
      if (req.path === `${BIZ}/adspixels`) return [{ id: PIXEL, name: 'Shop A pixel' }, { id: OTHER_PIXEL, name: 'Shop B pixel' }]
      if (req.path === `${OTHER_PIXEL}/shared_accounts`) return [{ account_id: OTHER_ACCOUNT, name: 'Shop B ads' }]
      return []
    }
    const res = data(await run({ view: 'portfolio' }))
    expect(res.items[0]).toMatchObject({ pixelId: PIXEL, name: 'Shop A pixel', onChosenAdAccount: true })
    expect(res.items[1]).toEqual({ pixelId: OTHER_PIXEL, takenByAnotherBusiness: true })
    expect(JSON.stringify(res)).not.toMatch(/Shop B/)
    h.taken = []
    expect(data(await run({ view: 'portfolio' })).items[1]).toEqual({ pixelId: OTHER_PIXEL, onChosenAdAccount: false, checked: true })
  })
  it('access: another business\'s ad account on the pixel is its id only, and the pixel says it mixes both', async () => {
    h.taken = [{ id: OTHER_ACCOUNT }]
    h.rowsFor = (req) => {
      if (req.path === `act_${OWN}/adspixels`) return pixels
      if (req.path === `${PIXEL}/shared_accounts`) return [{ account_id: OWN, name: 'Shop A ads' }, { account_id: OTHER_ACCOUNT, name: 'Shop B ads' }]
      return []
    }
    const res = data(await run({ view: 'access' }))
    expect(res.adAccounts.items).toEqual([{ adAccountId: OWN, name: 'Shop A ads', chosenHere: true, takenByAnotherBusiness: false }, { adAccountId: OTHER_ACCOUNT, takenByAnotherBusiness: true }])
    expect(res.alsoOnAnotherBusinessesAdAccount).toBe(true)
    expect(h.calls.find((c) => c.path === `${PIXEL}/shared_accounts`)?.query?.business).toBe(BIZ)
  })
})

describe('D2 — who sends the events (view sources)', () => {
  const setup = (input: { browser?: Record<string, number> | Error; server?: Record<string, number> | Error; dedup?: unknown[]; partner?: boolean }) => {
    h.rowsFor = (req) => {
      if (req.path === `act_${OWN}/adspixels`) return pixels
      if (req.path === `${PIXEL}/stats` && req.query?.event_source === 'WEB_ONLY') return input.browser instanceof Error ? input.browser : stats(input.browser ?? {})
      if (req.path === `${PIXEL}/stats` && req.query?.event_source === 'SERVER_ONLY') return input.server instanceof Error ? input.server : stats(input.server ?? {})
      if (req.path === `${PIXEL}/stats`) return [{ aggregation: 'event_source', data: [{ value: 'server', count: 3 }] }]
      return []
    }
    h.answer = (req) => {
      if (req.path === 'dataset_quality') {
        if (req.query?.agent_name) return { web: input.partner ? [{ event_name: 'Purchase', event_match_quality: { composite_score: 7 } }] : [] }
        return { web: [{ event_name: 'Purchase', event_coverage: { percentage: 80, goal_percentage: 75 }, event_match_quality: { composite_score: 6.4 }, dedupe_key_feedback: input.dedup ?? [] }] }
      }
      return { last_upload_app: 'Shop app', last_upload_app_changed_time: 1760000000 }
    }
  }
  const eventId = (overall: number) => ({ dedupe_key: 'event_id', browser_events_with_dedupe_key: { percentage: 100 }, server_events_with_dedupe_key: { percentage: 98 }, overall_browser_coverage_from_dedupe_key: { percentage: overall } })

  it('browser AND server, deduplicated → yes, no gap (upload-meta-events stays off)', async () => {
    setup({ browser: { Purchase: 10, PageView: 900 }, server: { Purchase: 9 }, dedup: [eventId(88)] })
    const res = data(await run({ view: 'sources' }))
    expect(res.answer).toMatchObject({ browserAndServer: 'yes', browser: 'yes', server: 'yes', deduplicated: 'yes', gap: 'none', eventIdOnBrowserPercent: 100, eventIdOnServerPercent: 98, serverCoveragePercent: 80 })
    expect(res.answer.sentence).toMatch(/^Does Purchase come from the browser AND a server\? yes/)
    expect(res.counts.browser).toMatchObject({ Purchase: 10 })
    expect(res.counts.server).toMatchObject({ Purchase: 9 })
    expect(res.integrations.lastUploadApp).toMatchObject({ app: 'Shop app' })
    expect(res.metaDoesNotGive.length).toBeGreaterThan(2)
    // The two counts are Meta's own browser / server split, one request per 7 days.
    const sources = h.calls.filter((c) => c.path === `${PIXEL}/stats`).map((c) => c.query?.event_source ?? c.query?.aggregation)
    expect(sources.sort()).toEqual(['SERVER_ONLY', 'WEB_ONLY', 'event_source'])
  })
  it('browser only → no, the gap is the server copy; server only → no, the gap is the browser pixel', async () => {
    setup({ browser: { Purchase: 10 }, server: {} })
    expect(data(await run({ view: 'sources' })).answer).toMatchObject({ browserAndServer: 'no', browser: 'yes', server: 'no', gap: 'server' })
    setup({ browser: {}, server: { Purchase: 4 } })
    expect(data(await run({ view: 'sources' })).answer).toMatchObject({ browserAndServer: 'no', gap: 'browser' })
  })
  it('both but never deduplicated → the gap is deduplication; no event at all, or a refused count → unknown', async () => {
    setup({ browser: { Purchase: 10 }, server: { Purchase: 10 }, dedup: [eventId(0)] })
    expect(data(await run({ view: 'sources' })).answer).toMatchObject({ browserAndServer: 'yes', deduplicated: 'no', gap: 'dedup' })
    setup({ browser: {}, server: {} })
    expect(data(await run({ view: 'sources' })).answer).toMatchObject({ browserAndServer: 'unknown', gap: 'unknown' })
    setup({ browser: metaError('100'), server: { Purchase: 3 } })
    const res = data(await run({ view: 'sources' }))
    expect(res.answer).toMatchObject({ browser: 'unknown', server: 'yes', browserAndServer: 'unknown' })
    expect(res.counts.browser).toEqual({ refused: 'Meta refused the read (100).' })
  })
  it('a partner\'s agent name: seen with it, or not seen (Meta lists no names)', async () => {
    setup({ browser: { Purchase: 1 }, server: { Purchase: 1 }, partner: true })
    expect(data(await run({ view: 'sources', agentName: 'shop' })).integrations.partnerAgent).toMatchObject({ agentName: 'shop', sendsThisEventByServer: 'yes' })
    expect(h.calls.find((c) => c.path === 'dataset_quality' && c.query?.agent_name)?.query).toMatchObject({ dataset_id: PIXEL, agent_name: 'shop' })
    setup({ browser: { Purchase: 1 }, server: { Purchase: 1 }, partner: false })
    expect(data(await run({ view: 'sources', agentName: 'shop' })).integrations.partnerAgent.sendsThisEventByServer).toBe('not-seen')
  })
  it('28 days are read 7 days at a time; another event can be checked', async () => {
    setup({ browser: { AddToCart: 5 }, server: { AddToCart: 5 } })
    const res = data(await run({ view: 'sources', event: 'AddToCart', hours: 672 }))
    expect(res.answer.browserAndServer).toBe('yes')
    expect(res.counts.browser.AddToCart).toBe(20)
    expect(h.calls.filter((c) => c.query?.event_source === 'WEB_ONLY')).toHaveLength(4)
  })
  it('an account outside a business portfolio still answers; only the per-portfolio part says why it is missing', async () => {
    h.connections = [{ ...CHOSEN, adAccount: { ...CHOSEN.adAccount, businessId: null } }]
    setup({ browser: { Purchase: 2 }, server: { Purchase: 2 }, dedup: [eventId(50)] })
    const res = await run({ view: 'sources' })
    expect(res.ok, String(res.error)).toBe(true)
    expect(data(res).answer.gap).toBe('none')
    expect(data(res).integrations.alsoOnAnotherBusinessesAdAccount).toBeNull()
    expect(h.calls.some((c) => c.path.endsWith('/shared_accounts'))).toBe(false)
  })
  it('sendersVerdict is the whole rule', () => {
    expect(sendersVerdict({ browserCount: 5, serverCount: 5, dedupKeys: [], coveragePercent: null })).toMatchObject({ both: 'yes', deduplicated: 'unknown', gap: 'unknown' })
    // One side unread and the other at 0 proves nothing (maybe no sale at all): unknown, never "no".
    expect(sendersVerdict({ browserCount: null, serverCount: 0, dedupKeys: [], coveragePercent: null })).toMatchObject({ both: 'unknown', server: 'no', gap: 'unknown' })
    expect(sendersVerdict({ browserCount: 3, serverCount: null, dedupKeys: [], coveragePercent: null })).toMatchObject({ both: 'unknown', browser: 'yes', gap: 'unknown' })
  })
})

describe('quality, money and other accounts\' ad sets', () => {
  it('event spend in minor units of its currency; an ad set of the chosen account in full, another account\'s by id only', async () => {
    h.knownAdSets = new Set(['120000000000201'])
    h.answer = (req) => {
      if (req.path === 'dataset_quality') {
        return {
          web: [{
            event_name: 'Purchase', event_spend: { amount: 108947.38, currency_code: 'mxn' },
            event_match_quality: { composite_score: 6.2, match_key_feedback: [{ identifier: 'email', coverage: { percentage: 100 } }] },
            event_ad_sets: { data: [
              { ad_set_id: '120000000000201', ad_set_name: 'Ad set A', objective: 'Sales', spend_amount: 20.5, spend_currency_code: 'EUR', event_use: 'Optimization' },
              { ad_set_id: '120000000000299', ad_set_name: 'Their ad set', objective: 'Sales', spend_amount: 99, spend_currency_code: 'EUR', event_use: 'Optimization' },
            ] },
            dedupe_key_feedback: [{ dedupe_key: 'event_id', browser_events_with_dedupe_key: { percentage: 100 }, server_events_with_dedupe_key: { percentage: 100 }, overall_browser_coverage_from_dedupe_key: { percentage: 14.8 } }],
          }],
        }
      }
      if (req.operation === 'datasets.adSetCheck') return { account_id: OTHER_ACCOUNT }
      return {}
    }
    const res = data(await run({ view: 'quality' }))
    const event = res.events[0]
    expect(event).toMatchObject({ eventName: 'Purchase', spendCents: 10894738, spendCurrency: 'MXN', matchQuality: { score: 6.2, matchKeys: [{ key: 'email', coveragePercent: 100 }] } })
    expect(event.adSets).toEqual([
      { adSetId: '120000000000201', ofChosenAdAccount: true, name: 'Ad set A', objective: 'Sales', eventUse: 'Optimization', spendCents: 2050, spendCurrency: 'EUR' },
      { adSetId: '120000000000299', ofChosenAdAccount: false },
    ])
    expect(event.dedupKeys).toEqual([{ key: 'event_id', browserEventsWithKeyPercent: 100, serverEventsWithKeyPercent: 100, browserEventsDedupedPercent: 14.8 }])
    expect(JSON.stringify(res)).not.toMatch(/Their ad set/)
    expect(h.calls.find((c) => c.path === 'dataset_quality')?.query?.fields).toMatch(/^web\{event_name,event_match_quality\{/)
  })
  it('currencyCents follows the currency\'s decimals', () => {
    expect(currencyCents(12.345, 'EUR')).toEqual({ cents: 1235, currency: 'EUR' })
    expect(currencyCents(1500, 'jpy')).toEqual({ cents: 1500, currency: 'JPY' })
    expect(currencyCents(undefined, 'EUR')).toEqual({ cents: null, currency: 'EUR' })
  })
  it('statsWindows: at most 7 days a request, at most 28 days', () => {
    expect(statsWindows(672, NOW)).toHaveLength(4)
    expect(statsWindows(1000, NOW)).toHaveLength(4)
    expect(statsWindows(1, NOW)).toEqual([{ start: NOW.getTime() / 1000 - 3600, end: NOW.getTime() / 1000 }])
  })
  it('stats sums the hours per value; URLs never keep a query', async () => {
    h.rowsFor = (req) => (req.path === `act_${OWN}/adspixels` ? pixels : req.path === `${PIXEL}/stats` ? [
      { aggregation: 'url', start_time: 'a', data: [{ value: 'https://shop.example/thanks?email=a@b.c', count: 2 }] },
      { aggregation: 'url', start_time: 'b', data: [{ value: 'https://shop.example/thanks', count: 3 }] },
    ] : [])
    const res = data(await run({ view: 'stats', aggregation: 'url' }))
    expect(res.totals).toEqual({ 'https://shop.example/thanks': 5 })
    expect(JSON.stringify(res)).not.toMatch(/email=/)
  })
})

describe('custom conversions', () => {
  it('the account\'s, with Meta\'s 100-per-account count and the default value in minor units', async () => {
    h.rowsFor = (req) => (req.path === `act_${OWN}/customconversions` ? [
      { id: CC, account_id: OWN, name: 'Big order', custom_event_type: 'PURCHASE', default_conversion_value: 12.5, is_archived: false, rule: '{"and":[]}', pixel: { id: PIXEL } },
      { id: '120000000000702', account_id: OWN, name: 'Old', is_archived: true },
    ] : [])
    const res = data(await run({ view: 'custom-conversions' }))
    expect(res.count).toEqual({ total: 2, notArchived: 1, limitPerAdAccount: 100, left: 98, complete: true })
    expect(res.items[0]).toMatchObject({ customConversionId: CC, defaultValueCents: 1250, pixelId: PIXEL, rule: '{"and":[]}' })
    expect(res.note).toMatch(/rule cannot change after it is made/)
  })
  it('one of another account is refused before it is read; stats in US dollars come under the restricted key', async () => {
    expect((await run({ view: 'custom-conversions', scope: 'one', customConversionId: '120000000000799' })).error).toMatch(/not the chosen ad account's/)
    expect(h.calls.some((c) => c.operation === 'datasets.conversion')).toBe(false)
    h.rowsFor = (req) => (req.path === `${CC}/stats` ? [{ aggregation: 'usd_amount', data: [{ usd_amount: 10 }] }] : [])
    const res = data(await run({ view: 'custom-conversions', scope: 'stats', customConversionId: CC, conversionAggregation: 'usd_amount' }))
    expect(res).toHaveProperty('usdAmounts')
    expect(res).not.toHaveProperty('buckets')
  })
  it('the portfolio\'s: another account\'s by id, another business\'s account by the flag', async () => {
    h.taken = [{ id: OTHER_ACCOUNT }]
    h.rowsFor = (req) => (req.path === `${BIZ}/customconversions` ? [{ id: CC, account_id: OWN, name: 'Big order' }, { id: '120000000000703', account_id: OTHER_ACCOUNT, name: 'Their conversion' }] : [])
    const res = data(await run({ view: 'custom-conversions', scope: 'business' }))
    expect(res.all[1]).toEqual({ customConversionId: '120000000000703', adAccountId: OTHER_ACCOUNT, takenByAnotherBusiness: true })
    expect(JSON.stringify(res)).not.toMatch(/Their conversion/)
  })
})

describe('debug feeds never carry a buyer\'s data', () => {
  it('raw fires and the event log: no query string, never Meta\'s raw event body', async () => {
    h.rowsFor = (req) => (req.path === `act_${OWN}/adspixels` ? pixels : req.path === `${PIXEL}/raw_fires` ? [
      { event: 'Purchase', event_src: 'browser', placed_url: 'https://shop.example/thanks?order=55&email=a@b.c', user_pii_keys: 'em,ph', data_json: '{"em":"x"}' },
    ] : [])
    const res = data(await run({ view: 'diagnostics', check: 'raw-fires', event: 'Purchase' }))
    expect(res.items[0]).toMatchObject({ event: 'Purchase', eventSrc: 'browser', placedUrl: 'https://shop.example/thanks', userPiiKeys: 'em,ph' })
    expect(JSON.stringify(res)).not.toMatch(/order=|email=|dataJson|"em"/)
    for (const check of ['raw-fires', 'event-log']) {
      await run({ view: 'diagnostics', check, event: 'Purchase' })
      expect(String(h.calls.at(-1)?.query?.fields)).not.toMatch(/data_json|dedup_data|resolved_link/)
    }
  })
  it('the checks that need an input ask for it before any Meta call', async () => {
    expect((await run({ view: 'diagnostics', check: 'domains-last-fired' })).error).toMatch(/needs the domains/)
    expect((await run({ view: 'diagnostics', check: 'raw-fires' })).error).toMatch(/needs the event/)
    expect((await run({ view: 'diagnostics', check: 'microdata' })).error).toMatch(/name it \(catalogId\)/)
  })
})
