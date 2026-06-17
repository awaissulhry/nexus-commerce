/**
 * FX.4 — value coercion engine. Pure, so enum match (exact/case/normalized),
 * EU-locale numbers, booleans, max-length flagging, and the row-batch issue
 * accounting are fully unit-testable without AI or a DB.
 */
import { describe, it, expect } from 'vitest'
import { coerceValue, coerceRows } from './flat-file-coerce.js'

const enumCol = (options: string[]) => ({ kind: 'enum' as const, options })
const numCol = { kind: 'number' as const }
const boolCol = { kind: 'boolean' as const }
const textCol = (maxLength?: number) => ({ kind: 'text' as const, maxLength })

describe('FX.4 — coerceValue: enum', () => {
  const col = enumCol(['Red', 'Black', 'Hi-Vis Yellow'])
  it('exact option → ok', () => expect(coerceValue('Red', col)).toMatchObject({ value: 'Red', status: 'ok' }))
  it('case-insensitive → coerced to the canonical option', () =>
    expect(coerceValue('black', col)).toMatchObject({ value: 'Black', status: 'coerced' }))
  it('normalized (punctuation/space) → coerced', () =>
    expect(coerceValue('hi vis yellow', col)).toMatchObject({ value: 'Hi-Vis Yellow', status: 'coerced' }))
  it('no match → flagged, original kept', () =>
    expect(coerceValue('Purple', col)).toMatchObject({ value: 'Purple', status: 'flagged' }))
  it('enum with no option list → passes through as ok', () =>
    expect(coerceValue('Anything', enumCol([]))).toMatchObject({ value: 'Anything', status: 'ok' }))
})

describe('FX.4 — coerceValue: number (EU locale)', () => {
  it('EU decimal comma → dot', () => expect(coerceValue('129,90', numCol)).toMatchObject({ value: '129.9', status: 'coerced' }))
  it('EU thousands + decimal', () => expect(coerceValue('1.234,56', numCol)).toMatchObject({ value: '1234.56', status: 'coerced' }))
  it('strips a currency symbol', () => expect(coerceValue('€ 89', numCol)).toMatchObject({ value: '89', status: 'coerced' }))
  it('already clean → ok', () => expect(coerceValue('42', numCol)).toMatchObject({ value: '42', status: 'ok' }))
  it('non-numeric → flagged', () => expect(coerceValue('N/A', numCol)).toMatchObject({ value: 'N/A', status: 'flagged' }))
})

describe('FX.4 — coerceValue: boolean', () => {
  it('yes → true', () => expect(coerceValue('Yes', boolCol)).toMatchObject({ value: 'true', status: 'coerced' }))
  it('Italian "sì" → true', () => expect(coerceValue('sì', boolCol)).toMatchObject({ value: 'true', status: 'coerced' }))
  it('0 → false', () => expect(coerceValue('0', boolCol)).toMatchObject({ value: 'false', status: 'coerced' }))
  it('already "true" → ok', () => expect(coerceValue('true', boolCol)).toMatchObject({ value: 'true', status: 'ok' }))
  it('garbage → flagged', () => expect(coerceValue('maybe', boolCol)).toMatchObject({ status: 'flagged' }))
})

describe('FX.4 — coerceValue: text', () => {
  it('within max length → ok (trimmed)', () =>
    expect(coerceValue('  Jacket  ', textCol(50))).toMatchObject({ value: 'Jacket', status: 'coerced' }))
  it('over max length → flagged (kept, not truncated)', () => {
    const r = coerceValue('abcdefghij', textCol(5))
    expect(r).toMatchObject({ value: 'abcdefghij', status: 'flagged' })
    expect(r.note).toContain('max length 5')
  })
  it('empty stays empty + ok', () => expect(coerceValue('', textCol())).toMatchObject({ value: '', status: 'ok' }))
})

describe('FX.4 — coerceRows: batch + issue accounting', () => {
  const columns = [
    { id: 'item_sku', kind: 'text' as const },
    { id: 'standard_price', kind: 'number' as const },
    { id: 'color_name', kind: 'enum' as const, options: ['Red', 'Black'] },
  ]
  const rows = [
    { _rowId: 'r1', item_sku: 'A1', standard_price: '129,90', color_name: 'black', not_a_column: 'left alone' },
    { _rowId: 'r2', item_sku: 'A2', standard_price: 'oops', color_name: 'Purple' },
  ]
  const out = coerceRows(rows, columns)

  it('coerces matched cells + leaves unknown/structural keys untouched', () => {
    expect(out.rows[0]).toMatchObject({ standard_price: '129.9', color_name: 'Black', not_a_column: 'left alone', _rowId: 'r1' })
  })
  it('flags the bad number + the unknown enum, keeping originals', () => {
    expect(out.rows[1]).toMatchObject({ standard_price: 'oops', color_name: 'Purple' })
  })
  it('counts ok/coerced/flagged and lists issues with row index + column', () => {
    expect(out.counts).toEqual({ ok: 2, coerced: 2, flagged: 2 })
    expect(out.issues.filter((i) => i.status === 'flagged').map((i) => i.columnId).sort())
      .toEqual(['color_name', 'standard_price'])
    expect(out.issues.find((i) => i.columnId === 'color_name' && i.rowIndex === 1)).toMatchObject({ from: 'Purple', status: 'flagged' })
  })
})
