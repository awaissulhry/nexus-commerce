/**
 * Negative Targeting page, Words view (step 4) — the WORDS block of /api/advertising/waste on PGlite
 * (production schema), business profiles ON, the permission manifest enforced (rbac-hook), the ads mode sandbox and the
 * job queue a stub (nothing leaves the process). Made-up ids, words and numbers.
 *
 *   words     one row per word (1 or 2 words next to each other) that 2 or more search terms hold: its terms counted once,
 *             its numbers their sums, its test per product (a product whose part is too small does not waste), its
 *             places (open, held with why — our keyword holding the word, a protected term —, blocked by a standing
 *             negative phrase, not wasting), its state; a 2-word piece its own word covers leaves the Wasting list
 *   ids       select all N that match: the same filters
 *   word      one word: every term holding it (its row id, where, product, numbers, sold), every place with its Nexus ids,
 *             each product's part, the negatives made of it
 *   block     POST /waste/preview with a word: one negative phrase per place (left out with why where it may not land);
 *             apply: one request; run, the negative phrase stands in the open place only; where=campaign reads campaigns
 *   scope     the filter-bar lists narrow the terms (and so the word); another business's id is a 404
 *   money     stripped without financials.adspend.view; never ordered by spend then
 *   MCP       ad-waste view words / word answers what the routes answer
 */
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../test-support/formula-database.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
})
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    readinessQueue: queue, agentPlanQueue: null, queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../lib/auth/audit.js', () => ({ writeAuthAudit: vi.fn(async () => undefined) }))
vi.mock('../services/outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

const A = 'words_waste_alpha'
const B = 'words_waste_beta'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(business(A), work)
const OWNER = [FEATURES.adsView, FEATURES.adsCampaignsManage, FEATURES.adsBidsEdit, FEATURES.adsAutomationManage, FIELDS.financialsAdspendView, FEATURES.aiRun, FEATURES.settingsSecurityManage]
let permissions = new Set<string>(OWNER)
let app: FastifyInstance
let userId = ''
const NOW = Date.now()
const DAY = 86_400_000
const dayAgo = (days: number) => new Date(Math.floor(NOW / DAY) * DAY - days * DAY)

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_RBAC_MODE', 'enforce')
  vi.stubEnv('NEXUS_WASTE_FACTS_TTL_MS', '0')
  for (const w of [A, B]) await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [w])
  userId = (await database.client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Wanda Words' } })).id
  await inA(async () => {
    const c = database.client as any
    const role = await c.role.create({ data: { key: `WRD_${randomUUID().slice(0, 8)}`, name: 'Ads owner', description: 'test', permissions: OWNER, isSystem: false } })
    await c.userRole.create({ data: { userId, roleId: role.id } })
    const membership = await c.workspaceMembership.create({ data: { workspaceId: A, userId, status: 'active' } })
    await c.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
    await c.adsAutomationState.create({ data: { id: 'singleton', autonomy: 'AUTO', defaultTargetAcosPct: 20 } })
    await c.amazonAdsConnection.create({ data: { profileId: 'P-IT-W', marketplace: 'IT', region: 'EU', mode: 'production', writesEnabledAt: new Date(), isActive: true } })
    await c.product.create({ data: { id: 'w-coat', sku: 'TST-COAT', name: 'Test coat', basePrice: '80.00', isParent: true } })
    await c.product.create({ data: { id: 'w-coat-m', sku: 'TST-COAT-M', name: 'Test coat M', basePrice: '80.00', parentId: 'w-coat' } })
    await c.product.create({ data: { id: 'w-boot', sku: 'TST-BOOT', name: 'Test boot', basePrice: '60.00' } })
    const campaign = (id: string) => c.campaign.create({
      data: { id, name: `Test ${id}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true },
    })
    const group = async (id: string, campaignId: string, product: string) => {
      await c.adGroup.create({ data: { id, campaignId, name: `group ${id}`, externalAdGroupId: `EXT-${id}` } })
      await c.adProductAd.create({ data: { adGroupId: id, productId: product, sku: `SKU-${id}`, asin: `B0WRD${id.replace(/[^a-z0-9]/gi, '').slice(-5).toUpperCase().padStart(5, '0')}`, externalAdId: `EXT-pa-${id}` } })
    }
    const keyword = (id: string, groupId: string, text: string, match = 'BROAD', extra: Record<string, unknown> = {}) => c.adTarget.create({
      data: { id, adGroupId: groupId, kind: 'KEYWORD', expressionType: match, expressionValue: text, bidCents: 40, externalTargetId: `EXT-${id}`, ...extra },
    })
    /** One search-term day (Amazon's EXTERNAL ids, as the report stores them). */
    const term = (campaignId: string, groupId: string, query: string, daysAgo: number, clicks: number, spendCents: number, orders = 0) => c.amazonAdsSearchTerm.create({
      data: {
        profileId: 'P-IT-W', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: dayAgo(daysAgo), campaignId: `EXT-${campaignId}`, adGroupId: `EXT-${groupId}`,
        matchType: 'BROAD', query, impressions: clicks * 20, clicks, costMicros: BigInt(spendCents) * 10_000n, currencyCode: 'EUR', orders7d: orders, sales7dCents: orders * 8000,
      },
    })

    // The coat: c-one (g-a, g-b) and c-two (g-c). A term that sells well gives the product its conversion rate.
    await campaign('c-one'); await campaign('c-two'); await campaign('c-boot')
    await group('g-a', 'c-one', 'w-coat-m'); await group('g-b', 'c-one', 'w-coat-m'); await group('g-c', 'c-two', 'w-coat-m')
    await group('g-d', 'c-boot', 'w-boot')
    await keyword('k-a', 'g-a', 'coat')
    await keyword('k-b', 'g-b', 'coat cheap') // our keyword holds "cheap": a negative phrase there would block it
    await term('c-one', 'g-a', 'warm parka', 15, 2000, 160_000, 160)
    // "cheap" in four places: no term alone passes the bar, together they do.
    await term('c-one', 'g-a', 'cheap coat', 10, 30, 1200)
    await term('c-one', 'g-a', 'cheap coat men', 20, 25, 1000)
    await term('c-one', 'g-b', 'coat cheap sale', 10, 20, 800)
    await term('c-two', 'g-c', 'cheap coat kids', 12, 5, 300)
    // g-c already holds the negative phrase "cheap" (a person made it).
    await c.adTarget.create({ data: { id: 'n-cheap', adGroupId: 'g-c', kind: 'KEYWORD', expressionType: 'NEGATIVE_PHRASE', expressionValue: 'cheap', isNegative: true, negativeLevel: 'AD_GROUP', bidCents: 0, externalTargetId: 'EXT-n-cheap', createdAt: dayAgo(40) } })
    await c.advertisingActionLog.create({ data: { userId: `user:${userId}`, actionType: 'create_negative_keyword', entityType: 'AD_TARGET', entityId: 'n-cheap', payloadBefore: {}, payloadAfter: { keywordText: 'cheap' }, amazonResponseStatus: 'SUCCESS', createdAt: dayAgo(40) } })
    // The boot's part of "cheap" is small: it does not waste for the boot.
    await term('c-boot', 'g-d', 'cheap boot', 10, 5, 200)
    await term('c-boot', 'g-d', 'cheap boot men', 11, 5, 200)
    // "rain" wastes, but a protected term holds it.
    await term('c-one', 'g-a', 'rain coat', 10, 30, 1500)
    await term('c-one', 'g-a', 'rain coat long', 20, 25, 1200)
    await c.adKeywordProtection.create({ data: { mode: 'WHITELIST', term: 'rain', matchType: 'EXACT' } })
    // "sale" sold once: not wasting.
    await term('c-one', 'g-a', 'coat sale', 10, 10, 500, 1)
    await term('c-one', 'g-a', 'sale coat', 20, 10, 500)
  })
  await withWorkspace(business(B), async () => {
    const c = database.client as any
    await c.campaign.create({ data: { id: 'b-camp', name: 'Other business', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-b-camp', dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z') } })
  })
  const { rbacHook } = await import('../lib/auth/rbac-hook.js')
  const { default: routes } = await import('./advertising-waste.routes.js')
  app = Fastify()
  app.addHook('onRequest', (request, _reply, done) => {
    const r = request as unknown as Record<string, unknown>
    r.__sessionLoaded = true
    r.authUser = { id: userId, email: 'wanda@example.test', displayName: 'Wanda Words' }
    r.__rbacResolved = { isOwner: false, permissions }
    r.workspace = business(A)
    withWorkspace(business(A), done)
  })
  app.addHook('preHandler', rbacHook)
  await app.register(routes, { prefix: '/api' })
  await app.ready()
}, 180_000)

beforeEach(() => { permissions = new Set(OWNER) })

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.close()
  await database?.close()
}, 30_000)

type Row = Record<string, any>
const get = (path: string, query = '') => app.inject({ method: 'GET', url: `/api/advertising/waste/${path}${query ? `?${query}` : ''}` })
const post = (path: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/advertising/waste${path}`, payload })
const words = async (query = 'market=IT&show=all&pageSize=200') => {
  const res = await get('words', query)
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}
const wordOf = (rows: Row[], w: string) => rows.find((r) => r.word === w)
const CHEAP = 'word:IT|cheap'

describe('GET /api/advertising/waste/words — one row per word that wastes across search terms', () => {
  it('counts the terms that hold the word (next to each other), sums their numbers, and judges it per product', async () => {
    const res = await get('words', 'market=IT')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const cheap = wordOf(res.json().rows, 'cheap')
    expect(cheap).toMatchObject({
      id: CHEAP, words: 1, market: 'IT', currency: 'EUR', terms: 6, sold: 0,
      d: { clicks: 90, orders: 0, spendCents: 3700 },
      places: { adGroups: 4, campaigns: 3, open: 1, blocked: 1 },
      products: 2, product: null, state: 'PARTLY_BLOCKED',
      verb: { action: 'NEGATE_PHRASE', where: 'adGroup', held: null, places: 1 },
      test: { met: true, windowDays: 60 },
      coveredBy: null,
    })
    expect(cheap.test.sentence).toMatch(/^TST-COAT: Wastes: 0 orders/)
    expect(cheap.test.sentence).toMatch(/2 products, each by its own bar/)
    // The state's sentence is true for the whole row: the part that wastes is the coat's, and the boot's is said too.
    expect(cheap.stateWhy).toBe('Wastes for TST-COAT: 4 terms in 3 ad groups, 0 orders; its other product does not waste (0 orders); a negative phrase blocks it in 1 of 4 ad groups.')
    expect(cheap.wastesFor).toMatchObject({ product: { id: 'w-coat' }, terms: 4, adGroups: 3, orders: 0, products: 1 })
    // No single term of it wastes on its own (the reason a word exists).
    const rows = (await (await get('rows', 'market=IT&show=all&kind=term&pageSize=200')).json()).rows as Row[]
    expect(rows.filter((r) => /cheap/.test(r.text) && r.test.met)).toEqual([])
  })

  it('a protected word reads PROTECTED (held with why); one that sold reads NOT_WASTING; a covered 2-word piece leaves the Wasting list', async () => {
    const all = (await words()).rows as Row[]
    expect(wordOf(all, 'rain')).toMatchObject({ state: 'PROTECTED', test: { met: true }, verb: { held: { label: 'Protected', reason: expect.stringMatching(/"rain" is a protected term/) }, places: 0 } })
    expect(wordOf(all, 'sale')).toMatchObject({ state: 'NOT_WASTING', sold: 1, test: { met: false }, verb: { held: { label: 'Not wasting' } }, wastesFor: null, stateWhy: 'Not wasting for TST-COAT: it sold (1 order).' })
    expect(wordOf(all, 'rain').stateWhy).toMatch(/"rain" is a protected term/)
    expect(wordOf(all, 'cheap coat')).toMatchObject({ coveredBy: 'cheap', terms: 3 })
    // Pairs are next to each other only; never across a word (no "cheap men").
    expect(wordOf(all, 'cheap men')).toBeUndefined()
    // One term holds "kids": not a word of its own.
    expect(wordOf(all, 'kids')).toBeUndefined()
    const wasting = (await words('market=IT')).rows.map((r: Row) => r.word)
    expect(wasting).toContain('cheap')
    expect(wasting).toContain('rain')
    expect(wasting).not.toContain('cheap coat')
    expect(wasting).not.toContain('sale')
  })

  it('the totals come from the same rows; show=blocked lists the blocked; ids answer the same filters; a bad query is a 400', async () => {
    const body = await words('market=IT')
    const all = (await words()).rows as Row[]
    expect(body.totals).toMatchObject({ wasting: body.total, all: all.length })
    const blocked = (await words('market=IT&show=blocked&pageSize=200')).rows.map((r: Row) => r.word)
    expect(blocked).toContain('cheap')
    expect(blocked).toContain('cheap coat')
    expect([...blocked].sort()).toEqual(all.filter((r) => r.places.blocked > 0).map((r) => r.word).sort())
    const ids = (await get('words/ids', 'market=IT')).json()
    expect(ids).toMatchObject({ total: body.total, truncated: false })
    expect(ids.ids).toEqual(body.rows.map((r: Row) => r.id))
    expect((await get('words', 'market=IT&show=nope')).statusCode).toBe(400)
    expect((await get('words', 'market=IT&sort=xCpa')).statusCode).toBe(400)
  })

  it('the filter bar narrows the terms, and so the word; another business\'s campaign is a 404', async () => {
    const one = wordOf((await words('market=IT&show=all&campaignIds=c-one')).rows, 'cheap')
    expect(one).toMatchObject({ terms: 3, places: { adGroups: 2, campaigns: 1, open: 1, blocked: 0 }, products: 1, product: { id: 'w-coat' }, state: 'WASTING' })
    expect((await get('words', 'market=IT&campaignIds=b-camp')).statusCode).toBe(404)
    // q: the word, or one of its terms (its campaign, ad group, product): the word's numbers stay whole.
    const q = (await words('market=IT&show=all&q=men')).rows as Row[]
    expect(wordOf(q, 'cheap')).toMatchObject({ terms: 6 })
    expect(wordOf(q, 'rain')).toBeUndefined()
  })
})

describe('GET /api/advertising/waste/word/:id — one word', () => {
  it('every term holding it, every place with why (and its Nexus ids), each product\'s part, the negatives made of it', async () => {
    const res = await get(`word/${encodeURIComponent(CHEAP)}`)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body.row.id).toBe(CHEAP)
    expect(body.terms.map((t: Row) => t.text).sort()).toEqual(['cheap boot', 'cheap boot men', 'cheap coat', 'cheap coat kids', 'cheap coat men', 'coat cheap sale'])
    expect(body.terms[0]).toMatchObject({ text: 'cheap coat', rowId: 'term:IT|EXT-g-a|cheap coat', campaign: { id: 'c-one' }, adGroup: { id: 'g-a' }, product: { id: 'w-coat' }, d: { clicks: 30, spendCents: 1200 }, sold: false, state: 'RUNNING' })
    expect(body.terms.find((t: Row) => t.text === 'cheap coat kids')).toMatchObject({ state: 'NEGATED' })
    const at = (id: string) => body.places.find((p: Row) => p.adGroupId === id)
    expect(at('g-a')).toMatchObject({ level: 'AD_GROUP', campaignId: 'c-one', state: 'OPEN', held: null, terms: 2, d: { spendCents: 2200 } })
    expect(at('g-b')).toMatchObject({ state: 'HELD', held: { label: 'Our keyword', reason: 'Our keyword "coat cheap" holds "cheap": a negative phrase here would block it.' } })
    expect(at('g-c')).toMatchObject({ state: 'BLOCKED', blockedBy: { rowId: 'neg:n-cheap', text: 'cheap', level: 'AD_GROUP' } })
    expect(at('g-d')).toMatchObject({ state: 'NOT_WASTING', held: { label: 'Not wasting' }, product: { id: 'w-boot' } })
    expect(body.products).toHaveLength(2)
    expect(body.products[0]).toMatchObject({ product: { id: 'w-coat' }, terms: 4, places: 3, test: { met: true } })
    expect(body.products[1]).toMatchObject({ product: { id: 'w-boot' }, terms: 2, test: { met: false } })
    expect(body.history).toEqual([expect.objectContaining({ action: 'negated', text: 'cheap', rowId: 'neg:n-cheap', adGroup: expect.objectContaining({ id: 'g-c' }) })])
  })

  it('a word that is not one is a 400; one no longer held by 2 terms under the filters is a 404', async () => {
    expect((await get('word/nope')).statusCode).toBe(400)
    expect((await get(`word/${encodeURIComponent('word:IT|kids')}`)).statusCode).toBe(404)
    expect((await get(`word/${encodeURIComponent(CHEAP)}`, 'campaignIds=c-two')).statusCode).toBe(404)
  })
})

describe('Block word — POST /waste/preview | apply: one negative phrase per place', () => {
  it('preview: the open place is a step of add-negative-targets; every other place is left out with why; nothing written', async () => {
    const res = await post('/preview', { items: [{ rowId: CHEAP, action: 'NEGATE_PHRASE', where: 'adGroup' }] })
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body.steps).toHaveLength(4)
    const at = (id: string) => body.steps.find((s: Row) => s.place.adGroup?.id === id)
    expect(at('g-a')).toMatchObject({ rowId: CHEAP, action: 'NEGATE_PHRASE', text: 'cheap', level: 'AD_GROUP', tool: 'add-negative-targets', refusal: null, from: 'RUNNING', to: 'NEGATED', lands: 'nexus', raise: false, final: false })
    expect(at('g-b')).toMatchObject({ refusal: { code: 'held', label: expect.stringMatching(/Our keyword "coat cheap" holds "cheap"/) }, tool: null })
    expect(at('g-c')).toMatchObject({ refusal: { code: 'already_blocked', label: expect.stringMatching(/negative phrase "cheap"/) } })
    expect(at('g-d')).toMatchObject({ refusal: { code: 'not_wasting' } })
    expect(body.blocked).toBe(3)
    // The place that gets the block comes first; the ones left out after it, each with a short reason.
    expect(body.steps.map((s: Row) => s.refusal?.code ?? null)).toEqual([null, ...body.steps.slice(1).map((s: Row) => s.refusal.code)])
    expect(body.steps[0].place.adGroup.id).toBe('g-a')
    expect(at('g-d').refusal.label).toMatch(/^Not wasting for TST-BOOT: 10 of \d+ clicks\.$/)
    expect(await inA(() => database.client.agentApproval.count())).toBe(0)
  })

  it('the whole campaign: one step per campaign; the lock reads every ad group of it', async () => {
    const body = (await post('/preview', { items: [{ rowId: CHEAP, action: 'NEGATE_PHRASE', where: 'campaign' }] })).json()
    const at = (id: string) => body.steps.find((s: Row) => s.place.campaign?.id === id)
    expect(body.steps).toHaveLength(3)
    // c-one holds our keyword "coat cheap" in g-b: a campaign negative would block it.
    expect(at('c-one')).toMatchObject({ level: 'CAMPAIGN', place: { adGroup: null }, refusal: { code: 'held' } })
    // c-two: the standing negative is its ad group's, not the campaign's — the campaign negative may land.
    expect(at('c-two')).toMatchObject({ level: 'CAMPAIGN', refusal: null, tool: 'add-negative-targets' })
    expect(at('c-boot')).toMatchObject({ refusal: { code: 'not_wasting' } })
  })

  it('a word only blocks as a negative phrase; one under other filters is the read\'s 404 in words', async () => {
    const body = (await post('/preview', { items: [
      { rowId: CHEAP, action: 'NEGATE_EXACT' },
      { rowId: 'word:IT|rain', action: 'NEGATE_PHRASE', scope: { campaignIds: 'c-two' } },
    ] })).json()
    expect(body.steps[0]).toMatchObject({ refusal: { code: 'wrong_verb' } })
    expect(body.steps[1]).toMatchObject({ refusal: { code: 'not_found' } })
  })

  it('apply: one request (the tool itself for one place), approved by the person; run, the negative phrase stands in the open place only', async () => {
    const items = [{ rowId: CHEAP, action: 'NEGATE_PHRASE', where: 'adGroup' }]
    const { planHash } = (await post('/preview', { items })).json()
    const res = await post('/apply', { items, planHash })
    expect(res.statusCode, res.body).toBe(202)
    const body = res.json()
    expect(body).toMatchObject({ status: 'queued', tool: 'add-negative-targets', approve: { ok: true }, blocked: 3 })
    const { commitScheduledApproval } = await import('../services/agent-fleet/approval-inbox.service.js')
    await inA(() => database.client.agentApproval.update({ where: { id: body.changeSetId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
    expect(await inA(() => commitScheduledApproval(body.changeSetId))).toMatchObject({ ok: true })
    const made = await inA(() => database.client.adTarget.findMany({ where: { isNegative: true, expressionValue: 'cheap' }, orderBy: { adGroupId: 'asc' } }))
    expect(made.map((n) => [n.adGroupId, n.expressionType, n.negativeLevel])).toEqual([['g-a', 'NEGATIVE_PHRASE', 'AD_GROUP'], ['g-c', 'NEGATIVE_PHRASE', 'AD_GROUP']])
    // The word now reads blocked in that place too; a second Block word has nothing to send there.
    const cheap = wordOf((await words()).rows, 'cheap')
    expect(cheap).toMatchObject({ places: { blocked: 2, open: 0 }, state: 'PARTLY_BLOCKED' })
    const again = (await post('/preview', { items })).json()
    expect(again.steps.filter((s: Row) => !s.refusal)).toEqual([])
  })
})

describe('money and MCP', () => {
  it('a person without ad spend gets the words minus the money keys, never ordered by spend', async () => {
    permissions = new Set(OWNER.filter((p) => p !== FIELDS.financialsAdspendView))
    const body = (await get('words', 'market=IT&show=all&pageSize=200&sort=-spend')).json()
    const cheap = wordOf(body.rows, 'cheap')
    expect(cheap.d).toEqual({ impressions: 1800, clicks: 90, orders: 0 })
    expect(cheap.test.spendBarCents).toBeUndefined()
    const terms = body.rows.map((r: Row) => r.terms)
    expect(terms).toEqual([...terms].sort((a: number, b: number) => b - a))
    const detail = (await get(`word/${encodeURIComponent(CHEAP)}`)).json()
    expect(detail.terms[0].d.spendCents).toBeUndefined()
    expect(detail.places[0].d.spendCents).toBeUndefined()
    permissions = new Set()
    expect((await get('words', 'market=IT')).statusCode).toBe(403)
  })

  it('ad-waste view words and word answer what the routes answer', async () => {
    const { ADS_WASTE_TOOLS } = await import('../services/agents/tools/ads-waste.tools.js')
    const tool = ADS_WASTE_TOOLS[0]
    const list = await inA(() => tool.handler({ view: 'words', market: 'IT', show: 'all', pageSize: 200 }, { can: () => true } as never)) as Row
    expect(list.ok).toBe(true)
    expect(list.data.rows.map((r: Row) => r.id)).toEqual((await words()).rows.map((r: Row) => r.id))
    const one = await inA(() => tool.handler({ view: 'word', wordId: CHEAP }, { can: () => true } as never)) as Row
    expect(one.data.places.map((p: Row) => [p.adGroupId, p.state])).toEqual((await get(`word/${encodeURIComponent(CHEAP)}`)).json().places.map((p: Row) => [p.adGroupId, p.state]))
    expect(await inA(() => tool.handler({ view: 'word' }, { can: () => true } as never))).toMatchObject({ ok: false })
    expect(await inA(() => tool.handler({ view: 'words', market: 'IT', show: 'kept' }, { can: () => true } as never))).toMatchObject({ ok: false })
  })
})
