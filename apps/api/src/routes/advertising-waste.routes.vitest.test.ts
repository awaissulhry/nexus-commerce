/**
 * Negative Targeting page (NREAD) — the READ block of /api/advertising/waste on a real PostgreSQL (PGlite), business
 * profiles ON:
 *
 *   rows      our keywords and shoppers' search terms in places that run, joined on Amazon's EXTERNAL ids; the verb per
 *             row (pause, negative exact here or in the campaign, held with why); the test late-order safe with the days
 *             out of stock left out; no data is not 0 orders; a paused campaign's rows never show; the tiles from the
 *             same rows (Bid audit M1); one owner per row that agrees with what waits and the last writer (M2)
 *   stopped   paused keywords and standing negatives with their authors (Brain funnel, Harvest, You, Unknown), what may
 *             be done with each and why not
 *   NWRITE    the hold and origin columns, absent first, then added to the table: the same code lights up
 *   row       runsIn / blockedIn / history of one row
 *   history   paused, negated, removed, refused — with delivery and undo
 *   business  another business's campaign is a 404; money keys are stripped without ad spend
 *   lists     the scope filter (2026-10-12) on rows, rows/ids, stopped and history: portfolioIds, campaignIds, adGroupIds,
 *             productIds — OR inside (the union of the singular reads), AND across, a singular merged in, the tiles
 *             follow; an unknown or another business's id is the singular's 404; at most 500 ids a list
 *
 * Values are made up (public repo).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../test-support/formula-database.js'
import { withWorkspace } from '../lib/workspace-context.js'
import type { ResolvedPermissions } from '../lib/auth/rbac.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const A = 'nread_waste_alpha'
const B = 'nread_waste_beta'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const NOW = Date.now()
const DAY = 86_400_000
const ago = (days: number) => new Date(NOW - days * DAY)
/** A report day: 00:00 UTC, `days` ago. */
const dayAgo = (days: number) => new Date(Math.floor(NOW / DAY) * DAY - days * DAY)
let app: FastifyInstance
let permissions: ResolvedPermissions = { isOwner: true, permissions: new Set() }
/** HONEST 19 — the person looking (the session's user); null: no one signed in. */
let viewerId: string | null = null

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  // Every read loads fresh facts here (the memo has its own test below).
  vi.stubEnv('NEXUS_WASTE_FACTS_TTL_MS', '0')
  for (const w of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [w])
  }
  await withWorkspace(business(A), async () => {
    const c = database.client as any
    await c.adsAutomationState.create({ data: { id: 'singleton', defaultTargetAcosPct: 20 } })
    // HONEST 19 — u1 has a profile (a name); every other person on record has none ("a person").
    await c.userProfile.create({ data: { id: 'u1', displayName: 'Test person one', email: 'u1@example.test' } })
    await c.product.create({ data: { id: 'p-root', sku: 'TST-JACKET', name: 'Test jacket', basePrice: '80.00', isParent: true } })
    for (const s of ['M', 'L']) await c.product.create({ data: { id: `p-${s}`, sku: `TST-JACKET-${s}`, name: `Test jacket ${s}`, basePrice: '80.00', parentId: 'p-root' } })
    await c.amazonAdsPortfolio.create({ data: { profileId: 'P-IT', externalPortfolioId: 'PF-1', name: 'Test portfolio' } })
    const campaign = (id: string, extra: Record<string, unknown> = {}) => c.campaign.create({
      data: { id, name: `Test ${id}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), ...extra },
    })
    const group = async (id: string, campaignId: string, product = 'p-M') => {
      // Nexus synced every ad group just now (a re-sync): a place's age comes from when it first served, never from this.
      await c.adGroup.create({ data: { id, campaignId, name: `group ${id}`, externalAdGroupId: `EXT-${id}`, createdAt: new Date(NOW) } })
      await c.adProductAd.create({ data: { adGroupId: id, productId: product, sku: `SKU-${id}`, asin: `B0TEST${id.replace(/[^A-Z0-9]/gi, '').slice(-4).toUpperCase().padStart(4, '0')}` } })
    }
    const target = (id: string, groupId: string, text: string, extra: Record<string, unknown> = {}) => c.adTarget.create({
      data: { id, adGroupId: groupId, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: text, bidCents: 40, externalTargetId: `EXT-${id}`, ...extra },
    })
    const negative = (id: string, groupId: string, text: string, extra: Record<string, unknown> = {}) =>
      target(id, groupId, text, { isNegative: true, negativeLevel: 'AD_GROUP', expressionType: 'NEGATIVE_EXACT', bidCents: 0, createdAt: ago(50), ...extra })
    /** One search-term day: Amazon's EXTERNAL ids, as the report stores them. */
    const term = (campaignId: string, groupId: string, query: string, via: string | null, daysAgo: number, clicks: number, spendCents: number, orders = 0) =>
      c.amazonAdsSearchTerm.create({
        data: {
          profileId: 'P-IT', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: dayAgo(daysAgo), campaignId: `EXT-${campaignId}`, adGroupId: `EXT-${groupId}`,
          matchedKeywordId: via ? `EXT-${via}` : null, matchType: 'BROAD', query, impressions: clicks * 20, clicks, costMicros: BigInt(spendCents) * 10_000n,
          currencyCode: 'EUR', orders7d: orders, sales7dCents: orders * 8000,
        },
      })
    const perf = (targetId: string, daysAgo: number, clicks: number, spendCents: number, orders = 0) => c.amazonAdsDailyPerformance.create({
      data: {
        profileId: 'P-IT', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: dayAgo(daysAgo), entityType: 'AD_TARGET', entityId: `EXT-${targetId}`, localEntityId: targetId,
        clicks, costMicros: BigInt(spendCents) * 10_000n, orders7d: orders, sales7dCents: orders * 8000, currencyCode: 'EUR', reportedAt: ago(1),
      },
    })

    // c-exact: an exact keyword that wastes as a whole, one Amazon reported nothing for, one paused by a person.
    await campaign('c-exact', { portfolioId: 'PF-1' })
    await group('g-exact', 'c-exact')
    await target('k-waste', 'g-exact', 'rain jacket')
    await target('k-nodata', 'g-exact', 'storm jacket')
    await target('k-paused', 'g-exact', 'old jacket', { status: 'PAUSED' })
    for (const d of [10, 20, 30, 40]) await perf('k-waste', d, 20, 2500)
    // Its own words as a search term, bought through it: the term row is held — a negative would block our keyword.
    for (const d of [10, 20]) await term('c-exact', 'g-exact', 'rain jacket', 'k-waste', d, 40, 4000)
    await c.advertisingActionLog.create({ data: { userId: 'user:u1', actionType: 'AD_ENTITY_STATE_UPDATE', entityType: 'AD_TARGET', entityId: 'k-paused', payloadBefore: { status: 'ENABLED' }, payloadAfter: { status: 'PAUSED' }, amazonResponseStatus: 'SUCCESS', createdAt: ago(20) } })
    // A refused pause of k-nodata (never sent).
    await c.advertisingActionLog.create({ data: { userId: 'automation:r-pause', actionType: 'AD_ENTITY_STATE_UPDATE', entityType: 'AD_TARGET', entityId: 'k-nodata', payloadBefore: { status: 'ENABLED' }, payloadAfter: { status: 'PAUSED', error: 'off the live-write allowlist' }, amazonResponseStatus: 'FAILED', createdAt: ago(2) } })

    // c-broad: a broad keyword whose terms partly sell; terms that waste, sell late, fall in a stock-out, are protected.
    await campaign('c-broad')
    await group('g-broad1', 'c-broad')
    await group('g-broad2', 'c-broad')
    await group('g-stock', 'c-broad', 'p-L')
    await target('k-broad', 'g-broad1', 'jacket', { expressionType: 'BROAD' })
    await target('k-broad2', 'g-broad2', 'jacket', { expressionType: 'BROAD' })
    await target('k-stock', 'g-stock', 'jacket', { expressionType: 'BROAD' })
    for (const d of [10, 20, 30]) await perf('k-broad', d, 30, 3000)
    await term('c-broad', 'g-broad1', 'jacket men', 'k-broad', 15, 10, 600, 1)
    // Our broad keyword's own words as a term in its place: a negative there would block it (held).
    await term('c-broad', 'g-broad1', 'jacket', 'k-broad', 10, 5, 200)
    // A term that sells well (the product's pooled conversion rate the tests read comes from here).
    await term('c-broad', 'g-broad2', 'jacket winter', 'k-broad2', 15, 1000, 100000, 80)
    // A person switched k-broad on 3 days ago: the writer of the last 7 days owns it (Bid audit M2).
    await c.advertisingActionLog.create({ data: { userId: 'user:u2', actionType: 'AD_ENTITY_STATE_UPDATE', entityType: 'AD_TARGET', entityId: 'k-broad', payloadBefore: { status: 'PAUSED' }, payloadAfter: { status: 'ENABLED' }, amazonResponseStatus: 'SUCCESS', createdAt: ago(3) } })
    for (const d of [10, 20, 30, 40]) await term('c-broad', 'g-broad1', 'jacket kids', 'k-broad', d, 20, 2500)
    await term('c-broad', 'g-broad2', 'jacket kids', 'k-broad2', 12, 30, 3000)
    for (const d of [10, 20, 30, 40]) await term('c-broad', 'g-broad1', 'Jacket  Late', 'k-broad', d, 20, 2500)
    await term('c-broad', 'g-broad1', 'jacket late', 'k-broad', 1, 0, 0, 1) // a late order: it can only save the row
    for (const d of [20, 21, 22, 23]) await term('c-broad', 'g-stock', 'jacket stock', 'k-stock', d, 20, 2500)
    await term('c-broad', 'g-stock', 'jacket stock', 'k-stock', 40, 5, 200)
    await c.stockoutEvent.create({ data: { productId: 'p-L', sku: 'TST-JACKET-L', startedAt: ago(24), endedAt: ago(19), detectedBy: 'cron', velocityAtStart: '1.00' } })
    for (const d of [10, 20, 30, 40]) await term('c-broad', 'g-broad1', 'jacket brand', 'k-broad', d, 20, 2500)
    await c.adKeywordProtection.create({ data: { mode: 'WHITELIST', term: 'jacket brand', matchType: 'EXACT' } })

    // Standing negatives in g-broad2, by author: a person, the brain's funnel, a harvest pair's source, nobody on record.
    await negative('n-person', 'g-broad2', 'jacket blue')
    await c.advertisingActionLog.create({ data: { userId: 'user:u1', actionType: 'create_negative_keyword', entityType: 'AD_TARGET', entityId: 'n-person', payloadBefore: {}, payloadAfter: { keywordText: 'jacket blue' }, amazonResponseStatus: 'SUCCESS', createdAt: ago(5) } })
    await term('c-broad', 'g-broad2', 'jacket blue', 'k-broad2', 30, 12, 900)
    await negative('n-funnel', 'g-broad2', 'jacket red')
    await negative('n-harvest', 'g-broad2', 'jacket green')
    await negative('n-unknown', 'g-broad2', 'jacket old')
    await negative('n-gone', 'g-broad2', 'jacket gone', { status: 'ARCHIVED', retiredAt: ago(2), retireReason: 'test' })
    await c.advertisingActionLog.create({ data: { userId: 'user:u1', actionType: 'retire_negative', entityType: 'AD_TARGET', entityId: 'n-gone', payloadBefore: { status: 'ENABLED' }, payloadAfter: { status: 'ARCHIVED' }, amazonResponseStatus: 'SUCCESS', createdAt: ago(2) } })
    // HONEST 5 — the Owner's funnel: a negative exact of our live broad keyword's own words in its place (on purpose: not a clash).
    await negative('n-clash', 'g-broad2', 'jacket')
    // A negative over a term that sold in its place in the window: a clash too ("Blocks a term that sold here").
    await negative('n-sold', 'g-broad1', 'jacket men')
    const brainRow = { productId: 'p-root', marketplace: 'IT', reasons: [], kind: 'KEYWORD', match: 'EXACT', level: 'AD_GROUP', campaignId: 'c-broad', mode: 'AUTO', why: 'made up', evidence: {}, digest: 'd', runId: 'run-1', dataDay: dayAgo(3), firstSeenAt: ago(3), checkedAt: ago(3), changedAt: ago(3) }
    await c.adsBrainNegative.create({ data: { ...brainRow, key: 'k1', action: 'ADD', reason: 'funnel', text: 'jacket red', adGroupId: 'g-broad2', status: 'WRITTEN', adTargetId: 'n-funnel' } })
    await c.adsBrainNegative.create({ data: { ...brainRow, key: 'k2', action: 'ADD', reason: 'waste', text: 'jacket kids', adGroupId: 'g-broad1', status: 'REFUSED', result: 'the gate refused it: off the allowlist' } })
    await c.adsBrainHarvest.create({ data: {
      productId: 'p-root', marketplace: 'IT', term: 'jacket green', status: 'LANDED', level: 'AUTO', destinationKind: 'EXACT', landedAt: ago(60),
      sources: [{ adGroupId: 'g-broad2', campaignId: 'c-broad', action: 'negate', result: 'landed', negativeTargetId: 'n-harvest' }],
      why: 'made up', evidence: {}, digest: 'd', runId: 'run-1', decidedAt: ago(60), checkedAt: ago(1), changedAt: ago(60),
    } })

    // An auto target (no words of its own: Amazon names it by its group) and a term our paused keyword bought.
    await target('k-auto', 'g-broad1', '', { kind: 'AUTO', expressionType: 'SEARCH_CLOSE_MATCH' })
    await term('c-exact', 'g-exact', 'old jacket blue', 'k-paused', 5, 4, 300)

    // g-new: an ad group whose first impression was 5 days ago — a new place: nothing is stopped there yet.
    await group('g-new', 'c-broad')
    await target('k-new', 'g-new', 'jacket new', { expressionType: 'BROAD' })
    await c.amazonAdsDailyPerformance.create({ data: { profileId: 'P-IT', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: dayAgo(5), entityType: 'AD_TARGET', entityId: 'EXT-k-new', localEntityId: 'k-new', impressions: 100, clicks: 3, costMicros: 900_000n, currencyCode: 'EUR', reportedAt: ago(1) } })
    await term('c-broad', 'g-new', 'jacket fresh', 'k-new', 5, 3, 90)

    // c-uk: another market, billed in pounds — a keyword that wastes there (every-market reads keep money per currency).
    await campaign('c-uk', { marketplace: 'UK', dailyBudgetCurrency: 'GBP' })
    await group('g-uk', 'c-uk')
    await target('k-uk', 'g-uk', 'rain jacket uk')
    for (const d of [10, 20, 30, 40]) await c.amazonAdsDailyPerformance.create({ data: { profileId: 'P-UK', marketplace: 'UK', adProduct: 'SPONSORED_PRODUCTS', date: dayAgo(d), entityType: 'AD_TARGET', entityId: 'EXT-k-uk', localEntityId: 'k-uk', clicks: 20, costMicros: 25_000_000n, currencyCode: 'GBP', reportedAt: ago(1) } })

    // c-paused: it wastes, but the campaign is paused — noise, never a row.
    await campaign('c-paused', { status: 'PAUSED' })
    await group('g-paused', 'c-paused')
    await target('k-hidden', 'g-paused', 'hidden jacket')
    for (const d of [10, 20, 30, 40]) await perf('k-hidden', d, 30, 5000)
    // Stops in the paused campaign: counted as inactive (under the same filters), never listed.
    await target('k-idle', 'g-paused', 'idle jacket', { status: 'PAUSED' })
    await negative('n-idle', 'g-paused', 'idle words')
    await c.advertisingActionLog.create({ data: { userId: 'user:u1', actionType: 'create_negative_keyword', entityType: 'AD_TARGET', entityId: 'n-idle', payloadBefore: {}, payloadAfter: { keywordText: 'idle words' }, amazonResponseStatus: 'SUCCESS', createdAt: ago(8) } })

    // What waits: Claude's pause of k-waste; a rule's card to negate "jacket kids" in c-broad.
    const run = await c.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'awaiting_approval', via: 'claude' } })
    await c.agentApproval.create({ data: { id: 'appr-pause', agentRunId: run.id, toolName: 'pause-ads', riskTier: 'medium', args: { targetIds: ['k-waste'], why: 'made up' }, status: 'pending', requestedAt: ago(1), expiresAt: new Date(NOW + 2 * DAY) } })
    await c.automationRule.create({ data: { id: 'r-neg', name: 'Stop waste — terms', domain: 'advertising', trigger: 'SEARCH_TERM_WASTING', enabled: true, autonomyLevel: 'PROPOSE', scopeCampaignId: 'c-broad', actions: [{ type: 'add_negative_exact' }] } })
    await c.adsRuleSuggestion.create({ data: { ruleId: 'r-neg', ruleName: 'Stop waste — terms', entityType: 'SEARCH_TERM', entityId: 'EXT-c-broad:jacket kids', proposedAction: { type: 'add_negative_exact' }, proposedKey: 'add_negative_exact', createdAt: ago(1) } })
  })
  await withWorkspace(business(B), async () => {
    const c = database.client as any
    await c.campaign.create({ data: { id: 'b-camp', name: 'Other business', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-b-camp', dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), portfolioId: 'PF-B' } })
  })
  const { default: routes } = await import('./advertising-waste.routes.js')
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    request.__rbacResolved = permissions
    if (viewerId) (request as unknown as { authUser: { id: string } }).authUser = { id: viewerId }
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

type Row = Record<string, any>
/** A read of the IT market (every list read names one; the page always does). */
const get = (path: string, query = '') => {
  const q = path.startsWith('row/') || /(^|&)market=/.test(query) ? query : ['market=IT', query].filter(Boolean).join('&')
  return app.inject({ method: 'GET', url: `/api/advertising/waste/${path}${q ? `?${q}` : ''}` })
}
const rowsOf = async (query = 'show=all&pageSize=200') => {
  const res = await get('rows', query)
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}
const byId = (rows: Row[]) => new Map(rows.map((r) => [r.id, r]))
const termId = (group: string, key: string) => `term:IT|EXT-${group}|${key}`

describe('GET /api/advertising/waste/rows — the wasting rows', () => {
  it('joins search terms on Amazon\'s external ids; places that do not run never show', async () => {
    const res = await get('rows', 'show=all&pageSize=200')
    expect(res.headers['cache-control']).toBe('no-store')
    const rows = byId(res.json().rows)
    expect(rows.has(termId('g-broad1', 'jacket kids'))).toBe(true)
    expect(rows.get(termId('g-broad1', 'jacket kids'))).toMatchObject({
      kind: 'TERM', text: 'jacket kids', match: 'BROAD', market: 'IT', currency: 'EUR',
      campaign: { id: 'c-broad', href: '/marketing/ads/campaigns/c-broad' },
      adGroup: { id: 'g-broad1', href: '/marketing/ads/campaigns/c-broad/ad-groups/g-broad1?tab=search-terms&focus=jacket%20kids' },
      product: { id: 'p-root', name: 'TST-JACKET', href: '/products/p-root' }, productCount: 1,
      via: { id: 'k-broad', name: 'jacket', href: '/marketing/ads/campaigns/c-broad/ad-groups/g-broad1?tab=targets&focus=k-broad' },
    })
    expect([...rows.keys()].some((id) => id.includes('hidden') || id === 'kw:k-hidden')).toBe(false)
    expect(rows.get('kw:k-waste').portfolio).toEqual({ id: 'PF-1', name: 'Test portfolio', href: '/marketing/ads/portfolios/PF-1' })
  })

  it('our exact keyword that wastes: Pause, kept paused, owned by what waits (Claude\'s request)', async () => {
    const row = byId((await rowsOf()).rows).get('kw:k-waste')
    expect(row.verb).toEqual({ action: 'PAUSE', where: 'adGroup', held: null })
    expect(row.test.met).toBe(true)
    expect(row.test.xCpaBar).toBe(2)
    expect(row.d).toMatchObject({ clicks: 80, orders: 0, spendCents: 10000 })
    expect(row.d.xCpa).toBeGreaterThan(2)
    expect(row.waiting).toMatchObject({ approvalId: 'appr-pause', by: { id: 'appr-pause', name: 'Claude' } })
    expect(row.owner).toEqual({ kind: 'CLAUDE', name: 'Claude', id: 'appr-pause' })
    expect(row.spark).toHaveLength(8)
    expect(row.d90).toMatchObject({ clicks: 80, orders: 0, spendCents: 10000 })
  })

  it('no data is not 0 orders: a keyword Amazon reported nothing for is never judged', async () => {
    const row = byId((await rowsOf()).rows).get('kw:k-nodata')
    expect(row.d).toBeNull()
    expect(row.d90).toBeNull()
    expect(row.test.met).toBe(false)
    expect(row.test.sentence).toMatch(/^No data/)
  })

  it('a broad keyword whose terms sell is held; its wasting term gets a negative in the campaign (2 ad groups)', async () => {
    const rows = byId((await rowsOf()).rows)
    expect(rows.get('kw:k-broad').verb.held.label).toBe('Its terms sell')
    expect(rows.get('kw:k-broad').test.met).toBe(false)
    const kids = rows.get(termId('g-broad1', 'jacket kids'))
    expect(kids.test.met).toBe(true)
    expect(kids.verb).toEqual({ action: 'NEGATE_EXACT', where: 'campaign', held: null })
    expect(kids.stillServesIn).toBe(1)
    // The rule's card waits on it: the rule owns the row.
    expect(kids.owner).toEqual({ kind: 'RULE', name: 'Stop waste — terms', id: 'r-neg' })
    expect(kids.waiting.approvalId).toMatch(/^suggestion:/)
  })

  it('late-order safe: an order today saves a term whose clicks are 3+ days old; case and spaces are one term', async () => {
    const late = byId((await rowsOf()).rows).get(termId('g-broad1', 'jacket late'))
    expect(late.text).toBe('Jacket Late')
    expect(late.d).toMatchObject({ clicks: 80, orders: 1 })
    expect(late.test.met).toBe(false)
  })

  it('days out of stock are left out of clicks and spend', async () => {
    const stock = byId((await rowsOf()).rows).get(termId('g-stock', 'jacket stock'))
    expect(stock.stockOutDays).toBeGreaterThanOrEqual(4)
    expect(stock.d).toMatchObject({ clicks: 5, spendCents: 200 })
    expect(stock.d90).toMatchObject({ clicks: 85 })
    expect(stock.test.met).toBe(false)
    expect(stock.test.sentence).toMatch(/out of stock left out/)
  })

  it('held with why: a protected term, our own keyword in its place; an exact keyword\'s own traffic is its row', async () => {
    const rows = byId((await rowsOf()).rows)
    const brand = rows.get(termId('g-broad1', 'jacket brand'))
    expect(brand.state).toBe('PROTECTED')
    expect(brand.verb.held.label).toBe('Protected')
    const own = rows.get(termId('g-broad1', 'jacket'))
    expect(own.verb.held.label).toBe('Our keyword')
    // Our exact keyword's own words bought through it are the keyword's row: no second row, no money counted twice.
    expect(rows.has(termId('g-exact', 'rain jacket'))).toBe(false)
  })

  it('a new place is judged by its first impression, never by when Nexus synced it', async () => {
    const rows: Row[] = (await rowsOf()).rows
    const fresh = byId(rows).get(termId('g-new', 'jacket fresh'))
    expect(fresh.verb.held).toMatchObject({ label: 'New place' })
    expect(fresh.verb.held.reason).toMatch(/5 days old/)
    expect(byId(rows).get('kw:k-new').verb.held.label).toBe('New place')
    // Every other ad group was synced "today" too, but has served for months: none is held as new.
    expect(rows.filter((r) => r.adGroup.id !== 'g-new' && r.verb.held?.label === 'New place')).toEqual([])
  })

  it('a negated term reads NEGATED with the negative\'s author; a paused keyword is its stopper\'s', async () => {
    const rows = byId((await rowsOf()).rows)
    // HONEST 19 — a person by their own name; "You" only for the person looking (below).
    expect(rows.get(termId('g-broad2', 'jacket blue'))).toMatchObject({ state: 'NEGATED', owner: { kind: 'PERSON', name: 'Test person one', id: 'u1' } })
    expect(rows.get('kw:k-paused')).toMatchObject({ state: 'PAUSED', owner: { kind: 'PERSON', name: 'Test person one', id: 'u1' } })
    // HONEST 13 — the blocked term names the negative that blocks it (its own match and level), not its buying keyword's.
    expect(rows.get(termId('g-broad2', 'jacket blue')).blockedBy).toMatchObject({ rowId: 'neg:n-person', text: 'jacket blue', match: 'EXACT', level: 'AD_GROUP' })
    expect(rows.get(termId('g-broad2', 'jacket blue')).test.settledThrough).toBe(new Date(Math.floor(NOW / DAY) * DAY - 3 * DAY).toISOString().slice(0, 10))
  })

  it('HONEST 19 — "You" is the person looking only; anyone else keeps their name, a person with no profile reads "a person"', async () => {
    viewerId = 'u1'
    try {
      const rows = byId((await rowsOf('show=all&pageSize=200')).rows)
      expect(rows.get('kw:k-paused').owner).toMatchObject({ kind: 'PERSON', name: 'You', id: 'u1' })
      expect(rows.get('kw:k-broad')).toMatchObject({ owner: { kind: 'PERSON', name: 'A person', id: 'u2' }, lastChange: { by: { id: 'u2', name: 'A person' } } })
    } finally {
      viewerId = null
    }
  })

  it('the tiles come from the same rows (Bid audit M1); show=wasting answers exactly the Wasting tile', async () => {
    const all = await rowsOf('show=wasting&pageSize=200')
    expect(all.total).toBe(all.totals.wasting)
    expect(all.rows.length).toBe(all.totals.wasting)
    expect(all.totals.keywords + all.totals.terms).toBe(all.totals.wasting)
    expect(all.totals.wastingSpendCents).toBe(all.rows.reduce((n: number, r: Row) => n + r.d.spendCents, 0))
    // Waiting counts asks, not rows: the rule's one card covers "jacket kids" in two ad groups (2 places), Claude's pause one.
    const waiting = await rowsOf('show=waiting&pageSize=200')
    const asks = new Set(waiting.rows.map((r: Row) => r.waiting.approvalId))
    expect(all.totals.waiting).toBe(asks.size)
    expect([all.totals.waiting, waiting.total]).toEqual([2, 3])
    expect(byId(waiting.rows).get(termId('g-broad2', 'jacket kids')).waiting.rows).toBe(2)
    expect(byId(waiting.rows).get('kw:k-waste').waiting.rows).toBe(1)
    expect(all.totals).toMatchObject({ negated: 6, clashes: 1, keptPaused: 0, skipped: 0 })
    expect(all.criteria).toMatchObject({ source: 'default', windowDays: 60 })
    const ids = await get('rows/ids', 'show=wasting')
    expect(ids.json()).toMatchObject({ total: all.total, truncated: false })
    expect(ids.json().ids.sort()).toEqual(all.rows.map((r: Row) => r.id).sort())
  })

  it('one owner per row, and a writer of the last 7 days is it (Bid audit M2)', async () => {
    const rows: Row[] = (await rowsOf()).rows
    let checked = 0
    for (const r of rows) {
      if (!r.lastChange || Date.parse(r.lastChange.at) < NOW - 7 * DAY || r.waiting || r.state === 'NEGATED') continue
      expect(r.owner.id ?? r.owner.kind.toLowerCase(), r.id).toBe(r.lastChange.by.id)
      checked++
    }
    expect(checked).toBeGreaterThan(0)
    expect(byId(rows).get('kw:k-broad')).toMatchObject({ owner: { kind: 'PERSON', name: 'A person', id: 'u2' }, lastChange: { action: 'turned_on', by: { id: 'u2', name: 'A person' } } })
  })

  it('show=clashes lists exactly the rows the Clashes tile counts, each with why in plain words', async () => {
    const res = await rowsOf('show=clashes&pageSize=200')
    expect(res.total).toBe(res.totals.clashes)
    expect(res.rows.map((r: Row) => `${r.id} ${r.clash.kind}`)).toEqual([`${termId('g-broad1', 'jacket men')} BLOCKS_SOLD`])
    // HONEST 5 — the Owner's funnel: a negative exact of our broad keyword's own words in its place blocks only that one
    // search, on purpose. Never a clash, never a Remove.
    const funnel = byId((await rowsOf()).rows).get('kw:k-broad2')
    expect(funnel.clash).toBeNull()
    expect(funnel.verb.action).toBe('PAUSE')
    // A negative that blocks every search our keyword serves (an exact over our exact keyword) is a clash: it names the
    // negative, and while the keyword does not waste the fix is to remove it (not to pause the keyword).
    await withWorkspace(business(A), async () => {
      const c = database.client as any
      await c.adTarget.create({ data: { id: 'k-c1', adGroupId: 'g-broad2', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'jacket clash', bidCents: 40, externalTargetId: 'EXT-k-c1' } })
      await c.adTarget.create({ data: { id: 'n-c1', adGroupId: 'g-broad2', kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'jacket clash', bidCents: 0, isNegative: true, negativeLevel: 'AD_GROUP', externalTargetId: 'EXT-n-c1' } })
    })
    try {
      const clashes = await rowsOf('show=clashes&pageSize=200')
      expect(clashes.total).toBe(clashes.totals.clashes)
      const own = byId(clashes.rows).get('kw:k-c1')
      expect(own.clash).toMatchObject({ kind: 'NEG_OVER_OWN_KEYWORD', label: 'Negative over our own keyword' })
      expect(own.clash.negative).toMatchObject({ rowId: 'neg:n-c1', text: 'jacket clash', match: 'EXACT', level: 'AD_GROUP', adGroup: { id: 'g-broad2' }, campaign: { id: 'c-broad' }, owner: { name: 'Unknown' } })
      expect(own.test.met).toBe(false)
      expect(own.verb).toEqual({ action: 'REMOVE_NEGATIVE', targetRowId: 'neg:n-c1', where: 'adGroup', held: null })
      // Kept by Harvest: the verb stays, held with Harvest's reason.
      await withWorkspace(business(A), () => (database.client as any).adTarget.update({ where: { id: 'n-c1' }, data: { negativeOrigin: 'HARVEST' } }))
      const held = byId((await rowsOf('show=clashes')).rows).get('kw:k-c1')
      expect(held.verb).toMatchObject({ action: 'REMOVE_NEGATIVE', held: { label: 'Harvest keeps it' } })
      expect(held.clash.negative.owner.kind).toBe('HARVEST')
    } finally {
      await withWorkspace(business(A), () => (database.client as any).adTarget.deleteMany({ where: { id: { in: ['k-c1', 'n-c1'] } } }))
    }
    // N1 — a keyword that wastes and has a negative over it keeps Pause; the clash (with its negative) stays on the row.
    await withWorkspace(business(A), async () => {
      const c = database.client as any
      await c.adTarget.create({ data: { id: 'k-n1', adGroupId: 'g-broad2', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'jacket wasted', bidCents: 40, externalTargetId: 'EXT-k-n1' } })
      await c.adTarget.create({ data: { id: 'n-n1', adGroupId: 'g-broad2', kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'jacket wasted', bidCents: 0, isNegative: true, negativeLevel: 'AD_GROUP', externalTargetId: 'EXT-n-n1' } })
      await c.amazonAdsDailyPerformance.createMany({ data: [10, 20, 30, 40].map((d) => ({ profileId: 'P-IT', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: dayAgo(d), entityType: 'AD_TARGET', entityId: 'EXT-k-n1', localEntityId: 'k-n1', clicks: 50, costMicros: 60_000_000n, currencyCode: 'EUR', reportedAt: ago(1) })) })
    })
    try {
      const wastes = byId((await rowsOf('show=clashes')).rows).get('kw:k-n1')
      expect(wastes.test.met).toBe(true)
      expect(wastes.verb.action).toBe('PAUSE')
      expect(wastes.clash).toMatchObject({ kind: 'NEG_OVER_OWN_KEYWORD', negative: { rowId: 'neg:n-n1', text: 'jacket wasted' } })
    } finally {
      await withWorkspace(business(A), async () => {
        const c = database.client as any
        await c.amazonAdsDailyPerformance.deleteMany({ where: { localEntityId: 'k-n1' } })
        await c.adTarget.deleteMany({ where: { id: { in: ['k-n1', 'n-n1'] } } })
      })
    }
    expect(byId(res.rows).get(termId('g-broad1', 'jacket men')).clash.label).toBe('Blocks a term that sold here')
    expect((await get('rows/ids', 'show=clashes')).json().total).toBe(res.totals.clashes)
    // The tile honours the owner and text filters like the rows.
    const men = await rowsOf('show=clashes&q=men')
    expect([men.total, men.totals.clashes]).toEqual([1, 1])
  })

  it('filters: kind, owner, text, scope; paging', async () => {
    const terms = await rowsOf('show=all&kind=term&pageSize=200')
    expect(terms.rows.every((r: Row) => r.kind === 'TERM')).toBe(true)
    const rule = await rowsOf('show=all&owner=RULE&pageSize=200')
    expect(rule.rows.every((r: Row) => r.owner.kind === 'RULE' && r.campaign.id === 'c-broad')).toBe(true)
    expect(rule.rows.map((r: Row) => r.id)).toEqual(expect.arrayContaining([termId('g-broad1', 'jacket kids'), termId('g-broad2', 'jacket kids')]))
    expect((await rowsOf('show=all&owner=r-neg&pageSize=200')).total).toBe(rule.total)
    expect((await rowsOf('show=all&q=storm')).rows.map((r: Row) => r.id)).toEqual(['kw:k-nodata'])
    expect((await rowsOf('show=all&adGroupId=g-exact&pageSize=200')).rows.every((r: Row) => r.adGroup.id === 'g-exact')).toBe(true)
    const page = await rowsOf('show=all&pageSize=2&page=2')
    expect(page).toMatchObject({ page: 2, pageSize: 2 })
    expect(page.rows).toHaveLength(2)
  })

  it('another business\'s campaign is a 404; a bad query is a 400', async () => {
    expect((await get('rows', 'campaignId=b-camp')).statusCode).toBe(404)
    expect((await get('rows', 'channel=EBAY')).statusCode).toBe(400)
    expect((await get('rows', 'sort=bid')).statusCode).toBe(400)
  })
})

describe('step 4 — the Protected tile: wasting rows a protected term keeps safe', () => {
  const brand = termId('g-broad1', 'jacket brand')
  it('show=protected lists exactly totals.protected (the test met, PROTECTED, not skipped), each naming the term that holds it', async () => {
    const res = await rowsOf('show=protected&pageSize=200')
    expect(res.total).toBe(res.totals.protected)
    expect(res.rows.map((r: Row) => r.id)).toEqual([brand])
    expect(res.rows[0]).toMatchObject({
      state: 'PROTECTED', test: { met: true }, verb: { held: { label: 'Protected' } },
      protection: { terms: [{ term: 'jacket brand', match: 'EXACT', market: null, campaign: null, reason: null, id: expect.any(String) }], then: null },
    })
    // One number, one list: every protected wasting row of the whole read, and no other row carries a protection.
    const all = await rowsOf('show=all&pageSize=200')
    expect(all.rows.filter((r: Row) => r.state === 'PROTECTED' && r.test.met && !r.skipped).map((r: Row) => r.id)).toEqual([brand])
    expect(all.rows.filter((r: Row) => r.state !== 'PROTECTED').some((r: Row) => 'protection' in r)).toBe(false)
    expect(all.totals.protected).toBe(1)
    expect((await get('rows/ids', 'show=protected')).json()).toEqual({ ids: [brand], total: 1, truncated: false })
    // The tile follows the text and owner filters like the rows.
    expect((await rowsOf('show=protected&q=kids')).totals.protected).toBe(0)
  })

  it('every term that holds a row, the first named; a market and campaign term reads its scope; kept protected leaves the tile', async () => {
    const kids = termId('g-broad1', 'jacket kids')
    const made = await withWorkspace(business(A), async () => {
      const c = database.client as any
      return [
        await c.adKeywordProtection.create({ data: { mode: 'WHITELIST', term: 'kids', matchType: 'CONTAINS', marketplace: 'IT', campaignId: 'c-broad', reason: 'made up: a line we keep', createdAt: ago(2) } }),
        await c.adKeywordProtection.create({ data: { mode: 'WHITELIST', term: 'jacket kids', matchType: 'EXACT', createdAt: ago(1) } }),
      ]
    })
    try {
      const res = await rowsOf('show=protected&pageSize=200')
      expect(res.rows.map((r: Row) => r.id).sort()).toEqual([brand, kids].sort())
      expect(byId(res.rows).get(kids).protection).toEqual({
        terms: [
          { id: made[0].id, term: 'kids', match: 'CONTAINS', market: 'IT', campaign: { id: 'c-broad', name: 'Test c-broad', href: '/marketing/ads/campaigns/c-broad' }, reason: 'made up: a line we keep' },
          { id: made[1].id, term: 'jacket kids', match: 'EXACT', market: null, campaign: null, reason: null },
        ],
        then: null,
      })
      // The held verb names the first, as before.
      expect(byId(res.rows).get(kids).verb.held.reason).toMatch(/"kids" is a protected term/)
      // Kept protected (the page's Skip): out of the tile, under Skipped, still protected.
      await withWorkspace(business(A), () => (database.client as any).adsWasteSkip.create({ data: { rowKey: kids, until: new Date(NOW + 30 * DAY), by: 'user:u1', at: ago(0), reason: 'Kept protected: the protected term stays.' } }))
      const after = await rowsOf('show=protected&pageSize=200')
      expect([after.total, after.totals.protected]).toEqual([1, 1])
      const skipped = byId((await rowsOf('show=skipped&pageSize=200')).rows).get(kids)
      expect(skipped).toMatchObject({ state: 'PROTECTED', skipped: { by: 'Test person one' }, protection: { terms: [{ term: 'kids' }, { term: 'jacket kids' }] } })
    } finally {
      await withWorkspace(business(A), async () => {
        const c = database.client as any
        await c.adsWasteSkip.deleteMany({})
        await c.adKeywordProtection.deleteMany({ where: { id: { in: made.map((m) => m.id) } } })
      })
    }
  })

  it('the MCP tool ad-waste takes show protected: the same rows and totals as the route', async () => {
    const { ADS_WASTE_TOOLS } = await import('../services/agents/tools/ads-waste.tools.js')
    const out = await withWorkspace(business(A), () => ADS_WASTE_TOOLS[0].handler({ view: 'rows', market: 'IT', show: 'protected' }, {} as never)) as { ok: boolean; data: any }
    const route = await rowsOf('show=protected')
    expect(out.ok).toBe(true)
    expect(out.data.rows.map((r: Row) => r.id)).toEqual(route.rows.map((r: Row) => r.id))
    expect(out.data.totals.protected).toBe(route.totals.protected)
    expect(out.data.rows[0].protection.terms[0].term).toBe('jacket brand')
    expect(ADS_WASTE_TOOLS[0].description).toMatch(/protected: exactly the rows show protected lists/)
  })
})

describe('scope filter — the four lists on rows, rows/ids, stopped and history (2026-10-12)', () => {
  const idsOf = async (path: string, query: string): Promise<string[]> => {
    const res = await get(path, query)
    expect(res.statusCode, `${path}?${query} ${res.body}`).toBe(200)
    const body = res.json()
    if (path === 'rows/ids') return [...body.ids].sort()
    if (path === 'history') return body.rows.map((r: Row) => `${r.at}|${r.action}|${r.rowId}|${r.text}`).sort()
    return body.rows.map((r: Row) => r.id).sort()
  }
  const union = (...lists: string[][]) => [...new Set(lists.flat())].sort()
  const reads: Array<[string, string]> = [['rows', 'show=all&pageSize=200'], ['rows/ids', 'show=all'], ['stopped', 'pageSize=200'], ['history', 'days=30']]

  it('OR inside a list: each read answers the union of its singular reads', async () => {
    for (const [path, base] of reads) {
      const one = await idsOf(path, `${base}&adGroupId=g-exact`)
      const two = await idsOf(path, `${base}&adGroupId=g-broad2`)
      expect(one.length + two.length, path).toBeGreaterThan(0)
      expect(await idsOf(path, `${base}&adGroupIds=g-exact,g-broad2`), path).toEqual(union(one, two))
      expect(await idsOf(path, `${base}&campaignIds=c-exact,c-broad`), path).toEqual(union(await idsOf(path, `${base}&campaignId=c-exact`), await idsOf(path, `${base}&campaignId=c-broad`)))
    }
  })

  it('AND across lists; a portfolio is the campaign\'s; a product is its family', async () => {
    for (const [path, base] of reads) {
      expect(await idsOf(path, `${base}&campaignIds=c-exact,c-broad&adGroupIds=g-exact`), path).toEqual(await idsOf(path, `${base}&adGroupId=g-exact`))
      expect(await idsOf(path, `${base}&portfolioIds=PF-1`), path).toEqual(await idsOf(path, `${base}&campaignId=c-exact`))
      expect(await idsOf(path, `${base}&portfolioIds=PF-1&campaignIds=c-broad`), path).toEqual([])
      expect(await idsOf(path, `${base}&productIds=p-M,p-L`), path).toEqual(await idsOf(path, `${base}&productId=p-root`))
    }
  })

  it('a singular is a list of one merged with its plural', async () => {
    for (const [path, base] of reads) {
      expect(await idsOf(path, `${base}&adGroupId=g-exact&adGroupIds=g-broad2`), path).toEqual(await idsOf(path, `${base}&adGroupIds=g-exact,g-broad2`))
      expect(await idsOf(path, `${base}&portfolioId=PF-1&portfolioIds=PF-1`), path).toEqual(await idsOf(path, `${base}&portfolioIds=PF-1`))
    }
  })

  it('the tiles follow the lists: the Wasting tile, the negated tile and the Stopped view\'s totals', async () => {
    const scope = 'adGroupIds=g-exact,g-broad2'
    const all = await rowsOf('show=wasting')
    const listed = await rowsOf(`show=wasting&${scope}`)
    expect(listed.total).toBe(listed.totals.wasting)
    expect(listed.rows.every((r: Row) => ['g-exact', 'g-broad2'].includes(r.adGroup.id))).toBe(true)
    expect(listed.totals.wasting).toBeLessThan(all.totals.wasting)
    const negated = (await get('stopped', `show=negated&${scope}`)).json()
    expect(listed.totals.negated).toBe(negated.total)
    expect(negated.totals.negated).toBe(negated.total)
    const stopped = (await get('stopped', `pageSize=200&${scope}`)).json()
    expect(stopped.totals.all).toBe(stopped.total)
    expect(stopped.totals.all).toBeLessThan((await get('stopped', 'pageSize=200')).json().totals.all)
  })

  it('an unknown or another business\'s id in any list is the singular\'s 404, naming it, on every read', async () => {
    const cases: Array<[string, string]> = [
      ['campaignIds=c-exact,b-camp', 'No campaign b-camp in this business.'],
      ['adGroupIds=g-exact,g-nope', 'No ad group g-nope in this business.'],
      ['portfolioIds=PF-1,PF-B', 'No portfolio PF-B in this business.'],
      ['productIds=p-root,p-nope', 'No product p-nope in this business.'],
      ['campaignIds=c-exact&adGroupIds=g-broad1', 'No ad group g-broad1 in this business and campaign.'],
    ]
    for (const [path, base] of reads) {
      for (const [query, words] of cases) {
        const res = await get(path, `${base}&${query}`)
        expect(res.statusCode, `${path}?${query}`).toBe(404)
        expect(res.json().error, `${path}?${query}`).toBe(words)
      }
    }
  })

  it('at most 500 ids in one list: 501 is a 400 in words', async () => {
    const many = Array.from({ length: 501 }, (_, i) => `g-${i}`).join(',')
    for (const [path, base] of reads) {
      const res = await get(path, `${base}&adGroupIds=${many}`)
      expect(res.statusCode, path).toBe(400)
      expect(res.json().error, path).toMatch(/^adGroupIds: at most 500 ids/)
    }
  })
})

describe('GET /api/advertising/waste/stopped', () => {
  it('paused keywords and standing negatives, each with its author and what may be done', async () => {
    const res = await get('stopped', 'pageSize=200')
    expect(res.statusCode, res.body).toBe(200)
    const rows = byId(res.json().rows)
    expect(rows.get('neg:n-person')).toMatchObject({ state: 'NEGATED', owner: { kind: 'PERSON', name: 'Test person one' }, level: 'AD_GROUP', actions: { removeNegative: { allowed: true } } })
    expect(rows.get('neg:n-funnel')).toMatchObject({ owner: { kind: 'BRAIN', name: 'Brain funnel' }, actions: { removeNegative: { allowed: false } } })
    expect(rows.get('neg:n-funnel').actions.removeNegative.why).toMatch(/The Brain keeps this negative/)
    expect(rows.get('neg:n-harvest')).toMatchObject({ owner: { kind: 'HARVEST', name: 'Harvest' }, actions: { removeNegative: { allowed: false } } })
    expect(rows.get('neg:n-unknown').owner).toEqual({ kind: 'NONE', name: 'Unknown', id: null })
    expect(rows.has('neg:n-gone')).toBe(false)
    expect(rows.get('kw:k-paused')).toMatchObject({ state: 'PAUSED', owner: { kind: 'PERSON' }, sinceSource: 'record', actions: { turnOn: { allowed: true }, release: { allowed: false } } })
    expect(rows.get('neg:n-person').spendBeforeCents).toBe(900)
    expect(res.json().totals).toMatchObject({ kept: 0, negated: 6, paused: 1, inactive: 2 })
    expect(rows.has('neg:n-idle') || rows.has('kw:k-idle')).toBe(false)
  })

  it('negated, clashes and inactive honour the owner and text filters, like the rows', async () => {
    expect((await get('stopped', 'owner=PERSON')).json().totals).toMatchObject({ negated: 1, inactive: 1 })
    expect((await get('stopped', 'q=idle')).json().totals).toMatchObject({ negated: 0, inactive: 2, all: 0 })
    expect((await rowsOf('show=wasting&owner=PERSON')).totals.negated).toBe(1)
    expect((await rowsOf('show=wasting&q=blue')).totals.negated).toBe(1)
    expect((await rowsOf('show=wasting&q=nothing-like-this')).totals).toMatchObject({ negated: 0, clashes: 0, wasting: 0 })
    expect((await rowsOf('show=wasting&q=jacket')).totals.clashes).toBe(1)
    expect((await rowsOf('show=wasting&owner=RULE')).totals.clashes).toBe(0)
  })

  it('show=negated answers the Wasting view\'s "negated" tile over the same scope (one list of standing negatives)', async () => {
    const neg = (await get('stopped', 'show=negated')).json()
    expect(neg.total).toBe(neg.totals.negated)
    expect((await rowsOf('show=wasting')).totals.negated).toBe(neg.total)
    expect((await rowsOf('show=wasting&adGroupId=g-exact')).totals.negated).toBe((await get('stopped', 'show=negated&adGroupId=g-exact')).json().total)
  })
})

describe('GET /api/advertising/waste/history and /row/:id', () => {
  it('history: paused, negated, removed, refused — with delivery and undo', async () => {
    const res = await get('history', 'days=30')
    expect(res.statusCode, res.body).toBe(200)
    const rows: Row[] = res.json().rows
    const of = (action: string, text: string) => rows.find((r) => r.action === action && r.text === text)
    expect(of('paused', 'old jacket')).toMatchObject({ by: { name: 'Test person one' }, delivery: 'LIVE', undo: { available: false } })
    expect(of('paused', 'old jacket').undo.why).toMatch(/undo window/)
    expect(of('negated', 'jacket blue')).toMatchObject({ kind: 'TERM', delivery: 'LIVE', undo: { available: false } })
    expect(of('removed', 'jacket gone')).toMatchObject({ undo: { available: false } })
    expect(of('removed', 'jacket gone').undo.why).toMatch(/Amazon archives it/)
    expect(of('refused', 'storm jacket')).toMatchObject({ delivery: 'FAILED' })
    expect(rows.some((r) => r.action === 'refused' && r.text === 'jacket kids' && r.by.name === 'Brain')).toBe(true)
  })

  it('one row: where its words run and where they are blocked', async () => {
    const res = await get(`row/${encodeURIComponent(termId('g-broad1', 'jacket kids'))}`)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body.row.id).toBe(termId('g-broad1', 'jacket kids'))
    expect(body.runsIn.map((p: Row) => p.adGroup.id).sort()).toEqual(['g-broad1', 'g-broad2'])
    expect(body.blockedIn).toEqual([])
    expect(body.history.some((h: Row) => h.action === 'refused')).toBe(true)
    const neg = await get(`row/${encodeURIComponent('neg:n-person')}`)
    expect(neg.statusCode, neg.body).toBe(200)
    expect(neg.json().blockedIn.map((p: Row) => p.rowId)).toEqual(['neg:n-person'])
    // HONEST 18a — a term blocked in its own place: its negative is listed, but no OTHER ad group is blocked.
    const blue = (await get(`row/${encodeURIComponent(termId('g-broad2', 'jacket blue'))}`)).json()
    expect([blue.blockedIn.length, blue.blockedAdGroups]).toEqual([1, 0])
    expect(blue.settledThrough).toBe(new Date(Math.floor(NOW / DAY) * DAY - 3 * DAY).toISOString().slice(0, 10))
    expect((await get('row/kw:nope')).statusCode).toBe(404)
    expect((await get('row/xyz')).statusCode).toBe(400)
  })
})

describe('NWRITE\'s columns: the hold, the stored author, the skip', () => {
  it('a hold on the paused keyword makes it KEPT_PAUSED, its holder the owner; the stored author wins over the derivation', async () => {
    await withWorkspace(business(A), async () => {
      const c = database.client as any
      await c.adTarget.update({ where: { id: 'k-paused' }, data: { keptPausedAt: ago(3), keptPausedBy: 'user:u7', keptPausedReason: 'wastes' } })
      await c.adTarget.update({ where: { id: 'n-unknown' }, data: { negativeOrigin: 'HARVEST' } })
      // The brain's log says funnel; NWRITE's stored author says a rule: the stored author wins.
      await c.adTarget.update({ where: { id: 'n-funnel' }, data: { negativeOrigin: 'RULE' } })
    })
    const stopped = byId((await get('stopped', 'pageSize=200')).json().rows)
    expect(stopped.get('kw:k-paused')).toMatchObject({ state: 'KEPT_PAUSED', owner: { kind: 'PERSON', id: 'u7' }, sinceSource: 'hold', keptPaused: { by: { name: 'A person' }, reason: 'wastes', until: null }, actions: { release: { allowed: true }, turnOn: { allowed: true } } })
    expect(stopped.get('neg:n-unknown').owner.kind).toBe('HARVEST')
    expect(stopped.get('neg:n-unknown').actions.removeNegative.allowed).toBe(false)
    expect(stopped.get('neg:n-funnel').owner).toEqual({ kind: 'RULE', name: 'Rule', id: null })
    const rows = await rowsOf()
    expect(byId(rows.rows).get('kw:k-paused')).toMatchObject({ state: 'KEPT_PAUSED', owner: { id: 'u7' } })
    expect(rows.totals.keptPaused).toBe(1)
    expect((await get('stopped', 'show=kept')).json().total).toBe(1)
  })

  it('a hold that has ended holds nothing', async () => {
    await withWorkspace(business(A), () => (database.client as any).adTarget.update({ where: { id: 'k-paused' }, data: { keptPausedUntil: ago(1) } }))
    try {
      expect(byId((await get('stopped', 'pageSize=200')).json().rows).get('kw:k-paused').state).toBe('PAUSED')
    } finally {
      await withWorkspace(business(A), () => (database.client as any).adTarget.update({ where: { id: 'k-paused' }, data: { keptPausedUntil: null } }))
    }
  })

  it('a skipped row leaves the Wasting tile and answers show=skipped until its end; an ended skip does not count', async () => {
    const before = await rowsOf('show=wasting&pageSize=200')
    expect(before.rows.some((r: Row) => r.id === 'kw:k-waste')).toBe(true)
    await withWorkspace(business(A), async () => {
      const c = database.client as any
      await c.adsWasteSkip.create({ data: { rowKey: 'kw:k-waste', until: new Date(NOW + 7 * DAY), by: 'user:u1', at: ago(1) } })
      await c.adsWasteSkip.create({ data: { rowKey: termId('g-broad1', 'jacket kids'), until: new Date(NOW + 7 * DAY), by: 'user:u1', at: ago(2), endedAt: ago(1), endedBy: 'user:u1' } })
    })
    const after = await rowsOf('show=wasting&pageSize=200')
    expect(after.rows.some((r: Row) => r.id === 'kw:k-waste')).toBe(false)
    expect(after.totals).toMatchObject({ wasting: before.totals.wasting - 1, skipped: 1 })
    const skipped = await rowsOf('show=skipped')
    expect(skipped.rows.map((r: Row) => r.id)).toEqual(['kw:k-waste'])
    // HONEST 19 — who skipped it, by name (never a raw id).
    expect(skipped.rows[0].skipped).toMatchObject({ by: 'Test person one' })
    const history: Row[] = (await get('history', 'kind=all')).json().rows
    expect(history.filter((h) => h.action === 'skipped').map((h) => h.rowId).sort()).toEqual(['kw:k-waste', termId('g-broad1', 'jacket kids')].sort())
    // M5 — the skip an Unskip ended reads UNDONE (no Undo); the one that holds reads LIVE.
    const skips = new Map(history.filter((h) => h.action === 'skipped').map((h) => [h.rowId, h]))
    expect(skips.get(termId('g-broad1', 'jacket kids'))).toMatchObject({ delivery: 'UNDONE', undo: { available: false }, text: 'jacket kids' })
    expect(skips.get(termId('g-broad1', 'jacket kids')).why).toMatch(/unskipped .* by Test person one/)
    expect(skips.get('kw:k-waste')).toMatchObject({ delivery: 'LIVE', undo: { available: true } })
    await withWorkspace(business(A), () => (database.client as any).adsWasteSkip.deleteMany({}))
  })

  it('the hold\'s Nexus-only history rows read kept; a turn-on the lock refused reads refused, with why', async () => {
    await withWorkspace(business(A), async () => {
      const c = database.client as any
      await c.advertisingActionLog.create({ data: { userId: 'user:u7', actionType: 'keep_paused', entityType: 'AD_TARGET', entityId: 'k-paused', payloadBefore: { keptPausedAt: null }, payloadAfter: { keptPausedAt: ago(3).toISOString(), keptPausedBy: 'user:u7' }, amazonResponseStatus: 'SKIPPED', createdAt: ago(3) } })
      await c.adWriteRefusal.create({ data: { deniedAt: 'kept_paused', reason: 'kept paused by a person: only a person may turn it on', entityType: 'AD_TARGET', entityId: 'k-paused', campaignId: 'c-exact', payloadValueCents: 0, createdAt: ago(1) } })
    })
    const rows: Row[] = (await get('history', 'kind=keyword')).json().rows
    expect(rows.find((r) => r.action === 'kept' && r.text === 'old jacket')).toMatchObject({ delivery: 'LIVE', by: { id: 'u7' }, rowId: 'kw:k-paused', undo: { available: false } })
    expect(rows.find((r) => r.action === 'refused' && r.text === 'old jacket')).toMatchObject({ delivery: 'REFUSED' })
    expect(rows.find((r) => r.action === 'refused' && r.text === 'old jacket').why).toBe('Kept paused — not turned on')
    expect(rows.every((r) => r.kind !== 'TERM')).toBe(true)
  })

  it('a turn-on the lock refused, written with the person who tried, shows once: refused, by that person', async () => {
    await withWorkspace(business(A), async () => {
      const c = database.client as any
      const at = ago(0.5)
      await c.advertisingActionLog.create({ data: { userId: 'user:u8', actionType: 'kept_paused_refused', entityType: 'AD_TARGET', entityId: 'k-paused', payloadBefore: { keptPausedAt: null }, payloadAfter: { keptPausedAt: null }, amazonResponseStatus: 'SKIPPED', createdAt: at } })
      await c.adWriteRefusal.create({ data: { deniedAt: 'kept_paused', reason: 'kept paused by a person (user:u7) since 2026-10-04 22:42 UTC', entityType: 'AD_TARGET', entityId: 'k-paused', campaignId: 'c-exact', payloadValueCents: 0, createdAt: new Date(at.getTime() + 2_000) } })
    })
    const rows: Row[] = (await get('history', 'kind=keyword')).json().rows
    const recent = rows.filter((r) => r.action === 'refused' && r.text === 'old jacket' && Date.parse(r.at) > NOW - 0.75 * DAY)
    expect(recent).toHaveLength(1)
    expect(recent[0]).toMatchObject({ by: { id: 'u8', name: 'A person' }, why: 'Kept paused — not turned on', delivery: 'REFUSED', undo: { available: false }, rowId: 'kw:k-paused' })
    // The row's own History says the same.
    const detail = (await get(`row/${encodeURIComponent('kw:k-paused')}`)).json()
    expect(detail.history.filter((h: Row) => h.action === 'refused' && Date.parse(h.at) > NOW - 0.75 * DAY)).toHaveLength(1)
  })

  it('a hold with Amazon reporting ENABLED reads TURNED_ON_ELSEWHERE', async () => {
    await database.db.query(`UPDATE "AdTarget" SET status = 'ENABLED' WHERE id = 'k-paused'`)
    try {
      const stopped = byId((await get('stopped', 'show=turned-on')).json().rows)
      expect(stopped.get('kw:k-paused')).toMatchObject({ state: 'TURNED_ON_ELSEWHERE', actions: { turnOn: { allowed: false }, release: { allowed: true } } })
      // S8 — the Wasting view shows it too: its own state and tile, its holder the owner.
      const rows = await rowsOf('show=turned-on')
      expect(rows.rows.map((r: Row) => r.id)).toEqual(['kw:k-paused'])
      expect(rows.rows[0]).toMatchObject({ state: 'TURNED_ON_ELSEWHERE', owner: { kind: 'PERSON', id: 'u7' }, verb: { action: 'PAUSE' } })
      expect(rows.totals).toMatchObject({ turnedOn: 1, keptPaused: 0 })
      expect(rows.rows[0].clash).toEqual({ kind: 'TURNED_ON', label: 'Turned on outside Nexus' })
      const clashes = await rowsOf('show=clashes')
      expect(clashes.rows.map((r: Row) => r.id)).toContain('kw:k-paused')
      expect(clashes.total).toBe(clashes.totals.clashes)
      expect(rows.total).toBe(rows.totals.turnedOn)
    } finally {
      await database.db.query(`UPDATE "AdTarget" SET status = 'PAUSED' WHERE id = 'k-paused'`)
    }
  })
})

describe('the MCP tool ad-waste reads the same functions', () => {
  it('rows, stopped, row and history answer what the routes answer', async () => {
    const { ADS_WASTE_TOOLS } = await import('../services/agents/tools/ads-waste.tools.js')
    const tool = ADS_WASTE_TOOLS[0]
    const call = (args: Record<string, unknown>) => withWorkspace(business(A), () => tool.handler(args, {} as never)) as Promise<{ ok: boolean; data: any; error?: string }>
    const viaTool = await call({ view: 'rows', market: 'IT', show: 'all', pageSize: 200 })
    const viaRoute = await rowsOf()
    expect(viaTool.ok).toBe(true)
    expect(viaTool.data.rows.map((r: Row) => r.id)).toEqual(viaRoute.rows.map((r: Row) => r.id))
    expect(viaTool.data.totals).toEqual(viaRoute.totals)
    expect((await call({ view: 'rows', show: 'all' })).data.total).toBeGreaterThanOrEqual(viaTool.data.total) // every market
    const stopped = await call({ view: 'stopped', market: 'IT' })
    expect(stopped.data.total).toBe((await get('stopped')).json().total)
    const one = await call({ view: 'row', rowId: 'kw:k-waste' })
    expect(one.data.row.id).toBe('kw:k-waste')
    expect((await call({ view: 'row' })).ok).toBe(false)
    expect((await call({ view: 'history', market: 'IT', days: 30 })).data.rows.length).toBe((await get('history', 'days=30')).json().rows.length)
    expect((await call({ view: 'stopped', market: 'IT', show: 'wasting' })).ok).toBe(false)
  })
})

describe('S3 — one market per read, a short memo, a focused row', () => {
  it('no market reads every market with Amazon ads: rows keep their market and currency, money is split per currency', async () => {
    const all = (path: string, query = '') => app.inject({ method: 'GET', url: `/api/advertising/waste/${path}${query ? `?${query}` : ''}` })
    const res = await all('rows', 'show=wasting&pageSize=200')
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    const it = await rowsOf('show=wasting&pageSize=200')
    const uk = await rowsOf('show=wasting&pageSize=200&market=UK')
    expect(body.total).toBe(it.total + uk.total)
    expect(body.rows.map((r: Row) => r.id).sort()).toEqual([...it.rows, ...uk.rows].map((r: Row) => r.id).sort())
    expect(byId(body.rows).get('kw:k-uk')).toMatchObject({ market: 'UK', currency: 'GBP' })
    expect(body.totals).toMatchObject({ wasting: it.totals.wasting + uk.totals.wasting, wastingSpendCents: null, currency: null, negated: it.totals.negated + uk.totals.negated })
    expect(body.totals.wastingSpendByCurrency).toEqual({ EUR: it.totals.wastingSpendCents, GBP: uk.totals.wastingSpendCents })
    expect(body.totals.wastingSpendNote).toMatch(/EUR, GBP/)
    expect(uk.totals).toMatchObject({ currency: 'GBP', wastingSpendNote: null })
    expect(body.criteria.sentence).toMatch(/^Every market \(IT, UK\)/)
    // The same for select-all, the Stopped view and the history.
    expect((await all('rows/ids', 'show=wasting')).json().total).toBe(body.total)
    expect((await all('stopped')).json().total).toBe((await get('stopped')).json().total + (await get('stopped', 'market=UK')).json().total)
    expect((await all('history', 'days=30')).statusCode).toBe(200)
    // A campaign scope reads only its own market.
    expect((await all('rows', 'show=all&campaignId=c-uk')).json().rows.every((r: Row) => r.market === 'UK')).toBe(true)
  })

  it('one market\'s facts are reused while nothing changed; our own writes (logged, decided, skipped) show at once', async () => {
    const { invalidateWasteFacts } = await import('../services/advertising/waste/read.js')
    vi.stubEnv('NEXUS_WASTE_FACTS_TTL_MS', '60000')
    invalidateWasteFacts()
    try {
      const before = (await rowsOf('show=all&q=storm')).rows.length
      await withWorkspace(business(A), () => (database.client as any).adTarget.create({ data: { id: 'k-memo', adGroupId: 'g-exact', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'storm memo', bidCents: 40, externalTargetId: 'EXT-k-memo' } }))
      expect((await rowsOf('show=all&q=storm')).rows.length).toBe(before)
      invalidateWasteFacts()
      expect((await rowsOf('show=all&q=storm')).rows.length).toBe(before + 1)
      // Our own writes move the change stamp: the next read is fresh with no invalidate, on any replica — a write logged
      // in the action log (an apply, an undo), a decided ask, a skip.
      await withWorkspace(business(A), async () => {
        const c = database.client as any
        await c.adTarget.create({ data: { id: 'k-memo2', adGroupId: 'g-exact', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'storm memo two', bidCents: 40, externalTargetId: 'EXT-k-memo2' } })
        await c.advertisingActionLog.create({ data: { userId: 'user:u1', actionType: 'AD_ENTITY_STATE_UPDATE', entityType: 'AD_TARGET', entityId: 'k-memo2', payloadBefore: { status: 'PAUSED' }, payloadAfter: { status: 'ENABLED' }, amazonResponseStatus: 'SUCCESS' } })
      })
      expect((await rowsOf('show=all&q=storm')).rows.length).toBe(before + 2)
      const waitingBefore = (await rowsOf('show=wasting')).totals.waiting
      await withWorkspace(business(A), () => (database.client as any).agentApproval.update({ where: { id: 'appr-pause' }, data: { status: 'rejected', decidedAt: new Date() } }))
      expect((await rowsOf('show=wasting')).totals.waiting).toBe(waitingBefore - 1)
      await withWorkspace(business(A), () => (database.client as any).agentApproval.update({ where: { id: 'appr-pause' }, data: { status: 'pending', decidedAt: null } }))
      await withWorkspace(business(A), () => (database.client as any).adsWasteSkip.create({ data: { rowKey: 'kw:k-waste', until: new Date(NOW + 7 * DAY), by: 'user:u1', at: new Date() } }))
      expect((await rowsOf('show=wasting')).totals.skipped).toBe(1)
      await withWorkspace(business(A), () => (database.client as any).adsWasteSkip.deleteMany({}))
      expect((await rowsOf('show=wasting')).totals.skipped).toBe(0)
    } finally {
      await withWorkspace(business(A), async () => {
        const c = database.client as any
        await c.advertisingActionLog.deleteMany({ where: { entityId: 'k-memo2' } })
        await c.adTarget.deleteMany({ where: { id: { in: ['k-memo', 'k-memo2'] } } })
      })
      vi.stubEnv('NEXUS_WASTE_FACTS_TTL_MS', '0')
      invalidateWasteFacts()
    }
  })

  it('one row\'s detail reads only its words and its own ad group', async () => {
    const { loadWasteFacts } = await import('../services/advertising/waste/read.js')
    const f = await withWorkspace(business(A), () => loadWasteFacts('IT', new Date(), { key: 'jacket kids', adGroupId: 'g-exact' }))
    const places = [...f.termPlaces.values()]
    expect(places.length).toBeGreaterThan(0)
    expect(places.every((p) => p.key === 'jacket kids' || p.adGroupId === 'g-exact')).toBe(true)
    expect([...f.keywords.keys()].every((id) => f.targetById.get(id)!.adGroupId === 'g-exact' || f.targetById.get(id)!.expressionValue === 'jacket kids')).toBe(true)
    // Its pooled conversion rate still reads the whole market (a light sum per campaign).
    expect(f.marketFacts.get('IT')!.cr).toBeGreaterThan(0)
  })
})

describe('polish 1 — names, numbers and plain words', () => {
  it('S11: an auto target reads by its group ("Close match") in the rows, the Stopped view and the history', async () => {
    const row = byId((await rowsOf()).rows).get('kw:k-auto')
    expect(row).toMatchObject({ text: 'Close match', kind: 'TARGET', match: 'AUTO' })
    await withWorkspace(business(A), () => (database.client as any).adsWasteSkip.create({ data: { rowKey: 'kw:k-auto', until: new Date(NOW + 7 * DAY), by: 'user:u1', at: ago(1) } }))
    try {
      const skip = (await get('history', 'kind=keyword')).json().rows.find((h: Row) => h.action === 'skipped' && h.rowId === 'kw:k-auto')
      expect(skip.text).toBe('Close match')
      expect(skip.kind).toBe('TARGET')
    } finally {
      await withWorkspace(business(A), () => (database.client as any).adsWasteSkip.deleteMany({ where: { rowKey: 'kw:k-auto' } }))
    }
  })

  it('S9: a keyword with no keyword report of its own reads its numbers from the search terms it bought', async () => {
    const rows = byId((await rowsOf()).rows)
    // k-broad2 has no keyword report; its terms in g-broad2 are its numbers.
    const k = rows.get('kw:k-broad2')
    expect(k.d).not.toBeNull()
    expect(k.d.clicks).toBe(1000 + 30 + 12) // jacket winter, jacket kids, jacket blue
    // A kept keyword switched on outside Nexus shows what it spends again.
    await database.db.query(`UPDATE "AdTarget" SET status = 'ENABLED' WHERE id = 'k-paused'`)
    try {
      const on = byId((await rowsOf('show=turned-on')).rows).get('kw:k-paused')
      expect(on.state).toBe('TURNED_ON_ELSEWHERE')
      expect(on.d).toMatchObject({ clicks: 4, spendCents: 300 })
    } finally {
      await database.db.query(`UPDATE "AdTarget" SET status = 'PAUSED' WHERE id = 'k-paused'`)
    }
    expect(rows.get('kw:k-nodata').d).toBeNull()
  })

  it('M8: no raw ids, tool names or UTC times reach the Owner in the reads', async () => {
    const bodies = [await get('rows', 'show=all&pageSize=200'), await get('stopped', 'pageSize=200'), await get('history', 'days=90'), await get(`row/${encodeURIComponent('kw:k-paused')}`)].map((r) => r.body)
    for (const text of bodies) {
      const words = [...text.matchAll(/"(?:why|sentence|label|reason|name|text)":"([^"]*)"/g)].map((m) => m[1]).join(' | ')
      expect(words).not.toMatch(/user:|automation:|enable-ads|pause-ads|retire-negatives|add-negative-targets|undo-change|releaseKe|keepPaused| UTC\b/)
    }
  })
})

describe('money', () => {
  it('a person without ad spend gets the answer minus exactly the money keys, ordered by place', async () => {
    permissions = { isOwner: false, permissions: new Set(['ads.view']) }
    try {
      const res = await get('rows', 'show=all&pageSize=200')
      expect(res.statusCode).toBe(200)
      const body = res.json()
      const row = body.rows.find((r: Row) => r.id === 'kw:k-waste')
      expect(row.d).toEqual({ impressions: 0, clicks: 80, orders: 0 })
      expect(row.spark).toBeUndefined()
      expect(row.test.spendBarCents).toBeUndefined()
      expect(body.totals.wastingSpendCents).toBeUndefined()
      const where = body.rows.map((r: Row) => `${r.portfolio?.name ?? ''} ${r.campaign.name} ${r.adGroup.name}`)
      expect(where).toEqual([...where].sort((a, b) => a.localeCompare(b)))
      permissions = { isOwner: false, permissions: new Set(['ads.view', FIELDS.financialsAdspendView]) }
      expect((await get('rows', 'show=all')).json().rows[0].d.spendCents).toBeTypeOf('number')
    } finally {
      permissions = { isOwner: true, permissions: new Set() }
    }
  })
})

describe('NFIX — "Since" is the day a negative was added; "Waiting for you" lists every ask it counts', () => {
  // Its own market (DE), made and removed here: the reads above never see it.
  const DE = 'market=DE'
  const ids = { approvals: ['appr-brain-de', 'appr-brain-old', 'appr-pause-de', 'appr-hv-de'], keys: ['de-1', 'de-2', 'de-3', 'de-old', 'de-written'] }
  const sync = Array.from({ length: 12 }, (_, i) => `n-sync-${i}`)
  const inA = <T>(fn: (c: any) => Promise<T>) => withWorkspace(business(A), () => fn(database.client as any))

  beforeAll(async () => {
    await inA(async (c) => {
      await c.campaign.create({ data: { id: 'c-de', name: 'Test c-de', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'DE', externalCampaignId: 'EXT-c-de', dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z') } })
      for (const [id, status] of [['g-de1', 'ENABLED'], ['g-de2', 'ENABLED'], ['g-de-paused', 'PAUSED']] as const) {
        await c.adGroup.create({ data: { id, campaignId: 'c-de', name: `group ${id}`, externalAdGroupId: `EXT-${id}`, status } })
      }
      await c.adTarget.create({ data: { id: 'k-de', adGroupId: 'g-de2', kind: 'KEYWORD', expressionType: 'BROAD', expressionValue: 'de jacket', bidCents: 40, externalTargetId: 'EXT-k-de' } })
      await c.adTarget.create({ data: { id: 'k-de-idle', adGroupId: 'g-de-paused', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'de idle jacket', bidCents: 40, externalTargetId: 'EXT-k-de-idle' } })
      const neg = (id: string, text: string, createdAt: Date) => c.adTarget.create({ data: { id, adGroupId: 'g-de1', kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: text, bidCents: 0, isNegative: true, negativeLevel: 'AD_GROUP', externalTargetId: `EXT-${id}`, createdAt } })
      // One sync stored twelve negatives at once today (a re-sync): none of them was added today.
      const syncedAt = ago(0.1)
      for (const [i, id] of sync.entries()) await neg(id, i === 0 ? 'de brain words' : `de synced ${i}`, syncedAt)
      // The first of them: the Brain wrote it 3 days ago (that row is gone; the place, match and words find it).
      await neg('n-single', 'de single', ago(4))
      await neg('n-door', 'de door', ago(2))
      await c.advertisingActionLog.create({ data: { userId: 'user:u1', actionType: 'create_negative_keyword', entityType: 'AD_TARGET', entityId: 'n-door', payloadBefore: {}, payloadAfter: { keywordText: 'de door' }, amazonResponseStatus: 'SUCCESS', createdAt: ago(2) } })
      const brain = { productId: 'p-root', marketplace: 'DE', reasons: [], kind: 'KEYWORD', level: 'AD_GROUP', campaignId: 'c-de', mode: 'PROPOSE', why: 'made up', evidence: {}, digest: 'd', runId: 'run-de', dataDay: dayAgo(1), firstSeenAt: ago(1), checkedAt: ago(1), changedAt: ago(1), action: 'ADD', reason: 'waste' }
      await c.adsBrainNegative.create({ data: { ...brain, key: 'de-written', match: 'EXACT', text: 'De Brain Words', adGroupId: 'g-de1', status: 'WRITTEN', adTargetId: 'n-gone-before', actedAt: ago(3), result: 'added at Amazon (made up)' } })
      // A search term that wastes in g-de2: its row carries the Brain's ask for it.
      for (const d of [10, 20]) {
        await c.amazonAdsSearchTerm.create({ data: { profileId: 'P-DE', marketplace: 'DE', adProduct: 'SPONSORED_PRODUCTS', date: dayAgo(d), campaignId: 'EXT-c-de', adGroupId: 'EXT-g-de2', matchedKeywordId: 'EXT-k-de', matchType: 'BROAD', query: 'de wasted term', impressions: 400, clicks: 20, costMicros: 25_000_000n, currencyCode: 'EUR', orders7d: 0, sales7dCents: 0 } })
      }
      // The Brain's change plan for the day (one ask, three changes): a phrase piece no term row is, a negative's removal,
      // and the wasting term — plus yesterday's plan, expired (its log rows still say PROPOSED).
      const run = await c.agentRun.create({ data: { agentKey: 'ads-brain-negatives', trigger: 'schedule', status: 'done' } })
      const plan = (id: string, expiresAt: Date, steps: Array<{ toolName: string; args: Record<string, unknown> }>) => c.agentApproval.create({
        data: { id, agentRunId: run.id, toolName: 'submit-change-plan', riskTier: 'high', args: { title: 'made up', steps: steps.length }, status: 'pending', requestedAt: ago(0.2), expiresAt,
          planSteps: { create: steps.map((s, i) => ({ position: i + 1, toolName: s.toolName, args: s.args })) } },
      })
      await plan('appr-brain-de', new Date(NOW + DAY), [
        { toolName: 'add-negative-targets', args: { negatives: [{ adGroupId: 'g-de1', text: 'cheap de', matchType: 'NEGATIVE_PHRASE' }], why: 'Ads brain: ngram (made up)' } },
        { toolName: 'retire-negatives', args: { negativeIds: ['n-single'], why: 'Ads brain: revive (made up)' } },
        { toolName: 'add-negative-targets', args: { negatives: [{ adGroupId: 'g-de2', text: 'de wasted term', matchType: 'NEGATIVE_EXACT' }], why: 'Ads brain: waste (made up)' } },
      ])
      await plan('appr-brain-old', ago(0.5), [{ toolName: 'add-negative-targets', args: { negatives: [{ adGroupId: 'g-de1', text: 'old de', matchType: 'NEGATIVE_EXACT' }] } }])
      for (const [key, match, text, approvalId] of [['de-1', 'PHRASE', 'cheap de', 'appr-brain-de'], ['de-2', 'EXACT', 'de single', 'appr-brain-de'], ['de-3', 'EXACT', 'de wasted term', 'appr-brain-de'], ['de-old', 'EXACT', 'old de', 'appr-brain-old']]) {
        await c.adsBrainNegative.create({ data: { ...brain, key, match, text, adGroupId: 'g-de1', status: 'PROPOSED', approvalId, actedAt: ago(0.2) } })
      }
      // A person's pause of our keyword in a paused ad group, waiting.
      const mine = await c.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'awaiting_approval', userId: 'u1' } })
      await c.agentApproval.create({ data: { id: 'appr-pause-de', agentRunId: mine.id, toolName: 'pause-ads', riskTier: 'medium', args: { targetIds: ['k-de-idle'], why: 'made up' }, status: 'pending', requestedAt: ago(0.3), expiresAt: new Date(NOW + DAY) } })
      // Harvest's asks (decided on the Keyword Harvest page): one still open, one whose request expired.
      await c.agentApproval.create({ data: { id: 'appr-hv-de', agentRunId: run.id, toolName: 'apply-brain-harvest', riskTier: 'high', args: {}, status: 'pending', requestedAt: ago(0.2), expiresAt: new Date(NOW + DAY) } })
      const hv = { productId: 'p-root', marketplace: 'DE', status: 'PROPOSED', level: 'PROPOSE', destinationKind: 'EXACT', sources: [], why: 'made up', evidence: {}, digest: 'd', runId: 'run-de', decidedAt: ago(1), checkedAt: ago(1), changedAt: ago(1) }
      await c.adsBrainHarvest.create({ data: { ...hv, term: 'de harvest open', approvalId: 'appr-hv-de' } })
      await c.adsBrainHarvest.create({ data: { ...hv, term: 'de harvest old', approvalId: 'appr-brain-old' } })
    })
  })

  afterAll(async () => {
    await inA(async (c) => {
      await c.agentApproval.deleteMany({ where: { id: { in: ids.approvals } } })
      await c.adsBrainNegative.deleteMany({ where: { marketplace: 'DE' } })
      await c.adsBrainHarvest.deleteMany({ where: { marketplace: 'DE' } })
      await c.amazonAdsSearchTerm.deleteMany({ where: { marketplace: 'DE' } })
      await c.advertisingActionLog.deleteMany({ where: { entityId: 'n-door' } })
      await c.adTarget.deleteMany({ where: { adGroup: { campaignId: 'c-de' } } })
      await c.adGroup.deleteMany({ where: { campaignId: 'c-de' } })
      await c.campaign.deleteMany({ where: { id: 'c-de' } })
    })
  })

  it('Since: a record (its own, the Brain\'s by place and words) else first seen; a re-sync\'s crowd is unknown, with why', async () => {
    const res = await get('stopped', `${DE}&pageSize=200`)
    expect(res.statusCode, res.body).toBe(200)
    const rows = byId(res.json().rows)
    expect(rows.get('neg:n-sync-0')).toMatchObject({ since: ago(3).toISOString(), sinceSource: 'brain', sinceWhy: expect.stringMatching(/Brain's write/) })
    for (const id of sync.slice(1)) {
      expect(rows.get(`neg:${id}`)).toMatchObject({ since: null, sinceSource: null, spendBeforeCents: null })
      expect(rows.get(`neg:${id}`).sinceWhy).toMatch(/^Added before Nexus kept a record: Nexus first saw it on .+, in one sync with 11 other negatives$/)
    }
    expect(rows.get('neg:n-door')).toMatchObject({ since: ago(2).toISOString(), sinceSource: 'record' })
    expect(rows.get('neg:n-single')).toMatchObject({ since: ago(4).toISOString(), sinceSource: 'first-seen', sinceWhy: expect.stringMatching(/first saw it/) })
    // Unknown days sort last; no row reads the re-sync's day.
    const order = res.json().rows.map((r: Row) => r.since)
    expect(order.slice(-11).every((s: string | null) => s === null)).toBe(true)
    // Ordered by Since either way, unknown days stay last (like Saved), and the known days keep their order.
    for (const sort of ['since', '-since']) {
      const by = ((await get('stopped', `${DE}&pageSize=200&sort=${sort}`)).json().rows as Row[]).map((r) => r.since as string | null)
      expect(by.slice(-11).every((s) => s === null), sort).toBe(true)
      const known = by.filter((s): s is string => s !== null)
      expect(known, sort).toEqual([...known].sort((a, b) => (sort === 'since' ? a.localeCompare(b) : b.localeCompare(a))))
    }
    expect(order.filter((s: string | null) => s && Date.parse(s) > Date.parse(ago(1).toISOString()))).toEqual([])
  })

  it('Waiting: every ask is counted and listed — the Brain\'s too, where no wasting row carries it; an expired ask is neither', async () => {
    const waiting = await rowsOf(`${DE}&show=waiting&pageSize=200`)
    const rows = byId(waiting.rows)
    expect(new Set(waiting.rows.map((r: Row) => r.waiting.approvalId))).toEqual(new Set(['appr-brain-de', 'appr-pause-de']))
    expect(waiting.totals.waiting).toBe(2)
    expect(waiting.total).toBe(4)
    // The wasting term carries the Brain's ask on its own row.
    expect(rows.get('term:DE|EXT-g-de2|de wasted term')).toMatchObject({ waiting: { approvalId: 'appr-brain-de', by: { id: 'brain', name: 'Brain' }, rows: 3, plan: { steps: 3, offPage: 0 } } })
    // A single request is not a plan.
    expect(rows.get('kw:k-de-idle').waiting.plan).toBeUndefined()
    expect(rows.get('term:DE|EXT-g-de2|de wasted term').askOnly).toBeUndefined()
    // A phrase piece, a negative's removal and a pause in a paused place: rows of their own, listed under Waiting only.
    expect(rows.get('term:DE|EXT-g-de1|cheap de')).toMatchObject({ askOnly: true, kind: 'TERM', match: 'PHRASE', owner: { kind: 'BRAIN' }, verb: { action: 'NEGATE_PHRASE', where: 'adGroup' }, d: { clicks: 0 } })
    expect(rows.get('term:DE|EXT-g-de1|cheap de').test.sentence).toBe('Asked by Brain: Ads brain: ngram (made up)')
    expect(rows.get('neg:n-single')).toMatchObject({ askOnly: true, state: 'NEGATED', verb: { action: 'REMOVE_NEGATIVE', targetRowId: 'neg:n-single' }, waiting: { approvalId: 'appr-brain-de' } })
    expect(rows.get('kw:k-de-idle')).toMatchObject({ askOnly: true, kind: 'KEYWORD', state: 'RUNNING', owner: { kind: 'PERSON' }, verb: { action: 'PAUSE' }, waiting: { approvalId: 'appr-pause-de' } })
    // HONEST 10 / 11 — each row carries the ask's own change there (never the row's verb), and how many changes the ask holds.
    expect(rows.get('term:DE|EXT-g-de2|de wasted term').waiting).toMatchObject({ action: 'NEGATE_EXACT', match: 'EXACT', level: 'AD_GROUP', text: 'de wasted term', changes: 3 })
    expect(rows.get('term:DE|EXT-g-de1|cheap de').waiting).toMatchObject({ action: 'NEGATE_PHRASE', match: 'PHRASE', level: 'AD_GROUP', text: 'cheap de', changes: 3 })
    expect(rows.get('neg:n-single').waiting).toMatchObject({ action: 'REMOVE_NEGATIVE', match: 'EXACT', level: 'AD_GROUP', text: 'de single', changes: 3 })
    expect(rows.get('kw:k-de-idle').waiting).toMatchObject({ action: 'PAUSE', match: 'EXACT', level: null, text: 'de idle jacket', keepPaused: false, changes: 1 })
    // HONEST 15 — a row listed only for its ask was never judged by the page's test; a row of the page was.
    for (const id of ['term:DE|EXT-g-de1|cheap de', 'neg:n-single', 'kw:k-de-idle']) expect(rows.get(id).test.judged, id).toBe(false)
    expect(rows.get('term:DE|EXT-g-de2|de wasted term').test.judged).toBeUndefined()
    // The same count in every view of the rows (Bid audit M1); the ask-only rows show nowhere else.
    const all = await rowsOf(`${DE}&show=all&pageSize=200`)
    expect(all.totals.waiting).toBe(2)
    expect(all.rows.some((r: Row) => r.askOnly)).toBe(false)
    expect((await rowsOf(`${DE}&show=wasting`)).totals.waiting).toBe(2)
    expect((await get('rows/ids', `${DE}&show=waiting`)).json()).toMatchObject({ total: 4 })
    // One row's record opens with its ask.
    const one = await get(`row/${encodeURIComponent('term:DE|EXT-g-de1|cheap de')}`)
    expect(one.statusCode, one.body).toBe(200)
    expect(one.json().row).toMatchObject({ askOnly: true, waiting: { approvalId: 'appr-brain-de' } })
    expect(one.json().runsIn.some((p: Row) => p.rowId === 'term:DE|EXT-g-de1|cheap de')).toBe(false)
  })

  it('the Rules view\'s Waiting is the same truth: the Brain row counts its asks the page lists, not its log\'s PROPOSED rows', async () => {
    const res = await get('rules', DE)
    expect(res.statusCode, res.body).toBe(200)
    const brain = res.json().rules.find((r: Row) => r.id === 'brain')
    const listed = new Set((await rowsOf(`${DE}&show=waiting&pageSize=200`)).rows.filter((r: Row) => r.waiting.by.id === 'brain').map((r: Row) => r.waiting.approvalId))
    expect(brain.waiting).toBe(listed.size)
    expect(brain.waiting).toBe(1)
    // Harvest's: only the asks whose request is still open (the page links to the Keyword Harvest page's list).
    expect(res.json().rules.find((r: Row) => r.id === 'harvest').waiting).toBe(1)
  })
})

describe('step 4 — "Did it work?" on the Stopped view: the money saved since the stop', () => {
  // Its own market (FR), made here last: the reads above never see it.
  const FR = 'market=FR'
  beforeAll(async () => {
    await withWorkspace(business(A), async () => {
      const c = database.client as any
      await c.campaign.create({ data: { id: 'c-fr', name: 'Test c-fr', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'FR', externalCampaignId: 'EXT-c-fr', dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z') } })
      for (const id of ['g-fr1', 'g-fr2']) await c.adGroup.create({ data: { id, campaignId: 'c-fr', name: `group ${id}`, externalAdGroupId: `EXT-${id}` } })
      const neg = async (id: string, text: string, daysAgo: number) => {
        await c.adTarget.create({ data: { id, adGroupId: 'g-fr1', kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: text, bidCents: 0, isNegative: true, negativeLevel: 'AD_GROUP', externalTargetId: `EXT-${id}`, createdAt: ago(daysAgo) } })
        await c.advertisingActionLog.create({ data: { userId: 'user:u1', actionType: 'create_negative_keyword', entityType: 'AD_TARGET', entityId: id, payloadBefore: {}, payloadAfter: { keywordText: text }, amazonResponseStatus: 'SUCCESS', createdAt: ago(daysAgo) } })
      }
      await neg('n-fr-saved', 'fr boots', 40)
      await neg('n-fr-still', 'fr gloves', 40)
      await neg('n-fr-early', 'fr socks', 9)
      const st = (groupId: string, query: string, daysAgo: number, spendCents: number) => c.amazonAdsSearchTerm.create({ data: {
        profileId: 'P-FR', marketplace: 'FR', adProduct: 'SPONSORED_PRODUCTS', date: dayAgo(daysAgo), campaignId: 'EXT-c-fr', adGroupId: `EXT-${groupId}`, matchType: 'BROAD', query,
        impressions: 100, clicks: 5, costMicros: BigInt(spendCents) * 10_000n, currencyCode: 'EUR', orders7d: 0, sales7dCents: 0,
      } })
      // In the 30 days before the stop (40 days ago): 3 × 30.00 each in its place; after it, 5.00 of "fr boots".
      for (const d of [45, 50, 55]) { await st('g-fr1', 'fr boots', d, 3000); await st('g-fr1', 'fr gloves', d, 3000) }
      await st('g-fr1', 'fr boots', 20, 500)
      // Another place that runs still buys "fr gloves", not blocked there: it still spends.
      await st('g-fr2', 'fr gloves', 10, 800)
      // HONEST 18b — "fr boots" spent in that place only BEFORE its stop (45 days ago): it does not still spend there.
      await st('g-fr2', 'fr boots', 45, 400)
      // Our keyword, paused 30 days ago (the pause on record): 3 × 15.00 of its own spend before, none since.
      await c.adTarget.create({ data: { id: 'k-fr', adGroupId: 'g-fr2', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'fr jacket', bidCents: 40, externalTargetId: 'EXT-k-fr', status: 'PAUSED' } })
      await c.advertisingActionLog.create({ data: { userId: 'user:u1', actionType: 'AD_ENTITY_STATE_UPDATE', entityType: 'AD_TARGET', entityId: 'k-fr', payloadBefore: { status: 'ENABLED' }, payloadAfter: { status: 'PAUSED' }, amazonResponseStatus: 'SUCCESS', createdAt: ago(30) } })
      for (const d of [35, 40, 45]) await c.amazonAdsDailyPerformance.create({ data: { profileId: 'P-FR', marketplace: 'FR', adProduct: 'SPONSORED_PRODUCTS', date: dayAgo(d), entityType: 'AD_TARGET', entityId: 'EXT-k-fr', localEntityId: 'k-fr', clicks: 10, costMicros: 15_000_000n, currencyCode: 'EUR', reportedAt: ago(1) } })
    })
  })

  it('saved = before per day × the days since (to 3 days ago) − after; still spends elsewhere; too early under 14 days', async () => {
    const res = await get('stopped', `${FR}&pageSize=200`)
    expect(res.statusCode, res.body).toBe(200)
    const rows = byId(res.json().rows)
    // 9000 over the 30 days before = 300 a day, 37 days counted after, 500 spent after.
    expect(rows.get('neg:n-fr-saved').effect).toEqual({ since: ago(40).toISOString(), days: 40, verdict: 'SAVED', beforePerDayCents: 300, afterCents: 500, savedCents: 300 * 37 - 500, words: 'Spends less here in the 37 days since the stop' })
    // The same 30 days the "Spend before" reads.
    expect(rows.get('neg:n-fr-saved').spendBeforeCents).toBe(300 * 30)
    expect(rows.get('neg:n-fr-still').effect).toMatchObject({ verdict: 'STILL_SPENDS', beforePerDayCents: 300, afterCents: 0, savedCents: 300 * 37, words: 'Stopped here, but its words spent in 1 other ad group since the stop' })
    expect([rows.get('neg:n-fr-still').stillServesIn, rows.get('neg:n-fr-saved').stillServesIn]).toEqual([1, 0])
    expect(rows.get('neg:n-fr-early').effect).toEqual({ since: ago(9).toISOString(), days: 9, verdict: 'TOO_EARLY', beforePerDayCents: null, afterCents: null, savedCents: null, words: 'Stopped 9 days ago, checked from 14 days' })
    expect(rows.get('kw:k-fr').effect).toMatchObject({ verdict: 'SAVED', days: 30, beforePerDayCents: 150, afterCents: 0, savedCents: 150 * 27, words: 'No spend here in the 27 days since the stop' })
  })

  it('the record and Claude (ad-waste view stopped) read the same effect', async () => {
    const listed = byId((await get('stopped', `${FR}&pageSize=200`)).json().rows)
    const one = await get(`row/${encodeURIComponent('neg:n-fr-saved')}`)
    expect(one.statusCode, one.body).toBe(200)
    expect(one.json().row.effect).toEqual(listed.get('neg:n-fr-saved').effect)
    const { ADS_WASTE_TOOLS } = await import('../services/agents/tools/ads-waste.tools.js')
    const viaTool = await withWorkspace(business(A), () => ADS_WASTE_TOOLS[0].handler({ view: 'stopped', market: 'FR' }, {} as never)) as { ok: boolean; data: any }
    expect(viaTool.ok).toBe(true)
    expect(byId(viaTool.data.rows).get('neg:n-fr-still').effect).toEqual(listed.get('neg:n-fr-still').effect)
  })

  it('the server orders the Stopped view: by what each stop saved across pages (too early last), by since; 400 another key', async () => {
    const ids = async (query: string) => ((await get('stopped', `${FR}&${query}`)).json().rows as Row[]).map((r) => r.id)
    expect([...await ids('sort=-saved&pageSize=2'), ...await ids('sort=-saved&pageSize=2&page=2')]).toEqual(['neg:n-fr-still', 'neg:n-fr-saved', 'kw:k-fr', 'neg:n-fr-early'])
    expect(await ids('sort=saved')).toEqual(['kw:k-fr', 'neg:n-fr-saved', 'neg:n-fr-still', 'neg:n-fr-early'])
    expect(await ids('sort=since')).toEqual(['neg:n-fr-saved', 'neg:n-fr-still', 'kw:k-fr', 'neg:n-fr-early'])
    // The default: the newest stop first.
    expect(await ids('')).toEqual(['neg:n-fr-early', 'kw:k-fr', 'neg:n-fr-saved', 'neg:n-fr-still'])
    expect((await get('stopped', `${FR}&sort=-spend`)).statusCode).toBe(400)
    // Claude's view stopped takes the same order.
    const { ADS_WASTE_TOOLS } = await import('../services/agents/tools/ads-waste.tools.js')
    const viaTool = await withWorkspace(business(A), () => ADS_WASTE_TOOLS[0].handler({ view: 'stopped', market: 'FR', sort: '-saved' }, {} as never)) as { ok: boolean; data: any }
    expect(viaTool.data.rows.map((r: Row) => r.id)).toEqual(['neg:n-fr-still', 'neg:n-fr-saved', 'kw:k-fr', 'neg:n-fr-early'])
  })

  it('a person without ad spend reads the verdict and its words, never the money', async () => {
    permissions = { isOwner: false, permissions: new Set(['ads.view']) }
    try {
      const vNoMoney = byId((await get('stopped', `${FR}&pageSize=200`)).json().rows).get('neg:n-fr-saved').effect
      expect(vNoMoney).toEqual({ since: ago(40).toISOString(), days: 40, verdict: 'SAVED', words: 'Spends less here in the 37 days since the stop' })
      // Never ordered by money: a money sort reads as the place.
      const where = ((await get('stopped', `${FR}&sort=-saved`)).json().rows as Row[]).map((r) => `${r.campaign.name} ${r.adGroup?.name ?? ''}`)
      expect(where).toEqual([...where].sort((a, b) => a.localeCompare(b)))
    } finally {
      permissions = { isOwner: true, permissions: new Set() }
    }
  })
})
