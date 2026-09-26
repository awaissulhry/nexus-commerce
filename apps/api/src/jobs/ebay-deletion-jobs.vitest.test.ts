/** eBay deletion notices: reviewed by one platform tick after acknowledgement; dormant behind the switch. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ platform: [] as Array<{ expression: string; handler: () => Promise<void> }>, review: vi.fn(), expire: vi.fn(), record: [] as string[] }))
vi.mock('../lib/cron/clustered.js', () => ({
  default: { schedule: vi.fn(() => ({ stop: vi.fn() })), validate: () => true },
  schedulePlatform: vi.fn((expression: string, handler: () => Promise<void>) => { state.platform.push({ expression, handler }); return { stop: vi.fn() } }),
}))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: vi.fn(async (name: string, work: () => Promise<string>) => { state.record.push(name); return work() }) }))
vi.mock('../services/cx/ingress/ebay-erasure-review.js', () => ({ reviewPendingEbayDeletions: state.review, expireEbayDeletionNotices: state.expire }))
vi.mock('../services/cx/ingress/archive.js', () => ({ archiveCompletedInbound: vi.fn() }))
vi.mock('../services/cx/ingress/ebay-processing.js', () => ({ dueEbayInboundEvents: async () => [], processEbayInbound: vi.fn(), ebayInboundProcessingEnabled: () => false }))
vi.mock('../services/cx/ingress/ledger.js', () => ({ dueInboundEvents: async () => [], isVerifiedInbound: () => true, completeInbound: vi.fn(), deadLetterInbound: vi.fn() }))
vi.mock('../services/cx/ingress/handlers.js', () => ({ canReplayInbound: () => false, inboundHandlerFor: async () => null }))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
const { startInboundRetryCron } = await import('./inbound-retry.job.js')
const { startRetentionSweepCron } = await import('./data-retention-sweep.job.js')
const tick = (name: string) => state.platform.find(entry => entry.expression === name)

beforeEach(() => {
  state.review.mockResolvedValue({ kind: 'reviewed', claimed: 1, reviewed: 1, unsupported: 0, failed: 0 })
  state.expire.mockResolvedValue({ kind: 'expired', expired: 0, limitReached: false })
})
afterEach(() => { vi.unstubAllEnvs(); state.record = []; state.review.mockReset(); state.expire.mockReset() })

it('schedules deletion review once per platform tick with the retry cadence, and keeps it dormant unless the switch is exactly 1', async () => {
  vi.stubEnv('NEXUS_INBOUND_RETRY_SCHEDULE', '*/2 * * * *')
  startInboundRetryCron()
  const review = tick('*/2 * * * *')
  expect(review).toBeDefined()
  for (const value of [undefined, '', '0', 'true']) {
    vi.stubEnv('NEXUS_ENABLE_EBAY_PRIVACY_REVIEW', value)
    await review!.handler()
  }
  expect(state.review).not.toHaveBeenCalled(); expect(state.record).toEqual([])
  vi.stubEnv('NEXUS_ENABLE_EBAY_PRIVACY_REVIEW', '1')
  await review!.handler()
  expect(state.review).toHaveBeenCalledOnce(); expect(state.record).toEqual(['ebay-deletion-review'])
})

it('expires deletion notices once per platform tick on the retention schedule, only with both switches on', async () => {
  vi.stubEnv('NEXUS_RETENTION_SWEEP_SCHEDULE', '7 3 * * *')
  startRetentionSweepCron()
  const expiry = tick('7 3 * * *')
  expect(expiry).toBeDefined()
  for (const [retention, privacy] of [[undefined, undefined], [undefined, '0'], [undefined, 'true'], ['0', '1']]) {
    vi.stubEnv('NEXUS_ENABLE_RETENTION_SWEEP', retention); vi.stubEnv('NEXUS_ENABLE_EBAY_PRIVACY_REVIEW', privacy)
    await expiry!.handler()
  }
  expect(state.expire).not.toHaveBeenCalled(); expect(state.record).toEqual([])
  vi.stubEnv('NEXUS_ENABLE_RETENTION_SWEEP', undefined); vi.stubEnv('NEXUS_ENABLE_EBAY_PRIVACY_REVIEW', '1')
  await expiry!.handler()
  expect(state.expire).toHaveBeenCalledOnce(); expect(state.record).toEqual(['ebay-deletion-notice-expiry'])
})
