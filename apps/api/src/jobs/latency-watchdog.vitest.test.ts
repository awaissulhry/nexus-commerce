/**
 * AS.1 — publish-health tripwire decision table.
 *
 * The 2026-07-20 lesson: the tripwires existed but were nested under the
 * degraded-dispatch branch and never ran in the healthy prod config. Beyond
 * un-nesting (wiring), the decision math is locked here as a pure function.
 */
import { describe, it, expect } from 'vitest'
import { computePublishHealthTrips } from './latency-watchdog.job.js'

const a = (channel: string, outcome: 'success' | 'failed', errorMessage: string | null = null) => ({
  channel,
  outcome,
  errorMessage,
})

describe('AS.1 — computePublishHealthTrips', () => {
  it('fires CHANNEL_AUTH_FAILURE from 3 auth-class failures (the silent-403 class)', () => {
    const attempts = [
      a('AMAZON', 'failed', 'HTTP 403 — Unauthorized: Access to requested resource is denied.'),
      a('AMAZON', 'failed', 'HTTP 403 — Unauthorized: Access to requested resource is denied.'),
      a('AMAZON', 'failed', 'HTTP 403 — Unauthorized: Access to requested resource is denied.'),
    ]
    const trips = computePublishHealthTrips(attempts)
    expect(trips.some((t) => t.channel === 'AMAZON' && t.conflictType === 'CHANNEL_AUTH_FAILURE')).toBe(true)
  })

  it('2 auth failures stay silent (threshold is 3)', () => {
    const attempts = [
      a('AMAZON', 'failed', 'HTTP 403 — Unauthorized'),
      a('AMAZON', 'failed', 'invalid_grant'),
      a('AMAZON', 'success'),
    ]
    expect(computePublishHealthTrips(attempts)).toEqual([])
  })

  it('fires PUBLISH_FAILURE_RATE at ≥20 attempts and >20% failed', () => {
    const attempts = [
      ...Array.from({ length: 15 }, () => a('EBAY', 'success' as const)),
      ...Array.from({ length: 5 }, () => a('EBAY', 'failed' as const, 'eBay API error 500: boom')),
    ]
    const trips = computePublishHealthTrips(attempts)
    expect(trips.some((t) => t.channel === 'EBAY' && t.conflictType === 'PUBLISH_FAILURE_RATE')).toBe(true)
  })

  it('19 attempts never fire the rate tripwire (volume floor)', () => {
    const attempts = [
      ...Array.from({ length: 9 }, () => a('EBAY', 'success' as const)),
      ...Array.from({ length: 10 }, () => a('EBAY', 'failed' as const, 'boom')),
    ]
    expect(
      computePublishHealthTrips(attempts).some((t) => t.conflictType === 'PUBLISH_FAILURE_RATE'),
    ).toBe(false)
  })

  it('channels are independent; an all-403 outage fires both tripwires for that channel only', () => {
    const attempts = [
      ...Array.from({ length: 25 }, () => a('AMAZON', 'failed' as const, 'HTTP 403 — Unauthorized: denied')),
      ...Array.from({ length: 25 }, () => a('EBAY', 'success' as const)),
    ]
    const trips = computePublishHealthTrips(attempts)
    expect(trips.filter((t) => t.channel === 'AMAZON')).toHaveLength(2)
    expect(trips.filter((t) => t.channel === 'EBAY')).toHaveLength(0)
  })
})
