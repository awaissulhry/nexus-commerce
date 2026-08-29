import { describe, expect, it } from 'vitest'

import { lengthValidation, matchPasteToHeaders, selectValidation } from './sheet'

const COLS = [
  { colId: 'sku', headerName: 'SKU' },
  { colId: 'title', headerName: 'Title' },
  { colId: 'color', headerName: 'Colour' },
  { colId: 'size', headerName: 'Size' },
]

describe('matchPasteToHeaders — smart paste', () => {
  it('re-orders a block by header NAME when ≥2 headers match, landing on the target columns', () => {
    const data = [['Size', 'SKU', 'Colour'], ['M', 'A-1', 'Black'], ['L', 'A-2', 'Red']]
    const out = matchPasteToHeaders(data, COLS, ['sku', 'title', 'color', 'size'])
    expect(out).toEqual([['A-1', '', 'Black', 'M'], ['A-2', '', 'Red', 'L']])
  })
  it('matches ids as well as labels, case-insensitively', () => {
    const data = [['sku', 'COLOUR'], ['A-1', 'Black']]
    expect(matchPasteToHeaders(data, COLS, ['sku', 'title', 'color'])).toEqual([['A-1', '', 'Black']])
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
  it('length: over the cap is an error; bytes when asked', () => {
    expect(lengthValidation(5).validate('12345', {}, 'c').level).toBeNull()
    expect(lengthValidation(5).validate('123456', {}, 'c').level).toBe('error')
    expect(lengthValidation(4, false, true).validate('éé', {}, 'c').level).toBeNull() // 4 bytes
    expect(lengthValidation(3, false, true).validate('éé', {}, 'c').level).toBe('error')
  })
})
