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
/**
 * A write that lands between Nexus's check and its own write (the compare-and-set test): when armed, the next local
 * `updateMany` on the model first runs this racing write, once.
 */
const race = vi.hoisted(() => ({ model: null as string | null, write: null as null | (() => Promise<unknown>) }))
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  const db = () => (wrapped ??= contextualDatabase(database.client as never))
  return {
    default: new Proxy({}, {
      get: (_t, p) => {
        const value = Reflect.get(db(), p)
        if (p !== race.model || !race.write) return value
        return new Proxy(value as object, {
          get: (d, m) => {
            const fn = Reflect.get(d, m) as (...a: unknown[]) => unknown
            if (m !== 'updateMany' || !race.write) return typeof fn === 'function' ? fn.bind(d) : fn
            return async (...a: unknown[]) => { const w = race.write!; race.write = null; await w(); return fn.apply(d, a) }
          },
        })
      },
    }),
  }
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

const send = async (method: 'POST' | 'PATCH' | 'GET', url: string, payload?: object, headers?: Record<string, string>) => {
  const res = await app.inject({ method, url: `/api${url}`, ...(payload ? { payload } : {}), ...(headers ? { headers } : {}) })
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
  const { default: keywordActionsRoutes } = await import('./keyword-actions.routes.js')
  app = Fastify()
  // A signed-in person, as auth sets it (personActor reads `authUser`): the test names him in a header.
  app.addHook('preHandler', (request, _reply, done) => {
    const who = request.headers['x-test-user']
    if (typeof who === 'string') (request as unknown as { authUser: { id: string } }).authUser = { id: who }
    done()
  })
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.register(keywordActionsRoutes, { prefix: '/api' })
  await app.ready()
  for (const id of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'b1', 'b2', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']) await seedCampaign(id)
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

describe('group 3 review — the Undo is judged on the value, never refused forever', () => {
  it('undo newest-first: B undone, then A — A\'s value still stands, so A is put back', async () => {
    const a = await send('PATCH', '/advertising/ad-targets/r1-t1', { bidCents: 50, applyImmediately: true })
    const b = await send('PATCH', '/advertising/ad-targets/r1-t1', { bidCents: 60, applyImmediately: true })
    const undoB = await undo(String(b.body.actionLogId))
    expect([undoB.status, (await bidOf('r1-t1')).bidCents]).toEqual([200, 50])
    const undoA = await undo(String(a.body.actionLogId))
    expect(undoA.status).toBe(200)
    expect(undoA.body).toMatchObject({ ok: true, reversed: 1 })
    expect((await bidOf('r1-t1')).bidCents).toBe(35)
  })

  it('a bid an engine moved away and back (50 → 30 → 50): the person\'s value stands, so his Undo goes', async () => {
    const mine = await send('PATCH', '/advertising/ad-targets/r2-t1', { bidCents: 50, applyImmediately: true })
    await inside(() => updateAdTargetWithSync({ adTargetId: 'r2-t1', patch: { bidCents: 30 }, actor: ENGINE, applyImmediately: true, force: true }))
    expect((await bidOf('r2-t1')).bidCents).toBe(30)
    await inside(() => updateAdTargetWithSync({ adTargetId: 'r2-t1', patch: { bidCents: 50 }, actor: ENGINE, applyImmediately: true, force: true }))
    expect((await bidOf('r2-t1')).bidCents).toBe(50)
    const r = await undo(String(mine.body.actionLogId))
    expect(r.status).toBe(200)
    expect((await bidOf('r2-t1')).bidCents).toBe(35)
  })

  it('a 3-decimal budget is written and logged to the cent, so its Undo is not refused', async () => {
    const set = await send('PATCH', '/advertising/campaigns/r6', { dailyBudget: 1.005, applyImmediately: true })
    expect(set.body).toMatchObject({ ok: true })
    const c = await inside(() => database.client.campaign.findUniqueOrThrow({ where: { id: 'r6' }, select: { dailyBudget: true } }))
    const log = await inside(() => database.client.advertisingActionLog.findUniqueOrThrow({ where: { id: String(set.body.actionLogId) }, select: { payloadAfter: true } }))
    expect([Number(c.dailyBudget), (log.payloadAfter as { dailyBudget: number }).dailyBudget]).toEqual([1.01, 1.01])
    const r = await undo(String(set.body.actionLogId))
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, reversed: 1 })
  })
})

describe('group 3 review — the compare-and-set is atomic: a write landing between the check and the write wins', () => {
  const queued = () => inside(() => database.client.outboundSyncQueue.count())
  const logsOn = (entityId: string) => inside(() => database.client.advertisingActionLog.count({ where: { entityId } }))

  it('a person\'s Undo: the reversal\'s local write is conditional; nothing written, nothing queued', async () => {
    const mine = await send('PATCH', '/advertising/ad-targets/r3-t1', { bidCents: 50, applyImmediately: true })
    const [q, l] = [await queued(), await logsOn('r3-t1')]
    Object.assign(race, { model: 'adTarget', write: () => database.client.adTarget.update({ where: { id: 'r3-t1' }, data: { bidCents: 77 } }) })
    try {
      const r = await undo(String(mine.body.actionLogId))
      expect(r.status).toBe(409)
      expect(String(r.body.reason)).toMatch(/^Changed since: now bid €0\.77\./)
    } finally { Object.assign(race, { model: null, write: null }) }
    expect((await bidOf('r3-t1')).bidCents).toBe(77)
    expect([await queued(), await logsOn('r3-t1')]).toEqual([q, l])
  })

  it('the bulk budget: the local write is conditional on the budget it saw; nothing written, nothing queued', async () => {
    const q = await queued()
    Object.assign(race, { model: 'campaign', write: () => database.client.campaign.update({ where: { id: 'r4' }, data: { dailyBudget: 26 } }) })
    try {
      const r = await send('PATCH', '/advertising/campaigns/r4', { dailyBudget: 22, expectedDailyBudget: 20, applyImmediately: true })
      expect(r.status).toBe(409)
      expect(r.body).toMatchObject({ ok: false, changedSince: { field: 'dailyBudget', now: 26 } })
    } finally { Object.assign(race, { model: null, write: null }) }
    const c = await inside(() => database.client.campaign.findUniqueOrThrow({ where: { id: 'r4' }, select: { dailyBudget: true } }))
    expect(Number(c.dailyBudget)).toBe(26)
    expect(await queued()).toBe(q)
  })
})

describe('group 3 review — bulk-bid names the signed-in person', () => {
  it('his bids are logged as his, and one sent past his CPC ceiling keeps the note', async () => {
    await inside(async () => {
      await database.client.campaign.update({ where: { id: 'r5' }, data: { dynamicBidding: { cpcCeiling: { enabled: true, multiple: 1.5 } } } as never })
      await database.client.adTarget.update({ where: { id: 'r5-t2' }, data: { clicks: 10, spendCents: 400 } as never }) // ceiling 60¢
    })
    const sent = await send('POST', '/advertising/ad-targets/bulk-bid', {
      entries: [{ adTargetId: 'r5-t1', bidCents: 45 }, { adTargetId: 'r5-t2', bidCents: 80 }], reason: 'Edit Targets inline', applyImmediately: true, confirmOwnLimits: true,
    }, { 'x-test-user': 'person-test' })
    const ids = (sent.body.outcomes as Array<{ actionLogId: string }>).map((o) => o.actionLogId)
    const rows = await inside(() => database.client.advertisingActionLog.findMany({ where: { id: { in: ids } }, select: { entityId: true, userId: true, evidence: true } }))
    expect(rows.map((r) => r.userId)).toEqual(['user:person-test', 'user:person-test'])
    const past = rows.find((r) => r.entityId === 'r5-t2')!.evidence as { sentPastOwnLimits?: string } | null
    expect(past?.sentPastOwnLimits).toBe('sent past your CPC ceiling by user:person-test: a bid of 80¢ is above your CPC ceiling of 60¢')
  })
})

describe('group 3 review — every person-clicked rollback is guarded and says what was not put back', () => {
  it('the keyword tracker\'s Undo of a set: the answer carries changedSince and the reason', async () => {
    await inside(async () => {
      await updateAdTargetWithSync({ adTargetId: 'r7-t1', patch: { bidCents: 45 }, actor: 'user:owner-test', applyImmediately: true, manual: true, changeSetId: 'set-test-r7' })
      await updateAdTargetWithSync({ adTargetId: 'r7-t2', patch: { bidCents: 70 }, actor: 'user:owner-test', applyImmediately: true, manual: true, changeSetId: 'set-test-r7' })
    })
    await inside(() => updateAdTargetWithSync({ adTargetId: 'r7-t2', patch: { bidCents: 75 }, actor: ENGINE, applyImmediately: true, force: true }))
    const row = await inside(() => database.client.advertisingActionLog.findFirstOrThrow({ where: { executionId: 'set-test-r7' }, select: { id: true } }))
    const r = await send('POST', '/advertising/keyword-actions/undo', { actionLogId: row.id, userId: 'owner-test' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ reversed: 1, changedSince: 1 })
    expect(String(r.body.reason)).toMatch(/^1 of 2 changes not undone\. Changed since: now bid €0\.75\./)
  })

  it('the bulk-sheet upload\'s rollback: the change made since stays, the rest of the upload is put back', async () => {
    const job = await inside(() => database.client.importJob.create({ data: { jobName: 'test upload', fileKind: 'xlsx', targetEntity: 'adsBulksheet' } as never, select: { id: true } }))
    await inside(async () => {
      await updateAdTargetWithSync({ adTargetId: 'r8-t1', patch: { bidCents: 45 }, actor: 'user:owner-test', applyImmediately: true, manual: true, changeSetId: `import:${job.id}` })
      await updateAdTargetWithSync({ adTargetId: 'r8-t2', patch: { bidCents: 70 }, actor: 'user:owner-test', applyImmediately: true, manual: true, changeSetId: `import:${job.id}` })
    })
    await inside(() => updateAdTargetWithSync({ adTargetId: 'r8-t2', patch: { bidCents: 75 }, actor: ENGINE, applyImmediately: true, force: true }))
    const r = await send('POST', `/advertising/bulk/import/${job.id}/rollback`, {})
    expect(r.body).toMatchObject({ reversed: 1, changedSince: 1 })
    expect(String(r.body.reason)).toMatch(/Changed since: now bid €0\.75\./)
    expect([(await bidOf('r8-t1')).bidCents, (await bidOf('r8-t2')).bidCents]).toEqual([35, 75])
  })

  it('a rule run\'s rollback: what a person changed since stays, the rest of the run is put back', async () => {
    const run = await inside(async () => {
      const rule = await database.client.automationRule.create({ data: { name: 'test rule', trigger: 'SCHEDULE', domain: 'advertising' } as never, select: { id: true } })
      return database.client.automationRuleExecution.create({ data: { ruleId: rule.id, triggerData: {}, actionResults: [], dryRun: false, status: 'SUCCESS', finishedAt: new Date() } as never, select: { id: true, ruleId: true } })
    })
    await inside(async () => {
      await updateAdTargetWithSync({ adTargetId: 'u6-t1', patch: { bidCents: 45 }, actor: `automation:${run.ruleId}` as never, applyImmediately: true, force: true, changeSetId: run.id })
      await updateAdTargetWithSync({ adTargetId: 'u6-t2', patch: { bidCents: 70 }, actor: `automation:${run.ruleId}` as never, applyImmediately: true, force: true, changeSetId: run.id })
    })
    await send('PATCH', '/advertising/ad-targets/u6-t2', { bidCents: 80, applyImmediately: true })
    const r = await send('POST', `/advertising/actions/${run.id}/rollback`, {})
    expect(r.body).toMatchObject({ reversed: 1, changedSince: 1 })
    expect(String(r.body.reason)).toMatch(/Changed since: now bid €0\.80\./)
    expect([(await bidOf('u6-t1')).bidCents, (await bidOf('u6-t2')).bidCents]).toEqual([35, 80])
  })
})
