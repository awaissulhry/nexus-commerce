/**
 * "Allow again" (POST /review-requests/:id/unsuppress) is refused on the SERVER for a request that was sent or may not
 * be asked (audit E3): a stale page or a direct call can never ask a buyer twice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ row: null as Record<string, unknown> | null, updates: [] as unknown[] }))
vi.mock('../../db.js', () => ({
  default: {
    reviewRequest: {
      findUnique: vi.fn(async () => db.row),
      updateMany: vi.fn(async (args: { where: { status: { in: string[] } } }) => {
        db.updates.push(args)
        return { count: db.row && args.where.status.in.includes(db.row.status as string) ? 1 : 0 }
      }),
    },
  },
}))

import { allowRequestAgain } from './review-queue.service.js'

const NOW = new Date('2026-10-27T12:00:00Z')
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000)
const row = (patch: Record<string, unknown>) => ({
  id: 'r1', status: 'SKIPPED', channel: 'AMAZON', marketplace: 'IT', scheduledFor: null, sentAt: null, providerResponseCode: null, errorMessage: null,
  suppressedReason: null, attemptCount: 0, lastAttemptAt: null, nextRetryAt: null, sentimentCheck: null,
  order: { deliveredAt: days(10), customerEmail: 'buyer@example.test', marketplace: 'IT', status: 'DELIVERED', cancelledAt: null, returns: [], financialTransactions: [] },
  ...patch,
})

beforeEach(() => {
  db.row = null
  db.updates = []
})

describe('allowRequestAgain', () => {
  it('refuses a sent request (409, in words) and writes nothing', async () => {
    db.row = row({ status: 'SENT', sentAt: days(2) })
    await expect(allowRequestAgain('r1', NOW)).rejects.toMatchObject({ statusCode: 409, message: 'Only a request that was not asked can be allowed again' })
    expect(db.updates).toEqual([])
  })

  it('refuses a buyer on the do-not-email list, a refund, and Amazon past day 30', async () => {
    db.row = row({ channel: 'SHOPIFY', providerResponseCode: 'SUPPRESSED', suppressedReason: 'Suppressed: suppressed (UNSUBSCRIBE)' })
    await expect(allowRequestAgain('r1', NOW)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/do-not-email list/) })
    // Nexus e-mails no eBay buyer (Owner, 2026-10-27): an eBay request is never put back.
    db.row = row({ channel: 'EBAY', providerResponseCode: 'EBAY_ASKS', suppressedReason: 'Not sent — eBay asks the buyer for feedback itself' })
    await expect(allowRequestAgain('r1', NOW)).rejects.toMatchObject({ statusCode: 409, message: 'Not sent — eBay asks the buyer for feedback itself' })
    db.row = row({ order: { ...row({}).order, financialTransactions: [{ id: 'f' }] } })
    await expect(allowRequestAgain('r1', NOW)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/refunded/) })
    db.row = row({ order: { ...row({}).order, deliveredAt: days(35) } })
    await expect(allowRequestAgain('r1', NOW)).rejects.toMatchObject({ statusCode: 409, message: 'Past Amazon’s day 30 — too late to ask' })
    expect(db.updates).toEqual([])
  })

  it('PR J — refuses the holdout of a timing test (409, in words): it stays not asked, so the test holds', async () => {
    db.row = row({ suppressedReason: 'timing_test_holdout', providerResponseCode: 'TIMING_TEST_HOLDOUT', scheduledFor: days(6) })
    await expect(allowRequestAgain('r1', NOW)).rejects.toMatchObject({
      statusCode: 409,
      message: 'Held out by a timing test on purpose — it stays not asked, so the test’s result holds',
    })
    // Lane N6 — a Shopify test's holdout the same: no review e-mail is put back.
    db.row = row({ channel: 'SHOPIFY', marketplace: null, suppressedReason: 'timing_test_holdout', providerResponseCode: 'TIMING_TEST_HOLDOUT', scheduledFor: days(6), order: { ...row({}).order, marketplace: null } })
    await expect(allowRequestAgain('r1', NOW)).rejects.toMatchObject({
      statusCode: 409,
      message: 'Held out by a timing test on purpose — it stays not asked, so the test’s result holds',
    })
    expect(db.updates).toEqual([])
  })

  it('puts a skipped request back, due now with a fresh set of tries; an unknown id is null', async () => {
    db.row = row({ suppressedReason: 'rule_exclusion:asked_buyer_90d', attemptCount: 2 })
    await allowRequestAgain('r1', NOW)
    expect(db.updates).toEqual([{
      // The write itself never puts a timing test's holdout row back, even if the row changed after the read (PR J).
      where: { id: 'r1', status: { in: ['SKIPPED', 'SUPPRESSED'] }, OR: [{ providerResponseCode: null }, { providerResponseCode: { not: 'TIMING_TEST_HOLDOUT' } }] },
      data: expect.objectContaining({ status: 'SCHEDULED', scheduledFor: NOW, attemptCount: 0, suppressedReason: null }),
    }])
    db.row = null
    expect(await allowRequestAgain('nope', NOW)).toBeNull()
  })
})
