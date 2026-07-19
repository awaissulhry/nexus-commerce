/**
 * RT.0 — failure disposition + eBay ended-listing auto-heal.
 *
 * Locks the three RT.0 dispatch-correctness behaviors:
 *  1. Circuit-open / rate-limit failures DEFER without consuming retry budget
 *     (the old 2s/4s/8s backoff burned all 3 attempts inside one 10-minute
 *     circuit episode → premature MAX_RETRIES_EXCEEDED, 75 measured on prod).
 *  2. Terminal failures are dead-lettered (isDead-parity with the BullMQ path).
 *  3. A Trading push at an ended eBay listing auto-ENDs its memberships and
 *     never records a circuit outcome (one dead listing froze the whole
 *     marketplace lane for ~10 min per episode — 2026-07-19 incident).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const membershipUpdateMany = vi.fn().mockResolvedValue({ count: 24 })
const connectionFindFirst = vi.fn().mockResolvedValue({ id: 'conn-1' })

vi.mock('../db.js', () => ({
  default: {
    sharedListingMembership: { updateMany: (...a: unknown[]) => membershipUpdateMany(...a) },
    channelConnection: { findFirst: (...a: unknown[]) => connectionFindFirst(...a) },
  },
}))

const recordEbayOutcome = vi.fn()
vi.mock('./ebay-publish-gate.service.js', () => ({
  acquireEbayPublishToken: vi.fn().mockResolvedValue({ ok: true }),
  checkEbayCircuit: vi.fn().mockReturnValue({ ok: true }),
  getEbayApiBaseForMode: vi.fn().mockReturnValue('https://api.ebay.com'),
  getEbayPublishMode: vi.fn().mockReturnValue('live'),
  recordEbayOutcome: (...a: unknown[]) => recordEbayOutcome(...a),
}))
vi.mock('./ebay-auth.service.js', () => ({
  ebayAuthService: { getValidToken: vi.fn().mockResolvedValue('tok') },
}))
vi.mock('./channel-publish-audit.service.js', () => ({
  digestPayload: vi.fn().mockReturnValue('digest'),
  writeAttemptLog: vi.fn(),
}))
vi.mock('./product-event.service.js', () => ({
  productEventService: { emit: vi.fn().mockResolvedValue(undefined) },
}))

import {
  computeFailureDisposition,
  matchEbayEndedListingCode,
  withJitter,
  OutboundSyncService,
  __ebayTrading,
} from './outbound-sync.service.js'

describe('RT.0 — computeFailureDisposition', () => {
  const NOW = 1_700_000_000_000
  const item = (retryCount: number, maxRetries = 3) => ({ retryCount, maxRetries })

  it('circuit-open (by errorCode) defers WITHOUT consuming retry budget', () => {
    const d = computeFailureDisposition(item(2), 'whatever', { errorCode: 'EBAY_CIRCUIT_OPEN' }, NOW)
    expect(d.kind).toBe('deferral')
    if (d.kind !== 'deferral') return
    expect(d.errorCode).toBe('CIRCUIT_OPEN_DEFERRED')
    const delta = d.nextRetryAt.getTime() - NOW
    expect(delta).toBeGreaterThanOrEqual(5 * 60_000)
    expect(delta).toBeLessThanOrEqual(6 * 60_000) // 5min + ≤20% jitter
  })

  it('circuit-open (by message) defers — the Trading circuit return path', () => {
    const d = computeFailureDisposition(
      item(0),
      'eBay publish circuit open after 3 consecutive failures. Retry in 438s.',
      undefined,
      NOW,
    )
    expect(d.kind).toBe('deferral')
  })

  it('rate-limited defers on a shorter clock', () => {
    const d = computeFailureDisposition(item(1), 'x', { errorCode: 'EBAY_RATE_LIMITED' }, NOW)
    expect(d.kind).toBe('deferral')
    if (d.kind !== 'deferral') return
    const delta = d.nextRetryAt.getTime() - NOW
    expect(delta).toBeGreaterThanOrEqual(60_000)
    expect(delta).toBeLessThanOrEqual(72_000)
  })

  it('retryable:false is terminal immediately and keeps the classifier code', () => {
    const d = computeFailureDisposition(item(0), 'ended', { errorCode: 'EBAY_LISTING_ENDED', retryable: false }, NOW)
    expect(d).toEqual({ kind: 'terminal', errorCode: 'EBAY_LISTING_ENDED' })
  })

  it('exhausted budget is terminal MAX_RETRIES_EXCEEDED', () => {
    const d = computeFailureDisposition(item(2), 'boom', undefined, NOW)
    expect(d).toEqual({ kind: 'terminal', errorCode: 'MAX_RETRIES_EXCEEDED' })
  })

  it('genuine retryable failures back off 30s then 2m (not 2s/4s/8s)', () => {
    const first = computeFailureDisposition(item(0), 'boom', undefined, NOW)
    expect(first.kind).toBe('retry')
    if (first.kind !== 'retry') return
    const d1 = first.nextRetryAt.getTime() - NOW
    expect(d1).toBeGreaterThanOrEqual(30_000)
    expect(d1).toBeLessThanOrEqual(36_000)

    const second = computeFailureDisposition(item(1), 'boom', undefined, NOW)
    if (second.kind !== 'retry') throw new Error('expected retry')
    const d2 = second.nextRetryAt.getTime() - NOW
    expect(d2).toBeGreaterThanOrEqual(120_000)
    expect(d2).toBeLessThanOrEqual(144_000)
  })

  it('withJitter stays within +20%', () => {
    for (let i = 0; i < 50; i++) {
      const v = withJitter(1000)
      expect(v).toBeGreaterThanOrEqual(1000)
      expect(v).toBeLessThanOrEqual(1200)
    }
  })
})

describe('RT.0 — matchEbayEndedListingCode', () => {
  it('matches the default ended code 21916750', () => {
    expect(
      matchEbayEndedListingCode(
        'eBay ReviseInventoryStatus Failure: Non puoi modificare un\'inserzione scaduta "256552369326". (code 21916750)',
      ),
    ).toBe('21916750')
  })

  it('ignores other codes — fail-closed', () => {
    expect(matchEbayEndedListingCode('eBay Failure: qty too low (code 25004)')).toBeNull()
    expect(matchEbayEndedListingCode('no code at all')).toBeNull()
  })
})

describe('RT.0 — ended-listing auto-heal (Trading branch)', () => {
  beforeEach(() => {
    membershipUpdateMany.mockClear()
    recordEbayOutcome.mockClear()
    process.env.NEXUS_ENABLE_EBAY_PUBLISH = 'true'
  })

  const queueItem = {
    id: 'q1',
    payload: {
      sku: 'GALE-SKU-1', itemId: '256552369326', market: 'IT',
      marketplaceId: 'EBAY_IT', quantity: 5, pushVia: 'TRADING', productId: 'p1',
    },
    externalListingId: '256552369326',
    retryCount: 0,
    maxRetries: 3,
    targetChannel: 'EBAY',
    syncType: 'QUANTITY_UPDATE',
  }

  it('auto-ENDs memberships, returns terminal non-retryable, never touches the circuit', async () => {
    const original = __ebayTrading.reviseInventoryStatus
    __ebayTrading.reviseInventoryStatus = vi.fn().mockRejectedValue(
      new Error('eBay ReviseInventoryStatus Failure: Non puoi modificare un\'inserzione scaduta "256552369326". (code 21916750)'),
    ) as never
    try {
      const svc = new OutboundSyncService() as unknown as {
        syncSharedTradingQuantity: (q: unknown) => Promise<{
          success: boolean; errorCode?: string; retryable?: boolean
        }>
      }
      const result = await svc.syncSharedTradingQuantity(queueItem)

      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('EBAY_LISTING_ENDED')
      expect(result.retryable).toBe(false)
      // memberships for the WHOLE item are ended, all SKUs
      expect(membershipUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { marketplace: 'IT', itemId: '256552369326', status: 'ACTIVE' },
          data: expect.objectContaining({ status: 'ENDED' }),
        }),
      )
      // the decisive invariant: a dead listing never records a circuit outcome
      expect(recordEbayOutcome).not.toHaveBeenCalled()
    } finally {
      __ebayTrading.reviseInventoryStatus = original
    }
  })

  it('a NON-ended Trading failure still records the circuit outcome (unchanged behavior)', async () => {
    const original = __ebayTrading.reviseInventoryStatus
    __ebayTrading.reviseInventoryStatus = vi.fn().mockRejectedValue(
      new Error('eBay ReviseInventoryStatus Failure: internal error (code 10007)'),
    ) as never
    try {
      const svc = new OutboundSyncService() as unknown as {
        syncSharedTradingQuantity: (q: unknown) => Promise<{ success: boolean; errorCode?: string }>
      }
      const result = await svc.syncSharedTradingQuantity(queueItem)
      expect(result.success).toBe(false)
      expect(result.errorCode).toBeUndefined()
      // the legacy path writes lastError via updateMany — but must NEVER end memberships
      const endedCalls = membershipUpdateMany.mock.calls.filter(
        (c) => (c[0] as { data?: { status?: string } })?.data?.status === 'ENDED',
      )
      expect(endedCalls).toHaveLength(0)
      expect(recordEbayOutcome).toHaveBeenCalledWith('conn-1', 'EBAY_IT', false)
    } finally {
      __ebayTrading.reviseInventoryStatus = original
    }
  })
})
