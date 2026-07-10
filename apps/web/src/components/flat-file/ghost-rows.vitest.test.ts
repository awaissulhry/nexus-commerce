import { describe, it, expect } from 'vitest'
import {
  makeGhostRow, makeGhostRows, countGhosts, topUpGhosts,
  materializeGhostPatch, pasteGrowCount,
} from './ghost-rows'
import type { BaseRow } from './FlatFileGrid.types'

// UFX P2d — ghost-row "infinite canvas" pure helpers.

let seq = 0
/** Mirrors eBay's makeBlankRow (EbayFlatFileClient.tsx): marks new rows
 *  _isNew/_dirty TRUE — exactly what the ghost factory must neutralize. */
const ebayBlank = (): BaseRow => ({ _rowId: `new-${seq++}`, _isNew: true, _dirty: true, _status: 'idle', sku: '' })

const ghost = (): BaseRow => makeGhostRow(ebayBlank)
const real = (over: Partial<BaseRow> = {}): BaseRow => ({ _rowId: `r-${seq++}`, sku: 'SKU', ...over })

describe('makeGhostRow / makeGhostRows — canvas rows from the consumer factory', () => {
  it('forces _ghost:true and _isNew/_dirty FALSE even when makeBlankRow sets them true (eBay)', () => {
    const g = ghost()
    expect(g._ghost).toBe(true)
    expect(g._isNew).toBe(false)
    expect(g._dirty).toBe(false)
    expect(g.sku).toBe('') // consumer fields kept
    expect(g._status).toBe('idle')
  })

  it('makeGhostRows(n) builds n distinct rows; 0/negative → empty', () => {
    const gs = makeGhostRows(3, ebayBlank)
    expect(gs).toHaveLength(3)
    expect(new Set(gs.map((g) => g._rowId)).size).toBe(3)
    expect(makeGhostRows(0, ebayBlank)).toEqual([])
    expect(makeGhostRows(-2, ebayBlank)).toEqual([])
  })
})

describe('topUpGhosts — converging auto-topup', () => {
  it('appends only the missing ghosts, at the end', () => {
    const rows = [real(), real(), ghost()]
    const out = topUpGhosts(rows, 3, ebayBlank)
    expect(out).toHaveLength(5)
    expect(out.slice(0, 3)).toEqual(rows) // originals untouched, in place
    expect(countGhosts(out)).toBe(3)
    expect(out[3]._ghost).toBe(true)
    expect(out[4]._ghost).toBe(true)
  })

  it('returns the SAME array reference when the buffer is full or overfull (loop guard)', () => {
    const full = [real(), ghost(), ghost()]
    expect(topUpGhosts(full, 2, ebayBlank)).toBe(full)
    expect(topUpGhosts(full, 1, ebayBlank)).toBe(full) // never trims
  })

  it('converges: a second pass after topping up is a no-op', () => {
    const once = topUpGhosts([real()], 4, ebayBlank)
    expect(topUpGhosts(once, 4, ebayBlank)).toBe(once)
  })
})

describe('materializeGhostPatch — first real edit turns a ghost into a plain new row', () => {
  it('ghost → _ghost:false, _isNew:true, _dirty:true (what Add-row produces)', () => {
    expect(materializeGhostPatch(ghost())).toEqual({ _ghost: false, _isNew: true, _dirty: true })
  })

  it('real row → empty patch (spreading it is a no-op — legacy write path identical)', () => {
    const r = real({ _dirty: false })
    expect(materializeGhostPatch(r)).toEqual({})
    expect({ ...r, ...materializeGhostPatch(r) }).toEqual(r)
  })
})

describe('pasteGrowCount — paste-beyond-end auto-grow sizing', () => {
  it('0 when the block fits (at or before the end)', () => {
    expect(pasteGrowCount(10, 0, 10)).toBe(0)
    expect(pasteGrowCount(10, 5, 5)).toBe(0)
    expect(pasteGrowCount(10, 5, 3)).toBe(0)
  })

  it('exactly the rows that spill past the end', () => {
    expect(pasteGrowCount(10, 8, 5)).toBe(3)   // rows 8..12 in a 10-row sheet
    expect(pasteGrowCount(10, 9, 1)).toBe(0)   // last row exactly
    expect(pasteGrowCount(10, 10, 1)).toBe(1)  // first row past the end
    expect(pasteGrowCount(0, 0, 4)).toBe(4)    // empty sheet, 4-row paste
  })
})
