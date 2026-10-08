/**
 * Bid optimiser review 2026-10-08 — the pure parts: the bid that served a window (A, for r̂) and the two waits (B).
 * Made-up values only.
 */
import { describe, expect, it } from 'vitest'
import { dataDaysBetween, isSafetyCut, isServingMove, movedThisDataDay, reversalWait, REVERSAL_WAIT_DATA_DAYS, SAFETY_CUT_ACOS_MULTIPLE, servingBidOn, windowBidCents, type AutoMove, type BidMove } from './ads-bid-window.js'

const day = (iso: string) => new Date(`${iso}T00:00:00Z`)
const at = (iso: string) => new Date(iso)
const window = { since: day('2026-09-01'), until: new Date('2026-09-30T23:59:59.999Z') }

describe('a serving move', () => {
  it('both sides at or above the 5¢ floor and different; a stop floor and its restore are not moves', () => {
    expect(isServingMove(40, 30)).toBe(true)
    expect(isServingMove(40, 2)).toBe(false)
    expect(isServingMove(2, 40)).toBe(false)
    expect(isServingMove(30, 30)).toBe(false)
    expect(isServingMove(Number.NaN, 30)).toBe(false)
  })
})

describe('servingBidOn — the bid in force over one UTC day, by the hours it served', () => {
  const moves: BidMove[] = [{ at: at('2026-09-10T12:00:00Z'), fromCents: 40, toCents: 20 }]
  it('before the move its `from`, after it its `to`, and the day of the move half and half', () => {
    expect(servingBidOn(day('2026-09-09'), moves)).toBe(40)
    expect(servingBidOn(day('2026-09-11'), moves)).toBe(20)
    expect(servingBidOn(day('2026-09-10'), moves)).toBe(30)
  })
})

describe('windowBidCents — the bid that served the window', () => {
  it('no move: today\'s bid served every click', () => {
    expect(windowBidCents(33, [], [], window)).toEqual({ cents: 33, basis: 'unchanged' })
  })
  it('moves and daily clicks: each day\'s bid weighted by its clicks (30 clicks at 50¢, 10 at 25¢ → 43.75¢)', () => {
    const moves = [{ at: at('2026-09-20T00:00:00Z'), fromCents: 50, toCents: 25 }]
    const days = [{ date: day('2026-09-05'), clicks: 30 }, { date: day('2026-09-25'), clicks: 10 }]
    expect(windowBidCents(25, moves, days, window)).toEqual({ cents: 43.75, basis: 'clicks' })
  })
  it('a move after the window\'s end served none of its clicks: the bid before it', () => {
    const moves = [{ at: at('2026-10-07T18:20:00Z'), fromCents: 58, toCents: 44 }, { at: at('2026-10-08T00:20:00Z'), fromCents: 44, toCents: 33 }]
    expect(windowBidCents(33, moves, [{ date: day('2026-09-12'), clicks: 7 }], window)).toEqual({ cents: 58, basis: 'clicks' })
    expect(windowBidCents(33, moves, [], window)).toEqual({ cents: 58, basis: 'time' })
  })
  it('moves but no daily clicks: weighted by the time each bid served inside the window', () => {
    // 2026-09-01 … 09-30 (30 days): 40¢ for 15 days, then 20¢ — 30¢.
    const moves = [{ at: at('2026-09-16T00:00:00Z'), fromCents: 40, toCents: 20 }]
    const out = windowBidCents(20, moves, [], window)
    expect(out.basis).toBe('time')
    expect(out.cents).toBeCloseTo(30, 3)
  })
  it('a stop floor and its restore leave the serving bid where it was', () => {
    const moves = [{ at: at('2026-09-10T00:00:00Z'), fromCents: 40, toCents: 2 }, { at: at('2026-09-10T08:00:00Z'), fromCents: 2, toCents: 40 }]
    expect(windowBidCents(40, moves, [{ date: day('2026-09-10'), clicks: 5 }], window)).toEqual({ cents: 40, basis: 'unchanged' })
  })
})

describe('the waits', () => {
  const own = (dataDay: string, fromCents: number, toCents: number): AutoMove => ({ dataDay, fromCents, toCents, by: 'automation:auto-bid', stamped: true })
  const other = (dataDay: string, fromCents: number, toCents: number): AutoMove => ({ dataDay, fromCents, toCents, by: 'automation:rule-x', stamped: false })

  it('data days between two days', () => {
    expect(dataDaysBetween('2026-09-30', '2026-10-01')).toBe(1)
    expect(dataDaysBetween('2026-10-01', '2026-10-01')).toBe(0)
    expect(dataDaysBetween('2026-09-28', '2026-10-01')).toBe(3)
  })

  it('once a data day: any automatic writer\'s move on this data day holds the target; one of the day before does not', () => {
    expect(movedThisDataDay('2026-10-01', [other('2026-10-01', 12, 14)])).toBe('already moved on data day 2026-10-01 (12 → 14¢ by automation:rule-x) — one move per data day')
    expect(movedThisDataDay('2026-10-01', [own('2026-09-30', 8, 10)])).toBeNull()
    // A stop floor on this data day is not a move.
    expect(movedThisDataDay('2026-10-01', [other('2026-10-01', 12, 2)])).toBeNull()
  })

  it('BB-14 — the data day steps back one day (00:20 clock rule 10-02, 06:20 settled 10-01): the 10-02 move holds 10-01', () => {
    const at0020 = own('2026-10-02', 40, 50)
    expect(movedThisDataDay('2026-10-01', [at0020])).toBe('already moved on data day 2026-10-02, newer than this run\'s 2026-10-01 (40 → 50¢ by automation:auto-bid) — one move per data day')
    // Another writer's newer move holds it too; the next data day after it is free again.
    expect(movedThisDataDay('2026-10-01', [other('2026-10-02', 40, 50)])).not.toBeNull()
    expect(movedThisDataDay('2026-10-03', [at0020])).toBeNull()
  })

  it('no quick reversal: 8 → 10¢ on one data day, 10 → 8¢ on the next waits; the same direction does not', () => {
    const raise = [own('2026-09-30', 8, 10)]
    expect(reversalWait('2026-10-01', 10, 8, raise)).toBe(`would reverse its own raise 8 → 10¢ of data day 2026-09-30 — a reversal waits ${REVERSAL_WAIT_DATA_DAYS} data days (2 to go)`)
    expect(reversalWait('2026-10-01', 10, 12, raise)).toBeNull()
  })

  it(`a reversal goes ahead once ${REVERSAL_WAIT_DATA_DAYS} data days have passed`, () => {
    const raise = [own('2026-09-30', 8, 10)]
    expect(reversalWait('2026-10-02', 10, 8, raise)).not.toBeNull()
    expect(reversalWait('2026-10-03', 10, 8, raise)).toBeNull()
  })

  it("no wait against another writer's move, or once the bid has left where its own move put it", () => {
    expect(reversalWait('2026-10-01', 10, 8, [other('2026-09-30', 8, 10)])).toBeNull()
    expect(reversalWait('2026-10-01', 11, 8, [own('2026-09-30', 8, 10)])).toBeNull()
  })

  it('reads its own newest move only (newest first), skipping writes that are no serving move', () => {
    const moves = [own('2026-09-30', 10, 2), own('2026-09-30', 12, 10), own('2026-09-29', 10, 12)]
    // The newest serving move is the cut 12 → 10¢: a further cut is the same direction, a raise reverses it.
    expect(reversalWait('2026-10-01', 10, 8, moves)).toBeNull()
    expect(reversalWait('2026-10-01', 10, 12, moves)).toMatch(/^would reverse its own cut 12 → 10¢ of data day 2026-09-30/)
  })
})

describe('a safety cut (review follow-up)', () => {
  it(`a cut while the bid now runs over ${SAFETY_CUT_ACOS_MULTIPLE} × the target; not at or under it, not a raise, not without an expected ACoS`, () => {
    // Target 35 %: the line is 52.5 %.
    expect(isSafetyCut(50, 28, 0.625, 0.35)).toBe(true)
    expect(isSafetyCut(50, 35, 0.5, 0.35)).toBe(false)
    expect(isSafetyCut(50, 35, 0.75, 0.5)).toBe(false) // at the line (target 50 %: 75 %): not over it
    expect(isSafetyCut(50, 60, 0.9, 0.35)).toBe(false) // a raise is never a safety cut
    expect(isSafetyCut(50, 25, null, 0.35)).toBe(false) // the zero-sales cut: no expected ACoS
    expect(isSafetyCut(50, 25, 0.9, 0)).toBe(false) // no target: nothing to measure against
  })
})
