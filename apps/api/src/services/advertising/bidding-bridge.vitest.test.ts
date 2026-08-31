// PH.5 — the bidding bridge's pure logic.
//
// This is the point of de-layering: none of this was reachable by a test while
// it lived inside a Fastify handler. The bid band decides how far an automated
// engine may move a live bid in one step, so it is worth asserting directly
// rather than through an HTTP round trip.

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('./ads-api-client.js', () => ({ adsMode: () => 'sandbox' }))

import { computeBidBand, buildBidContext, type BidTargetRow } from './bidding-bridge.service.js'

const row = (over: Partial<BidTargetRow> = {}): BidTargetRow => ({
  id: 't1', externalTargetId: 'kw-1', bidCents: 50, clicks: 100,
  spendCents: 4000, salesCents: 16000, ordersCount: 8,
  adGroup: { campaign: { marketplace: 'IT', dynamicBidding: {} } },
  ...over,
})

describe('computeBidBand — the guardrail', () => {
  it('uses the wide default band when no cap is set', () => {
    expect(computeBidBand(50, undefined)).toEqual({ bidMinMinor: 5, bidMaxMinor: 300 })
  })

  it('scales the default ceiling with the bid once 3x exceeds the 300 floor', () => {
    expect(computeBidBand(200, undefined)).toEqual({ bidMinMinor: 5, bidMaxMinor: 600 })
  })

  it('honours a campaign max-change-% as a band around the current bid', () => {
    // Apex A.2a: the engine must respect the same cap as the audited path.
    expect(computeBidBand(100, 20)).toEqual({ bidMinMinor: 80, bidMaxMinor: 120 })
  })

  it('never lets the cap push the floor below the absolute minimum', () => {
    // A 99% cut on a 5c bid would compute 0.05 — a bid of zero is not a bid.
    expect(computeBidBand(5, 99).bidMinMinor).toBe(5)
  })

  it.each([0, -10, NaN, undefined, null, 'twenty'])('treats %p as no cap', (pct) => {
    expect(computeBidBand(50, pct)).toEqual({ bidMinMinor: 5, bidMaxMinor: 300 })
  })
})

describe('buildBidContext', () => {
  it('derives conversion rate from orders over clicks', () => {
    const c = buildBidContext(row({ clicks: 200, ordersCount: 10 }), 'profile-1')
    expect(c.cr7d).toBeCloseTo(0.05)
    expect(c.cr30d).toBeCloseTo(0.05)
  })

  it('derives AOV from sales over orders', () => {
    expect(buildBidContext(row({ salesCents: 16000, ordersCount: 8 }), 'p').aovMinor).toBe(2000)
  })

  it('falls back to a default AOV rather than dividing by zero', () => {
    expect(buildBidContext(row({ ordersCount: 0 }), 'p').aovMinor).toBe(5000)
  })

  it('reports a zero conversion rate when there are no clicks', () => {
    expect(buildBidContext(row({ clicks: 0, ordersCount: 0 }), 'p').cr7d).toBe(0)
  })

  it('converts the campaign ACoS target to basis points', () => {
    const c = buildBidContext(row({ adGroup: { campaign: { marketplace: 'IT', dynamicBidding: { targetAcos: 0.25 } } } }), 'p')
    expect(c.acosTargetBps).toBe(2500)
  })

  it('defaults the ACoS target to 30% when the campaign sets none', () => {
    expect(buildBidContext(row(), 'p').acosTargetBps).toBe(3000)
  })

  it('applies the campaign guardrail to the band', () => {
    const c = buildBidContext(row({ bidCents: 100, adGroup: { campaign: { marketplace: 'IT', dynamicBidding: { maxBidChangePct: 10 } } } }), 'p')
    expect(c).toMatchObject({ bidMinMinor: 90, bidMaxMinor: 110 })
  })

  it('carries the profile as accountRef — the name the engine reads', () => {
    // The wire field is accountRef, not profileId. A rename here is a silent
    // undefined on the engine side, which reads as "no eligible targets".
    expect(buildBidContext(row(), 'profile-it-1').accountRef).toBe('profile-it-1')
  })

  it('leaves the fields the primary cannot supply explicitly null', () => {
    const c = buildBidContext(row(), 'p')
    expect(c.acos1hBps).toBeNull()
    expect(c.daysOfSupply).toBeNull()
  })
})
