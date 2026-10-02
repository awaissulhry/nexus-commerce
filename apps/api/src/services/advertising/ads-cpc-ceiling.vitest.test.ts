/**
 * MCP full control A1 — the CPC-ceiling clamp moved out of advertising.routes.ts into `ads-cpc-ceiling.ts` with no
 * behaviour change (proven byte-equal on the bid routes against the code before the move). These arms keep it so:
 *   · cpcCeilingCents: multiple × average CPC, default multiple 1.5, never below 5 cents; none without clicks or
 *     with the ceiling off;
 *   · clampBidsByCeiling: only a bid above the ceiling moves, order kept, each clamp logged;
 *   · the two bid routes hand the clamped bid to the mutation service and answer cpcClamp / cpcClamps as before.
 * PGlite with the production schema; the mutation service is a recorder (no queue, no Amazon).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_t, p) => Reflect.get(database.client, p) }) }))
vi.mock('../../lib/queue.js', () => {
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
vi.mock('./ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined,
}))
// The audited mutation service is not under test here: it records what the route hands it.
vi.mock('./ads-mutation.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateAdTargetWithSync: async (args: Record<string, unknown>) => ({ ok: true, received: { adTargetId: args.adTargetId, patch: args.patch } }),
  bulkUpdateAdTargetBids: async (args: Record<string, unknown>) => ({ updated: (args.entries as unknown[]).length, received: args.entries }),
}))

import { clampBidsByCeiling, cpcCeilingCents } from './ads-cpc-ceiling.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
let app: FastifyInstance

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await inside(async () => {
    const campaign = (id: string, dynamicBidding: unknown) => db.campaign.create({ data: { id, name: id, type: 'SP', marketplace: 'IT', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), ...(dynamicBidding ? { dynamicBidding } : {}) } as never })
    await campaign('cpc-c1', { cpcCeiling: { enabled: true, multiple: 2 } })
    await campaign('cpc-c2', null)
    await campaign('cpc-c3', { cpcCeiling: { enabled: true } })
    for (const [group, c] of [['cpc-g1', 'cpc-c1'], ['cpc-g2', 'cpc-c2'], ['cpc-g3', 'cpc-c3']]) await db.adGroup.create({ data: { id: group, campaignId: c, name: group } as never })
    const target = (id: string, adGroupId: string, clicks: number, spendCents: number) =>
      db.adTarget.create({ data: { id, adGroupId, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `kw ${id}`, bidCents: 60, clicks, spendCents } as never })
    await target('cpc-t1', 'cpc-g1', 10, 500) // CPC 50 → ceiling 2 × 50 = 100
    await target('cpc-t2', 'cpc-g1', 0, 0) // no clicks → no ceiling
    await target('cpc-t3', 'cpc-g3', 4, 8) // CPC 2 → 1.5 × 2 = 3 → the 5-cent floor
    await target('cpc-t4', 'cpc-g2', 5, 50) // ceiling off
  })
  app = Fastify()
  app.addHook('preHandler', (_r, _p, done) => { withWorkspace(business, done) })
  const { default: advertisingRoutes } = await import('../../routes/advertising.routes.js')
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
}, 180_000)
afterAll(async () => { await app?.close(); await database?.close() })

describe('cpcCeilingCents', () => {
  it('multiple × average CPC, the default multiple 1.5, never below 5 cents', () => {
    expect(cpcCeilingCents({ clicks: 10, spendCents: 500 }, { enabled: true, multiple: 2 })).toBe(100)
    expect(cpcCeilingCents({ clicks: 10, spendCents: 500 }, { enabled: true })).toBe(75)
    expect(cpcCeilingCents({ clicks: 3, spendCents: 100 }, { enabled: true })).toBe(50) // 1.5 × 33.33… rounds to 50
    expect(cpcCeilingCents({ clicks: 4, spendCents: 8 }, { enabled: true })).toBe(5)
  })

  it('none with the ceiling off, without click history, or without a target', () => {
    expect(cpcCeilingCents({ clicks: 10, spendCents: 500 }, { enabled: false, multiple: 2 })).toBeNull()
    expect(cpcCeilingCents({ clicks: 10, spendCents: 500 }, undefined)).toBeNull()
    expect(cpcCeilingCents({ clicks: 0, spendCents: 0 }, { enabled: true })).toBeNull()
    expect(cpcCeilingCents(null, { enabled: true })).toBeNull()
  })
})

describe('clampBidsByCeiling', () => {
  it('moves only a bid above its ceiling, keeps the order, and logs each clamp', async () => {
    const entries = [
      { adTargetId: 'cpc-t1', bidCents: 150 }, { adTargetId: 'cpc-t1', bidCents: 80 }, { adTargetId: 'cpc-t2', bidCents: 999 },
      { adTargetId: 'cpc-t3', bidCents: 40 }, { adTargetId: 'cpc-t4', bidCents: 300 }, { adTargetId: 'cpc-missing', bidCents: 20 },
    ]
    const out = await inside(() => clampBidsByCeiling(entries))
    expect(out.entries.map((e) => e.bidCents)).toEqual([100, 80, 999, 5, 300, 20])
    expect(out.clamps).toEqual([
      { adTargetId: 'cpc-t1', from: 150, to: 100, ceilingCents: 100 },
      { adTargetId: 'cpc-t3', from: 40, to: 5, ceilingCents: 5 },
    ])
    // An entry that is not clamped is handed back as given.
    expect(out.entries[1]).toBe(entries[1])
    expect(out.entries[0]).not.toBe(entries[0])
  })
})

describe('the bid routes use it', () => {
  it('PATCH /advertising/ad-targets/:id hands the clamped bid on and names the clamp', async () => {
    const clamped = await app.inject({ method: 'PATCH', url: '/api/advertising/ad-targets/cpc-t1', payload: { bidCents: 150 } })
    expect(clamped.json()).toEqual({ ok: true, received: { adTargetId: 'cpc-t1', patch: { bidCents: 100 } }, cpcClamp: { from: 150, to: 100, ceilingCents: 100 } })
    const kept = await app.inject({ method: 'PATCH', url: '/api/advertising/ad-targets/cpc-t2', payload: { bidCents: 150 } })
    expect(kept.json()).toEqual({ ok: true, received: { adTargetId: 'cpc-t2', patch: { bidCents: 150 } } })
  })

  it('POST /advertising/ad-targets/bulk-bid hands the clamped entries on and lists the clamps', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/advertising/ad-targets/bulk-bid', payload: { entries: [{ adTargetId: 'cpc-t1', bidCents: 80 }, { adTargetId: 'cpc-t3', bidCents: 40 }, { adTargetId: 'cpc-t4', bidCents: 300 }] } })
    expect(response.json()).toEqual({
      ok: true, updated: 3,
      received: [{ adTargetId: 'cpc-t1', bidCents: 80 }, { adTargetId: 'cpc-t3', bidCents: 5 }, { adTargetId: 'cpc-t4', bidCents: 300 }],
      cpcClamps: [{ adTargetId: 'cpc-t3', from: 40, to: 5, ceilingCents: 5 }],
    })
  })
})
