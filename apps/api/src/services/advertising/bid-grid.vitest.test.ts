/**
 * BID.S0 — the two things in the bid grid that go wrong silently.
 *
 * Not a test of the Prisma reads. Those are exercised by the probe scripts against production,
 * where a wrong field name is caught by the query failing rather than by a mock agreeing with it —
 * a mocked shape assertion is how the daily-cap bug got pinned in place (see the memory note), and
 * this file deliberately does not add another one.
 *
 * What IS tested here is the pure arithmetic, because both of these fail without failing:
 *
 *   1. `bandOf` must be TOTAL and CONTIGUOUS over the integers. A gap makes a row invisible to
 *      every band chip while the census above still counts it, and nothing about that looks wrong
 *      on screen: the numbers simply do not add up, and only if you add them.
 *   2. The band list the API validates against must be exactly the set `bandOf` can return. If
 *      they drift, `?band=` accepts a value that matches no row, or rejects one that does.
 */

import { describe, it, expect } from 'vitest'
import { bandOf, BID_BANDS, type BidBand } from './bid-grid.service.js'

describe('bandOf', () => {
  it('is total over every bid a target can hold', () => {
    // 0 through 400¢ covers the measured range with room to spare: the account's max keyword bid
    // is €2.32 and the highest ceiling set on any campaign is €1.90.
    for (let c = 0; c <= 400; c++) {
      expect(BID_BANDS, `bidCents=${c} fell outside every band`).toContain(bandOf(c))
    }
  })

  it('puts every bid in exactly one band', () => {
    for (let c = 0; c <= 400; c++) {
      const hits = BID_BANDS.filter((b) => bandOf(c) === b)
      expect(hits, `bidCents=${c} matched ${hits.length} bands`).toHaveLength(1)
    }
  })

  it('places the boundaries where the study drew them', () => {
    // 5¢ is BID_FLOOR_CENTS in the rule handlers and FLOOR_CENTS in the optimiser, so "0-5" is
    // exactly the population both of them consider already at the floor. Moving this boundary
    // silently changes what the floor chip means.
    expect(bandOf(0)).toBe('0-5')
    expect(bandOf(2)).toBe('0-5')      // the suppression floor
    expect(bandOf(5)).toBe('0-5')
    expect(bandOf(6)).toBe('6-20')
    expect(bandOf(20)).toBe('6-20')
    expect(bandOf(21)).toBe('21-50')
    expect(bandOf(34)).toBe('21-50')   // the median keyword bid
    expect(bandOf(50)).toBe('21-50')
    expect(bandOf(51)).toBe('51-100')
    expect(bandOf(100)).toBe('51-100')
    expect(bandOf(101)).toBe('100+')
    expect(bandOf(232)).toBe('100+')   // the highest live keyword bid
  })

  it('has no band the API would reject and no value the API would accept for nothing', () => {
    const reachable = new Set<BidBand>()
    for (let c = 0; c <= 400; c++) reachable.add(bandOf(c))
    expect([...reachable].sort()).toEqual([...BID_BANDS].sort())
  })
})
