/**
 * Ads brain page A1 — the brain's read routes on a real PostgreSQL (PGlite), business profiles ON:
 *
 *   parity    every ads-brain view and every bid-brain view answers exactly what Claude's tool answers for the same
 *             arguments (both run services/advertising/brain/read-view.ts)
 *   errors    an unknown view 404 naming the views; a query the view does not take 400 in words; a refusal 400, or 404
 *             when it names something not in this business — another business's product reads as not found
 *   money     a person without ad-spend money gets the answer minus exactly the view's money keys; with it, everything
 *   cache     every answer is Cache-Control: no-store
 *
 * Values are made up (public repo).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../test-support/formula-database.js'
import { seedAdsFixture } from '../test-support/ads-fixtures.js'
import { withWorkspace } from '../lib/workspace-context.js'
import type { ResolvedPermissions } from '../lib/auth/rbac.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const A = 'a1_brain_routes_alpha'
const B = 'a1_brain_routes_beta'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const P = 'a1-jacket'
const OTHER = 'a1-other-business-jacket'
let app: FastifyInstance
let permissions: ResolvedPermissions = { isOwner: true, permissions: new Set() }

type Tool = { input: { parse: (v: unknown) => unknown }; handler: (args: unknown, ctx: never) => Promise<{ ok: boolean; data?: unknown; error?: string }> }
let adsBrainTool: Tool
let bidBrainTool: Tool

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const w of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [w])
  }
  await withWorkspace(business(A), async () => {
    const c = database.client as any
    await seedAdsFixture(c)
    await c.product.create({ data: { id: P, sku: 'A1-JACKET', name: 'Jacket', basePrice: '80.00', isParent: true } })
    await c.adProductAd.create({ data: { adGroupId: 'g-c-it', productId: P, sku: 'A1-JACKET', asin: 'A1TESTASIN' } })
    // One shadow decision of the bid brain on t-it: its bids and its why are ad-spend money.
    await c.bidBrainDecision.create({
      data: {
        runId: 'a1-run', mode: 'SHADOW', kind: 'change', marketplace: 'IT', campaignId: 'c-it', adGroupId: 'g-c-it', targetId: 't-it',
        action: 'write', layer: 'goal', currentCents: 45, decidedCents: 50, goalBidCents: 50, aim: '0.2000', bandLo: '0.1500', bandHi: '0.2500',
        expectedAcos: '0.1800', confidence: '0.5000', dataDay: new Date(Date.now() - 2 * 86_400_000), why: 'goal: a made-up why naming 50c',
      },
    })
  })
  await withWorkspace(business(B), async () => {
    await (database.client as any).product.create({ data: { id: OTHER, sku: 'A1-JACKET', name: 'Jacket', basePrice: '80.00', isParent: true } })
  })
  adsBrainTool = (await import('../services/agents/tools/ads-brain.tools.js')).ADS_BRAIN_TOOLS[0] as unknown as Tool
  bidBrainTool = (await import('../services/agents/tools/ads-bid-brain.tools.js')).ADS_BID_BRAIN_TOOLS[0] as unknown as Tool
  const { default: routes } = await import('./advertising-brain.routes.js')
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

const get = (url: string) => app.inject({ method: 'GET', url })
const qs = (args: Record<string, string>) => new URLSearchParams(args).toString()
/** Instants (decided now) and durations measured at the call differ between two reads by milliseconds; nothing else may. */
const steady = (value: unknown) => JSON.parse(JSON.stringify(value)
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<instant>')
  .replace(/"(ms|tookMs|durationMs)":\d+/g, '"$1":0'))
const viaTool = (tool: Tool, args: Record<string, string>) => withWorkspace(business(A), () => tool.handler(tool.input.parse(args), {} as never))

describe('GET /api/advertising/automation/brain/views/:view — the ads-brain tool\'s views', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['map', {}],
    ['map', { market: 'IT', productId: P }],
    ['map', { campaignId: 'c-it' }],
    ['clashes', { market: 'IT' }],
    ['clashes', { market: 'IT', productId: P }],
    ['setup', { market: 'IT' }],
    ['money', { market: 'IT' }],
    ['money', { market: 'IT', productId: P }],
    ['terms', { market: 'IT' }],
    ['state', { market: 'IT' }],
    ['state', { market: 'IT', productId: P }],
    ['hours', { market: 'IT', productId: P }],
    ['negatives', { market: 'IT' }],
    ['harvest', { market: 'IT' }],
    ['report', { market: 'IT' }],
    ['structure', { market: 'IT' }],
    ['bidding', { market: 'IT' }],
    ['retire', { market: 'IT' }],
    ['proof', { market: 'IT' }],
  ]
  it.each(cases)('%s %o answers what the tool answers', async (view, args) => {
    const route = await get(`/api/advertising/automation/brain/views/${view}?${qs(args)}`)
    const tool = await viaTool(adsBrainTool, { view, ...args })
    expect(tool.ok, tool.error).toBe(true)
    expect(route.statusCode, route.body).toBe(200)
    expect(route.headers['cache-control']).toBe('no-store')
    expect(steady(route.json())).toEqual(steady(tool.data))
  }, 60_000)

  it('every view of the tool has a route', () => {
    const views = (adsBrainTool.input as unknown as { shape: { view: { removeDefault: () => { options: string[] } } } }).shape.view.removeDefault().options
    expect(new Set(cases.map(([v]) => v))).toEqual(new Set(views))
  })

  it('an unknown view is a 404 naming the views; a query the view does not take is a 400 in words', async () => {
    const unknown = await get('/api/advertising/automation/brain/views/everything')
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json().views).toContain('map')
    expect(unknown.json().error).toMatch(/There is no view everything/)
    expect(unknown.headers['cache-control']).toBe('no-store')
    const badLimit = await get('/api/advertising/automation/brain/views/terms?market=IT&limit=0')
    expect(badLimit.statusCode).toBe(400)
    expect(badLimit.json().error).toMatch(/^limit: /)
    const badDay = await get('/api/advertising/automation/brain/views/report?market=IT&day=yesterday')
    expect(badDay.statusCode).toBe(400)
  })

  it('a refusal is a 400 in words; a product of another business reads as not found (404)', async () => {
    const noMarket = await get('/api/advertising/automation/brain/views/state')
    expect(noMarket.statusCode).toBe(400)
    expect(noMarket.json()).toEqual({ error: 'name the market (market), and optionally a productId: view state reads one market' })
    for (const view of ['map', 'state', 'money', 'hours', 'bidding']) {
      const other = await get(`/api/advertising/automation/brain/views/${view}?market=IT&productId=${OTHER}`)
      expect(other.statusCode, `${view}: ${other.body}`).toBe(404)
      expect(other.json().error).toMatch(/not found/)
    }
    expect((await get('/api/advertising/automation/brain/views/map?campaignId=no-such')).statusCode).toBe(404)
  })
})

describe('GET /api/advertising/automation/brain/bid-brain/:view — the bid-brain tool\'s views', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['why', { market: 'IT' }],
    ['why', { campaignId: 'c-it' }],
    ['what-if', { market: 'IT', targetAcosPct: '25' }],
    ['diff', { market: 'IT', days: '7' }],
    ['calibration', { market: 'IT' }],
    ['hour-factors', { market: 'IT' }],
    ['probes', { market: 'IT' }],
  ]
  it.each(cases)('%s %o answers what the tool answers', async (view, args) => {
    const route = await get(`/api/advertising/automation/brain/bid-brain/${view}?${qs(args)}`)
    const tool = await viaTool(bidBrainTool, { view, ...args })
    expect(tool.ok, tool.error).toBe(true)
    expect(route.statusCode, route.body).toBe(200)
    expect(route.headers['cache-control']).toBe('no-store')
    expect(steady(route.json())).toEqual(steady(tool.data))
  }, 60_000)

  it('the why view shows the decision; errors as the ads-brain views', async () => {
    const why = (await get('/api/advertising/automation/brain/bid-brain/why?market=IT')).json()
    expect(why.decisions).toMatchObject([{ targetId: 't-it', currentCents: 45, decidedCents: 50, why: 'goal: a made-up why naming 50c' }])
    expect((await get('/api/advertising/automation/brain/bid-brain/everything')).statusCode).toBe(404)
    expect((await get('/api/advertising/automation/brain/bid-brain/what-if?market=IT')).statusCode).toBe(400)
    expect((await get('/api/advertising/automation/brain/bid-brain/why?targetAcosPct=0')).statusCode).toBe(400)
    expect((await get('/api/advertising/automation/brain/bid-brain/why?campaignId=no-such')).statusCode).toBe(404)
    expect((await get('/api/advertising/automation/brain/bid-brain/why?targetId=no-such')).statusCode).toBe(404)
  })
})

describe('money', () => {
  it('a person without ad-spend money gets the answer minus exactly the money keys; with it, everything', async () => {
    const url = '/api/advertising/automation/brain/bid-brain/why?market=IT'
    const all = (await get(url)).json()
    const ownersMoney = (await get(`/api/advertising/automation/brain/views/money?market=IT&productId=${P}`)).json()
    permissions = { isOwner: false, permissions: new Set([FEATURES.adsView]) }
    try {
      const hidden = (await get(url)).json()
      const [shown] = hidden.decisions
      for (const key of ['currentCents', 'decidedCents', 'goalBidCents', 'aimPct', 'bandLoPct', 'bandHiPct', 'expectedAcosPct', 'why']) expect(shown, key).not.toHaveProperty(key)
      expect(shown).toMatchObject({ targetId: 't-it', action: 'write', layer: 'goal' })
      const { currentCents, decidedCents, goalBidCents, aimPct, bandLoPct, bandHiPct, expectedAcosPct, why, ...rest } = all.decisions[0]
      expect(shown).toEqual(rest)
      // The ads-brain views strip theirs: the money view's money keys.
      const money = (await get(`/api/advertising/automation/brain/views/money?market=IT&productId=${P}`)).json()
      expect(JSON.stringify(ownersMoney)).toMatch(/"money":/)
      expect(JSON.stringify(money)).not.toMatch(/"(money|portfolioCapCents|dailyBudgetCents|amountCents)":/)
      expect(money).toMatchObject({ view: 'money', scope: { productId: P, market: 'IT' } })
      permissions = { isOwner: false, permissions: new Set([FEATURES.adsView, FIELDS.financialsAdspendView]) }
      expect((await get(url)).json()).toEqual(all)
    } finally {
      permissions = { isOwner: true, permissions: new Set() }
    }
  })
})

describe('A2b — archived campaigns and decided requests, read side', () => {
  const HOUR = 3_600_000
  beforeAll(async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    await withWorkspace(business(A), async () => {
      const c = database.client as any
      // c-arch: the jacket's campaign, archived, still enrolled LIVE (as c-it); two Owner choices left on it.
      await c.campaign.create({ data: { id: 'c-arch', name: 'Italy archived', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-arch', dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), status: 'ARCHIVED', liveBidWritesEnabled: true } })
      await c.adGroup.create({ data: { id: 'g-c-arch', campaignId: 'c-arch', name: 'group arch' } })
      await c.adProductAd.create({ data: { adGroupId: 'g-c-arch', productId: P, sku: 'A1-JACKET' } })
      for (const campaignId of ['c-it', 'c-arch']) await c.bidBrainEnrollment.create({ data: { campaignId, marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:test' } })
      await c.adsBrainEnrollment.create({ data: { productId: P, marketplace: 'IT', enrolledBy: 'user:test', updatedBy: 'user:test' } })
      for (const key of ['budgets', 'state']) await c.adsBrainOverride.create({ data: { productId: P, marketplace: 'IT', scope: 'CAMPAIGN', campaignId: 'c-arch', kind: 'LEVEL', key, value: 'OBSERVE', by: 'user:owner' } })
      // The state brain's newest decisions: four requests it asked for, decided or not since.
      const run = await c.agentRun.create({ data: { agentKey: 'ads-brain', trigger: 'schedule' } })
      const ask = (id: string, status: string, expiresAt: Date) => c.agentApproval.create({ data: { id, agentRunId: run.id, toolName: 'pause-ads', riskTier: 'medium', args: {}, status, expiresAt, ...(status === 'executed' ? { decidedAt: new Date(), decidedBy: 'user:owner' } : {}) } })
      await ask('ap-done', 'executed', new Date(Date.now() + 24 * HOUR))
      await ask('ap-open', 'pending', new Date(Date.now() + 24 * HOUR))
      await ask('ap-late', 'pending', new Date(Date.now() - HOUR))
      await ask('ap-arch', 'executed', new Date(Date.now() + 24 * HOUR))
      const decided = (campaignId: string, approvalId: string, memory: boolean) => c.adsBrainStateDecision.create({
        data: {
          runId: 'a2b-run', mode: 'PROPOSE', kind: 'change', productId: P, marketplace: 'IT', campaignId, level: 'PROPOSE', action: 'pause', outcome: 'asked', cause: 'stock', status: 'ENABLED',
          approvalId, decisionHash: `h-${campaignId}`, why: 'made-up why', decision: { productId: P, name: campaignId, why: 'made-up why', ...(memory ? { memory: { pausedAt: new Date().toISOString(), causes: ['stock'], expectedEndAt: null } } : {}) },
        },
      })
      await decided('c-it', 'ap-done', false)
      await decided('c-off', 'ap-open', false)
      await decided('c-pin', 'ap-late', false)
      await decided('c-arch', 'ap-arch', true)
    })
  }, 60_000)

  it('the state view: waiting only while a person can decide; decided and archived apart, never waiting or paused by the brain', async () => {
    const state = (await get('/api/advertising/automation/brain/views/state?market=IT')).json()
    expect(state.waiting.map((w: { campaignId: string }) => w.campaignId)).toEqual(['c-off'])
    expect(state.waiting[0]).toMatchObject({ approvalId: 'ap-open', approvalStatus: 'pending' })
    expect(Object.fromEntries(state.decided.map((d: { campaignId: string; approvalStatus: string }) => [d.campaignId, d.approvalStatus]))).toEqual({ 'c-it': 'executed', 'c-pin': 'expired' })
    expect(state.archived).toEqual([expect.objectContaining({ campaignId: 'c-arch', approvalId: 'ap-arch', approvalStatus: 'executed', why: expect.stringMatching(/^archived since/) })])
    expect(state.pausedByTheBrain.map((p: { campaignId: string }) => p.campaignId)).not.toContain('c-arch')
    // The product's own view: its newest logged decision names its request's status.
    const product = (await get(`/api/advertising/automation/brain/views/state?market=IT&productId=${P}`)).json()
    expect(product.campaigns.find((c: { campaignId: string }) => c.campaignId === 'c-it').logged).toMatchObject({ approvalId: 'ap-done', approvalStatus: 'executed' })
  })

  it('the bid brain owns no archived campaign: its enrollment is said as left over', async () => {
    const why = (await get('/api/advertising/automation/brain/bid-brain/why?market=IT')).json()
    expect(why).toMatchObject({ owned: ['c-it'], ownedButArchived: ['c-arch'] })
    expect((await get('/api/advertising/automation/brain/bid-brain/diff?market=IT')).json()).toMatchObject({ owned: ['c-it'], ownedButArchived: ['c-arch'] })
    const one = (await get('/api/advertising/automation/brain/views/map?campaignId=c-arch')).json()
    expect(one.campaigns[0].levers.bids.writers.find((w: { kind: string }) => w.kind === 'brain')).toMatchObject({ state: 'off', why: expect.stringMatching(/^archived: its bid brain enrollment \(LIVE\) is left over/) })
    const market = (await get('/api/advertising/automation/brain/views/map?market=IT')).json()
    expect(market.ownedButArchived).toEqual([{ campaignId: 'c-arch', market: 'IT', mode: 'LIVE' }])
    expect(market.products.find((p: { productId: string }) => p.productId === P)?.liveCampaigns).toEqual(['c-it'])
    const setup = (await get('/api/advertising/automation/brain/views/setup?market=IT')).json()
    expect(setup.brain).toEqual(expect.arrayContaining([expect.objectContaining({ item: 'bid brain enrollments on archived campaigns', state: expect.stringContaining('c-arch') })]))
  })

  it('the Owner\'s choices on an archived campaign are said to have no effect', async () => {
    const map = (await get(`/api/advertising/automation/brain/views/map?market=IT&productId=${P}`)).json()
    expect(map.drift).toContain('2 Owner choices sit on 1 archived campaign (c-arch): no effect — nothing runs on an archived campaign')
    expect(map.drift.some((d: string) => d.includes('they still apply'))).toBe(false)
  })
})

describe('GET /api/advertising/automation/brain/switchboard (A3)', () => {
  it('what is on, never cached; a lock\'s money hidden without the ad-spend permission; another business\'s product not found', async () => {
    await withWorkspace(business(A), () => (database.client as any).adsBrainOverride.create({ data: { productId: P, marketplace: 'IT', scope: 'PRODUCT', kind: 'LOCK', key: 'budgets', value: { dailyBudgetCents: 2000 }, by: 'user:owner' } }))
    const res = await get('/api/advertising/automation/brain/switchboard?market=IT')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const all = res.json()
    expect(all).toMatchObject({ view: 'switchboard', scope: { market: 'IT' }, brain: { products: [{ productId: P, levers: { budgets: { effective: 'LOCKED', lock: { value: { dailyBudgetCents: 2000 } } } } }] } })
    expect(all.server.map((s: { name: string }) => s.name)).toContain('NEXUS_BID_BRAIN_MODE')
    permissions = { isOwner: false, permissions: new Set([FEATURES.adsView]) }
    try {
      const hidden = (await get('/api/advertising/automation/brain/switchboard?market=IT')).json()
      expect(hidden.brain.products[0].levers.budgets.lock.value).toEqual({})
      expect(hidden.brain.products[0].levers.budgets.acting).toEqual(all.brain.products[0].levers.budgets.acting)
    } finally {
      permissions = { isOwner: true, permissions: new Set() }
    }
    expect((await get(`/api/advertising/automation/brain/switchboard?productId=${OTHER}`)).statusCode).toBe(404)
    expect((await get('/api/advertising/automation/brain/switchboard?market=X')).statusCode).toBe(400)
  })
})
