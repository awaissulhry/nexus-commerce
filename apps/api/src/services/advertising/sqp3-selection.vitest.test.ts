/**
 * SQP.3 Phase C — the selector. These pin the property the whole design rests on: settling frees a
 * slot and coverage takes it, WITHOUT the nightly budget changing.
 */
import { describe, it, expect } from 'vitest'
import { selectNightlyAsins, selectionSummary, type SqpCandidate } from './sqp-selection.js'

const D = (iso: string) => new Date(iso)
/** a pool of 20, ranks 0..19; the first ten have been asked for, the tail never has. */
const pool = (): SqpCandidate[] =>
  Array.from({ length: 20 }, (_, i) => ({
    asin: `A${String(i).padStart(2, '0')}`,
    rank: i,
    lastRequestedAt: i < 10 ? D(`2026-08-${String(10 + (i % 3)).padStart(2, '0')}T03:45:00Z`) : null,
  }))

const none = new Set<string>()

describe('selectNightlyAsins — today\'s behaviour is the floor', () => {
  it('with nothing settled, picks exactly the existing top ten and nothing else', () => {
    const s = selectNightlyAsins({ candidates: pool(), budget: 10, settled: none, outstanding: none })
    expect(s.chosen).toEqual(['A00','A01','A02','A03','A04','A05','A06','A07','A08','A09'])
    expect(s.chosen.every((a) => s.reason[a] === 'core')).toBe(true)
    expect(s.slotsFreedToRotation).toBe(0)
  })

  it('never returns more than the budget', () => {
    const s = selectNightlyAsins({ candidates: pool(), budget: 6, settled: none, outstanding: none })
    expect(s.chosen).toHaveLength(6)
  })
})

describe('🔴 settling pays for coverage — the point of Phase C', () => {
  it('hands a freed slot to an ASIN that has never been asked for', () => {
    const settled = new Set(['A00', 'A01', 'A02'])
    const s = selectNightlyAsins({ candidates: pool(), budget: 10, settled, outstanding: none })
    expect(s.chosen).toHaveLength(10)               // the budget did NOT shrink
    expect(s.skippedSettled).toEqual(['A00','A01','A02'])
    // three never-requested ASINs from the tail now have slots
    const rotating = s.chosen.filter((a) => s.reason[a] === 'rotation')
    expect(rotating).toEqual(['A10', 'A11', 'A12'])
    expect(s.slotsFreedToRotation).toBe(3)
  })

  it('orders rotation by how long since we asked, never-requested first', () => {
    const c = pool().map((x) => ({ ...x, lastRequestedAt: x.rank === 15 ? null : D(`2026-08-${String(1 + (x.rank % 9)).padStart(2,'0')}T00:00:00Z`) }))
    const s = selectNightlyAsins({ candidates: c, budget: 12, settled: none, outstanding: none, coreCount: 10 })
    const rotating = s.chosen.filter((a) => s.reason[a] === 'rotation')
    expect(rotating[0]).toBe('A15')                 // never asked for → first
  })

  it('breaks ties on rank, so two runs of the same night agree', () => {
    const same = D('2026-08-01T00:00:00Z')
    const c: SqpCandidate[] = [
      { asin: 'X', rank: 7, lastRequestedAt: same },
      { asin: 'Y', rank: 3, lastRequestedAt: same },
      { asin: 'Z', rank: 5, lastRequestedAt: same },
    ]
    const a = selectNightlyAsins({ candidates: c, budget: 2, settled: none, outstanding: none, coreCount: 0 })
    const b = selectNightlyAsins({ candidates: [...c].reverse(), budget: 2, settled: none, outstanding: none, coreCount: 0 })
    expect(a.chosen).toEqual(['Y', 'Z'])
    expect(a.chosen).toEqual(b.chosen)
  })
})

describe('the exclusions, which must not double-count', () => {
  it('counts an ASIN that is both outstanding and settled once, as outstanding', () => {
    const s = selectNightlyAsins({
      candidates: pool(), budget: 10,
      settled: new Set(['A00', 'A01']), outstanding: new Set(['A00']),
    })
    expect(s.skippedOutstanding).toEqual(['A00'])
    expect(s.skippedSettled).toEqual(['A01'])
    expect(s.chosen).not.toContain('A00')
    expect(s.chosen).not.toContain('A01')
  })

  it('does not report freed slots when the pool was too small to fill the budget anyway', () => {
    // 🔴 A budget that never filled did not "free" anything, and saying it did would credit this
    // design with coverage it had no part in.
    const c = pool().slice(0, 4)
    const s = selectNightlyAsins({ candidates: c, budget: 10, settled: new Set(['A00']), outstanding: none })
    expect(s.chosen).toHaveLength(3)
    expect(s.slotsFreedToRotation).toBe(0)
  })

  it('returns nothing, and does not throw, when everything is settled', () => {
    const s = selectNightlyAsins({ candidates: pool(), budget: 10, settled: new Set(pool().map((c) => c.asin)), outstanding: none })
    expect(s.chosen).toEqual([])
    expect(s.skippedSettled).toHaveLength(20)
  })
})

describe('selectionSummary — the pass has to be able to say what it covered', () => {
  it('names the split only once there is one', () => {
    const plain = selectNightlyAsins({ candidates: pool(), budget: 10, settled: none, outstanding: none })
    expect(selectionSummary('IT', plain, 252)).toBe('IT 10/252')
    const mixed = selectNightlyAsins({ candidates: pool(), budget: 10, settled: new Set(['A00','A01']), outstanding: new Set(['A03']) })
    expect(selectionSummary('IT', mixed, 252)).toBe('IT 10/252 · 7 core + 3 rotating · 2 settled · 1 in flight')
  })
})
