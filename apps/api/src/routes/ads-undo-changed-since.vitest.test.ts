/**
 * Editing correctness, group 3 ("one save line for every grid") — a person's ads edit never overwrites a newer one.
 *
 *   1. A person's Undo (the change feed, the Bid page, the batch Undo after Change bid) puts the old value back only
 *      while the change still stands: a later engine, brain or person write of the same field, or a value that moved
 *      with no record, refuses it with "Changed since: now …" and writes nothing. Per row of a batch or a change set:
 *      the others are still put back. A later write of ANOTHER field (a pause after a bid) does not hold it back.
 *   2. The Ad Manager's bulk budget sends the budget it showed (`expectedDailyBudget`): a budget moved since (a budget
 *      schedule, an engine) refuses that campaign, 409, nothing written.
 *   3. The ad-group page reads past the API's read cache after its own save (`fresh=1`).
 *
 * PGlite with the production schema and the real advertising routes (as ads-manual-routes.vitest.test.ts). The gate
 * lets every write through (what is checked here is Nexus's own compare-and-set, not the gate); Amazon is a recorder.
 * Every id and name is made up.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import type { GateDecision } from '../services/advertising/ads-write-gate.js'

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
const cache = vi.hoisted(() => ({ reads: [] as Array<{ key: string; refresh: boolean }> }))
vi.mock('../services/advertising/ads-cache.js', () => ({
  cached: async (key: string, _ttl: number, work: () => Promise<unknown>, opts: { refresh?: boolean } = {}) => {
    cache.reads.push({ key, refresh: opts.refresh === true })
    return work()
  },
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))
vi.mock('../services/advertising/ads-write-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/advertising/ads-write-gate.js')>()),
  checkAdsWriteGate: async (): Promise<GateDecision> => ({ allowed: true, mode: 'live', profileId: 'P-IT-TEST' }),
  logGateDeny: () => undefined,
  recordSuccessfulWrite: async () => undefined,
  recordCampaignLiveWrite: async () => undefined,
}))
vi.mock('../services/advertising/ads-api-client.js', () => {
  const update = async () => ({ ok: true, mode: 'live', rawResponse: {} })
  const listCampaignsV3 = async (_ctx: unknown, q: { campaignIds: string[] }) =>
    q.campaignIds.map((campaignId) => ({ campaignId, dynamicBidding: { strategy: 'LEGACY_FOR_SALES', placementBidding: [] } }))
  return { adsMode: () => 'live', updateCampaign: update, updateAdGroup: update, updateTarget: update, updateProductAd: update, updatePortfolio: update, listCampaignsV3 }
})

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const ENGINE = 'automation:rank-defend-test' as const
let app: FastifyInstance

const { updateAdTargetWithSync, updateCampaignWithSync } = await import('../services/advertising/ads-mutation.service.js')

const send = async (method: 'POST' | 'PATCH' | 'GET', url: string, payload?: object) => {
  const res = await app.inject({ method, url: `/api${url}`, ...(payload ? { payload } : {}) })
  return { status: res.statusCode, body: res.json() as Record<string, unknown> }
}
const undo = (actionLogId: string) => send('POST', `/advertising/changes/${actionLogId}/undo`, {})
const bidOf = async (id: string) => (await inside(() => database.client.adTarget.findUniqueOrThrow({ where: { id }, select: { bidCents: true, status: true } })))
const logOf = async (id: string) => inside(() => database.client.advertisingActionLog.findUniqueOrThrow({ where: { id }, select: { rolledBackAt: true } }))

async function seedCampaign(id: string, targets: Array<[string, number]> = [['t1', 35], ['t2', 60]]) {
  const db = database.client
  await inside(async () => {
    await db.campaign.create({
      data: {
        id, name: `Test campaign ${id}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${id}`,
        dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true,
      } as never,
    })
    await db.adGroup.create({ data: { id: `${id}-g`, campaignId: id, name: `${id}-g`, externalAdGroupId: `EXT-${id}-g`, defaultBidCents: 40 } as never })
    for (const [n, bid] of targets) {
      await db.adTarget.create({
        data: { id: `${id}-${n}`, adGroupId: `${id}-g`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `test kw ${id} ${n}`, bidCents: bid, externalTargetId: `EXT-${id}-${n}` } as never,
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
  for (const id of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'b1', 'b2']) await seedCampaign(id)
}, 180_000)
afterAll(async () => { await app?.close(); await database?.close() })
beforeEach(() => { cache.reads = [] })

describe('1 — a person\'s Undo never puts an old value over a newer write', () => {
  it('a later engine write of the bid: refused, 409 "Changed since: now <bid>", nothing written, not marked undone', async () => {
    const mine = await send('PATCH', '/advertising/ad-targets/u1-t1', { bidCents: 50, applyImmediately: true })
    expect(mine.body).toMatchObject({ ok: true })
    const engine = await inside(() => updateAdTargetWithSync({ adTargetId: 'u1-t1', patch: { bidCents: 55 }, actor: ENGINE, applyImmediately: true }))
    expect(engine.ok).toBe(true)
    const now = (await bidOf('u1-t1')).bidCents
    expect(now).not.toBe(50)

    const r = await undo(String(mine.body.actionLogId))
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ ok: false, reversed: 0, changedSince: 1 })
    expect(String(r.body.reason)).toBe(`Changed since: now bid €${(now / 100).toFixed(2)}. Undo would overwrite that newer change, so nothing was put back.`)
    expect((await bidOf('u1-t1')).bidCents).toBe(now) // the engine's bid stands
    expect((await logOf(String(mine.body.actionLogId))).rolledBackAt).toBeNull()
  })

  it('a change that still stands is put back as before', async () => {
    const mine = await send('PATCH', '/advertising/ad-targets/u2-t1', { bidCents: 50, applyImmediately: true })
    const r = await undo(String(mine.body.actionLogId))
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, reversed: 1 })
    expect(r.body.changedSince).toBeUndefined()
    expect((await bidOf('u2-t1')).bidCents).toBe(35)
  })

  it('a later write of another field (a pause) does not hold back the Undo of the bid; the pause stays', async () => {
    const mine = await send('PATCH', '/advertising/ad-targets/u3-t1', { bidCents: 50, applyImmediately: true })
    await send('PATCH', '/advertising/ad-targets/u3-t1', { status: 'PAUSED', applyImmediately: true })
    const r = await undo(String(mine.body.actionLogId))
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, reversed: 1 })
    expect(await bidOf('u3-t1')).toEqual({ bidCents: 35, status: 'PAUSED' })
  })

  it('a value that moved with no record (an Amazon read) refuses it too', async () => {
    const mine = await send('PATCH', '/advertising/ad-targets/u4-t1', { bidCents: 50, applyImmediately: true })
    await inside(() => database.client.adTarget.update({ where: { id: 'u4-t1' }, data: { bidCents: 70 } }))
    const r = await undo(String(mine.body.actionLogId))
    expect(r.status).toBe(409)
    expect(String(r.body.reason)).toMatch(/^Changed since: now bid €0\.70\./)
    expect((await bidOf('u4-t1')).bidCents).toBe(70)
  })

  it('the batch Undo after Change bid (bulk-bid, one Undo per row): the row changed since is refused, the other is put back', async () => {
    const sent = await send('POST', '/advertising/ad-targets/bulk-bid', {
      entries: [{ adTargetId: 'b1-t1', bidCents: 45 }, { adTargetId: 'b1-t2', bidCents: 70 }], reason: 'Bid page: change bid', applyImmediately: true,
    })
    const ids = (sent.body.outcomes as Array<{ actionLogId: string }>).map((o) => o.actionLogId)
    expect(ids).toHaveLength(2)
    await inside(() => updateAdTargetWithSync({ adTargetId: 'b1-t2', patch: { bidCents: 75 }, actor: ENGINE, applyImmediately: true }))
    const t2Now = (await bidOf('b1-t2')).bidCents

    const first = await undo(ids[0]!)
    const second = await undo(ids[1]!)
    expect([first.status, second.status]).toEqual([200, 409])
    expect(String(second.body.reason)).toMatch(/^Changed since: now bid €/)
    expect((await bidOf('b1-t1')).bidCents).toBe(35)
    expect((await bidOf('b1-t2')).bidCents).toBe(t2Now)
  })

  it('a change set (one Undo for the whole set): per entity — the one changed since is refused, the rest is put back', async () => {
    await inside(async () => {
      await updateAdTargetWithSync({ adTargetId: 'b2-t1', patch: { bidCents: 45 }, actor: 'user:owner-test', applyImmediately: true, manual: true, changeSetId: 'set-test-b2' })
      await updateAdTargetWithSync({ adTargetId: 'b2-t2', patch: { bidCents: 70 }, actor: 'user:owner-test', applyImmediately: true, manual: true, changeSetId: 'set-test-b2' })
    })
    await inside(() => updateAdTargetWithSync({ adTargetId: 'b2-t2', patch: { bidCents: 75 }, actor: ENGINE, applyImmediately: true }))
    const t2Now = (await bidOf('b2-t2')).bidCents
    const anyRow = await inside(() => database.client.advertisingActionLog.findFirstOrThrow({ where: { executionId: 'set-test-b2' }, select: { id: true } }))

    const r = await undo(anyRow.id)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ reversed: 1, changedSince: 1 })
    expect(String(r.body.reason)).toMatch(/^1 of 2 changes not undone\. Changed since: now bid €/)
    expect((await bidOf('b2-t1')).bidCents).toBe(35)
    expect((await bidOf('b2-t2')).bidCents).toBe(t2Now)
  })
})

describe('2 — the Ad Manager\'s bulk budget goes only onto the budget it showed', () => {
  it('a budget moved since (a schedule): 409 "Changed since: now <budget>", nothing written', async () => {
    await inside(() => updateCampaignWithSync({ campaignId: 'u5', patch: { dailyBudget: 25 }, actor: 'automation:budget-schedule-test', applyImmediately: true }))
    const r = await send('PATCH', '/advertising/campaigns/u5', { dailyBudget: 22, expectedDailyBudget: 20, applyImmediately: true, reason: 'Ad Manager bulk action' })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ ok: false, changedSince: { field: 'dailyBudget', now: 25 } })
    expect(String(r.body.error)).toMatch(/^Changed since: now €25\.00 \(the screen showed €20\.00\)\. Nothing was written/)
    const c = await inside(() => database.client.campaign.findUniqueOrThrow({ where: { id: 'u5' }, select: { dailyBudget: true } }))
    expect(Number(c.dailyBudget)).toBe(25)
  })

  it('the budget it showed: written', async () => {
    const r = await send('PATCH', '/advertising/campaigns/u6', { dailyBudget: 22, expectedDailyBudget: 20, applyImmediately: true, reason: 'Ad Manager bulk action' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true })
    const c = await inside(() => database.client.campaign.findUniqueOrThrow({ where: { id: 'u6' }, select: { dailyBudget: true } }))
    expect(Number(c.dailyBudget)).toBe(22)
  })
})

describe('3 — the ad-group page\'s re-read after its own save skips the read cache', () => {
  it('fresh=1 reads past the cache; an ordinary read may use it', async () => {
    await send('GET', '/advertising/ad-groups/u6-g?fresh=1')
    await send('GET', '/advertising/ad-groups/u6-g')
    expect(cache.reads.filter((r) => r.key.startsWith('adgroup:u6-g:')).map((r) => r.refresh)).toEqual([true, false])
  })
})
