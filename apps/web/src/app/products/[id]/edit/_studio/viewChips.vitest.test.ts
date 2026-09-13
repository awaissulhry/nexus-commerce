/**
 * PES.1 — the View-bar chip rules.
 *
 * The whole point of this contract is the difference between "not counted" and "counted, none", so
 * that is what these lock. A chip that renders `(0)` because nobody has answered yet tells the
 * operator the sheet is clean when it is merely unread.
 */

import { describe, expect, it } from 'vitest'

import {
  EMPTY_VIEW_CHIP_CELLS,
  isViewChipVisible,
  viewChipColumns,
  viewChipCountLabel,
  viewChipColumnCountLabel,
  viewChipSummary,
  viewChipHasCell,
  viewChipRows,
} from './viewChips'
import type { ViewChip } from './types'

const cells = {
  byRow: {
    'row-a': ['title', 'ean'],
    'row-b': ['ean'],
    'row-c': ['country_of_origin', 'title'],
  },
}

const chip = (over: Partial<ViewChip>): ViewChip => ({
  id: 'missing-required',
  label: 'Missing required',
  count: { n: 0, unit: 'cells' },
  cells: EMPTY_VIEW_CHIP_CELLS,
  ...over,
})

describe('the cell projection', () => {
  it('gives rows as the keys', () => {
    expect(viewChipRows(cells)).toEqual(['row-a', 'row-b', 'row-c'])
  })

  it('gives columns as the de-duplicated union, in first-seen order', () => {
    expect(viewChipColumns(cells)).toEqual(['title', 'ean', 'country_of_origin'])
  })

  it('keeps WHICH cell, not just the rectangle', () => {
    // row-b × title is inside the 3 × 3 rectangle the projection implies, and is NOT one of the
    // chip's cells. A renderer that highlighted the rectangle would mark it anyway.
    expect(viewChipHasCell(cells, 'row-a', 'title')).toBe(true)
    expect(viewChipHasCell(cells, 'row-b', 'title')).toBe(false)
    expect(viewChipHasCell(cells, 'row-z', 'title')).toBe(false)
  })

  it('is empty, not undefined, for a chip with nothing to point at', () => {
    expect(viewChipRows(EMPTY_VIEW_CHIP_CELLS)).toEqual([])
    expect(viewChipColumns(EMPTY_VIEW_CHIP_CELLS)).toEqual([])
  })
})

describe('🔴 null is not zero', () => {
  it('never labels an uncounted chip as 0', () => {
    expect(viewChipCountLabel(chip({ count: null }))).toBeNull()
    expect(viewChipCountLabel(chip({ count: { n: 0, unit: 'cells' } }))).toBe('0 cells')
    expect(viewChipCountLabel(chip({ count: { n: 7, unit: 'cells' } }))).toBe('7 cells')
  })

  it('KEEPS an uncounted chip on screen — hiding it would answer "none"', () => {
    // The pending chip is the only thing telling the operator a count is outstanding. Hiding it
    // is indistinguishable from having counted and found nothing.
    expect(isViewChipVisible(chip({ count: null }))).toBe(true)
    expect(isViewChipVisible(chip({ count: null, hideWhenZero: true }))).toBe(true)
  })

  it('hides only a REAL zero, and only when the producer asked', () => {
    expect(isViewChipVisible(chip({ count: { n: 0, unit: 'cells' } }))).toBe(false)
    expect(isViewChipVisible(chip({ count: { n: 0, unit: 'cells' }, hideWhenZero: false }))).toBe(true)
    expect(isViewChipVisible(chip({ count: { n: 3, unit: 'cells' } }))).toBe(true)
    expect(isViewChipVisible(chip({ count: { n: 3, unit: 'cells' }, hideWhenZero: true }))).toBe(true)
  })

  it('keeps a selected filter visible when its final match is fixed or searched away', () => {
    expect(isViewChipVisible(chip({ count: { n: 0, unit: 'cells' } }), 'missing-required')).toBe(true)
    expect(isViewChipVisible(chip({ count: { n: 0, unit: 'cells' } }), 'mapping-errors')).toBe(false)
  })
})


describe('visible count units', () => {
  it('displays 63 cells and explains filter breadth across three columns and 21 rows', () => {
    const c = chip({ count: { n: 63, unit: 'cells' }, cells: { byRow: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [String(i), ['fabric_type', 'country_of_origin', 'hazmat']])) } })
    expect(viewChipCountLabel(c)).toBe('63 cells')
    expect(viewChipColumnCountLabel(c)).toBe('3 columns')
    expect(viewChipSummary(c)).toBe('63 affected cells across 3 columns and 21 rows')
  })
  it('deduplicates cells and ignores empty row entries', () => {
    const c = chip({ count: { n: 1, unit: 'cells' }, cells: { byRow: { a: ['brand', 'brand'], b: [] } } })
    expect(viewChipSummary(c)).toBe('1 affected cell across 1 column and 1 row')
  })
  it('leaves an uncounted result unknown', () => {
    expect(viewChipColumnCountLabel(chip({ count: null }))).toBeNull()
    expect(viewChipSummary(chip({ count: null }))).toBe('Not counted yet')
  })
})


it('keeps declared quantities independent of the cells used to narrow the view', () => {
  expect(viewChipCountLabel(chip({ count: { n: 17, unit: 'cells' }, cells: { byRow: { a: ['one'] } } }))).toBe('17 cells')
  expect(viewChipCountLabel(chip({ count: { n: 4, unit: 'variants' }, cells: { byRow: {} } }))).toBe('4 variants')
  expect(viewChipCountLabel(chip({ count: { n: 1, unit: 'axes' } }))).toBe('1 axis')
  expect(viewChipCountLabel(chip({ count: { n: 2, unit: 'axes' } }))).toBe('2 axes')
})
