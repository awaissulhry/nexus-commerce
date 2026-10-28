import { describe, expect, it } from 'vitest'
import { compareForAgGrid, compareSortValues, type SortDir, type SortValue } from './sortValues'

type Row = { id: string; spend: SortValue }

/** Blanks deliberately scattered, not clustered at an end, so a no-op comparator cannot pass. */
const ROWS: Row[] = [
  { id: 'b5', spend: 5 },
  { id: 'nullA', spend: null },
  { id: 'b1', spend: 1 },
  { id: 'undef', spend: undefined },
  { id: 'b9', spend: 9 },
]
const val = (r: Row) => r.spend
const ids = (rs: Row[]) => rs.map((r) => r.id).join(',')

/** The hand-rolled grid: the comparator IS the final order. */
const wsSort = (dir: SortDir) => [...ROWS].sort((a, b) => compareSortValues(val(a), val(b), dir))

/**
 * AG Grid: it calls the comparator with `isDescending`, then NEGATES the result when descending.
 * That negation is simulated here rather than assumed — it is the whole reason the adapter exists,
 * and a test that skipped it would pass while the real grid put blanks on top.
 */
const agSort = (dir: SortDir) =>
  [...ROWS].sort((a, b) => {
    const isDesc = dir === 'desc'
    const r = compareForAgGrid(val(a), val(b), isDesc)
    return isDesc ? -r : r
  })

describe('KT.3 — a blank sinks to the BOTTOM in both directions', () => {
  it('ascending: measured rows ascend, blanks last', () => {
    expect(ids(wsSort('asc'))).toBe('b1,b5,b9,nullA,undef')
  })

  it('descending: measured rows descend, blanks STILL last', () => {
    // The bug this pins: reversing the whole comparison floats blanks to the top, and a
    // descending grid looks perfectly correct in a screenshot because they are off page one.
    expect(ids(wsSort('desc'))).toBe('b9,b5,b1,nullA,undef')
  })

  it('treats undefined exactly as null', () => {
    expect(compareSortValues(null, undefined, 'asc')).toBe(0)
    expect(compareSortValues(null, undefined, 'desc')).toBe(0)
  })
})

describe('a blank is NOT zero', () => {
  it('does not sort a blank among the numbers on either side of 0', () => {
    const rows: Row[] = [{ id: 'neg', spend: -5 }, { id: 'blank', spend: null }, { id: 'pos', spend: 5 }]
    const asc = [...rows].sort((a, b) => compareSortValues(val(a), val(b), 'asc'))
    // If a blank read as 0 it would land BETWEEN -5 and 5. It must be last instead.
    expect(asc.map((r) => r.id).join(',')).toBe('neg,pos,blank')
  })
})

describe('ENGINE CONFORMANCE — both engines must land the same order', () => {
  // The point of the AG series: the props contract is the seam, so the same rows in the same
  // direction must come out in the same order whichever engine is underneath.
  it('agrees ascending', () => {
    expect(ids(agSort('asc'))).toBe(ids(wsSort('asc')))
  })

  it('agrees descending — the direction AG Grid negates', () => {
    expect(ids(agSort('desc'))).toBe(ids(wsSort('desc')))
  })

  it('the AG adapter is pre-inverted, and that is load-bearing', () => {
    // Descending, `a` blank: the adapter must hand AG the value that SURVIVES its negation.
    // Ascending is passed straight through, so the two differ in sign by construction.
    expect(compareForAgGrid(null, 5, true)).toBe(-1)
    expect(compareForAgGrid(null, 5, false)).toBe(1)
    // …and after AG's own negation, descending lands on the same +1 the hand-rolled grid returns.
    expect(-compareForAgGrid(null, 5, true)).toBe(compareSortValues(null, 5, 'desc'))
  })
})

describe('ordinary comparisons still work', () => {
  it('numbers compare numerically, not lexically', () => {
    // The classic: String(9) > String(10). A numeric column must not sort 10 before 9.
    expect(compareSortValues(9, 10, 'asc')).toBeLessThan(0)
  })

  it('strings compare with localeCompare, and reverse on desc', () => {
    expect(compareSortValues('apple', 'banana', 'asc')).toBeLessThan(0)
    expect(compareSortValues('apple', 'banana', 'desc')).toBeGreaterThan(0)
  })

  it('mixed types fall back to string comparison rather than NaN arithmetic', () => {
    expect(Number.isNaN(compareSortValues(5, 'apple', 'asc'))).toBe(false)
  })
})
