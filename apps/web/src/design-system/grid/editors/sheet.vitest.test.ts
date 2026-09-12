import { describe, expect, it } from 'vitest'

import { lengthValidation, matchPasteToHeaders, selectValidation } from './sheet'

const COLS = [
  { colId: 'sku', headerName: 'SKU' },
  { colId: 'title', headerName: 'Title' },
  { colId: 'color', headerName: 'Colour' },
  { colId: 'size', headerName: 'Size' },
]

describe('matchPasteToHeaders — smart paste', () => {
  /**
   * 🔴 A column the block does not name comes back `null` — "leave this cell alone" — NOT `''`.
   *
   * This test used to assert the empty strings, which meant it described the implementation instead
   * of protecting the operator: AG pastes what it is given, so a two-column block from Excel blanked
   * every other visible column to its right on every pasted row. `title` is the column at risk here.
   */
  it('re-orders a block by header NAME and leaves unnamed columns UNTOUCHED', () => {
    const data = [['Size', 'SKU', 'Colour'], ['M', 'A-1', 'Black'], ['L', 'A-2', 'Red']]
    const out = matchPasteToHeaders(data, COLS, ['sku', 'title', 'color', 'size'])
    expect(out).toEqual([['A-1', null, 'Black', 'M'], ['A-2', null, 'Red', 'L']])
  })
  it('matches ids as well as labels, case-insensitively', () => {
    const data = [['sku', 'COLOUR'], ['A-1', 'Black']]
    expect(matchPasteToHeaders(data, COLS, ['sku', 'title', 'color'])).toEqual([['A-1', null, 'Black']])
  })
  it('a narrow block never reaches the columns beyond it', () => {
    // Two named columns, four targets: the two the operator meant, and two left alone.
    const data = [['SKU', 'Colour'], ['A-1', 'Black']]
    const out = matchPasteToHeaders(data, COLS, ['sku', 'title', 'color', 'size'])
    expect(out[0].filter((v) => v === null)).toHaveLength(2)
    expect(out[0]).toEqual(['A-1', null, 'Black', null])
  })
  it('pastes as-is when fewer than two headers match (a plain block of values)', () => {
    const data = [['M', 'Black'], ['L', 'Red']]
    expect(matchPasteToHeaders(data, COLS, ['size', 'color'])).toBe(data)
    const one = [['Size', 'x'], ['M', 'y']]
    expect(matchPasteToHeaders(one, COLS, ['size', 'color'])).toBe(one)
  })
  it('a single-row paste is never a header', () => {
    const data = [['SKU', 'Title']]
    expect(matchPasteToHeaders(data, COLS, ['sku', 'title'])).toBe(data)
  })
})

describe('validations — warn, never block, on an off-list value', () => {
  const strict = selectValidation(['Black', 'Red'], 'strict', true)
  it('strict select: listed = fine (case-insensitive), off-list = WARN, empty required = error', () => {
    expect(strict.validate('black', {}, 'c').level).toBeNull()
    expect(strict.validate('Blue', {}, 'c').level).toBe('warn')
    expect(strict.validate('', {}, 'c').level).toBe('error')
  })
  it('open select never warns', () => {
    expect(selectValidation(['Black'], 'open').validate('Anything', {}, 'c').level).toBeNull()
  })
  it('length: over the cap is an error; bytes when the cap is IN bytes', () => {
    const chars = (cap: number) => ({ characters: cap, bytes: null })
    const bytes = (cap: number) => ({ characters: null, bytes: cap })
    expect(lengthValidation(chars(5)).validate('12345', {}, 'c').level).toBeNull()
    expect(lengthValidation(chars(5)).validate('123456', {}, 'c').level).toBe('error')
    expect(lengthValidation(bytes(4)).validate('éé', {}, 'c').level).toBeNull() // 4 bytes
    expect(lengthValidation(bytes(3)).validate('éé', {}, 'c').level).toBe('error')
  })
})
