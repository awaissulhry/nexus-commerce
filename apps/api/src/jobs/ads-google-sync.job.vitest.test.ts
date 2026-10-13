/**
 * Google Ads step 1a — the daily read's cron (ads-google-sync.job.ts) and worker (workers/google-ads-sync.worker.ts):
 * 06:25 UTC through the cluster-safe wrapper, moved by NEXUS_GOOGLE_ADS_SYNC_SCHEDULE, nothing at all while
 * NEXUS_GOOGLE_ADS_SYNC=off; a business without a chosen Google Ads account makes no call and records no run; with
 * workers the reads are queued, without them they run in the tick; the worker reads one account per job.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  schedule: vi.fn((..._args: unknown[]) => ({ stop: vi.fn() })),
  recorded: [] as Array<{ job: string; summary: unknown }>,
  targets: [] as Array<{ connectionId: string; customerId: string; loginCustomerId: string | null }>,
  listed: 0,
  enqueue: vi.fn(async (_input: unknown) => ({ queued: true, reason: null as string | null })),
  syncAccount: vi.fn(async (target: { customerId: string }, options: { kind: string }) => ({ customerId: target.customerId, kind: options.kind, status: 'SUCCESS', mode: 'DAILY', ops: 4, campaigns: 2, metricRows: 28, changeEvents: 1 })),
  syncCustomer: vi.fn(async (customerId: string, kind: string) => ({ customerId, kind, status: 'SUCCESS', ops: 4 })),
}))
vi.mock('../lib/cron/clustered.js', () => ({ default: { schedule: h.schedule } }))
vi.mock('../utils/cron-observability.js', () => ({
  recordCronRun: vi.fn(async (job: string, run: () => Promise<unknown>) => { const summary = await run(); h.recorded.push({ job, summary }); return summary }),
}))
vi.mock('../services/marketing/google-ads/targets.js', () => ({ listReadTargets: vi.fn(async () => { h.listed++; return h.targets }) }))
vi.mock('../services/marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: h.enqueue, GOOGLE_ADS_SYNC_QUEUE: 'google-ads-sync' }))
vi.mock('../services/marketing/google-ads/sync.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/marketing/google-ads/sync.service.js')>()
  return { syncSummaryLine: real.syncSummaryLine, syncGoogleAdsAccount: h.syncAccount, syncGoogleAdsCustomer: h.syncCustomer }
})
vi.mock('../lib/queue.js', () => ({ redis: { connection: {} } }))
vi.mock('../lib/workspace-jobs.js', () => ({ WorkspaceWorker: class { on() { return this } } }))

import { GOOGLE_ADS_SYNC_JOB, runGoogleAdsSyncTick as tickOutsideABusiness, startGoogleAdsSyncCron } from './ads-google-sync.job.js'
import { withWorkspace } from '../lib/workspace-context.js'
import { nextGoogleAdsReadAt } from '../services/marketing/google-ads/sync-switch.js'
import { processGoogleAdsSyncJob } from '../workers/google-ads-sync.worker.js'

const TARGET = { connectionId: 'g-conn-1', customerId: '1234567890', loginCustomerId: null }
const NOW = new Date('2026-10-13T06:25:00Z')
/** The clustered cron runs each tick inside one business. */
const runGoogleAdsSyncTick = (now: Date) => withWorkspace({ workspaceId: 'gads_job_alpha', actorUserId: null, membershipId: null, roleKeys: [] }, () => tickOutsideABusiness(now))

beforeEach(() => {
  h.schedule.mockClear(); h.recorded = []; h.targets = []; h.listed = 0
  h.enqueue.mockClear(); h.syncAccount.mockClear(); h.syncCustomer.mockClear()
  vi.stubEnv('NEXUS_GOOGLE_ADS_SYNC', '')
  vi.stubEnv('NEXUS_GOOGLE_ADS_SYNC_SCHEDULE', '')
  vi.stubEnv('ENABLE_QUEUE_WORKERS', '1')
})
afterEach(() => { vi.unstubAllEnvs() })

describe('the daily Google Ads read — schedule', () => {
  it('06:25 UTC through the cluster-safe wrapper, once', async () => {
    vi.resetModules()
    const job = await import('./ads-google-sync.job.js')
    job.startGoogleAdsSyncCron()
    job.startGoogleAdsSyncCron()
    expect(h.schedule).toHaveBeenCalledTimes(1)
    expect(h.schedule).toHaveBeenCalledWith('25 6 * * *', expect.any(Function), expect.objectContaining({ timezone: 'Etc/UTC' }))
  })

  it('NEXUS_GOOGLE_ADS_SYNC_SCHEDULE moves it; a line that is not a cron line is ignored', async () => {
    vi.stubEnv('NEXUS_GOOGLE_ADS_SYNC_SCHEDULE', '40 7 * * *')
    vi.resetModules()
    ;(await import('./ads-google-sync.job.js')).startGoogleAdsSyncCron()
    expect(h.schedule).toHaveBeenLastCalledWith('40 7 * * *', expect.any(Function), expect.anything())
    vi.stubEnv('NEXUS_GOOGLE_ADS_SYNC_SCHEDULE', 'every morning')
    vi.resetModules()
    ;(await import('./ads-google-sync.job.js')).startGoogleAdsSyncCron()
    expect(h.schedule).toHaveBeenLastCalledWith('25 6 * * *', expect.any(Function), expect.anything())
  })

  it('NEXUS_GOOGLE_ADS_SYNC=off: nothing scheduled, and a tick does nothing', async () => {
    vi.stubEnv('NEXUS_GOOGLE_ADS_SYNC', 'off')
    startGoogleAdsSyncCron()
    expect(h.schedule).not.toHaveBeenCalled()
    h.targets = [TARGET]
    expect(await runGoogleAdsSyncTick(NOW)).toBeNull()
    expect(h.listed).toBe(0)
    expect(h.recorded).toEqual([])
  })

  it('the manual "Run now" is registered under the run record\'s name', () => {
    expect(GOOGLE_ADS_SYNC_JOB).toBe('google-ads-sync')
    // Read as text: loading the registry loads every job of the platform.
    expect(readFileSync(new URL('./cron-registry.ts', import.meta.url), 'utf8'))
      .toContain("'google-ads-sync': () => import('./ads-google-sync.job.js').then((m) => m.runGoogleAdsSyncOnce(new Date(), 'MANUAL'))")
  })
})

describe('the daily Google Ads read — one tick in one business', () => {
  it('no chosen Google Ads account: no call, no run record', async () => {
    expect(await runGoogleAdsSyncTick(NOW)).toBeNull()
    expect(h.recorded).toEqual([])
    expect(h.enqueue).not.toHaveBeenCalled()
    expect(h.syncAccount).not.toHaveBeenCalled()
  })

  it('with workers: the daily read queued, one run record', async () => {
    h.targets = [TARGET]
    expect(await runGoogleAdsSyncTick(NOW)).toBe('queued the daily read of 1 Google Ads account')
    expect(h.enqueue).toHaveBeenCalledWith({ kind: 'DAILY' })
    expect(h.recorded).toEqual([{ job: 'google-ads-sync', summary: 'queued the daily read of 1 Google Ads account' }])
    expect(h.syncAccount).not.toHaveBeenCalled()
  })

  it('without workers: each account read in the tick, its outcome in the run record', async () => {
    vi.stubEnv('ENABLE_QUEUE_WORKERS', '')
    h.targets = [TARGET]
    const summary = await runGoogleAdsSyncTick(NOW)
    expect(h.syncAccount).toHaveBeenCalledWith(TARGET, { kind: 'DAILY', now: NOW })
    expect(summary).toBe('7890: SUCCESS DAILY ops=4 campaigns=2 days=28 changes=1')
    expect(h.enqueue).not.toHaveBeenCalled()
  })
})

describe('the cron registry\'s "Run now"', () => {
  it('a read asked for by a person: through the once-an-hour rule, with or without workers, its answer in the run record', async () => {
    const { runGoogleAdsSyncOnce } = await import('./ads-google-sync.job.js')
    vi.stubEnv('ENABLE_QUEUE_WORKERS', '')
    h.targets = [TARGET]
    h.enqueue.mockResolvedValueOnce({ queued: false, reason: 'Nexus read this Google Ads account at 06:25 UTC.' })
    expect(await runGoogleAdsSyncOnce(NOW, 'MANUAL')).toBe('not queued: Nexus read this Google Ads account at 06:25 UTC.')
    expect(h.enqueue).toHaveBeenCalledWith({ kind: 'MANUAL' })
    expect(h.syncAccount).not.toHaveBeenCalled()
    expect(await runGoogleAdsSyncOnce(NOW, 'MANUAL')).toBe('queued a read of 1 Google Ads account')
  })
})

describe('the worker', () => {
  it('reads the account the job names, in the job\'s business; a malformed job or the kill switch makes no call', async () => {
    expect(await processGoogleAdsSyncJob({ customerId: '1234567890', kind: 'BACKFILL' })).toEqual({ skipped: false, status: 'SUCCESS', ops: 4 })
    expect(h.syncCustomer).toHaveBeenCalledWith('1234567890', 'BACKFILL')
    expect(await processGoogleAdsSyncJob({ customerId: '123-456', kind: 'DAILY' })).toEqual({ skipped: true })
    expect(await processGoogleAdsSyncJob({ customerId: '1234567890', kind: 'WRITE' as never })).toEqual({ skipped: true })
    vi.stubEnv('NEXUS_GOOGLE_ADS_SYNC', 'off')
    expect(await processGoogleAdsSyncJob({ customerId: '1234567890', kind: 'DAILY' })).toEqual({ skipped: true })
    expect(h.syncCustomer).toHaveBeenCalledTimes(1)
  })
})

describe('nextGoogleAdsReadAt', () => {
  it('the next 06:25 UTC; none when the schedule is not a plain daily time or reading is off', () => {
    expect(nextGoogleAdsReadAt(new Date('2026-10-13T05:00:00Z'))?.toISOString()).toBe('2026-10-13T06:25:00.000Z')
    expect(nextGoogleAdsReadAt(new Date('2026-10-13T06:25:00Z'))?.toISOString()).toBe('2026-10-14T06:25:00.000Z')
    expect(nextGoogleAdsReadAt(new Date('2026-12-31T23:00:00Z'))?.toISOString()).toBe('2027-01-01T06:25:00.000Z')
    vi.stubEnv('NEXUS_GOOGLE_ADS_SYNC_SCHEDULE', '*/30 6 * * 1')
    expect(nextGoogleAdsReadAt(NOW)).toBeNull()
    vi.stubEnv('NEXUS_GOOGLE_ADS_SYNC_SCHEDULE', '')
    vi.stubEnv('NEXUS_GOOGLE_ADS_SYNC', 'off')
    expect(nextGoogleAdsReadAt(NOW)).toBeNull()
  })
})
