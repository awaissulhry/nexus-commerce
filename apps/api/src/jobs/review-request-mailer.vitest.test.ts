/**
 * Reviews area PR C (B9) — the ONE sender. `runReviewMailerOnce({ onlyIds })` ("Send now" on the Requests page) sends
 * only those requests: no delivery sweep, no scheduling of new orders, no other failed request brought back. Every
 * run says what it did per channel and per market; a paused business sends nothing.
 *
 * Everything outside is mocked: the database is a fake, Amazon's "Request a Review" and our e-mail are spies.
 * Nothing is sent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  reviewRequest: { updateMany: vi.fn(async () => ({ count: 0 })), findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
  reviewSentimentCheck: { update: vi.fn(async () => ({})) },
}))
const spies = vi.hoisted(() => ({
  schedulePendingOrders: vi.fn(async () => ({ examined: 0, scheduled: 0, skipped: 0, errors: 0 })),
  sendAmazonSolicitation: vi.fn(),
  sendReviewRequestEmail: vi.fn(),
  sendSentimentCheckEmail: vi.fn(),
  readReviewMailerState: vi.fn(async () => ({ isPaused: false, pausedReason: null, pausedAt: null, pausedBy: null })),
  applyShipDeliveryHeuristic: vi.fn(async () => ({ scanned: 0, updated: 0 })),
}))

vi.mock('../db.js', () => ({ default: db }))
vi.mock('../lib/cron/clustered.js', () => ({ default: { schedule: vi.fn(), validate: vi.fn(() => true) } }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()) }))
vi.mock('../services/reviews/review-scheduler.service.js', () => ({ schedulePendingOrders: spies.schedulePendingOrders, buildReviewUrl: vi.fn(() => 'https://review.example/leave') }))
vi.mock('../services/reviews/amazon-solicitations.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendAmazonSolicitation: spies.sendAmazonSolicitation,
}))
vi.mock('../services/reviews/review-request-email.service.js', () => ({ sendReviewRequestEmail: spies.sendReviewRequestEmail }))
vi.mock('../services/reviews/sentiment-check-email.service.js', () => ({ sendSentimentCheckEmail: spies.sendSentimentCheckEmail, resolveLocaleForMarketplace: vi.fn(() => 'it') }))
vi.mock('../services/reviews/review-mailer-state.service.js', () => ({ readReviewMailerState: spies.readReviewMailerState }))
vi.mock('../services/reviews/orders-delivered-backfill.service.js', () => ({ applyShipDeliveryHeuristic: spies.applyShipDeliveryHeuristic }))
vi.mock('../services/reviews/review-pipeline-health.service.js', () => ({
  computeReviewPipelineFreshness: vi.fn(async () => ({ deliveryStale: false, schedulingStalled: false, warnings: [] })),
}))

import { runReviewMailerOnce } from './review-request-mailer.job.js'

const DAY = 86_400_000
const due = (id: string, channel: string, marketplace: string | null, deliveredDaysAgo: number, over: Record<string, unknown> = {}) => ({
  id, status: 'SCHEDULED', attemptCount: 0, sentimentCheck: null, rule: { fallbackOnNoResponse: true },
  order: {
    id: `o-${id}`, channel, channelOrderId: `ORDER-${id}`, marketplace, deliveredAt: new Date(Date.now() - deliveredDaysAgo * DAY),
    customerEmail: `${id}@example.com`, customerName: 'Test Buyer', items: [{ product: { name: 'Test jacket', productType: 'jacket' } }],
  },
  ...over,
})
const TOO_EARLY = "HTTP 403 — You can't use this feature to request a review outside the 5-30 day range after the order delivery date."

beforeEach(() => {
  vi.clearAllMocks()
  spies.readReviewMailerState.mockResolvedValue({ isPaused: false, pausedReason: null, pausedAt: null, pausedBy: null })
  db.reviewRequest.findMany.mockResolvedValue([])
})

describe('runReviewMailerOnce', () => {
  it('onlyIds: sends only those requests; no sweep, no scheduling, no retries brought back', async () => {
    db.reviewRequest.findMany.mockResolvedValue([due('r1', 'AMAZON', 'IT', 8)])
    spies.sendAmazonSolicitation.mockResolvedValue({ ok: true, errorCode: 'OK' })
    const result = await runReviewMailerOnce({ onlyIds: ['r1', 'r1', 'r2'] })

    const where = db.reviewRequest.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({ status: 'SCHEDULED', id: { in: ['r1', 'r2'] } })
    expect(spies.applyShipDeliveryHeuristic).not.toHaveBeenCalled()
    expect(spies.schedulePendingOrders).not.toHaveBeenCalled()
    expect(db.reviewRequest.updateMany).not.toHaveBeenCalled()
    expect(spies.sendAmazonSolicitation).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ sent: 1, scheduled: 0, retried: 0, byChannel: { AMAZON: { sent: 1, failed: 0, skipped: 0, tooEarly: 0 } }, byMarket: { 'AMAZON:IT': { sent: 1 } } })
  })

  it('onlyIds empty: nothing is read or sent', async () => {
    const result = await runReviewMailerOnce({ onlyIds: [] })
    expect(db.reviewRequest.findMany).not.toHaveBeenCalled()
    expect(spies.sendAmazonSolicitation).not.toHaveBeenCalled()
    expect(result).toMatchObject({ sent: 0, due: 0, byChannel: {}, byMarket: {} })
  })

  it('the hourly run: sweeps, schedules, brings retries back, and counts per channel and market', async () => {
    db.reviewRequest.findMany.mockResolvedValue([
      due('a1', 'AMAZON', 'IT', 8),
      due('a2', 'AMAZON', 'DE', 6),
      due('a3', 'AMAZON', 'DE', 2),
      due('e1', 'EBAY', 'IT', 12),
      due('s1', 'SHOPIFY', null, 12),
    ])
    spies.sendAmazonSolicitation.mockImplementation(async ({ amazonOrderId }: { amazonOrderId: string }) =>
      amazonOrderId === 'ORDER-a2' ? { ok: false, errorCode: 'OUTSIDE_WINDOW', errorMessage: TOO_EARLY } : { ok: true, errorCode: 'OK' })
    spies.sendReviewRequestEmail.mockImplementation(async ({ channel }: { channel: string }) =>
      channel === 'EBAY' ? { ok: true, dryRun: false } : { ok: false, dryRun: false, error: 'boom' })

    const result = await runReviewMailerOnce()

    expect(spies.applyShipDeliveryHeuristic).toHaveBeenCalledTimes(1)
    expect(spies.schedulePendingOrders).toHaveBeenCalledTimes(1)
    expect(db.reviewRequest.updateMany).toHaveBeenCalledTimes(1)
    expect(db.reviewRequest.findMany.mock.calls[0][0].where.id).toBeUndefined()
    // a3 is before our day 4: not sent, waits.
    expect(spies.sendAmazonSolicitation).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ sent: 2, failed: 1, skipped: 2, tooEarly: 2 })
    expect(result.byChannel).toEqual({
      AMAZON: { sent: 1, failed: 0, skipped: 0, tooEarly: 2 },
      EBAY: { sent: 1, failed: 0, skipped: 0, tooEarly: 0 },
      SHOPIFY: { sent: 0, failed: 1, skipped: 0, tooEarly: 0 },
    })
    expect(result.byMarket).toEqual({
      'AMAZON:IT': { sent: 1, failed: 0, skipped: 0, tooEarly: 0 },
      'AMAZON:DE': { sent: 0, failed: 0, skipped: 0, tooEarly: 2 },
      'EBAY:IT': { sent: 1, failed: 0, skipped: 0, tooEarly: 0 },
      'SHOPIFY:': { sent: 0, failed: 1, skipped: 0, tooEarly: 0 },
    })
    // Amazon's "too early" stays queued for tomorrow; it uses up no try.
    const a2 = db.reviewRequest.update.mock.calls.find(([arg]) => arg.where.id === 'a2')![0].data
    expect(a2).toMatchObject({ status: 'SCHEDULED', providerResponseCode: 'OUTSIDE_WINDOW' })
    expect(a2.attemptCount).toBeUndefined()
  })

  it('email sending switched off: our email requests are SKIPPED in words, never SENT', async () => {
    db.reviewRequest.findMany.mockResolvedValue([due('e1', 'EBAY', 'IT', 12), due('s1', 'SHOPIFY', null, 12)])
    spies.sendReviewRequestEmail.mockResolvedValue({ ok: true, dryRun: true })
    const result = await runReviewMailerOnce({ onlyIds: ['e1', 's1'] })
    expect(result).toMatchObject({ sent: 0, skipped: 2 })
    for (const id of ['e1', 's1']) {
      const data = db.reviewRequest.update.mock.calls.find(([arg]) => arg.where.id === id)![0].data
      expect(data).toMatchObject({ status: 'SKIPPED', providerResponseCode: 'EMAIL_OFF', suppressedReason: 'Email sending is off' })
      expect(data.sentAt).toBeUndefined()
    }
  })

  it('paused: nothing is read or sent, also with onlyIds', async () => {
    spies.readReviewMailerState.mockResolvedValue({ isPaused: true, pausedReason: 'checking a rule', pausedAt: new Date(), pausedBy: 'user-1' })
    const result = await runReviewMailerOnce({ onlyIds: ['r1'] })
    expect(result).toMatchObject({ paused: true, sent: 0, byChannel: {}, byMarket: {} })
    expect(db.reviewRequest.findMany).not.toHaveBeenCalled()
    expect(spies.sendAmazonSolicitation).not.toHaveBeenCalled()
    expect(spies.sendReviewRequestEmail).not.toHaveBeenCalled()
  })
})
