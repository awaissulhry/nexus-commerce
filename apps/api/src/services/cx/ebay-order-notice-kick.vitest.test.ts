/**
 * eBay order notices, Phase 4 — when the receiver asks the worker to run a stored notice now, and when it must not.
 * The queue is a stub here; the claim race and the sweep fallback run on a real PostgreSQL
 * (workers/ebay-order-notice-postgres.vitest.test.ts), BullMQ's own id dedupe on a real Redis
 * (workers/ebay-order-notice-redis.vitest.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Job } from 'bullmq'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'

const state = vi.hoisted(() => ({ add: vi.fn(), businesses: [] as string[] }))
vi.mock('../../lib/queue.js', () => ({ ebayOrderNoticeQueue: { name: 'ebay-order-notice' }, addJobSafely: state.add }))
vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
const { kickStoredEbayOrderNotice, ebayOrderNoticeJobId } = await import('./ebay-order-notice-kick.js')
const { logger } = await import('../../utils/logger.js')

const notice = (topic: string, notificationId = 'synthetic-notice') => Buffer.from(JSON.stringify({
  metadata: { topic, schemaVersion: '1.0' },
  notification: { notificationId, publishDate: '2026-10-06T10:00:01.000Z', data: { order: { orderId: 'synthetic-order' } } },
}))
const accepted = (receiptId = 'receipt-1', workspaceId = 'business-a', duplicate = false) => ({ kind: 'accepted' as const, receiptId, workspaceId, duplicate })
const ORDER = notice('ORDER_CONFIRMATION')

/** BullMQ's own id rule, offline, as lib/bullmq-job-ids.vitest.test.ts checks it. */
function bullmqRefusal(jobId: string): string | null {
  const queue = { opts: {}, keys: {}, toKey: (key: string) => key, qualifiedName: 'bull:check', client: Promise.resolve({}) }
  try {
    const job = new Job(queue as never, 'check', {}, { jobId })
    ;(job as unknown as { validateOptions(data: unknown): void }).validateOptions(job.asJSON())
    return null
  } catch (error) { return error instanceof Error ? error.message : String(error) }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.businesses = []
  state.add.mockImplementation(async () => { state.businesses.push(workspaceIdForQuery()); return { enqueued: true } })
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '1')
  vi.stubEnv('NEXUS_ENABLE_EBAY_ORDER_NOTICES', '1')
  vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '1')
})
afterEach(() => vi.unstubAllEnvs())

describe('kickStoredEbayOrderNotice', () => {
  it('asks for exactly one job for a routed order notice, in the receipt\'s own business', async () => {
    expect(await kickStoredEbayOrderNotice(accepted('receipt-1', 'business-a'), ORDER)).toEqual({ kicked: true })
    expect(state.add).toHaveBeenCalledExactlyOnceWith({ name: 'ebay-order-notice' }, 'process-receipt', { receiptId: 'receipt-1' }, { jobId: 'ebay-order-notice-receipt-1' })
    expect(state.businesses).toEqual(['business-a'])
  })

  it('names the job by the receipt, so a redelivered notice asks for the same job (and BullMQ accepts the id)', async () => {
    await kickStoredEbayOrderNotice(accepted('receipt-2', 'business-b'), ORDER)
    await kickStoredEbayOrderNotice(accepted('receipt-2', 'business-b', true), ORDER)
    const ids = state.add.mock.calls.map(call => call[3].jobId)
    expect(ids).toEqual(['ebay-order-notice-receipt-2', 'ebay-order-notice-receipt-2'])
    expect(ebayOrderNoticeJobId('cmuq0qwvo0033n7s4gs9klmj5')).toBe('ebay-order-notice-cmuq0qwvo0033n7s4gs9klmj5')
    expect(bullmqRefusal(ebayOrderNoticeJobId('cmuq0qwvo0033n7s4gs9klmj5'))).toBeNull()
    // WorkspaceQueue prefixes "w_<business>_" (lib/workspace-jobs.ts): still valid.
    expect(bullmqRefusal(`w_business-b_${ebayOrderNoticeJobId('cmuq0qwvo0033n7s4gs9klmj5')}`)).toBeNull()
  })

  it.each([
    [{ kind: 'quarantined' as const, quarantineId: 'q-1', reason: 'owner_unknown' }],
    [{ kind: 'quarantined' as const, quarantineId: 'q-2', reason: 'subject_or_topic_unresolved' }],
    [{ kind: 'rejected' as const, quarantineId: 'q-3', reason: 'signature_mismatch' }],
  ])('never kicks a notice admission did not route to a business: %o', async outcome => {
    expect(await kickStoredEbayOrderNotice(outcome, ORDER)).toEqual({ kicked: false, reason: 'not_routed' })
    expect(state.add).not.toHaveBeenCalled()
  })

  it.each([
    ['an authorization revocation', notice('AUTHORIZATION_REVOCATION')],
    ['an account deletion', notice('MARKETPLACE_ACCOUNT_DELETION')],
    ['an unreadable body', Buffer.from('{"metadata":')],
    ['a body without a notification id', Buffer.from(JSON.stringify({ metadata: { topic: 'ORDER_CONFIRMATION' } }))],
  ])('leaves %s to the sweep', async (_label, body) => {
    expect(await kickStoredEbayOrderNotice(accepted(), body)).toEqual({ kicked: false, reason: 'not_an_order_notice' })
    expect(state.add).not.toHaveBeenCalled()
  })

  it.each([
    ['eBay inbound processing unset', 'NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', ''],
    ['eBay inbound processing off', 'NEXUS_ENABLE_EBAY_INBOUND_PROCESSING', '0'],
    ['order notices unset', 'NEXUS_ENABLE_EBAY_ORDER_NOTICES', ''],
    ['order notices off', 'NEXUS_ENABLE_EBAY_ORDER_NOTICES', '0'],
    ['the token service off', 'NEXUS_CX_TOKEN_SERVICE', '0'],
  ])('asks for nothing while the notice is held: %s', async (_label, name, value) => {
    vi.stubEnv(name, value)
    expect(await kickStoredEbayOrderNotice(accepted(), ORDER)).toEqual({ kicked: false, reason: 'held' })
    expect(state.add).not.toHaveBeenCalled()
  })

  it('never throws when the queue fails, and logs no notice body', async () => {
    state.add.mockRejectedValueOnce(new Error('synthetic redis failure with a private body'))
    expect(await kickStoredEbayOrderNotice(accepted('receipt-3'), ORDER)).toEqual({ kicked: false, reason: 'enqueue_failed' })
    state.add.mockImplementationOnce(() => { throw new Error('synthetic synchronous failure') })
    expect(await kickStoredEbayOrderNotice(accepted('receipt-3'), ORDER)).toEqual({ kicked: false, reason: 'enqueue_failed' })
    state.add.mockResolvedValueOnce({ enqueued: false, timedOut: true })
    expect(await kickStoredEbayOrderNotice(accepted('receipt-3'), ORDER)).toEqual({ kicked: false, reason: 'enqueue_failed' })
    state.add.mockResolvedValueOnce({ enqueued: false, skipped: true })
    expect(await kickStoredEbayOrderNotice(accepted('receipt-3'), ORDER)).toEqual({ kicked: false, reason: 'enqueue_failed' })
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(4)
    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls)
    expect(logged).not.toContain('private body')
    expect(logged).not.toContain('synthetic-order')
  })

  it('reports workers switched off without a warning (the sweep runs it, by configuration)', async () => {
    state.add.mockResolvedValueOnce({ enqueued: false, skipped: true, workersOff: true })
    expect(await kickStoredEbayOrderNotice(accepted(), ORDER)).toEqual({ kicked: false, reason: 'workers_off' })
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled()
  })
})
