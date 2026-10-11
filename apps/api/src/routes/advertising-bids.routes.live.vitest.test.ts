/**
 * KAPI-S — the Bid page's suggested bids, live cursor and per-row delivery, on a real PostgreSQL (PGlite), business
 * profiles ON. Amazon is never asked: `fetchThemeBidRecommendations` (ads-api-client.ts, tested on Amazon's documented
 * payload in ads-api-client.theme-bids.vitest.test.ts) is a stand-in here, and the market's Ads profile is set per test.
 *
 *   suggested    GET /api/advertising/bids/suggested: rows for every keyword and target of the ad group (or the campaign's
 *                ad groups), null where Amazon gave nothing; honest `unavailable` reasons (sandbox, no connection, a test
 *                account, not on Amazon yet, not Sponsored Products, Amazon's error, a partial answer); 6 hours of cache
 *                per ad group (a new keyword asks again; a failure is kept 5 minutes); money stripped without ad spend;
 *                another business's ids are a 404; ads.view only
 *   delivery     BidRow.delivery: what became of each bid's newest change (Waiting · Sent · Live · Failed · Cancelled ·
 *                Replaced · Undone · none), from its AdMutation and its action-log row
 *   cursor       GET /api/advertising/bids/cursor: the newest move in scope, how many bids are Waiting / Sent (the same
 *                reading as the rows), no-store, the scope of /bids, 404 for another business's ids
 *
 * Values are made up (public repo).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../test-support/formula-database.js'
import { withWorkspace } from '../lib/workspace-context.js'
import type { ResolvedPermissions } from '../lib/auth/rbac.js'
import type { ThemeBidFetch, ThemeBidSuggestion, ThemeExpression } from '../services/advertising/ads-api-client.js'
import { __resetSuggestedBidsCache, readSuggestedBids } from '../services/advertising/bid-suggested.service.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const h = vi.hoisted(() => ({
  mode: 'live' as 'live' | 'sandbox',
  profiles: {} as Record<string, { profileId: string; region: string; mode: string } | null>,
  calls: [] as Array<{ adGroupId: string; expressions: ThemeExpression[] }>,
  /** What the stand-in answers: a failure for every call, a failure for some expressions, or Amazon's numbers. */
  fail: null as null | { reason: string; expressions?: number },
}))
vi.mock('../services/advertising/ads-api-client.js', async (original) => {
  const real = await original<typeof import('../services/advertising/ads-api-client.js')>()
  return {
    ...real,
    adsMode: () => h.mode,
    fetchThemeBidRecommendations: vi.fn(async (_ctx: unknown, input: { externalAdGroupId: string; expressions: ThemeExpression[] }): Promise<ThemeBidFetch> => {
      h.calls.push({ adGroupId: input.externalAdGroupId, expressions: input.expressions })
      const suggestions = new Map<string, ThemeBidSuggestion>()
      const failed = h.fail ? (h.fail.expressions ?? input.expressions.length) : 0
      input.expressions.slice(failed).forEach((e, i) => {
        suggestions.set(real.themeExpressionKey(e), { type: e.type, value: e.value ?? null, theme: 'CONVERSION_OPPORTUNITIES', lowCents: 20 + i, midCents: 30 + i, highCents: 40 + i })
      })
      return { sandbox: false, suggestions, asked: input.expressions.length, failures: h.fail ? [{ expressions: failed, reason: h.fail.reason }] : [] }
    }),
  }
})
vi.mock('../services/advertising/ads-profile-resolver.js', async (original) => ({
  ...(await original<object>()),
  adsProfileFor: vi.fn(async (market: string) => {
    const p = h.profiles[market]
    return p ? { ...p, connectionId: null, writesEnabledAt: null, lastWriteAt: null, marketplace: market, source: 'row' } : null
  }),
}))

const A = 'kapi_s_alpha'
const B = 'kapi_s_beta'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const NOW = Date.now()
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const ago = (ms: number) => new Date(NOW - ms)
let app: FastifyInstance
let permissions: ResolvedPermissions = { isOwner: true, permissions: new Set() }

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const w of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [w])
  }
  await withWorkspace(business(A), async () => {
    const c = database.client as any
    const campaign = (id: string, extra: Record<string, unknown> = {}) => c.campaign.create({
      data: { id, name: `Campaign ${id}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra },
    })
    const group = (id: string, campaignId: string, extra: Record<string, unknown> = {}) => c.adGroup.create({ data: { id, campaignId, name: `group ${id}`, externalAdGroupId: `EXT-${id}`, ...extra } })
    const target = (id: string, adGroupId: string, kind: string, expressionType: string, expressionValue: string, extra: Record<string, unknown> = {}) => c.adTarget.create({
      data: { id, adGroupId, kind, expressionType, expressionValue, bidCents: 30, externalTargetId: `EXT-${id}`, ...extra },
    })

    // Suggested bids: one ad group with every kind of target, a second ad group in the same campaign.
    await campaign('c-sg')
    await group('g-sg', 'c-sg')
    await target('s-exact', 'g-sg', 'KEYWORD', 'EXACT', 'rain jacket')
    await target('s-phrase', 'g-sg', 'KEYWORD', 'PHRASE', 'rain jacket men')
    await target('s-asin', 'g-sg', 'PRODUCT', 'ASIN', 'B0TESTASN1')
    await target('s-auto', 'g-sg', 'AUTO', 'SEARCH_CLOSE_MATCH', '')
    await target('s-cat', 'g-sg', 'CATEGORY', 'CATEGORY', '1234567')
    await target('s-neg', 'g-sg', 'KEYWORD', 'EXACT', 'cheap jacket', { isNegative: true })
    await target('s-arch', 'g-sg', 'KEYWORD', 'EXACT', 'old jacket', { status: 'ARCHIVED' })
    await target('s-paused', 'g-sg', 'KEYWORD', 'BROAD', 'jacket', { status: 'PAUSED' })
    await group('g-sg2', 'c-sg')
    await target('s-two', 'g-sg2', 'KEYWORD', 'BROAD', 'boots')
    // Not on Amazon yet; Sponsored Brands; markets with no connection and with a test account.
    await campaign('c-local')
    await group('g-local', 'c-local', { externalAdGroupId: null })
    await target('s-local', 'g-local', 'KEYWORD', 'EXACT', 'new jacket')
    await campaign('c-sb', { type: 'SB', adProduct: 'SPONSORED_BRANDS' })
    await group('g-sb', 'c-sb')
    await target('s-sb', 'g-sb', 'KEYWORD', 'EXACT', 'brand jacket')
    await campaign('c-de', { marketplace: 'DE' })
    await group('g-de', 'c-de')
    await target('s-de', 'g-de', 'KEYWORD', 'EXACT', 'regenjacke')
    await campaign('c-fr', { marketplace: 'FR' })
    await group('g-fr', 'c-fr')
    await target('s-fr', 'g-fr', 'KEYWORD', 'EXACT', 'veste pluie')

    // Delivery: one bid per outcome of its newest change.
    await campaign('c-dl')
    await group('g-dl', 'c-dl')
    for (const id of ['d-wait', 'd-sent', 'd-live', 'd-fail', 'd-undo', 'd-stale', 'd-repl', 'd-cancel', 'd-later-log', 'd-old', 'd-none']) await target(id, 'g-dl', 'KEYWORD', 'EXACT', `jacket ${id}`)
    const mutation = (entityId: string, state: string, createdAt: Date, updatedAt: Date, outboundQueueId: string | null) => c.adMutation.create({
      data: { entityType: 'AD_TARGET', entityId, field: 'bid', intendedValue: '31', previousValue: '30', state, actor: 'user:u1', createdAt, updatedAt, outboundQueueId },
    })
    const log = (entityId: string, status: string, createdAt: Date, extra: Record<string, unknown> = {}) => c.advertisingActionLog.create({
      data: { userId: 'user:u1', actionType: 'AD_BID_UPDATE', entityType: 'AD_TARGET', entityId, payloadBefore: { bidCents: 30 }, payloadAfter: { bidCents: 31 }, createdAt, amazonResponseStatus: status, ...extra },
    })
    await mutation('d-wait', 'PENDING', ago(2 * MIN), ago(2 * MIN), 'q-wait')
    await log('d-wait', 'PENDING', ago(2 * MIN), { outboundQueueId: 'q-wait' })
    // The newest move in scope: d-sent's write went in flight 30 s ago.
    await mutation('d-sent', 'IN_FLIGHT', ago(3 * MIN), ago(30_000), 'q-sent')
    await log('d-sent', 'PENDING', ago(3 * MIN), { outboundQueueId: 'q-sent' })
    await mutation('d-live', 'APPLIED', ago(HOUR), ago(59 * MIN), 'q-live')
    await log('d-live', 'SUCCESS', ago(HOUR), { outboundQueueId: 'q-live' })
    await log('d-fail', 'FAILED', ago(2 * HOUR))
    await log('d-undo', 'SUCCESS', ago(3 * HOUR), { rolledBackAt: ago(10 * MIN) })
    await log('d-stale', 'PENDING', ago(3 * DAY))
    await mutation('d-repl', 'APPLIED', ago(5 * HOUR), ago(5 * HOUR), 'q-r1')
    await log('d-repl', 'SUCCESS', ago(5 * HOUR), { outboundQueueId: 'q-r1' })
    await mutation('d-repl', 'SUPERSEDED', ago(4 * HOUR), ago(4 * HOUR), 'q-r2')
    await log('d-repl', 'SUPERSEDED', ago(4 * HOUR), { outboundQueueId: 'q-r2' })
    await log('d-cancel', 'SKIPPED', ago(6 * HOUR))
    await mutation('d-later-log', 'APPLIED', ago(2 * DAY), ago(2 * DAY), 'q-x')
    await log('d-later-log', 'FAILED', ago(DAY)) // a later write the gate refused (no queue row)
    await mutation('d-old', 'PENDING', ago(40 * DAY), ago(40 * DAY), 'q-old') // outside the 30 days
  })
  await withWorkspace(business(B), async () => {
    const c = database.client as any
    await c.campaign.create({ data: { id: 'b-camp', name: 'Other business', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-b-camp', dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z') } })
    await c.adGroup.create({ data: { id: 'b-group', campaignId: 'b-camp', name: 'other group', externalAdGroupId: 'EXT-b-group' } })
    await c.adTarget.create({ data: { id: 'b-target', adGroupId: 'b-group', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'other jacket', bidCents: 40 } })
    await c.adMutation.create({ data: { entityType: 'AD_TARGET', entityId: 'b-target', field: 'bid', state: 'PENDING', actor: 'user:u2' } })
  })
  const { default: routes } = await import('./advertising-bids.routes.js')
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    request.__rbacResolved = permissions
    withWorkspace(business(A), done)
  })
  await app.register(routes, { prefix: '/api' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.close()
  await database?.close()
}, 30_000)

beforeEach(() => {
  __resetSuggestedBidsCache()
  h.mode = 'live'
  h.profiles = { IT: { profileId: 'P-IT-TEST', region: 'EU', mode: 'production' }, FR: { profileId: 'P-FR-TEST', region: 'EU', mode: 'sandbox' } }
  h.calls = []
  h.fail = null
  permissions = { isOwner: true, permissions: new Set() }
})

type Row = Record<string, any>
const suggested = (query: string) => app.inject({ method: 'GET', url: `/api/advertising/bids/suggested?${query}` })
const cursor = (query = '') => app.inject({ method: 'GET', url: `/api/advertising/bids/cursor${query ? `?${query}` : ''}` })
const byTarget = (rows: Row[]) => new Map(rows.map((r) => [r.targetId, r]))
const inA = <T,>(work: () => Promise<T>) => withWorkspace(business(A), work)

describe('GET /api/advertising/bids/suggested', () => {
  it('every keyword and target of the ad group, Amazon\'s low / mid / high and theme; null where Amazon is not asked', async () => {
    const res = await suggested('adGroupId=g-sg')
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const body = res.json()
    expect(body.unavailable).toBeNull()
    expect(Date.parse(body.fetchedAt)).toBeGreaterThanOrEqual(NOW)
    // Not negative, not archived; a paused one is in.
    expect(body.rows.map((r: Row) => r.targetId).sort()).toEqual(['s-asin', 's-auto', 's-cat', 's-exact', 's-paused', 's-phrase'])
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].adGroupId).toBe('EXT-g-sg')
    expect(h.calls[0].expressions).toEqual(expect.arrayContaining([
      { type: 'KEYWORD_EXACT_MATCH', value: 'rain jacket' }, { type: 'KEYWORD_PHRASE_MATCH', value: 'rain jacket men' },
      { type: 'PAT_ASIN', value: 'B0TESTASN1' }, { type: 'CLOSE_MATCH' }, { type: 'KEYWORD_BROAD_MATCH', value: 'jacket' },
    ]))
    expect(h.calls[0].expressions).toHaveLength(5)
    const rows = byTarget(body.rows)
    for (const id of ['s-exact', 's-phrase', 's-asin', 's-auto', 's-paused']) {
      expect(rows.get(id)).toMatchObject({ theme: 'CONVERSION_OPPORTUNITIES', low: expect.any(Number), mid: expect.any(Number), high: expect.any(Number) })
      expect(rows.get(id)!.low).toBeLessThan(rows.get(id)!.mid)
    }
    // A category target: Amazon is not asked — null, never Nexus's own median.
    expect(rows.get('s-cat')).toEqual({ targetId: 's-cat', low: null, mid: null, high: null, theme: null })
  })

  it('a campaign: every ad group\'s rows, one call per ad group', async () => {
    const body = (await suggested('campaignId=c-sg')).json()
    expect(body.rows.map((r: Row) => r.targetId).sort()).toEqual(['s-asin', 's-auto', 's-cat', 's-exact', 's-paused', 's-phrase', 's-two'])
    expect(h.calls.map((c) => c.adGroupId).sort()).toEqual(['EXT-g-sg', 'EXT-g-sg2'])
    expect(body.unavailable).toBeNull()
  })

  it('kept 6 hours per ad group: a second read asks nothing; a new keyword asks again; after 6 hours it asks again', async () => {
    const first = await inA(() => readSuggestedBids({ adGroupId: 'g-sg' }, () => NOW))
    expect(h.calls).toHaveLength(1)
    const again = await inA(() => readSuggestedBids({ adGroupId: 'g-sg' }, () => NOW + 6 * HOUR - 1))
    expect(h.calls).toHaveLength(1)
    expect(again).toEqual(first)
    // Two reads at once share one call.
    __resetSuggestedBidsCache()
    h.calls = []
    await Promise.all([inA(() => readSuggestedBids({ adGroupId: 'g-sg' }, () => NOW)), inA(() => readSuggestedBids({ adGroupId: 'g-sg' }, () => NOW))])
    expect(h.calls).toHaveLength(1)
    // A keyword the cached answer did not ask about.
    await inA(() => (database.client as any).adTarget.create({ data: { id: 's-new', adGroupId: 'g-sg', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'storm jacket', bidCents: 30 } }))
    try {
      const withNew = await inA(() => readSuggestedBids({ adGroupId: 'g-sg' }, () => NOW + MIN))
      expect(h.calls).toHaveLength(2)
      expect(h.calls[1].expressions).toContainEqual({ type: 'KEYWORD_EXACT_MATCH', value: 'storm jacket' })
      expect(withNew.ok && withNew.answer.rows.find((r) => r.targetId === 's-new')?.mid).toEqual(expect.any(Number))
      await inA(() => readSuggestedBids({ adGroupId: 'g-sg' }, () => NOW + 6 * HOUR + 2 * MIN))
      expect(h.calls).toHaveLength(3)
    } finally {
      await inA(() => (database.client as any).adTarget.delete({ where: { id: 's-new' } }))
    }
  })

  it('Amazon\'s error: no numbers, the reason in words, kept 5 minutes (not 6 hours)', async () => {
    h.fail = { reason: 'Amazon is busy (too many requests). Try again in a few minutes.' }
    const out = await inA(() => readSuggestedBids({ adGroupId: 'g-sg' }, () => NOW))
    expect(out.ok && out.answer).toMatchObject({ unavailable: 'Amazon is busy (too many requests). Try again in a few minutes.', fetchedAt: new Date(NOW).toISOString() })
    expect(out.ok && out.answer.rows.every((r) => r.mid === null && r.theme === null)).toBe(true)
    await inA(() => readSuggestedBids({ adGroupId: 'g-sg' }, () => NOW + 4 * MIN))
    expect(h.calls).toHaveLength(1)
    h.fail = null
    const later = await inA(() => readSuggestedBids({ adGroupId: 'g-sg' }, () => NOW + 6 * MIN))
    expect(h.calls).toHaveLength(2)
    expect(later.ok && later.answer.unavailable).toBeNull()
  })

  it('a partial answer keeps its numbers and says what is missing', async () => {
    h.fail = { reason: 'Amazon had an error (HTTP 503). Try again later.', expressions: 2 }
    const body = (await suggested('adGroupId=g-sg')).json()
    expect(body.unavailable).toBe('Amazon answered for 3 of 5 keywords and targets. Amazon had an error (HTTP 503). Try again later.')
    expect(body.rows.filter((r: Row) => r.mid != null)).toHaveLength(3)
  })

  it.each([
    ['sandbox mode', () => { h.mode = 'sandbox' }, 'adGroupId=g-sg', 'Nexus runs Amazon Ads in test mode (sandbox) here, so Amazon is not asked and there is no suggested bid.'],
    ['no Ads connection for the market', () => {}, 'adGroupId=g-de', 'No Amazon Ads connection serves DE, so Amazon cannot be asked for a suggested bid.'],
    ['a test account for the market', () => {}, 'adGroupId=g-fr', 'The Amazon Ads account for FR is a test (sandbox) account, so Amazon gives no suggested bid.'],
    ['not on Amazon yet', () => {}, 'adGroupId=g-local', 'This ad group is not on Amazon yet (it has no Amazon id), so Amazon has no suggestion for it.'],
    ['not Sponsored Products', () => {}, 'adGroupId=g-sb', 'Amazon gives suggested bids here for Sponsored Products only.'],
  ])('unavailable — %s: the reason in plain words, Amazon not asked, rows null', async (_name, arrange, query, words) => {
    arrange()
    const body = (await suggested(query)).json()
    expect(body.unavailable).toBe(words)
    expect(body.fetchedAt).toBeNull()
    expect(body.rows.length).toBeGreaterThan(0)
    expect(body.rows.every((r: Row) => r.low === null && r.mid === null && r.high === null && r.theme === null)).toBe(true)
    expect(h.calls).toHaveLength(0)
  })

  it('a campaign whose ad groups differ: the numbers it has, and how many ad groups have none', async () => {
    await inA(() => (database.client as any).adGroup.create({ data: { id: 'g-sg-local', campaignId: 'c-sg', name: 'not yet on Amazon', externalAdGroupId: null } }))
    try {
      const out = await inA(() => readSuggestedBids({ campaignId: 'c-sg' }))
      expect(out.ok && out.answer.unavailable).toBe('1 of 3 ad groups have no suggestion. This ad group is not on Amazon yet (it has no Amazon id), so Amazon has no suggestion for it.')
      expect(out.ok && out.answer.rows.filter((r) => r.mid != null)).toHaveLength(6)
    } finally {
      await inA(() => (database.client as any).adGroup.delete({ where: { id: 'g-sg-local' } }))
    }
  })

  it('without ad-spend money: the answer minus exactly low / mid / high; with it: everything', async () => {
    permissions = { isOwner: false, permissions: new Set() }
    const body = (await suggested('adGroupId=g-sg')).json()
    const row = byTarget(body.rows).get('s-exact')
    expect(row).toEqual({ targetId: 's-exact', theme: 'CONVERSION_OPPORTUNITIES' })
    expect(body).toMatchObject({ unavailable: null, fetchedAt: expect.any(String) })
    permissions = { isOwner: false, permissions: new Set([FIELDS.financialsAdspendView]) }
    expect(byTarget((await suggested('adGroupId=g-sg')).json().rows).get('s-exact')).toMatchObject({ low: expect.any(Number), mid: expect.any(Number), high: expect.any(Number) })
  })

  it('another business\'s ad group or campaign is a 404; a query it does not take is a 400 in words', async () => {
    expect((await suggested('adGroupId=b-group')).statusCode).toBe(404)
    expect((await suggested('campaignId=b-camp')).statusCode).toBe(404)
    expect((await suggested('campaignId=c-dl&adGroupId=g-sg')).statusCode).toBe(404)
    const none = await app.inject({ method: 'GET', url: '/api/advertising/bids/suggested' })
    expect(none.statusCode).toBe(400)
    expect(none.json().error).toBe('adGroupId: give adGroupId or campaignId')
    expect((await suggested('adGroupId=g-sg&market=IT')).statusCode).toBe(400)
    expect(h.calls).toHaveLength(0)
  })
})

describe('BidRow.delivery — what became of each bid\'s newest change', () => {
  it('Waiting · Sent · Live · Failed · Undone · Replaced · Cancelled · none', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/advertising/bids?adGroupId=g-dl' })
    expect(res.statusCode).toBe(200)
    const rows = byTarget(res.json().rows)
    expect(Object.fromEntries([...rows].map(([id, r]) => [id, r.delivery]))).toEqual({
      'd-wait': 'waiting',
      'd-sent': 'sent',
      'd-live': 'live',
      'd-fail': 'failed',
      'd-undo': 'undone',
      // An action-log row alone, PENDING for 3 days with no write behind it: no record, not an eternal Waiting.
      'd-stale': null,
      'd-repl': 'replaced',
      'd-cancel': 'cancelled',
      // A later write the gate refused (logged, never queued) is newer than the one Amazon took.
      'd-later-log': 'failed',
      'd-old': null,
      'd-none': null,
    })
    // lastChange counts only writes that reached Amazon or may still; delivery says the newest, whatever became of it.
    expect(rows.get('d-later-log')!.lastChange).toBeNull()
  })
})

describe('GET /api/advertising/bids/cursor', () => {
  it('the newest move in scope and how many bids are Waiting / Sent — the same reading as the rows; no-store', async () => {
    const res = await cursor('adGroupId=g-dl')
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.json()).toEqual({ latestChangeAt: ago(30_000).toISOString(), waiting: 1, sent: 1 })
    const rows = (await app.inject({ method: 'GET', url: '/api/advertising/bids?adGroupId=g-dl' })).json().rows as Row[]
    expect(rows.filter((r) => r.delivery === 'waiting')).toHaveLength(res.json().waiting)
    expect(rows.filter((r) => r.delivery === 'sent')).toHaveLength(res.json().sent)
  })

  it('it moves when a change moves: a write sent now', async () => {
    const before = (await cursor('adGroupId=g-dl')).json()
    const moved = new Date()
    await inA(() => (database.client as any).adMutation.updateMany({ where: { entityId: 'd-wait', field: 'bid' }, data: { state: 'IN_FLIGHT', updatedAt: moved } }))
    try {
      const after = (await cursor('adGroupId=g-dl')).json()
      expect(Date.parse(after.latestChangeAt)).toBeGreaterThan(Date.parse(before.latestChangeAt))
      expect(after).toMatchObject({ waiting: 0, sent: 2 })
    } finally {
      await inA(() => (database.client as any).adMutation.updateMany({ where: { entityId: 'd-wait', field: 'bid' }, data: { state: 'PENDING', updatedAt: ago(2 * MIN) } }))
    }
  })

  it('the scope of /bids: owner is taken and does not narrow it; a scope without changes reads null and zeros', async () => {
    expect((await cursor()).json()).toEqual({ latestChangeAt: ago(30_000).toISOString(), waiting: 1, sent: 1 })
    expect((await cursor('owner=BRAIN&market=it')).json()).toMatchObject({ waiting: 1, sent: 1 })
    expect((await cursor('campaignId=c-sg&status=all')).json()).toEqual({ latestChangeAt: null, waiting: 0, sent: 0 })
    expect((await cursor('market=DE')).json()).toEqual({ latestChangeAt: null, waiting: 0, sent: 0 })
  })

  it('another business\'s ids are a 404 and its changes never count; a query it does not take is a 400', async () => {
    expect((await cursor('adGroupId=b-group')).statusCode).toBe(404)
    expect((await cursor('campaignId=b-camp')).statusCode).toBe(404)
    expect((await cursor('status=all')).json()).toMatchObject({ waiting: 1, sent: 1 })
    expect((await cursor('since=1')).statusCode).toBe(400)
  })
})

describe('permission', () => {
  it('both reads need ads.view only, never the /bid rule\'s bid editing', async () => {
    const { permissionForRoute } = await import('../lib/auth/permissions-manifest.js')
    expect(permissionForRoute('GET', '/api/advertising/bids/suggested')).toBe('ads.view')
    expect(permissionForRoute('GET', '/api/advertising/bids/cursor')).toBe('ads.view')
    expect(permissionForRoute('GET', '/api/advertising/bids')).toBe('ads.view')
    // A write under the same path still asks for bid editing.
    expect(permissionForRoute('POST', '/api/advertising/bids/t-1/mode')).toBe('ads.bids.edit')
  })
})
