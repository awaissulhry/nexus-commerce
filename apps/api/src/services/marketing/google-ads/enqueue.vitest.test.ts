/**
 * Google Ads step 1a — asking for a read (enqueue.ts): nothing while the kill switch is set or no account is chosen; on
 * the `google-ads-sync` queue with a deterministic id when workers run, in this process otherwise (or when the queue does
 * not answer); a manual read at most once an hour per account, refused in words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  targets: [] as Array<{ connectionId: string; customerId: string; loginCustomerId: string | null }>,
  lastSyncAt: null as Date | null,
  add: vi.fn(async (..._args: unknown[]) => ({ id: 'job' })),
  set: vi.fn(async (..._args: unknown[]) => 'OK' as string | null),
  sync: vi.fn(async (customerId: string, kind: string) => ({ customerId, kind, status: 'SUCCESS' })),
}))
vi.mock('./targets.js', () => ({ listReadTargets: vi.fn(async () => h.targets) }))
vi.mock('./store.js', () => ({ getGoogleAdsCustomer: vi.fn(async () => (h.lastSyncAt ? { lastSyncAt: h.lastSyncAt } : null)) }))
vi.mock('./sync.service.js', () => ({ syncGoogleAdsCustomer: h.sync }))
vi.mock('../../../lib/queue.js', () => ({ googleAdsSyncQueue: { add: h.add }, redis: { connection: { set: h.set } } }))

import { enqueueGoogleAdsSync, googleAdsSyncJobId } from './enqueue.js'

const TARGET = { connectionId: 'g-conn-1', customerId: '1234567890', loginCustomerId: null }
const settle = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  h.targets = [TARGET]
  h.lastSyncAt = null
  h.add.mockReset().mockResolvedValue({ id: 'job' })
  h.set.mockReset().mockResolvedValue('OK')
  h.sync.mockClear()
  vi.stubEnv('NEXUS_GOOGLE_ADS_SYNC', '')
  vi.stubEnv('ENABLE_QUEUE_WORKERS', '1')
  vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379')
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '')
})
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })

describe('googleAdsSyncJobId', () => {
  it('one per account and UTC day for the daily read, per hour for a manual or first read; never a ":"', () => {
    const at = new Date('2026-10-13T06:25:41Z')
    expect(googleAdsSyncJobId('DAILY', '1234567890', at)).toBe('gads-daily-1234567890-2026-10-13')
    expect(googleAdsSyncJobId('DAILY', '1234567890', new Date('2026-10-13T23:59:00Z'))).toBe('gads-daily-1234567890-2026-10-13')
    expect(googleAdsSyncJobId('MANUAL', '1234567890', at)).toBe('gads-manual-1234567890-2026-10-13T06')
    expect(googleAdsSyncJobId('BACKFILL', '1234567890', at)).toBe('gads-backfill-1234567890-2026-10-13T06')
  })
})

describe('enqueueGoogleAdsSync', () => {
  it('the kill switch: nothing listed, nothing queued, the reason in words', async () => {
    vi.stubEnv('NEXUS_GOOGLE_ADS_SYNC', 'off')
    expect(await enqueueGoogleAdsSync({ kind: 'MANUAL' })).toEqual({ queued: false, reason: expect.stringMatching(/switched off/) })
    expect(h.add).not.toHaveBeenCalled()
  })

  it('no Google Ads account chosen, or not this one: no read, the reason in words', async () => {
    h.targets = []
    expect(await enqueueGoogleAdsSync({ kind: 'DAILY' })).toEqual({ queued: false, reason: 'Choose a Google Ads account first, in Settings, Channels, Google.' })
    h.targets = [TARGET]
    expect(await enqueueGoogleAdsSync({ customerId: '5550001112', kind: 'MANUAL' })).toEqual({ queued: false, reason: 'This business does not read that Google Ads account.' })
    expect(h.add).not.toHaveBeenCalled()
    expect(h.sync).not.toHaveBeenCalled()
  })

  it('with workers: on the google-ads-sync queue with its deterministic id, nothing run here', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-13T09:10:00Z'), toFake: ['Date'] })
    expect(await enqueueGoogleAdsSync({ customerId: '1234567890', kind: 'BACKFILL' })).toEqual({ queued: true, reason: null })
    expect(h.add).toHaveBeenCalledWith('sync', { customerId: '1234567890', kind: 'BACKFILL' }, { jobId: 'gads-backfill-1234567890-2026-10-13T09' })
    await settle()
    expect(h.sync).not.toHaveBeenCalled()
  })

  it('without workers, or when the queue refuses: read in this process instead', async () => {
    vi.stubEnv('ENABLE_QUEUE_WORKERS', '')
    expect(await enqueueGoogleAdsSync({ kind: 'DAILY' })).toEqual({ queued: true, reason: null })
    await settle()
    expect(h.add).not.toHaveBeenCalled()
    expect(h.sync).toHaveBeenCalledWith('1234567890', 'DAILY')

    h.sync.mockClear()
    vi.stubEnv('ENABLE_QUEUE_WORKERS', '1')
    h.add.mockRejectedValueOnce(new Error('Redis is down'))
    expect(await enqueueGoogleAdsSync({ kind: 'DAILY' })).toEqual({ queued: true, reason: null })
    await settle()
    expect(h.sync).toHaveBeenCalledWith('1234567890', 'DAILY')
  })

  it('manual: refused within an hour of the last read, with the times in words', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-13T07:00:00Z'), toFake: ['Date'] })
    h.lastSyncAt = new Date('2026-10-13T06:25:00Z')
    expect(await enqueueGoogleAdsSync({ kind: 'MANUAL' })).toEqual({
      queued: false,
      reason: 'Nexus read this Google Ads account at 06:25 UTC. It reads it again on request at most once an hour: ask again after 07:25 UTC.',
    })
    expect(h.add).not.toHaveBeenCalled()
  })

  it('manual: one ask an hour per account across processes (Redis), the second refused', async () => {
    h.lastSyncAt = new Date(Date.now() - 2 * 3600_000)
    expect(await enqueueGoogleAdsSync({ kind: 'MANUAL' })).toEqual({ queued: true, reason: null })
    expect(h.set).toHaveBeenCalledWith(expect.stringMatching(/^nexus:gads:manual:.+:1234567890$/), expect.any(String), 'PX', 3_600_000, 'NX')
    h.set.mockResolvedValueOnce(null)
    expect(await enqueueGoogleAdsSync({ kind: 'MANUAL' })).toEqual({ queued: false, reason: expect.stringMatching(/less than an hour ago/) })
    expect(h.add).toHaveBeenCalledTimes(1)
  })

  it('manual without Redis: this process remembers the hour', async () => {
    vi.stubEnv('REDIS_URL', '')
    vi.stubEnv('REDIS_HOST', '')
    h.targets = [{ ...TARGET, customerId: '5550001119' }]
    expect(await enqueueGoogleAdsSync({ kind: 'MANUAL' })).toEqual({ queued: true, reason: null })
    expect(await enqueueGoogleAdsSync({ kind: 'MANUAL' })).toEqual({ queued: false, reason: expect.stringMatching(/less than an hour ago/) })
    expect(h.set).not.toHaveBeenCalled()
  })
})
