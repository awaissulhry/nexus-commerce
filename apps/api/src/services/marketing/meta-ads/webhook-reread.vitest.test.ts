/**
 * Meta ads step 30 — the structure re-read a verified Meta webhook asks for (enqueue.ts enqueueMetaWebhookReread, the
 * worker's WEBHOOK kind): one job per ad account and 10-minute window, run when the window ends, only on the queue
 * (never in the process that received the push), only for an account this business reads, and a queue that did not
 * answer is something to try again. The queue, the targets and the read are doubles; made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  targets: [{ connectionId: 'conn-1', adAccountId: '1234567890' }],
  added: [] as Array<{ name: string; data: unknown; options: { jobId: string; delay?: number } }>,
  addFails: false,
  reads: [] as Array<{ adAccountId: string; kind: string }>,
}))
vi.mock('../../../db.js', () => ({ default: {} }))
vi.mock('../../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('./targets.js', () => ({ listMetaReadTargets: vi.fn(async () => h.targets) }))
vi.mock('./sync.service.js', () => ({ syncMetaAdAccountById: vi.fn(async (adAccountId: string, kind: string) => { h.reads.push({ adAccountId, kind }); return { status: 'SUCCESS', calls: 1 } }) }))
vi.mock('../../../lib/queue.js', () => ({
  redis: { connection: {} },
  metaAdsSyncQueue: {
    add: vi.fn(async (name: string, data: unknown, options: { jobId: string; delay?: number }) => {
      if (h.addFails) throw new Error('queue down')
      h.added.push({ name, data, options })
      return {}
    }),
  },
}))
vi.mock('../../../lib/workspace-jobs.js', () => ({ WorkspaceWorker: class {} }))

const { enqueueMetaWebhookReread, metaAdsSyncJobId, WEBHOOK_REREAD_WINDOW_MS } = await import('./enqueue.js')
const { processMetaAdsSyncJob } = await import('../../../workers/meta-ads-sync.worker.js')

beforeEach(() => {
  h.targets = [{ connectionId: 'conn-1', adAccountId: '1234567890' }]
  h.added.length = 0
  h.reads.length = 0
  h.addFails = false
  vi.stubEnv('ENABLE_QUEUE_WORKERS', '1')
  vi.stubEnv('NEXUS_META_ADS_SYNC', '')
})

describe('the webhook re-read', () => {
  it('one job per account and window, run 30 s after the window ends; every push in the window is that one read', async () => {
    // 09:13:20 is in the 09:10–09:20 window: the read runs at 09:20:30, 7 min 10 s later.
    const at = new Date('2026-10-21T09:13:20Z')
    expect(await enqueueMetaWebhookReread('1234567890', at)).toEqual({ queued: true, reason: null, retry: false })
    expect(h.added).toEqual([{ name: 'sync', data: { adAccountId: '1234567890', kind: 'WEBHOOK' }, options: { jobId: metaAdsSyncJobId('WEBHOOK', '1234567890', at), delay: 430_000 } }])
    expect(metaAdsSyncJobId('WEBHOOK', '1234567890', at)).toBe(metaAdsSyncJobId('WEBHOOK', '1234567890', new Date('2026-10-21T09:19:59Z')))
    expect(metaAdsSyncJobId('WEBHOOK', '1234567890', at)).not.toBe(metaAdsSyncJobId('WEBHOOK', '1234567890', new Date('2026-10-21T09:20:00Z')))
    expect(metaAdsSyncJobId('WEBHOOK', '1234567890', at)).not.toBe(metaAdsSyncJobId('MANUAL', '1234567890', at))
    expect(metaAdsSyncJobId('WEBHOOK', '1234567890', at)).not.toContain(':')
    expect(WEBHOOK_REREAD_WINDOW_MS).toBe(600_000)
  })

  it('never reads in the receiving process: no queue workers → nothing queued and nothing read, not retried', async () => {
    vi.stubEnv('ENABLE_QUEUE_WORKERS', '0')
    expect(await enqueueMetaWebhookReread('1234567890')).toMatchObject({ queued: false, retry: false })
    await new Promise((resolve) => setImmediate(resolve))
    expect(h.added).toEqual([])
    expect(h.reads).toEqual([])
  })

  it('only an account this business reads; the read switch off queues nothing; a queue that failed is retried', async () => {
    expect(await enqueueMetaWebhookReread('5550001112')).toMatchObject({ queued: false, retry: false, reason: 'This business does not read that Meta ad account.' })
    vi.stubEnv('NEXUS_META_ADS_SYNC', 'off')
    expect(await enqueueMetaWebhookReread('1234567890')).toMatchObject({ queued: false, retry: false })
    vi.stubEnv('NEXUS_META_ADS_SYNC', '')
    h.addFails = true
    expect(await enqueueMetaWebhookReread('1234567890')).toMatchObject({ queued: false, retry: true })
    expect(h.added).toEqual([])
  })

  it('the worker runs a WEBHOOK job as a read of that kind', async () => {
    await expect(processMetaAdsSyncJob({ adAccountId: '1234567890', kind: 'WEBHOOK' })).resolves.toMatchObject({ skipped: false })
    expect(h.reads).toEqual([{ adAccountId: '1234567890', kind: 'WEBHOOK' }])
    await expect(processMetaAdsSyncJob({ adAccountId: '1234567890', kind: 'NOPE' as never })).resolves.toEqual({ skipped: true })
  })
})
