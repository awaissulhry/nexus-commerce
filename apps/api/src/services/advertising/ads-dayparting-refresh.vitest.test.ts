import { describe, it, expect } from 'vitest'
import { shrinkShare, generateDaypartingWindows } from './ads-dayparting-refresh.service.js'

interface P { key: number; orders: number; units: number; revenueCents: number; index: number | null }
const wd = (indices: (number | null)[]): P[] => indices.map((index, key) => ({ key, orders: 0, units: 0, revenueCents: 0, index }))
const hr = (rev: number[]): P[] => rev.map((revenueCents, key) => ({ key, orders: 0, units: 0, revenueCents, index: null }))

// RC2.DD1 — the market-prior shrinkage that makes sparse per-product hourly data
// accurate: empty cells borrow the market shape, busy cells keep their own signal.
describe('DD1 shrinkShare', () => {
  it('empty family cell → market share', () => {
    expect(shrinkShare(0, 0.05, 0, true)).toBeCloseTo(0.05)
  })
  it('K family orders → midpoint of family + market', () => {
    expect(shrinkShare(0.1, 0.06, 2, true)).toBeCloseTo(0.08) // (2·0.1 + 2·0.06)/4
  })
  it('high family volume → family share dominates', () => {
    expect(shrinkShare(0.1, 0.02, 20, true)).toBeGreaterThan(0.09)
  })
  it('not blended → family share unchanged', () => {
    expect(shrinkShare(0.123, 0.05, 0, false)).toBe(0.123)
  })
})

// RC2.T6 — demand → AdSchedule windows: bid-up high-demand days, bid-down low,
// keep average (no multiplier), and pause the dead overnight.
describe('T6 generateDaypartingWindows', () => {
  const weekday = wd([1.5, 1.5, 1.0, 1.0, 1.0, 0.4, 0.4]) // Sun/Mon peak, Fri/Sat weak (0=Sun)
  const hours = hr([0, 0, 0, 0, 0, 0, 0, ...Array(17).fill(100)]) // dead 00–07, active 07–24
  const w = generateDaypartingWindows(weekday, hours, { bidUpPct: 25, bidDownPct: 40, pauseOvernight: true })

  it('pauses the dead overnight (windows start at 07, end 24)', () => {
    expect(w.every(x => x.startHour === 7 && x.endHour === 24)).toBe(true)
  })
  it('bid-up window for the peak days at +25%', () => {
    const up = w.find(x => x.bidMultiplierPct === 25)
    expect(up?.days.sort()).toEqual([0, 1])
  })
  it('bid-down window for the weak days at −40%', () => {
    const down = w.find(x => x.bidMultiplierPct === -40)
    expect(down?.days.sort()).toEqual([5, 6])
  })
  it('keep days carry no multiplier', () => {
    const keep = w.find(x => x.days.includes(2))
    expect(keep?.bidMultiplierPct).toBeUndefined()
  })
})
