import { describe, expect, it } from 'vitest'

import { isSheetCellStamp, sheetCellStamp, sheetStampHolds } from './sheet-stamp'

const own = { value: 'Giacca nera', tier: 'source', inherited: false, pinned: false, follows: null, layer: 'master', source: 'masterColumn', editable: true }

describe('sheetCellStamp', () => {
  it('stamps the value and where it came from, nothing else of the cell', () => {
    expect(sheetCellStamp(own)).toEqual({ value: 'Giacca nera', from: { tier: 'source', inherited: false, pinned: false, follows: null, layer: 'master' } })
    expect(sheetCellStamp(null)).toBeUndefined()
  })

  it('reads a value as JSON carries it (a Date as its text, undefined as null)', () => {
    expect(sheetCellStamp({ value: new Date('2026-10-13T10:00:00.000Z') })?.value).toBe('2026-10-13T10:00:00.000Z')
    expect(sheetCellStamp({ value: undefined })?.value).toBeNull()
  })
})

describe('sheetStampHolds', () => {
  it('holds on the same cell read again, also after a JSON round trip and with other keys in another order', () => {
    const sent = JSON.parse(JSON.stringify(sheetCellStamp({ ...own, value: { value: 2, unit: 'kg' } })))
    expect(sheetStampHolds(sent, { layer: 'master', value: { unit: 'kg', value: 2 }, tier: 'source', pinned: false, inherited: false, follows: null, editable: false })).toBe(true)
  })

  it('refuses a value that moved', () => {
    expect(sheetStampHolds(sheetCellStamp(own), { ...own, value: 'Giacca blu' })).toBe(false)
  })

  it('refuses an inherited value that is now the row’s own — the same text, from another place', () => {
    const inherited = { value: 'Nero', inherited: true, pinned: false, follows: null, layer: 'master' }
    expect(sheetStampHolds(sheetCellStamp(inherited), { ...inherited, inherited: false, pinned: true, layer: 'variant' })).toBe(false)
  })

  it('refuses a followed text that is now pinned on the listing', () => {
    const following = { value: 'Title', tier: 'language', follows: true, pinned: false, layer: 'master' }
    expect(sheetStampHolds(sheetCellStamp(following), { ...following, tier: 'pin', follows: false, pinned: true, layer: 'channel' })).toBe(false)
  })

  it('never holds without a stamp or without a cell', () => {
    expect(sheetStampHolds(undefined, own)).toBe(false)
    expect(sheetStampHolds({ value: 'x' }, own)).toBe(false)
    expect(sheetStampHolds(sheetCellStamp(own), undefined)).toBe(false)
    expect(isSheetCellStamp(sheetCellStamp(own))).toBe(true)
  })
})
