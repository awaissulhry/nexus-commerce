/**
 * 5b (5a's open note) — a negative refused at the wire is a permanent failure, not a retry.
 *
 * 5a refuses, inside liveCall, a PUT that puts a negative back to ENABLED when it would block a protected term (or when
 * Nexus holds no copy of it). The worker caught the NegativeRefusedError as a plain message that the retry classifier
 * did not recognise, so the same refusal was sent again every 15 minutes until maxRetries. It is dead on the first try
 * now, with the refusal's own sentence.
 *
 * PGlite with the production schema; the gate is a stand-in that allows the write (the wire is what refuses it), and
 * the Amazon client's updateTarget throws what liveCall throws. Nothing leaves the process.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
const SENTENCE = 'Not re-enabled: "xavia" cannot be negated: it matches the protected term "xavia" (brand term).'
vi.mock('../services/advertising/ads-api-client.js', async () => {
  const { NegativeRefusedError } = await import('../services/advertising/ads-negation-policy.js')
  return {
    adsMode: () => 'live',
    updateTarget: async () => { throw new NegativeRefusedError(SENTENCE) },
  }
})

const { drainAdsSyncOnce } = await import('./ads-sync.worker.js')
const { updateAdTargetWithSync } = await import('../services/advertising/ads-mutation.service.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await inside(async () => {
    await db.campaign.create({
      data: {
        id: 'nr-c', name: 'nr-c', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-nr-c',
        dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true,
      } as never,
    })
    await db.adGroup.create({ data: { id: 'nr-g', campaignId: 'nr-c', name: 'nr-g', externalAdGroupId: 'EXT-nr-g', defaultBidCents: 40 } as never })
    await db.adTarget.create({
      data: {
        id: 'nr-neg', adGroupId: 'nr-g', kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'xavia', bidCents: 0,
        status: 'PAUSED', isNegative: true, negativeLevel: 'AD_GROUP', externalTargetId: 'EXT-nr-neg',
      } as never,
    })
  })
}, 180_000)
afterAll(async () => { await database?.close() })

describe('a negative re-enable refused at the wire', () => {
  it('is dead on the first attempt, with the refusal\'s sentence — not retried until maxRetries', async () => {
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 'nr-neg', patch: { status: 'ENABLED' }, actor: 'user:nr-test', applyImmediately: true }))
    expect(r.ok).toBe(true)
    const out = await inside(() => drainAdsSyncOnce(50))
    expect(out.processed).toBe(1)
    const [row] = await inside(() => database.client.outboundSyncQueue.findMany({
      where: { id: { in: out.results.map((x) => x.queueId) } },
      select: { syncStatus: true, isDead: true, retryCount: true, nextRetryAt: true, errorMessage: true },
    }))
    expect(row).toMatchObject({ syncStatus: 'FAILED', isDead: true, retryCount: 1, nextRetryAt: null })
    expect(row!.errorMessage).toBe(`forbidden by Nexus: ${SENTENCE}`)
  })
})
