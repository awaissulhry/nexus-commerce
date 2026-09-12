import { describe, expect, it } from 'vitest'

import type { GridSetFilterModel } from '@nexus/shared/products-grid'

import { BLANK_FILTER_VALUE, numberFilterPasses, setFilterPasses, textFilterPasses } from './filterPredicates'

describe('setFilterPasses', () => {
  it('no model, or an empty selection, filters nothing', () => {
    expect(setFilterPasses(null, 'anything')).toBe(true)
    expect(setFilterPasses(undefined, 'anything')).toBe(true)
    expect(setFilterPasses({ filterType: 'set', values: [] }, 'anything')).toBe(true)
  })

  it('keeps only the chosen values', () => {
    const m: GridSetFilterModel = { filterType: 'set', values: ['ACTIVE', 'DRAFT'] }
    expect(setFilterPasses(m, 'ACTIVE')).toBe(true)
    expect(setFilterPasses(m, 'ARCHIVED')).toBe(false)
  })

  it('compares as text, so a number cell matches its own option', () => {
    expect(setFilterPasses({ filterType: 'set', values: ['10'] }, 10)).toBe(true)
    expect(setFilterPasses({ filterType: 'set', values: ['10'] }, 11)).toBe(false)
  })

  it('a blank cell is excluded unless the operator explicitly asked for blanks', () => {
    const chosen: GridSetFilterModel = { filterType: 'set', values: ['ACTIVE'] }
    for (const blank of [null, undefined, '']) expect(setFilterPasses(chosen, blank)).toBe(false)
    const blanks: GridSetFilterModel = { filterType: 'set', values: [BLANK_FILTER_VALUE] }
    for (const blank of [null, undefined, '']) expect(setFilterPasses(blanks, blank)).toBe(true)
    expect(setFilterPasses(blanks, 'ACTIVE')).toBe(false)
  })
})

describe('numberFilterPasses', () => {
  it('no model, or no bound at all, filters nothing', () => {
    expect(numberFilterPasses(null, 5)).toBe(true)
    expect(numberFilterPasses({ filterType: 'number', type: 'inRange', filter: null, filterTo: null }, 5)).toBe(true)
  })

  it('an absent bound is OPEN on that side', () => {
    const minOnly = { filterType: 'number', type: 'inRange', filter: 10, filterTo: null } as const
    expect(numberFilterPasses(minOnly, 9)).toBe(false)
    expect(numberFilterPasses(minOnly, 10)).toBe(true)
    expect(numberFilterPasses(minOnly, 1e9)).toBe(true)

    const maxOnly = { filterType: 'number', type: 'inRange', filter: null, filterTo: 10 } as const
    expect(numberFilterPasses(maxOnly, 11)).toBe(false)
    expect(numberFilterPasses(maxOnly, 10)).toBe(true)
    expect(numberFilterPasses(maxOnly, -1e9)).toBe(true)
  })

  it('inRange includes both bounds', () => {
    const m = { filterType: 'number', type: 'inRange', filter: 10, filterTo: 20 } as const
    expect([9, 10, 15, 20, 21].map((n) => numberFilterPasses(m, n))).toEqual([false, true, true, true, false])
  })

  it('honours the single-sided comparison types', () => {
    expect(numberFilterPasses({ filterType: 'number', type: 'greaterThanOrEqual', filter: 10 }, 10)).toBe(true)
    expect(numberFilterPasses({ filterType: 'number', type: 'greaterThanOrEqual', filter: 10 }, 9)).toBe(false)
    expect(numberFilterPasses({ filterType: 'number', type: 'lessThanOrEqual', filter: 10 }, 11)).toBe(false)
    expect(numberFilterPasses({ filterType: 'number', type: 'equals', filter: 10 }, 10)).toBe(true)
    expect(numberFilterPasses({ filterType: 'number', type: 'equals', filter: 10 }, 10.5)).toBe(false)
  })

  /**
   * 🔴 The null-is-not-a-zero rule. `null <= 10` is true in JavaScript exactly as it is in SQL, so
   * a naive comparison hands the operator every never-measured row inside a "price under 10" filter.
   */
  it('a blank cell never passes a bounded filter — it is no answer, not a zero', () => {
    const under10 = { filterType: 'number', type: 'lessThanOrEqual', filter: 10 } as const
    for (const blank of [null, undefined, '']) expect(numberFilterPasses(under10, blank)).toBe(false)
    // The coercion that would have let them through, stated so the intent is unmistakable.
    expect(Number(null) <= 10).toBe(true)
  })

  it('a value that is not a number at all does not pass', () => {
    expect(numberFilterPasses({ filterType: 'number', type: 'inRange', filter: 0, filterTo: 100 }, 'n/a')).toBe(false)
    expect(numberFilterPasses({ filterType: 'number', type: 'inRange', filter: 0, filterTo: 100 }, NaN)).toBe(false)
  })

  it('reads a numeric string, which is how a JSONB attribute arrives', () => {
    expect(numberFilterPasses({ filterType: 'number', type: 'inRange', filter: 10, filterTo: 20 }, '15')).toBe(true)
    expect(numberFilterPasses({ filterType: 'number', type: 'inRange', filter: 10, filterTo: 20 }, '25')).toBe(false)
  })
})

describe('textFilterPasses', () => {
  it('no model, or a blank needle, filters nothing', () => {
    expect(textFilterPasses(null, 'Giacca')).toBe(true)
    expect(textFilterPasses({ filterType: 'text', type: 'contains', filter: '   ' }, 'Giacca')).toBe(true)
  })

  it('matches a substring, case-insensitively', () => {
    const m = { filterType: 'text', type: 'contains', filter: 'giac' } as const
    expect(textFilterPasses(m, 'XAVIA GALE Giacca Da Moto')).toBe(true)
    expect(textFilterPasses(m, 'Guanti')).toBe(false)
  })

  it('trims the operator’s typo but never the data', () => {
    expect(textFilterPasses({ filterType: 'text', type: 'contains', filter: ' gale ' }, 'XAVIA GALE')).toBe(true)
    expect(textFilterPasses({ filterType: 'text', type: 'contains', filter: 'e j' }, 'GALE JACKET')).toBe(true)
  })

  /**
   * The needles here are chosen, not incidental. `String(undefined)` is the seven-letter word
   * "undefined" and `String(null)` is "null", so a filter for "e", "n", "d" or "ul" matches every
   * blank cell in the column unless the blank is refused BEFORE the coercion. A test that only ever
   * searches for "a" passes against the broken implementation.
   */
  it('a blank cell never matches — including needles inside the words "undefined" and "null"', () => {
    for (const needle of ['a', 'e', 'n', 'd', 'ul', 'undefined', 'null', 'defin']) {
      for (const blank of [null, undefined, '']) {
        expect(textFilterPasses({ filterType: 'text', type: 'contains', filter: needle }, blank)).toBe(false)
      }
    }
  })

  it('reads a non-string value as its text', () => {
    expect(textFilterPasses({ filterType: 'text', type: 'contains', filter: '06' }, 5060)).toBe(true)
  })
})
