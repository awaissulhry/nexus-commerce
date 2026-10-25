/**
 * Amazon's 5–30 day window for "Request a Review": its refusal is told apart from other errors (OUTSIDE_WINDOW), and
 * a refused request waits for tomorrow until our day 30, then stops. The SP-API client is mocked: nothing leaves the machine.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: client }))

import { isBenignFailure, outsideWindowUpdate, sendAmazonSolicitation } from './amazon-solicitations.service.js'

const DAY = 86_400_000
// Amazon's answer, as the client throws it (seen 2026-10).
const REFUSED = 'HTTP 403 — {"errors":[{"code":"Unauthorized","message":"You can\'t use this feature to request a review outside the 5-30 day range after the order delivery date.","details":""}]}'

describe('sendAmazonSolicitation', () => {
  afterEach(() => { vi.unstubAllEnvs(); client.request.mockReset() })

  it('Amazon\'s "outside the 5-30 day range" is OUTSIDE_WINDOW, not benign', async () => {
    vi.stubEnv('NEXUS_ENABLE_AMAZON_SOLICITATIONS', 'true')
    client.request.mockRejectedValueOnce(new Error(REFUSED))
    const result = await sendAmazonSolicitation({ amazonOrderId: '408-0000000-0000000', marketplaceCode: 'IT' })
    expect(result).toMatchObject({ ok: false, errorCode: 'OUTSIDE_WINDOW' })
    expect(isBenignFailure(result.errorCode)).toBe(false)
  })

  it('other refusals keep their codes', async () => {
    vi.stubEnv('NEXUS_ENABLE_AMAZON_SOLICITATIONS', 'true')
    client.request.mockRejectedValueOnce(new Error('HTTP 403 — {"errors":[{"message":"A solicitation has already been sent"}]}'))
    expect((await sendAmazonSolicitation({ amazonOrderId: 'A', marketplaceCode: 'DE' })).errorCode).toBe('ALREADY_SOLICITED')
    client.request.mockRejectedValueOnce(new Error('HTTP 500 — oops'))
    expect((await sendAmazonSolicitation({ amazonOrderId: 'B', marketplaceCode: 'FR' })).errorCode).toBe('HTTP_500')
  })
})

describe('outsideWindowUpdate', () => {
  const delivered = new Date('2026-09-23T12:00:00Z')

  it('day 5.3: waits for tomorrow, stays SCHEDULED, keeps Amazon\'s words', () => {
    const now = new Date(delivered.getTime() + 5.3 * DAY)
    expect(outsideWindowUpdate(delivered, REFUSED, now)).toEqual({
      status: 'SCHEDULED', scheduledFor: new Date(now.getTime() + DAY), providerResponseCode: 'OUTSIDE_WINDOW',
      errorMessage: REFUSED, lastAttemptAt: now, nextRetryAt: null,
    })
  })

  it('day 29: tomorrow is day 30 exactly, one more try', () => {
    expect(outsideWindowUpdate(delivered, REFUSED, new Date(delivered.getTime() + 29 * DAY)).status).toBe('SCHEDULED')
  })

  it('day 29.5: tomorrow is past day 30, SKIPPED with the reason', () => {
    const update = outsideWindowUpdate(delivered, REFUSED, new Date(delivered.getTime() + 29.5 * DAY))
    expect(update).toMatchObject({ status: 'SKIPPED', suppressedReason: 'Outside Amazon window: Amazon refused every day until day 30', nextRetryAt: null })
    expect(update).not.toHaveProperty('scheduledFor')
  })
})
