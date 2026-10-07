/**
 * SQP fairness — the request pass must not serve the markets in the same order every night.
 *
 * Alphabetical order put DE first every night; when the requests ran out, DE got all 6 that went out and
 * ES and IT got none, so Amazon IT had no new SQP week from 2026-08-16 to 2026-10-05.
 */
import { describe, expect, it } from 'vitest'
import { rotateForNight } from './sqp-ingest.job.js'

const MARKETS = ['DE', 'ES', 'IT']
const night = (n: number) => new Date(Date.UTC(2026, 9, 1, 3, 45) + n * 86_400_000)

describe('rotateForNight', () => {
  it('starts with a different market on each of three nights, and every market is last once', () => {
    const orders = [0, 1, 2].map((n) => rotateForNight(MARKETS, night(n)))
    expect(new Set(orders.map((o) => o[0]))).toEqual(new Set(MARKETS))
    expect(new Set(orders.map((o) => o[2]))).toEqual(new Set(MARKETS))
    for (const o of orders) expect([...o].sort()).toEqual(MARKETS) // a rotation: nothing dropped or doubled
  })

  it('is the same all night long (the order is chosen per UTC day, not per call)', () => {
    const d = night(4)
    const later = new Date(d.getTime() + 3 * 3_600_000)
    expect(rotateForNight(MARKETS, later)).toEqual(rotateForNight(MARKETS, d))
  })

  it('repeats after as many nights as there are markets', () => {
    expect(rotateForNight(MARKETS, night(7))).toEqual(rotateForNight(MARKETS, night(4)))
  })

  it('leaves the input alone and handles zero or one market', () => {
    const input = [...MARKETS]
    rotateForNight(input, night(1))
    expect(input).toEqual(MARKETS)
    expect(rotateForNight([], night(1))).toEqual([])
    expect(rotateForNight(['IT'], night(1))).toEqual(['IT'])
  })
})
