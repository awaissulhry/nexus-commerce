/**
 * 1e (CM-10) — the other paths a person drives straight from a screen pass the account halt and autonomy OFF; the
 * same write from an engine, a rule or a Claude request does not.
 *
 * Each person path is driven through its REAL route (so the test proves the route marks the click), the queued ones
 * through the real worker; each engine counterpart calls the same service the way an engine does. Covered: adding a
 * keyword, product target, ad group or product ad; adding an ad-group negative
 * keyword or negative ASIN; the change log's Undo button; the Budget Manager control plane (budget, restore, bid,
 * placement). The bulk sheet upload is in workers/ads-manual-control.vitest.test.ts.
 *
 * PGlite with the production schema and the real advertising routes. The gate is a stand-in that answers as a HALTED
 * gate does (a suppression or a person's own edit passes, everything else is refused); the real gate's own arms are in
 * ads-write-gate-bounds. Amazon is a recorder; nothing leaves the process.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import type { GateContext, GateDecision } from '../services/advertising/ads-write-gate.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../services/outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: null,
  }
})
vi.mock('../services/advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))
const gate = vi.hoisted(() => ({ seen: [] as GateContext[] }))
vi.mock('../services/advertising/ads-write-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/advertising/ads-write-gate.js')>()),
  checkAdsWriteGate: async (ctx: GateContext): Promise<GateDecision> => {
    gate.seen.push(ctx)
    return ctx.isSuppression || ctx.manual
      ? { allowed: true, mode: 'live', profileId: 'P-IT-TEST' }
      : { allowed: false, deniedAt: 'automation_halted', reason: 'ads automation is stopped (halted: test)' }
  },
  logGateDeny: () => undefined,
  recordSuccessfulWrite: async () => undefined,
  recordCampaignLiveWrite: async () => undefined,
}))
const amazon = vi.hoisted(() => ({ calls: [] as string[], seq: 0 }))
vi.mock('../services/advertising/ads-api-client.js', () => {
  const update = async (_ctx: unknown, externalId: string) => { amazon.calls.push(`update ${externalId}`); return { ok: true, mode: 'live', rawResponse: {} } }
  const create = (what: string) => async () => {
    amazon.calls.push(`create ${what}`)
    return { ok: true, mode: 'live', externalId: `EXT-NEW-${++amazon.seq}`, rawResponse: {} }
  }
  const listCampaignsV3 = async (_ctx: unknown, q: { campaignIds: string[] }) =>
    q.campaignIds.map((campaignId) => ({ campaignId, dynamicBidding: { strategy: 'LEGACY_FOR_SALES', placementBidding: [] } }))
  return {
    adsMode: () => 'live',
    updateCampaign: update, updateAdGroup: update, updateTarget: update, updateProductAd: update, updatePortfolio: update,
    listCampaignsV3,
    createKeyword: create('keyword'), createTarget: create('target'), createAdGroup: create('ad group'), createProductAd: create('product ad'),
    createNegativeKeyword: create('negative keyword'), createNegativeProductTarget: create('negative product target'),
  }
})

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const ENGINE = 'automation:rule-test' as const
let app: FastifyInstance

const { drainAdsSyncOnce } = await import('../workers/ads-sync.worker.js')
const svc = await import('../services/advertising/ads-create.service.js')
const neg = await import('../services/advertising/ads-negative-kw.service.js')
const { updateAdTargetWithSync } = await import('../services/advertising/ads-mutation.service.js')
const { rollbackByActionLogId } = await import('../services/advertising/rollback.service.js')
const { suppressCampaignBids, restoreCampaignBids } = await import('../services/advertising/ads-bid-suppression.service.js')

/** The control plane queues with the 5-minute grace hold (a cancel window, not part of this subject): end it now. */
const endGraceHolds = () => inside(() => database.client.outboundSyncQueue.updateMany({
  where: { syncStatus: 'PENDING' }, data: { holdUntil: new Date(Date.now() - 1_000) },
}))

async function drain() {
  gate.seen = []
  const out = await inside(() => drainAdsSyncOnce(50))
  const rows = await inside(() => database.client.outboundSyncQueue.findMany({
    where: { id: { in: out.results.map((r) => r.queueId) } },
    select: { id: true, syncStatus: true, errorMessage: true },
  }))
  return { rows, manual: gate.seen.map((c) => c.manual === true) }
}
const post = async (url: string, payload: object = {}) => {
  gate.seen = []
  const res = await app.inject({ method: 'POST', url: `/api${url}`, payload })
  return { status: res.statusCode, body: res.json() as Record<string, unknown>, manual: gate.seen.map((c) => c.manual === true) }
}

async function seedCampaign(id: string) {
  const db = database.client
  await inside(async () => {
    await db.campaign.create({
      data: {
        id, name: id, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`,
        dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true,
      } as never,
    })
    await db.adGroup.create({ data: { id: `${id}-g`, campaignId: id, name: `${id}-g`, externalAdGroupId: `EXT-${id}-g`, defaultBidCents: 40 } as never })
    for (const [n, bid] of [['t1', 35], ['t2', 60]] as const) {
      await db.adTarget.create({
        data: { id: `${id}-${n}`, adGroupId: `${id}-g`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `kw ${id} ${n}`, bidCents: bid, externalTargetId: `EXT-${id}-${n}` } as never,
      })
    }
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  const { default: advertisingRoutes } = await import('./advertising.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
  for (const id of ['add-c', 'neg-c', 'undo-c', 'cp-c', 'cp2-c', 'pre-c']) await seedCampaign(id)
  await inside(() => database.client.amazonAdsConnection.create({
    data: { profileId: 'P-IT-TEST', marketplace: 'IT', region: 'EU', mode: 'production', isActive: true, writesEnabledAt: new Date() } as never,
  }))
}, 180_000)
afterAll(async () => { await app?.close(); await database?.close() })
beforeEach(() => { gate.seen = []; amazon.calls = [] })

describe('adds from the campaign manager, while the account is halted', () => {
  it('his keyword, product target, ad group and product ad are created on Amazon (each route marks his click)', async () => {
    const kw = await post('/advertising/keywords/create', { adGroupId: 'add-c-g', keywordText: 'giacca test', matchType: 'EXACT', bidEur: 0.4 })
    expect([kw.status, kw.manual]).toEqual([200, [true]])
    expect(kw.body.externalTargetId).toMatch(/^EXT-NEW-/)

    const pt = await post('/advertising/targets/create', { adGroupId: 'add-c-g', kind: 'PRODUCT', value: 'B0TESTASN1', bidEur: 0.4 })
    expect([pt.status, pt.manual]).toEqual([200, [true]])
    expect(pt.body.externalTargetId).toMatch(/^EXT-NEW-/)

    const ag = await post('/advertising/adgroups/create', { campaignId: 'add-c', name: 'his new group', defaultBidEur: 0.3 })
    expect([ag.status, ag.manual]).toEqual([200, [true]])
    expect(ag.body.externalAdGroupId).toMatch(/^EXT-NEW-/)

    const ad = await post('/advertising/product-ads/create', { adGroupId: 'add-c-g', sku: 'SKU-TEST-1' })
    expect([ad.status, ad.manual]).toEqual([200, [true]])
    expect(ad.body.externalAdId).toMatch(/^EXT-NEW-/)
  })

  it('the same adds from an engine or rule are refused by the halt (and say so)', async () => {
    gate.seen = []
    const kw = await inside(() => svc.createKeywordLocal({ adGroupId: 'add-c-g', keywordText: 'giacca engine', matchType: 'EXACT', bidEur: 0.4, userId: ENGINE, manual: true }))
    expect(kw.externalTargetId).toBeNull()
    expect(kw.denied?.deniedAt).toBe('automation_halted')
    const pt = await inside(() => svc.createTargetLocal({ adGroupId: 'add-c-g', kind: 'PRODUCT', value: 'B0TESTASN2', bidEur: 0.4 }))
    expect(pt.externalTargetId).toBeNull()
    const ag = await inside(() => svc.createAdGroupLocal({ campaignId: 'add-c', name: 'engine group', defaultBidEur: 0.3, userId: ENGINE }))
    expect(ag.externalAdGroupId).toBeNull()
    const ad = await inside(() => svc.createProductAdLocal({ adGroupId: 'add-c-g', sku: 'SKU-TEST-2' }))
    expect(ad.externalAdId).toBeNull()
    expect(gate.seen.map((c) => c.manual === true)).toEqual([false, false, false, false])
    expect(amazon.calls).toEqual([])
  })
})

describe('negatives from the campaign manager, while the account is halted', () => {
  it('his ad-group negative keyword and negative ASIN reach Amazon', async () => {
    const kw = await post('/advertising/negative-keywords', {
      externalCampaignId: 'EXT-neg-c', externalAdGroupId: 'EXT-neg-c-g', keywordText: 'gratis', matchType: 'NEGATIVE_EXACT', scope: 'AD_GROUP', marketplace: 'IT',
    })
    expect([kw.status, kw.manual]).toEqual([200, [true]])
    expect(kw.body.ok).toBe(true)

    const asin = await post('/advertising/negative-targets/create', { adGroupId: 'neg-c-g', asin: 'B0NEGTEST1' })
    expect([asin.status, asin.manual]).toEqual([200, [true]])
    expect(asin.body.externalTargetId).toMatch(/^EXT-NEW-/)
  })

  it('a rule\'s negative is refused by the halt, and nothing is recorded', async () => {
    gate.seen = []
    const kw = await inside(() => neg.writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'neg-c-g', keywordText: 'usato', matchType: 'EXACT', userId: ENGINE, manual: true }))
    expect(kw.outcome).toBe('refused')
    expect(kw.refusal?.deniedAt).toBe('automation_halted')
    const asin = await inside(() => neg.writeNegativeProductTarget({ adGroupId: 'neg-c-g', asin: 'B0NEGTEST2', userId: ENGINE }))
    expect(asin.outcome).toBe('refused')
    expect(gate.seen.map((c) => c.manual === true)).toEqual([false, false])
  })
})

describe('W1-7 — a negative ASIN of a product his ads strategy protects (3A: his own setting warns, never blocks)', () => {
  it('his add from the screen answers 409 with the warning and writes nothing; his "Send anyway" reaches Amazon', async () => {
    await inside(async () => {
      const own = await database.client.product.create({ data: { sku: 'NEG-PROT-1', name: 'Test protected', basePrice: '10.00', amazonAsin: 'B0NEGPROT1' } })
      await database.client.adsStrategy.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: own.id, label: 'NEG-PROT-1 (IT)', protect: true, updatedBy: 'user:test' } })
    })
    const before = amazon.calls.length
    const waits = await post('/advertising/negative-targets/create', { adGroupId: 'neg-c-g', asin: 'B0NEGPROT1' })
    expect(waits.status).toBe(409)
    expect(waits.body).toMatchObject({ id: null, needsConfirmation: { limits: [{ limit: 'product_protected' }] }, error: expect.stringMatching(/^This goes past a product your ads strategy protects: "B0NEGPROT1" is the ASIN of NEG-PROT-1/) })
    expect(amazon.calls.length).toBe(before)
    const sent = await post('/advertising/negative-targets/create', { adGroupId: 'neg-c-g', asin: 'B0NEGPROT1', confirmOwnLimits: true })
    expect([sent.status, sent.manual]).toEqual([200, [true]])
    expect(sent.body.externalTargetId).toMatch(/^EXT-NEW-/)
    // An engine's same negative is refused before it reaches the gate.
    const engine = await inside(() => neg.writeNegativeProductTarget({ adGroupId: 'neg-c-g', asin: 'B0NEGPROT1', userId: ENGINE, confirmOwnLimits: true }))
    expect(engine).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'product_protected' } })
  })
})

describe('the Undo button, while the account is halted', () => {
  it('his Undo reaches Amazon; the same reversal from an engine or a Claude request is refused', async () => {
    // Two edits that landed before the halt (a person's, applied now): one to undo by the button, one by a request.
    const a = await inside(() => updateAdTargetWithSync({ adTargetId: 'undo-c-t1', patch: { bidCents: 50 }, actor: 'user:owner-test', applyImmediately: true, manual: true }))
    const b = await inside(() => updateAdTargetWithSync({ adTargetId: 'undo-c-t2', patch: { bidCents: 70 }, actor: 'user:owner-test', applyImmediately: true, manual: true }))
    expect((await drain()).manual).toEqual([true, true])

    const undo = await post(`/advertising/changes/${a.actionLogId}/undo`)
    expect(undo.status).toBe(200)
    expect(undo.body.reversed).toBe(1)
    const byButton = await drain()
    expect(byButton.manual).toEqual([true])
    expect(byButton.rows[0]!.syncStatus).toBe('SUCCESS')

    const byRequest = await inside(() => rollbackByActionLogId({ actionLogId: b.actionLogId!, actor: 'user:owner-test', reason: 'Claude request' }))
    expect(byRequest.reversed).toBe(1) // queued — the gate decides at dispatch
    const refused = await drain()
    expect(refused.manual).toEqual([false])
    expect(refused.rows[0]!.syncStatus).toBe('SKIPPED')
    expect(refused.rows[0]!.errorMessage).toContain('automation_halted')
  })
})

describe('the Budget Manager control plane, while the account is halted', () => {
  it('his committed budget, bid, placement and Restore reach Amazon', async () => {
    await inside(() => suppressCampaignBids('cp-c', { actor: ENGINE, reason: 'test: night floor' }))
    await drain() // the floor is a suppression: it lands while halted
    const commit = await post('/advertising/budget-manager/scenario/commit', {
      changes: [
        { entityType: 'campaign', entityId: 'cp-c', kind: 'budget', budgetCents: 2100 },
        { entityType: 'campaign', entityId: 'cp-c', kind: 'restore' },
        { entityType: 'campaign', entityId: 'cp-c', kind: 'placement', placements: { tos: 30 } },
      ],
    })
    expect(commit.status).toBe(200)
    expect(commit.body).toMatchObject({ ok: true, applied: 3 })
    // the budget asks the gate before writing (3A: past his own limits it would wait for "Send anyway"), and the
    // placement goes inline — both as his
    expect(commit.manual).toEqual([true, true])
    await endGraceHolds()
    const queued = await drain()
    expect(queued.manual).toEqual([true, true, true, true]) // budget + the restore of the ad group and both keywords
    expect(queued.rows.every((r) => r.syncStatus === 'SUCCESS')).toBe(true)
    const t1 = await inside(() => database.client.adTarget.findUniqueOrThrow({ where: { id: 'cp-c-t1' }, select: { bidCents: true } }))
    expect(t1.bidCents).toBe(35)

    const bid = await post('/advertising/budget-manager/scenario/commit', { changes: [{ entityType: 'target', entityId: 'cp-c-t2', kind: 'targetBid', bidCents: 2 }] })
    expect(bid.body).toMatchObject({ ok: true, applied: 1 })
    await endGraceHolds()
    const bidRow = await drain()
    expect(bidRow.manual).toEqual([true])
    expect(bidRow.rows[0]!.syncStatus).toBe('SUCCESS')
  })

  it('an engine\'s restore still waits for Resume (Owner decision S1)', async () => {
    await inside(() => suppressCampaignBids('cp2-c', { actor: ENGINE, reason: 'test: night floor' }))
    await drain()
    await inside(() => restoreCampaignBids('cp2-c', { actor: ENGINE, reason: 'test: engine restore' }))
    const { manual, rows } = await drain()
    expect(manual).toEqual([false, false, false])
    expect(rows.every((r) => r.syncStatus === 'SKIPPED')).toBe(true)
  })
})

describe('the screen pre-check (CM-10, #365) agrees with dispatch, while the account is halted', () => {
  const patch = async (url: string, payload: object) => {
    gate.seen = []
    const res = await app.inject({ method: 'PATCH', url: `/api${url}`, payload })
    return { status: res.statusCode, body: res.json() as Record<string, unknown>, manual: gate.seen.map((c) => c.manual === true) }
  }

  it('his bid, budget, ad-group bid and product-ad edits pass the pre-check AND dispatch', async () => {
    const bid = await patch('/advertising/ad-targets/pre-c-t1', { bidCents: 2, applyImmediately: true })
    expect(bid.status).toBe(200)
    expect(bid.body).toMatchObject({ ok: true, error: null })
    expect(bid.manual).toEqual([true]) // the pre-check asked the gate as a person
    const budget = await patch('/advertising/campaigns/pre-c', { dailyBudget: 22, applyImmediately: true })
    expect([budget.body.ok, budget.manual]).toEqual([true, [true]])
    const group = await patch('/advertising/ad-groups/pre-c-g', { defaultBidCents: 30, applyImmediately: true })
    expect([group.body.ok, group.manual]).toEqual([true, [true]])
    const { rows, manual } = await drain()
    expect(manual).toEqual([true, true, true])
    expect(rows.every((r) => r.syncStatus === 'SUCCESS')).toBe(true)
  })

  it('without the person mark the same pre-check refuses at once, in the gate\'s words, and writes nothing', async () => {
    gate.seen = []
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 'pre-c-t2', patch: { bidCents: 40 }, actor: 'user:owner-test', askGate: true }))
    expect(r.ok).toBe(false)
    expect(r.error).toBe('Not sent to Amazon: ads automation is stopped (halted: test)')
    expect(gate.seen.map((c) => c.manual === true)).toEqual([false])
    const t2 = await inside(() => database.client.adTarget.findUniqueOrThrow({ where: { id: 'pre-c-t2' }, select: { bidCents: true } }))
    expect(t2.bidCents).toBe(60)
  })
})
