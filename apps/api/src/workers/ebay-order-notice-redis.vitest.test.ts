/**
 * eBay order notices, Phase 4 — the queue half on a REAL Redis: BullMQ's own jobId dedupe and the real
 * WorkspaceWorker. The stored-receipt processing is a stub here (its claim race runs on PostgreSQL in
 * ebay-order-notice-postgres.vitest.test.ts).
 *
 * Skipped unless NEXUS_TEST_REDIS_URL names a THROWAWAY Redis on this machine, for example:
 *   docker run --rm -d --name nexus-test-redis -p 127.0.0.1::6379 redis:7-alpine   # then: docker port nexus-test-redis 6379
 *   NEXUS_TEST_REDIS_URL=redis://127.0.0.1:<port> npx vitest run src/workers/ebay-order-notice-redis.vitest.test.ts
 * It writes and obliterates the "ebay-order-notice" queue there, so never point it at a shared Redis.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { workspaceIdForQuery } from '../lib/workspace-context.js'

const TEST_REDIS = (() => {
  const raw = process.env.NEXUS_TEST_REDIS_URL?.trim()
  if (!raw) return null
  const url = new URL(raw)
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) throw new Error('NEXUS_TEST_REDIS_URL must name a throwaway Redis on this machine.')
  return raw
})()

const state = vi.hoisted(() => ({ runs: [] as Array<{ receiptId: string; business: string }> }))
vi.mock('../db.js', () => ({ default: {
  workspace: { findUnique: async () => ({ status: 'active', automationResumedAt: null }) },
  webhookEvent: { findFirst: async ({ where }: { where: { id: string; eventType: string } }) => where.eventType === 'ORDER_CONFIRMATION' ? { id: where.id } : null },
} }))
vi.mock('../services/cx/ingress/ebay-processing.js', () => ({
  processEbayInbound: async (receiptId: string) => { state.runs.push({ receiptId, business: workspaceIdForQuery() }); return { kind: 'done' } },
}))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

describe.skipIf(!TEST_REDIS)('eBay order notice queue on a real Redis', () => {
  let queueModule: typeof import('../lib/queue.js')
  let kick: typeof import('../services/cx/ebay-order-notice-kick.js')['kickStoredEbayOrderNotice']
  let initializeWorker: typeof import('./ebay-order-notice.worker.js')['initializeEbayOrderNoticeWorker']
  const order = (notificationId: string) => Buffer.from(JSON.stringify({ metadata: { topic: 'ORDER_CONFIRMATION', schemaVersion: '1.0' },
    notification: { notificationId, data: { order: { orderId: 'synthetic-order' } } } }))
  const jobsFor = async (receiptId: string) => (await queueModule.ebayOrderNoticeQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']))
    .filter(job => job.data?.receiptId === receiptId)

  beforeAll(async () => {
    vi.stubEnv('REDIS_URL', TEST_REDIS!)
    vi.stubEnv('ENABLE_QUEUE_WORKERS', '1')
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '1')
    vi.stubEnv('NEXUS_ENABLE_EBAY_ORDER_NOTICES', '1')
    vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '1')
    queueModule = await import('../lib/queue.js')
    kick = (await import('../services/cx/ebay-order-notice-kick.js')).kickStoredEbayOrderNotice
    initializeWorker = (await import('./ebay-order-notice.worker.js')).initializeEbayOrderNoticeWorker
    await queueModule.ebayOrderNoticeQueue.obliterate({ force: true })
  }, 30_000)
  afterAll(async () => {
    await queueModule?.ebayOrderNoticeQueue.obliterate({ force: true })
    await queueModule?.closeQueue()
    vi.unstubAllEnvs()
  }, 30_000)

  it('a notice delivered three times makes one job, named by its receipt in its business; another receipt makes its own', async () => {
    const business = `business-${randomUUID().slice(0, 8)}`, receiptId = `receipt-${randomUUID()}`, other = `receipt-${randomUUID()}`
    for (const duplicate of [false, true, true]) {
      expect(await kick({ kind: 'accepted', receiptId, workspaceId: business, duplicate }, order('n-1'))).toEqual({ kicked: true })
    }
    const jobs = await jobsFor(receiptId)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].id).toBe(`w_${business}_ebay-order-notice-${receiptId}`)
    expect(jobs[0].data.__nexusWorkspace).toMatchObject({ version: 1, workspaceId: business, actorUserId: null })
    expect(await kick({ kind: 'accepted', receiptId: other, workspaceId: business, duplicate: false }, order('n-2'))).toEqual({ kicked: true })
    expect(await jobsFor(other)).toHaveLength(1)
  })

  it('the worker runs the job once in the receipt\'s business, and a later kick for the same receipt runs nothing more', async () => {
    await queueModule.ebayOrderNoticeQueue.obliterate({ force: true })
    state.runs = []
    const business = `business-${randomUUID().slice(0, 8)}`, receiptId = `receipt-${randomUUID()}`
    const worker = initializeWorker()
    try {
      expect(await kick({ kind: 'accepted', receiptId, workspaceId: business, duplicate: false }, order('n-3'))).toEqual({ kicked: true })
      await vi.waitFor(() => expect(state.runs).toEqual([{ receiptId, business }]), { timeout: 10_000, interval: 50 })
      await vi.waitFor(async () => expect((await jobsFor(receiptId)).map(job => job.finishedOn != null)).toEqual([true]), { timeout: 5_000, interval: 50 })
      expect(await kick({ kind: 'accepted', receiptId, workspaceId: business, duplicate: true }, order('n-3'))).toEqual({ kicked: true })
      await new Promise(resolve => setTimeout(resolve, 500))
      expect(state.runs).toEqual([{ receiptId, business }])
    } finally { await worker.close() }
  }, 30_000)
})
