/**
 * ADS AUTONOMY W3-2 (review) — a cancel that lands while the worker is mid-way through a queued ad write.
 *
 * The worker read the row as PENDING, claimed the entity, and only then set it IN_PROGRESS — without asking whether it
 * was still PENDING. A cancel in that gap (the staged tray's Discard, cancel-queued-ad-write) moved the row to CANCELLED
 * and put Nexus's copy back, and the worker then sent the write anyway: Amazon got a value Nexus no longer showed. The
 * worker now takes the row with a compare-and-set (PENDING → IN_PROGRESS), as the cancel does (PENDING → CANCELLED):
 * exactly one wins.
 *
 * PGlite with the production schema. The cancel is run INSIDE the gap: the worker's supersede check (after its read and
 * its entity claim, before it takes the row) is wrapped to cancel the row first. The gate allows everything; Amazon is
 * a recorder, nothing leaves the process.
 */
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
vi.mock('../services/advertising/ads-write-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/advertising/ads-write-gate.js')>()),
  checkAdsWriteGate: async (): Promise<GateDecision> => ({ allowed: true, mode: 'live', profileId: 'P-IT-TEST' }),
  logGateDeny: () => undefined,
  recordSuccessfulWrite: async () => undefined,
  recordCampaignLiveWrite: async () => undefined,
}))
const amazon = vi.hoisted(() => ({ calls: [] as Array<{ externalId: string; patch: Record<string, unknown> }> }))
vi.mock('../services/advertising/ads-api-client.js', () => {
  const record = async (_ctx: unknown, externalId: string, patch: Record<string, unknown>) => {
    amazon.calls.push({ externalId, patch })
    return { ok: true, rawResponse: {} }
  }
  return { adsMode: () => 'live', updateCampaign: record, updateAdGroup: record, updateTarget: record, updateProductAd: record, updatePortfolio: record, archiveSpEntity: record }
})
// The gap: after the worker's read and its entity claim, before it takes the row — a cancel lands here.
const race = vi.hoisted(() => ({ cancelIn: null as string | null, cancel: null as unknown }))
vi.mock('../services/advertising/ads-mutation.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/advertising/ads-mutation.service.js')>()
  return {
    ...real,
    supersedeOlderWrites: async (queueId: string) => {
      if (race.cancelIn === queueId) {
        race.cancelIn = null
        race.cancel = await real.cancelPendingMutation(queueId)
      }
      return real.supersedeOlderWrites(queueId)
    },
  }
})

const { drainAdsSyncOnce } = await import('./ads-sync.worker.js')
const { updateAdTargetWithSync } = await import('../services/advertising/ads-mutation.service.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ACTOR = 'automation:race-test-engine' as const

/** Queue a bid write as an engine does, with no grace window (it goes at the next drain). */
async function queueBid(targetId: string, bidCents: number): Promise<string> {
  const r = await inside(() => updateAdTargetWithSync({ adTargetId: targetId, patch: { bidCents }, actor: ACTOR, applyImmediately: true }))
  expect(r.ok, r.error ?? '').toBe(true)
  await inside(() => database.client.outboundSyncQueue.update({ where: { id: r.outboundQueueId! }, data: { holdUntil: null } }))
  return r.outboundQueueId!
}
const rowOf = (id: string) => inside(() => database.client.outboundSyncQueue.findUniqueOrThrow({ where: { id }, select: { syncStatus: true } }))
const bidOf = async (id: string) => (await inside(() => database.client.adTarget.findUniqueOrThrow({ where: { id }, select: { bidCents: true } }))).bidCents

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await inside(async () => {
    await db.campaign.create({
      data: {
        id: 'race-c', name: 'race-c', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-race-c',
        dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true,
      } as never,
    })
    await db.adGroup.create({ data: { id: 'race-g', campaignId: 'race-c', name: 'race-g', externalAdGroupId: 'EXT-race-g', defaultBidCents: 40 } as never })
    for (const id of ['race-t1', 'race-t2']) {
      await db.adTarget.create({ data: { id, adGroupId: 'race-g', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `kw ${id}`, bidCents: 35, externalTargetId: `EXT-${id}` } as never })
    }
  })
}, 180_000)
afterAll(async () => { await database?.close() })
beforeEach(() => { amazon.calls = []; race.cancelIn = null; race.cancel = null })

describe('W3-2 — a cancel in the worker\'s gap', () => {
  it('control: with no cancel, the drain sends the queued bid', async () => {
    const id = await queueBid('race-t2', 50)
    const out = await inside(() => drainAdsSyncOnce(50))
    expect(out.results).toEqual([{ status: expect.any(String), queueId: id }])
    expect(amazon.calls.map((c) => c.externalId)).toEqual(['EXT-race-t2'])
    expect((await rowOf(id)).syncStatus).toBe('SUCCESS')
  })

  it('a cancel after the worker read the row and claimed the entity, before it took the row: never sent, Nexus put back', async () => {
    const id = await queueBid('race-t1', 55)
    expect(await bidOf('race-t1')).toBe(55) // Nexus wrote its copy when it queued the write
    race.cancelIn = id
    const out = await inside(() => drainAdsSyncOnce(50))
    expect(race.cancel).toMatchObject({ ok: true, restored: ['bid'] })
    expect(out.results).toEqual([{ status: 'CANCELLED', queueId: id }])
    expect(amazon.calls).toEqual([])
    expect((await rowOf(id)).syncStatus).toBe('CANCELLED')
    expect(await bidOf('race-t1')).toBe(35)
    const typed = await inside(() => database.client.adMutation.findMany({ where: { outboundQueueId: id }, select: { state: true } }))
    expect(typed.map((t) => t.state)).toEqual(['CANCELLED'])
  })
})
