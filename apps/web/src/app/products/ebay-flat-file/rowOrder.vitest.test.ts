import { describe, it, expect } from 'vitest'
import { pinBlankRowsLast } from './rowOrder'

type Row = { sku?: string; _isNew?: boolean; _dirty?: boolean; id?: string }

describe('pinBlankRowsLast', () => {
  it('(a) moves blank rows from the middle to the end, preserving relative order', () => {
    const realA: Row = { sku: 'SKU-A', _isNew: false, id: 'a' }
    const blank1: Row = { sku: '', _isNew: true, id: 'b1' }
    const realC: Row = { sku: 'SKU-C', _isNew: false, id: 'c' }
    const blank2: Row = { sku: '', _isNew: true, id: 'b2' }

    const result = pinBlankRowsLast([realA, blank1, realC, blank2])

    expect(result).toEqual([realA, realC, blank1, blank2])
  })

  it('(b) imported row landing after trailing blank lands before blank', () => {
    const realA: Row = { sku: 'SKU-A', _isNew: false, id: 'a' }
    const blank: Row = { sku: '', _isNew: true, id: 'pad' }
    const importedB: Row = { sku: 'SKU-B', _isNew: true, _dirty: true, id: 'imported' }

    // Simulates: allRows=[realA, blank], then imported row appended → [realA, blank, importedB]
    const result = pinBlankRowsLast([realA, blank, importedB])

    expect(result).toEqual([realA, importedB, blank])
  })

  it('(c) rows with no blanks are returned in unchanged order', () => {
    const rows: Row[] = [
      { sku: 'SKU-1', _isNew: false },
      { sku: 'SKU-2', _isNew: false },
      { sku: 'SKU-3', _isNew: true, _dirty: true },
    ]
    const result = pinBlankRowsLast(rows)
    expect(result).toEqual(rows)
  })

  it('(d) a _dirty row WITH a sku is NOT treated as blank — stays in reals', () => {
    const dirty: Row = { sku: 'SKU-DIRTY', _isNew: true, _dirty: true }
    const blank: Row = { sku: '', _isNew: true }

    const result = pinBlankRowsLast([blank, dirty])

    // dirty has a sku → real; blank has empty sku + _isNew → blank
    expect(result).toEqual([dirty, blank])
  })

  it('empty input returns empty array', () => {
    expect(pinBlankRowsLast([])).toEqual([])
  })

  it('all blanks stay in original relative order at the end', () => {
    const b1: Row = { sku: '', _isNew: true, id: '1' }
    const b2: Row = { sku: '', _isNew: true, id: '2' }
    expect(pinBlankRowsLast([b1, b2])).toEqual([b1, b2])
  })
})
