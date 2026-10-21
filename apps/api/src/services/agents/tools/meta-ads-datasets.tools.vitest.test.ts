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
  /** The pixel check (review A-N1): its owner portfolio, its ad accounts in a portfolio, its partner portfolios. */
  ownerFor: null as null | ((req: { path: string }) => unknown),
  sharedAccountsFor: null as null | ((req: { path: string; query?: Record<string, unknown> }) => unknown),
  agenciesFor: null as null | ((req: { path: string }) => unknown),
  knownAdSets: new Set<string>(),
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../marketing/meta-ads/read-client.js', async () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: Req) => {
    h.calls.push(req)
    if (req.operation === 'datasets.pixelOwner') {
      const owner = h.ownerFor?.(req) ?? { owner_business: { id: '9876543210' } }
      if (owner instanceof Error) throw owner
      return { body: owner, calls: 1 }
    }
    const body = h.answer?.(req)
    if (body instanceof Error) throw body
    return { body: body ?? {}, calls: 1 }
  }),
  metaReadAll: vi.fn(async (_t: unknown, req: Req, onRows: (rows: Record<string, unknown>[]) => void) => {
    h.calls.push(req)
    const custom = h.rowsFor?.(req)
    // By default a pixel is the chosen portfolio's, connected to the chosen ad account only, shared with no partner.
    const rows = req.path.endsWith('/shared_accounts') && !(custom instanceof Error) && !(Array.isArray(custom) && custom.length)
      ? (h.sharedAccountsFor?.(req) ?? [{ account_id: '1234567890', name: 'Shop A ads' }])
      : req.path.endsWith('/shared_agencies') && !(custom instanceof Error) && !(Array.isArray(custom) && custom.length)
        ? (h.agenciesFor?.(req) ?? [])
        : custom ?? []
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
    // nexus_meta_links_taken answers only the ids asked (taken.ts passes them as the template's second value).
    $queryRaw: vi.fn(async (_sql: unknown, _product: unknown, ids: string[]) => h.taken.filter((t) => ids.includes(t.id))),
  },
}))

import { META_ADS_DATASETS_TOOLS } from './meta-ads-datasets.tools.js'
import { CONVERSION_SCOPES, currencyCents, DATASET_VIEWS, DIAGNOSTIC_CHECKS, QUALITY_WEB_FIELDS_SDK, sendersVerdict, statsWindows, stripUrls } from '../../marketing/meta-ads/live-datasets.js'
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
  h.connections = [CHOSEN]; h.calls.length = 0; h.taken = []; h.ownerFor = null; h.sharedAccountsFor = null; h.agenciesFor = null; h.knownAdSets = new Set()
  pixels = [{ id: PIXEL, name: 'Shop A pixel', owner_business: { id: BIZ } }]
  h.answer = (req) => {
    if (req.operation === 'datasets.conversionOwner') return { account_id: req.path === CC ? OWN : OTHER_ACCOUNT, pixel: { id: PIXEL } }
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
    ['collaborative-ads', { actionSource: 'website' }, 'cpas_events_debugging_info'],
  ]
  it('covers every diagnostics check (microdata waits for step 12)', () => { expect([...CHECKS.map(([c]) => c), 'microdata'].sort()).toEqual([...DIAGNOSTIC_CHECKS].sort()) })
  it('diagnostics microdata is refused in words before any call (a catalog is checked to be the business\'s only from step 12)', async () => {
    expect((await run({ view: 'diagnostics', check: 'microdata' })).error).toMatch(/step 12's catalog ownership check/)
    expect(h.calls).toHaveLength(0)
    expect(() => tool.input.parse({ view: 'diagnostics', check: 'microdata', catalogId: '1' })).not.toThrow()
    expect(tool.input.parse({ view: 'diagnostics', check: 'microdata', catalogId: '1' })).not.toHaveProperty('catalogId')
  })
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
    // Not taken, but not on the chosen ad account either: Meta's lists cannot show where else it is used → unchecked.
    h.taken = []
    expect(data(await run({ view: 'portfolio' })).items[1]).toEqual({ pixelId: OTHER_PIXEL, onChosenAdAccount: false, checked: false })
  })
  it('access: the pixel\'s ad accounts, people and partners, read with the portfolio', async () => {
    h.rowsFor = (req) => {
      if (req.path === `act_${OWN}/adspixels`) return pixels
      if (req.path === `${PIXEL}/shared_accounts`) return [{ account_id: OWN, name: 'Shop A ads' }]
      return []
    }
    const res = data(await run({ view: 'access' }))
    expect(res.adAccounts.items).toEqual([{ adAccountId: OWN, name: 'Shop A ads', chosenHere: true, takenByAnotherBusiness: false }])
    expect(h.calls.find((c) => c.path === `${PIXEL}/shared_accounts`)?.query?.business).toBe(BIZ)
  })
})

describe('a pixel another business in Nexus uses is never read (review A4)', () => {
  const takenPixel = () => {
    h.taken = [{ id: OTHER_ACCOUNT }]
    h.rowsFor = (req) => {
      if (req.path === `act_${OWN}/adspixels`) return [{ id: PIXEL, name: 'Shared pixel' }]
      if (req.path === `${PIXEL}/shared_accounts`) return [{ account_id: OWN }, { account_id: OTHER_ACCOUNT, name: 'Shop B ads' }]
      return []
    }
  }
  it.each(['access', 'stats', 'sources', 'quality', 'diagnostics', 'gateway', 'event-setup', 'quality-offline'])('view %s refuses it before reading it', async (view) => {
    takenPixel()
    expect((await run({ view })).error).toMatch(/another business in Nexus uses/)
    expect(h.calls.filter((c) => c.path.startsWith(PIXEL) && c.operation !== 'datasets.pixelOwner' && !c.path.endsWith('/shared_accounts')).map((c) => c.path)).toEqual([])
    expect(h.calls.some((c) => c.path === 'dataset_quality')).toBe(false)
  })
  it('list and detail show it as its id and the flag only', async () => {
    takenPixel()
    expect(data(await run({ view: 'list' })).items).toEqual([{ pixelId: PIXEL, takenByAnotherBusiness: true }])
    h.calls.length = 0
    const res = data(await run({ view: 'detail' }))
    expect(res.pixel).toEqual({ pixelId: PIXEL, takenByAnotherBusiness: true })
    expect(h.calls.some((c) => c.operation === 'datasets.detail')).toBe(false)
    expect(JSON.stringify(res)).not.toMatch(/Shared pixel|Shop B/)
  })
  it('never "free" without the check: no portfolio, or a refused check, refuses the views and leaves list rows at their id', async () => {
    h.connections = [{ ...CHOSEN, adAccount: { ...CHOSEN.adAccount, businessId: null } }]
    expect((await run({ view: 'sources' })).error).toMatch(/could not check whether another business in Nexus also uses this pixel/)
    expect(data(await run({ view: 'list' })).items).toEqual([expect.objectContaining({ pixelId: PIXEL, checked: false })])
    h.connections = [CHOSEN]
    h.rowsFor = (req) => (req.path === `act_${OWN}/adspixels` ? pixels : req.path === `${PIXEL}/shared_accounts` ? metaError('200') : [])
    expect((await run({ view: 'quality' })).error).toMatch(/could not check/)
    const row = data(await run({ view: 'list' })).items[0]
    expect(row).not.toHaveProperty('name')
    expect(row).not.toHaveProperty('takenByAnotherBusiness')
  })
  it('A-N1 — owned by another portfolio, or not listing the chosen account: unchecked, never read in full', async () => {
    h.ownerFor = () => ({ owner_business: { id: '2222222222' } })
    const row = data(await run({ view: 'list' })).items[0]
    expect(row).toMatchObject({ pixelId: PIXEL, checked: false })
    expect(row.why).toMatch(/owned by another business portfolio/)
    expect(row).not.toHaveProperty('name')
    h.calls.length = 0
    expect((await run({ view: 'detail' })).error).toMatch(/owned by another business portfolio/)
    expect(h.calls.some((c) => c.operation === 'datasets.detail')).toBe(false)
    h.ownerFor = null
    h.sharedAccountsFor = () => [{ account_id: '4444444444' }]
    expect((await run({ view: 'sources' })).error).toMatch(/does not list the chosen ad account/)
  })
  it('A-N1 — a partner portfolio\'s ad accounts are checked too: another business\'s there = taken; unreadable = unchecked', async () => {
    h.agenciesFor = () => [{ id: '3333333333' }]
    h.taken = [{ id: OTHER_ACCOUNT }]
    h.sharedAccountsFor = (req) => (req.query?.business === '3333333333' ? [{ account_id: OTHER_ACCOUNT }] : [{ account_id: OWN }])
    // The chosen portfolio's list answers only the chosen account, so the hit is in the partner portfolio.
    h.taken = []
    expect((await run({ view: 'quality' })).ok).toBe(true)
    h.taken = [{ id: OTHER_ACCOUNT }]
    h.sharedAccountsFor = (req) => (req.query?.business === '3333333333' ? [{ account_id: OTHER_ACCOUNT }] : [])
    h.rowsFor = (req) => (req.path === `act_${OWN}/adspixels` ? pixels : req.path === `${PIXEL}/shared_accounts` && req.query?.business === BIZ ? [{ account_id: OWN }] : [])
    expect(data(await run({ view: 'list' })).items).toEqual([{ pixelId: PIXEL, takenByAnotherBusiness: true }])
    h.rowsFor = (req) => (req.path === `act_${OWN}/adspixels` ? pixels : req.path === `${PIXEL}/shared_accounts` && req.query?.business === '3333333333' ? metaError('200') : [])
    h.sharedAccountsFor = () => [{ account_id: OWN }]
    expect((await run({ view: 'sources' })).error).toMatch(/shared with another business portfolio whose ad accounts Meta does not show/)
    expect(refusedCalls()).toEqual([])
  })
  it('A-N2 — gateway and legacy-offline: full rows only for checked datasets, any other by its id', async () => {
    h.taken = [{ id: OTHER_ACCOUNT }]
    h.rowsFor = (req) => {
      if (req.path === `act_${OWN}/adspixels`) return pixels
      if (req.path === `${BIZ}/openbridge_configurations`) return [{ id: '61', pixel_id: PIXEL, partner_name: 'Ours' }, { id: '62', pixel_id: OTHER_PIXEL, partner_name: 'Theirs' }]
      if (req.path === `act_${OWN}/offline_conversion_data_sets`) return [{ id: PIXEL, name: 'Our set' }, { id: OTHER_PIXEL, name: 'Their set' }]
      if (req.path === `${BIZ}/offline_conversion_data_sets`) return [{ id: PIXEL, name: 'Our set' }, { id: OTHER_PIXEL, name: 'Their set' }]
      if (req.path === `${OTHER_PIXEL}/shared_accounts`) return [{ account_id: OWN }, { account_id: OTHER_ACCOUNT }]
      return []
    }
    const gateway = data(await run({ view: 'gateway' }))
    expect(gateway.portfolioGatewayConfigurations).toEqual([expect.objectContaining({ id: '61', partnerName: 'Ours' }), { id: '62', otherPixel: true }])
    const offline = data(await run({ view: 'legacy-offline' }))
    expect(offline.accountOfflineSets).toEqual([expect.objectContaining({ id: PIXEL, name: 'Our set' }), { pixelId: OTHER_PIXEL, takenByAnotherBusiness: true }])
    expect(offline.portfolioOfflineSets).toEqual([{ id: PIXEL, notChecked: true }, { id: OTHER_PIXEL, notChecked: true }])
    expect(data(await run({ view: 'legacy-offline', pixelId: PIXEL })).portfolioOfflineSets[0]).toMatchObject({ id: PIXEL, name: 'Our set' })
    expect(JSON.stringify(gateway) + JSON.stringify(offline)).not.toMatch(/Theirs|Their set/)
  })
  it('detail lists only the chosen account\'s own audiences built on the pixel', async () => {
    h.rowsFor = (req) => (req.path === `act_${OWN}/adspixels` ? pixels : req.path === `${PIXEL}/audiences` ? [
      { id: '120000000000401', account_id: OWN, name: 'Ours', approximate_count_lower_bound: 1, approximate_count_upper_bound: 2, retention_days: 30 },
      { id: '120000000000402', account_id: OTHER_ACCOUNT, name: 'Theirs' },
    ] : [])
    const res = data(await run({ view: 'detail' }))
    expect(res.audiences).toEqual([expect.objectContaining({ audienceId: '120000000000401', name: 'Ours', retentionDays: 30 })])
    expect(JSON.stringify(res)).not.toMatch(/Theirs/)
  })
})

describe('D2 — who sends the events (view sources)', () => {
  type Dqa = { coverage?: number | null; goal?: number | null; score?: number | null; dedup?: unknown[] } | Error | 'none'
  const setup = (input: { browser?: Record<string, number> | Error; server?: Record<string, number> | Error; dqa?: Dqa; partner?: Record<string, number> }) => {
    h.rowsFor = (req) => {
      if (req.path === `act_${OWN}/adspixels`) return pixels
      if (req.path === `${PIXEL}/stats` && req.query?.agent) return stats(input.partner ?? {})
      if (req.path === `${PIXEL}/stats` && req.query?.event_source === 'WEB_ONLY') return input.browser instanceof Error ? input.browser : stats(input.browser ?? {})
      if (req.path === `${PIXEL}/stats` && req.query?.event_source === 'SERVER_ONLY') return input.server instanceof Error ? input.server : stats(input.server ?? {})
      if (req.path === `${PIXEL}/stats`) return [{ aggregation: 'event_source', data: [{ value: 'server', count: 3 }] }]
      return []
    }
    h.answer = (req) => {
      if (req.path === 'dataset_quality') {
        const d = input.dqa ?? {}
        if (d instanceof Error) return d
        if (d === 'none') return { web: [] }
        return { web: [{
          event_name: 'Purchase',
          ...(d.coverage === null ? {} : { event_coverage: { percentage: d.coverage ?? 80, goal_percentage: d.goal === undefined ? 75 : d.goal } }),
          ...(d.score === null ? {} : { event_match_quality: { composite_score: d.score ?? 6.4 } }),
          dedupe_key_feedback: d.dedup ?? [],
        }] }
      }
      return { last_upload_app: 'Shop app', last_upload_app_changed_time: 1760000000 }
    }
  }
  const key = (name: string, overall: number | null, server = 98, browser = 100) => ({ dedupe_key: name, browser_events_with_dedupe_key: { percentage: browser }, server_events_with_dedupe_key: { percentage: server }, overall_browser_coverage_from_dedupe_key: overall === null ? {} : { percentage: overall } })
  const noServerSide: Dqa = { coverage: 0, score: null, dedup: [key('event_id', 0, 0)] }

  it('browser AND server, covered to Meta\'s goal → yes, no gap (upload-meta-events stays off)', async () => {
    setup({ browser: { Purchase: 10, PageView: 900 }, server: { Purchase: 9 }, dqa: { coverage: 80, goal: 75, dedup: [key('event_id', 70), key('external_id', 12)] } })
    const res = data(await run({ view: 'sources' }))
    expect(res.answer).toMatchObject({ browserAndServer: 'yes', browser: 'yes', server: 'yes', serverByStats: 'yes', serverByQuality: 'yes', deduplicated: 'yes', gap: 'none', coveragePercent: 80, dedupCoveragePercent: 82, coverageGoalPercent: 75, eventIdOnServerPercent: 98 })
    expect(res.answer.sentence).toMatch(/^Does Purchase come from the browser AND a server\? yes/)
    expect(res.counts.browser).toMatchObject({ Purchase: 10 })
    expect(res.integrations.lastUploadApp).toMatchObject({ app: 'Shop app' })
    expect(res.metaDoesNotGive.length).toBeGreaterThan(3)
    const sources = h.calls.filter((c) => c.path === `${PIXEL}/stats`).map((c) => c.query?.event_source ?? c.query?.aggregation)
    expect(sources.sort()).toEqual(['SERVER_ONLY', 'WEB_ONLY', 'event_source'])
  })
  it('Meta\'s own example (34.1% coverage, goal 75%) is a coverage gap, never "no gap"', async () => {
    setup({ browser: { Purchase: 10 }, server: { Purchase: 4 }, dqa: { coverage: 34.1, goal: 75, dedup: [key('event_id', 14.8), key('external_id', 15.96)] } })
    const answer = data(await run({ view: 'sources' })).answer
    expect(answer).toMatchObject({ browserAndServer: 'yes', gap: 'coverage', coveragePercent: 34.1 })
    expect(answer.gapWords).toMatch(/covers about 34.1% of browser Purchase events; Meta's goal is 75%/)
  })
  it('server "no" only when the stats AND the Dataset Quality API show no server side; they disagree → unknown', async () => {
    setup({ browser: { Purchase: 10 }, server: {}, dqa: noServerSide })
    expect(data(await run({ view: 'sources' })).answer).toMatchObject({ browserAndServer: 'no', server: 'no', gap: 'server' })
    setup({ browser: { Purchase: 10 }, server: {}, dqa: 'none' })
    expect(data(await run({ view: 'sources' })).answer).toMatchObject({ server: 'no', gap: 'server' })
    // The stats say no server event, but Meta's quality API scores server events: unknown, never a false "missing".
    setup({ browser: { Purchase: 10 }, server: {}, dqa: { coverage: 0, score: 6.1, dedup: [] } })
    expect(data(await run({ view: 'sources' })).answer).toMatchObject({ serverByStats: 'no', serverByQuality: 'yes', server: 'unknown', browserAndServer: 'unknown', gap: 'unknown' })
    // The stats count server events, but the quality API shows none: unknown, never a false "covered".
    setup({ browser: { Purchase: 10 }, server: { Purchase: 5 }, dqa: noServerSide })
    expect(data(await run({ view: 'sources' })).answer).toMatchObject({ serverByStats: 'yes', serverByQuality: 'no', server: 'unknown', gap: 'unknown' })
    // The quality API refused: the server side stays unknown either way.
    setup({ browser: { Purchase: 10 }, server: { Purchase: 5 }, dqa: metaError('100') })
    const refused = data(await run({ view: 'sources' }))
    expect(refused.answer).toMatchObject({ server: 'unknown', gap: 'unknown' })
    expect(refused.deduplication.refused).toBe('Meta refused the read (100).')
  })
  it('coverage is Meta\'s documented pair alone (B-N1): at the goal → none; 60% under a 75% goal → coverage even with a dedup sum of 80; no coverage → unknown', async () => {
    setup({ browser: { Purchase: 10 }, server: { Purchase: 9 }, dqa: { coverage: 75, goal: 75, dedup: [key('event_id', 75)] } })
    expect(data(await run({ view: 'sources' })).answer).toMatchObject({ gap: 'none', coveragePercent: 75 })
    setup({ browser: { Purchase: 10 }, server: { Purchase: 9 }, dqa: { coverage: 60, goal: 75, dedup: [key('event_id', 50), key('external_id', 30)] } })
    expect(data(await run({ view: 'sources' })).answer).toMatchObject({ gap: 'coverage', coveragePercent: 60, dedupCoveragePercent: 80 })
    setup({ browser: { Purchase: 10 }, server: { Purchase: 9 }, dqa: { coverage: null, dedup: [key('event_id', 50)] } })
    expect(data(await run({ view: 'sources' })).answer).toMatchObject({ browserAndServer: 'yes', gap: 'unknown', coveragePercent: null })
  })
  it('B-N2 — both send and Meta deduplicates nothing: dedup, even when the coverage reaches the goal', async () => {
    setup({ browser: { Purchase: 10 }, server: { Purchase: 9 }, dqa: { coverage: 80, goal: 75, dedup: [key('event_id', 0), key('fbp', 0)] } })
    expect(data(await run({ view: 'sources' })).answer).toMatchObject({ gap: 'dedup', deduplicated: 'no', dedupCoveragePercent: 0 })
  })
  it('B-N3 — a missing per-key share is not 0: no dedup sum, never "deduplicates none"', async () => {
    setup({ browser: { Purchase: 10 }, server: { Purchase: 9 }, dqa: { coverage: 80, goal: 75, dedup: [key('event_id', 0), key('fbp', null)] } })
    expect(data(await run({ view: 'sources' })).answer).toMatchObject({ dedupCoveragePercent: null, deduplicated: 'unknown', gap: 'none' })
  })
  it('B-N4 — browser "no" only when the quality API shows no browser side either; they disagree → unknown', async () => {
    setup({ browser: {}, server: { Purchase: 4 }, dqa: { coverage: 0, dedup: [key('event_id', 0, 98, 100)] } })
    expect(data(await run({ view: 'sources' })).answer).toMatchObject({ browserByStats: 'no', browserByQuality: 'yes', browser: 'unknown', gap: 'unknown' })
  })
  it('server only → no, the gap is the browser pixel; both but nothing deduplicated → dedup; nothing at all → unknown', async () => {
    setup({ browser: {}, server: { Purchase: 4 }, dqa: { coverage: 0, dedup: [key('event_id', 0, 98, 0)] } })
    expect(data(await run({ view: 'sources' })).answer).toMatchObject({ browserAndServer: 'no', browser: 'no', gap: 'browser' })
    setup({ browser: { Purchase: 10 }, server: { Purchase: 10 }, dqa: { coverage: 0, dedup: [key('event_id', 0)] } })
    expect(data(await run({ view: 'sources' })).answer).toMatchObject({ browserAndServer: 'yes', deduplicated: 'no', gap: 'dedup' })
    setup({ browser: {}, server: {}, dqa: noServerSide })
    expect(data(await run({ view: 'sources' })).answer).toMatchObject({ browserAndServer: 'unknown', gap: 'unknown' })
    setup({ browser: { Purchase: 10 }, server: { Purchase: 10 }, dqa: { coverage: 90, goal: null, dedup: [key('event_id', 90)] } })
    expect(data(await run({ view: 'sources' })).answer).toMatchObject({ browserAndServer: 'yes', gap: 'unknown' })
  })
  it('a partner is proven by Meta\'s count of the server events sent with its agent name (a made-up name: not seen)', async () => {
    setup({ browser: { Purchase: 1 }, server: { Purchase: 1 }, partner: { Purchase: 7 } })
    expect(data(await run({ view: 'sources', agentName: 'shop' })).integrations.partnerAgent).toMatchObject({ agentName: 'shop', serverEventsSent: 7, sendsThisEventByServer: 'yes' })
    expect(h.calls.find((c) => c.query?.agent)?.query).toMatchObject({ aggregation: 'event', event_source: 'SERVER_ONLY', agent: 'shop' })
    expect(h.calls.some((c) => c.path === 'dataset_quality' && c.query?.agent_name)).toBe(false)
    setup({ browser: { Purchase: 1 }, server: { Purchase: 1 }, partner: {} })
    expect(data(await run({ view: 'sources', agentName: 'made-up-agent' })).integrations.partnerAgent).toMatchObject({ sendsThisEventByServer: 'not-seen', serverEventsSent: 0 })
    expect(refusedCalls()).toEqual([])
  })
  it('28 days are read in four windows, each shorter than 7 days; another event can be checked', async () => {
    setup({ browser: { AddToCart: 5 }, server: { AddToCart: 5 } })
    const res = data(await run({ view: 'sources', event: 'AddToCart', hours: 672 }))
    expect(res.counts.browser.AddToCart).toBe(20)
    const windows = h.calls.filter((c) => c.query?.event_source === 'WEB_ONLY').map((c) => Number(c.query?.end_time) - Number(c.query?.start_time))
    expect(windows).toHaveLength(4)
    for (const w of windows) expect(w).toBeLessThan(7 * 24 * 3600)
  })
  it('sendersVerdict is the whole rule', () => {
    const read = (extra: Partial<{ row: boolean; matchQualityScore: number | null; coveragePercent: number | null; goalPercent: number | null; dedupKeys: any[] }> = {}) => ({ row: true, matchQualityScore: 6, coveragePercent: 80, goalPercent: 75, dedupKeys: [], ...extra })
    expect(sendersVerdict({ browserCount: 5, serverCount: 5, quality: read() })).toMatchObject({ both: 'yes', deduplicated: 'unknown', gap: 'none' })
    expect(sendersVerdict({ browserCount: 5, serverCount: 5, quality: read({ coveragePercent: 74.9 }) })).toMatchObject({ gap: 'coverage' })
    // One side unread and the other at 0 proves nothing (maybe no sale at all): unknown, never "no".
    expect(sendersVerdict({ browserCount: null, serverCount: 0, quality: read({ matchQualityScore: null, coveragePercent: 0 }) })).toMatchObject({ both: 'unknown', server: 'no', gap: 'unknown' })
    expect(sendersVerdict({ browserCount: 3, serverCount: null, quality: read() })).toMatchObject({ both: 'unknown', browser: 'yes', gap: 'unknown' })
    expect(sendersVerdict({ browserCount: 3, serverCount: 3, quality: { refused: true } })).toMatchObject({ server: 'unknown', gap: 'unknown' })
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
  it('statsWindows: each window shorter than 7 days, starting one minute after now − hours, at most 28 days', () => {
    const end = NOW.getTime() / 1000
    expect(statsWindows(1, NOW)).toEqual([{ start: end - 3600 + 60, end }])
    expect(statsWindows(168, NOW)).toEqual([{ start: end - 7 * 24 * 3600 + 60, end }])
    const four = statsWindows(672, NOW)
    expect(four).toHaveLength(4)
    expect(four[0].start).toBe(end - 28 * 24 * 3600 + 60)
    expect(four.at(-1)!.end).toBe(end)
    for (let i = 1; i < 4; i++) expect(four[i].start).toBe(four[i - 1].end)
    for (const w of four) expect(w.end - w.start).toBeLessThan(7 * 24 * 3600)
    expect(statsWindows(1000, NOW)).toHaveLength(4)
  })
  it('stripUrls: every web address at any depth loses its query and fragment', () => {
    expect(stripUrls({ a: [{ b: 'see https://shop.example/thanks?email=a@b.c#x and http://x.example/p?q=1' }], n: 3 }))
      .toEqual({ a: [{ b: 'see https://shop.example/thanks and http://x.example/p' }], n: 3 })
  })
  it('stats sums the hours per value; URLs never keep a query', async () => {
    h.rowsFor = (req) => (req.path === `act_${OWN}/adspixels` ? pixels : req.path === `${PIXEL}/stats` ? [
      { aggregation: 'url', start_time: 'a', data: [{ value: 'https://shop.example/thanks?email=a@b.c', count: 2 }] },
      { aggregation: 'url', start_time: 'b', data: [{ value: 'https://shop.example/thanks', count: 3 }] },
    ] : [])
    const res = data(await run({ view: 'stats', aggregation: 'url' }))
    expect(res.totals).toEqual({ 'https://shop.example/thanks': 5 })
    expect(JSON.stringify(res)).not.toMatch(/email=/)
    h.rowsFor = (req) => (req.path === `act_${OWN}/adspixels` ? pixels : req.path === `${PIXEL}/stats` ? [{ aggregation: 'url_by_rule', data: [{ value: 'https://shop.example/p?order=55', count: 1 }] }] : [])
    expect(JSON.stringify(data(await run({ view: 'stats', aggregation: 'url_by_rule' })))).not.toMatch(/order=55/)
  })
  it('quality: when Meta refuses the newer fields (#100), it reads again without value_diagnostics and event_delay', async () => {
    h.answer = (req) => (req.path === 'dataset_quality'
      ? (String(req.query?.fields).includes('event_delay') ? metaError('100') : { web: [{ event_name: 'Purchase' }] })
      : {})
    const res = data(await run({ view: 'quality' }))
    expect(res.events).toHaveLength(1)
    expect(res.withoutFields).toEqual(['value_diagnostics', 'event_delay'])
    const asked = h.calls.filter((c) => c.path === 'dataset_quality').map((c) => String(c.query?.fields))
    expect(asked).toHaveLength(2)
    expect(asked[1]).toBe(`web{${QUALITY_WEB_FIELDS_SDK}}`)
    expect(asked[1]).not.toMatch(/value_diagnostics|event_delay/)
    expect(asked[1]).toMatch(/event_spend\{amount,currency_code\}/)
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
  it('one of another account — or another kind of object — is refused before it is read; stats in US dollars come under the restricted key', async () => {
    expect((await run({ view: 'custom-conversions', scope: 'one', customConversionId: '120000000000799' })).error).toMatch(/not a custom conversion of the chosen ad account/)
    expect(h.calls.find((c) => c.operation === 'datasets.conversionOwner')?.query?.fields).toBe('account_id,custom_event_type,pixel{id}')
    expect(h.calls.some((c) => c.operation === 'datasets.conversion')).toBe(false)
    const answer = h.answer
    h.answer = (req) => (req.operation === 'datasets.conversionOwner' ? metaError('100') : answer!(req))
    expect((await run({ view: 'custom-conversions', scope: 'one', customConversionId: '120000000000101' })).error).toMatch(/not a custom conversion of the chosen ad account/)
    h.answer = answer
    h.rowsFor = (req) => (req.path === `${CC}/stats` ? [{ aggregation: 'url', data: [{ value: 'https://shop.example/thanks?email=a@b.c', count: 2 }] }] : [])
    expect(JSON.stringify(data(await run({ view: 'custom-conversions', scope: 'stats', customConversionId: CC, conversionAggregation: 'url' })))).not.toMatch(/email=/)
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

describe('A-N5 — a custom conversion is read only through a checked pixel', () => {
  it('its pixel taken, unchecked or not named → refused before its stats or details are read', async () => {
    h.taken = [{ id: OTHER_ACCOUNT }]
    h.sharedAccountsFor = () => [{ account_id: OWN }, { account_id: OTHER_ACCOUNT }]
    expect((await run({ view: 'custom-conversions', scope: 'stats', customConversionId: CC })).error).toMatch(/counts a pixel another business in Nexus also uses/)
    h.taken = []; h.sharedAccountsFor = null
    h.ownerFor = () => ({ owner_business: { id: '2222222222' } })
    expect((await run({ view: 'custom-conversions', scope: 'one', customConversionId: CC })).error).toMatch(/could not check/)
    h.ownerFor = null
    const answer = h.answer!
    h.answer = (req) => (req.operation === 'datasets.conversionOwner' ? { account_id: OWN } : answer(req))
    expect((await run({ view: 'custom-conversions', scope: 'one', customConversionId: CC })).error).toMatch(/names no pixel/)
    expect(h.calls.some((c) => c.operation === 'datasets.conversion' || c.path === `${CC}/stats`)).toBe(false)
  })
})

describe('debug feeds never carry a buyer\'s data', () => {
  it('A-S1 — addresses without a scheme lose their query too; event-setup and value diagnostics are stripped', async () => {
    expect(stripUrls(['shop.example/thanks?order=55&email=a@b.c', '/checkout/thanks?email=a@b.c', '//cdn.shop.example/a?b=1', 'Is it ready? yes']))
      .toEqual(['shop.example/thanks', '/checkout/thanks', '//cdn.shop.example/a', 'Is it ready? yes'])
    h.rowsFor = (req) => (req.path === `act_${OWN}/adspixels` ? pixels
      : req.path === `${PIXEL}/event_rules` ? [{ id: '1', event_type: 'Purchase', rule: '{"url":{"i_contains":"thanks"}}', sample_urls: ['https://shop.example/thanks?email=a@b.c', 'shop.example/thanks?order=55'] }]
        : req.path === `${PIXEL}/extractors` ? [{ id: '2', event_type: 'Purchase', domain_uri: 'https://shop.example/p?ref=x' }] : [])
    const res = data(await run({ view: 'event-setup' }))
    expect(res.eventRules[0].sampleUrls).toEqual(['https://shop.example/thanks', 'shop.example/thanks'])
    expect(res.parameterExtractors[0].domainUri).toBe('https://shop.example/p')
    h.answer = (req) => (req.path === 'dataset_quality' ? { web: [{ event_name: 'Purchase', value_diagnostics: [{ issue_type: 'MISSING_OR_INVALID_VALUE', issue_example: 'shop.example/thanks?email=a@b.c' }] }] } : {})
    expect(data(await run({ view: 'quality' })).events[0].valueDiagnostics).toEqual([{ issueType: 'MISSING_OR_INVALID_VALUE', issueExample: 'shop.example/thanks' }])
  })
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
  })
})
