/**
 * Reviews area PR C (B9) — the ONE sender. `runReviewMailerOnce({ onlyIds })` ("Send now" on the Requests page) sends
 * only those requests: no delivery sweep, no scheduling of new orders, no other failed request brought back. Every
 * run says what it did per channel and per market; a paused business sends nothing.
 *
 * Everything outside is mocked: the database is a fake, Amazon's "Request a Review" and our e-mail are spies.
 * Nothing is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  reviewRequest: { updateMany: vi.fn(async () => ({ count: 0 })), findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
  reviewSentimentCheck: { update: vi.fn(async () => ({})) },
  reviewSendWindow: { findMany: vi.fn(async () => [] as unknown[]) },
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
  db.reviewSendWindow.findMany.mockResolvedValue([])
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
    spies.sendReviewRequestEmail.mockResolvedValue({ ok: false, dryRun: false, error: 'boom' })

    const result = await runReviewMailerOnce()

    expect(spies.applyShipDeliveryHeuristic).toHaveBeenCalledTimes(1)
    expect(spies.schedulePendingOrders).toHaveBeenCalledTimes(1)
    expect(db.reviewRequest.updateMany).toHaveBeenCalledTimes(1)
    expect(db.reviewRequest.findMany.mock.calls[0][0].where.id).toBeUndefined()
    // a3 is before our day 4: not sent, waits.
    expect(spies.sendAmazonSolicitation).toHaveBeenCalledTimes(2)
    // e1 (eBay) is not e-mailed: eBay asks the buyer itself (Owner, 2026-10-27). Only s1 (Shopify) gets our e-mail.
    expect(spies.sendReviewRequestEmail).toHaveBeenCalledTimes(1)
    expect(spies.sendReviewRequestEmail.mock.calls[0][0]).toMatchObject({ channel: 'SHOPIFY' })
    expect(result).toMatchObject({ sent: 1, failed: 1, skipped: 3, tooEarly: 2 })
    expect(result.byChannel).toEqual({
      AMAZON: { sent: 1, failed: 0, skipped: 0, tooEarly: 2 },
      EBAY: { sent: 0, failed: 0, skipped: 1, tooEarly: 0 },
      SHOPIFY: { sent: 0, failed: 1, skipped: 0, tooEarly: 0 },
    })
    expect(result.byMarket).toEqual({
      'AMAZON:IT': { sent: 1, failed: 0, skipped: 0, tooEarly: 0 },
      'AMAZON:DE': { sent: 0, failed: 0, skipped: 0, tooEarly: 2 },
      'EBAY:IT': { sent: 0, failed: 0, skipped: 1, tooEarly: 0 },
      'SHOPIFY:': { sent: 0, failed: 1, skipped: 0, tooEarly: 0 },
    })
    // Amazon's "too early" stays queued for tomorrow; it uses up no try.
    const a2 = db.reviewRequest.update.mock.calls.find(([arg]) => arg.where.id === 'a2')![0].data
    expect(a2).toMatchObject({ status: 'SCHEDULED', providerResponseCode: 'OUTSIDE_WINDOW' })
    expect(a2.attemptCount).toBeUndefined()
  })

  it('email sending switched off: our email requests are SKIPPED in words, never SENT', async () => {
    db.reviewRequest.findMany.mockResolvedValue([due('s1', 'SHOPIFY', null, 12), due('s2', 'SHOPIFY', 'IT', 12)])
    spies.sendReviewRequestEmail.mockResolvedValue({ ok: true, dryRun: true })
    const result = await runReviewMailerOnce({ onlyIds: ['s1', 's2'] })
    expect(result).toMatchObject({ sent: 0, skipped: 2 })
    for (const id of ['s1', 's2']) {
      const data = db.reviewRequest.update.mock.calls.find(([arg]) => arg.where.id === id)![0].data
      expect(data).toMatchObject({ status: 'SKIPPED', providerResponseCode: 'EMAIL_OFF', suppressedReason: 'Email sending is off' })
      expect(data.sentAt).toBeUndefined()
    }
  })

  it('eBay: never e-mailed (Owner, 2026-10-27) — a waiting eBay request ends not asked, before any e-mail, the "How was it?" check included', async () => {
    const check = { id: 'c1', token: 'TOKEN', response: 'NONE', sentimentEmailSentAt: null }
    db.reviewRequest.findMany.mockResolvedValue([due('e1', 'EBAY', 'DE', 12), due('e2', 'EBAY', 'IT', 12, { sentimentCheck: check })])
    spies.sendReviewRequestEmail.mockResolvedValue({ ok: true, dryRun: false })
    spies.sendSentimentCheckEmail.mockResolvedValue({ ok: true, dryRun: false })
    const result = await runReviewMailerOnce({ onlyIds: ['e1', 'e2'] })
    expect(spies.sendReviewRequestEmail).not.toHaveBeenCalled()
    expect(spies.sendSentimentCheckEmail).not.toHaveBeenCalled()
    expect(db.reviewSentimentCheck.update).not.toHaveBeenCalled()
    expect(result).toMatchObject({ sent: 0, failed: 0, skipped: 2, sentimentEmails: 0 })
    for (const id of ['e1', 'e2']) {
      const data = db.reviewRequest.update.mock.calls.find(([arg]) => arg.where.id === id)![0].data
      expect(data).toEqual({ status: 'SKIPPED', providerResponseCode: 'EBAY_ASKS', suppressedReason: 'Not sent — eBay asks the buyer for feedback itself', nextRetryAt: null })
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

// Live audit B05 — many Amazon requests went out between 22:00 and 06:00, every one a retry: the hourly run sent a
// due row at whatever hour it ran, and "too early" retries were set to now + 24 h (an hour later each day).
describe('send hours (live audit B05)', () => {
  // Every day 19:00 Rome (the Timing table), Mon 26 Oct 2026 — Rome is UTC+1.
  const WINDOWS = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ marketplace: '*', dayOfWeek: d, hourLocal: 19, dayRank: 1, isActive: true }))
  const at = (iso: string) => vi.setSystemTime(new Date(iso))
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    db.reviewSendWindow.findMany.mockResolvedValue(WINDOWS)
  })
  afterEach(() => vi.useRealTimers())

  it('the hourly run sends inside the send hours; a request due at night waits for the next send hour', async () => {
    at('2026-10-26T23:00:00Z') // Tue 00:00 Rome
    db.reviewRequest.findMany.mockResolvedValue([due('n1', 'AMAZON', 'IT', 8)])
    const result = await runReviewMailerOnce({ sendHours: true })
    expect(spies.sendAmazonSolicitation).not.toHaveBeenCalled()
    expect(db.reviewRequest.update).toHaveBeenCalledWith({ where: { id: 'n1' }, data: { scheduledFor: new Date('2026-10-27T18:00:00Z') } })
    expect(result).toMatchObject({ sent: 0, waitingForSendHour: 1 })

    vi.clearAllMocks()
    db.reviewSendWindow.findMany.mockResolvedValue(WINDOWS)
    at('2026-10-27T18:00:30Z') // Tue 19:00 Rome
    db.reviewRequest.findMany.mockResolvedValue([due('n1', 'AMAZON', 'IT', 9)])
    spies.sendAmazonSolicitation.mockResolvedValue({ ok: true, errorCode: 'OK' })
    expect(await runReviewMailerOnce({ sendHours: true })).toMatchObject({ sent: 1, waitingForSendHour: 0 })
  })

  it('a person’s run sends what is due at once, whatever the hour', async () => {
    at('2026-10-26T23:00:00Z')
    db.reviewRequest.findMany.mockResolvedValue([due('p1', 'AMAZON', 'IT', 8)])
    spies.sendAmazonSolicitation.mockResolvedValue({ ok: true, errorCode: 'OK' })
    expect(await runReviewMailerOnce()).toMatchObject({ sent: 1 })
    expect(await runReviewMailerOnce({ onlyIds: ['p1'] })).toMatchObject({ sent: 1 })
  })

  it('Amazon’s "too early" is tried again at tomorrow’s send hour, not now + 24 h', async () => {
    at('2026-10-26T18:00:40Z') // Mon 19:00:40 Rome
    db.reviewRequest.findMany.mockResolvedValue([due('t1', 'AMAZON', 'IT', 5)])
    spies.sendAmazonSolicitation.mockResolvedValue({ ok: false, errorCode: 'OUTSIDE_WINDOW', errorMessage: TOO_EARLY })
    await runReviewMailerOnce({ sendHours: true })
    const data = db.reviewRequest.update.mock.calls.find(([arg]) => arg.where.id === 't1')![0].data
    expect(data).toMatchObject({ status: 'SCHEDULED', scheduledFor: new Date('2026-10-27T18:00:00Z') })
  })

  it('a request whose next send hour would pass Amazon’s last day goes now: the hour never costs a request', async () => {
    at('2026-10-26T23:00:00Z')
    // Delivered 29.99 days ago: day 30 ends before tomorrow's 19:00.
    db.reviewRequest.findMany.mockResolvedValue([due('l1', 'AMAZON', 'IT', 29.99)])
    spies.sendAmazonSolicitation.mockResolvedValue({ ok: true, errorCode: 'OK' })
    expect(await runReviewMailerOnce({ sendHours: true })).toMatchObject({ sent: 1, waitingForSendHour: 0 })
  })

  it('a failed send comes back at the send hour after its back-off, never at night', async () => {
    at('2026-10-26T18:30:00Z') // Mon 19:30 Rome; +4 h = 23:30 → Tue 19:00
    db.reviewRequest.findMany.mockResolvedValue([due('f1', 'AMAZON', 'IT', 8)])
    spies.sendAmazonSolicitation.mockResolvedValue({ ok: false, errorCode: 'HTTP_500', errorMessage: 'Amazon did not answer' })
    await runReviewMailerOnce({ sendHours: true })
    const data = db.reviewRequest.update.mock.calls.find(([arg]) => arg.where.id === 'f1')![0].data
    expect(data).toMatchObject({ status: 'FAILED', nextRetryAt: new Date('2026-10-27T18:00:00Z') })
  })
})
