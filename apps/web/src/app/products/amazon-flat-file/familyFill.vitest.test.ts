import { describe, expect, it } from 'vitest'
import { computeFamilyUniformFills } from './familyFill.pure'

const child = (sku: string, over: Record<string, unknown> = {}) => ({
  rowKey: `upd:${sku}`,
  row: { item_sku: sku, parent_sku: 'FAM', parentage_level: 'child', ...over },
})

describe('computeFamilyUniformFills (FFT-I3)', () => {
  it('fills blanks when the family agrees on exactly one value', () => {
    const r = computeFamilyUniformFills([
      child('A', { product_tax_code: 'A_GEN_STANDARD' }),
      child('B', { product_tax_code: 'A_GEN_STANDARD' }),
      child('C', { product_tax_code: '' }),
      child('D', {}),
    ], ['product_tax_code'])
    expect(r.cells).toEqual([
      { rowKey: 'upd:C', sku: 'C', columnId: 'product_tax_code', value: 'A_GEN_STANDARD' },
      { rowKey: 'upd:D', sku: 'D', columnId: 'product_tax_code', value: 'A_GEN_STANDARD' },
    ])
    expect(r.byColumn.product_tax_code).toEqual({ value: 'A_GEN_STANDARD', count: 2 })
  })

  it('never fills on disagreement, single-source, or fully-filled columns', () => {
    const r = computeFamilyUniformFills([
      child('A', { c1: 'X', c2: 'ONLY-ONE', c3: 'F' }),
      child('B', { c1: 'Y', c2: '', c3: 'F' }),
      child('C', { c1: '', c2: '', c3: 'F' }),
    ], ['c1', 'c2', 'c3'])
    expect(r.cells).toEqual([]) // c1 disagreement; c2 only 1 filled; c3 no blanks
  })

  it('never proposes pool/identity/axis/image/name columns', () => {
    const rows = [
      child('A', { 'fulfillment_availability__quantity': '5', size_name: 'M', item_name: 'T', main_product_image_locator: 'u' }),
      child('B', { 'fulfillment_availability__quantity': '5', size_name: 'M', item_name: 'T', main_product_image_locator: 'u' }),
      child('C', {}),
    ]
    const r = computeFamilyUniformFills(rows, ['fulfillment_availability__quantity', 'size_name', 'item_name', 'main_product_image_locator'])
    expect(r.cells).toEqual([])
  })

  it('parents are never fill targets and families are independent', () => {
    const r = computeFamilyUniformFills([
      { rowKey: 'upd:P', row: { item_sku: 'P', parentage_level: 'parent', product_tax_code: '' } },
      child('A', { product_tax_code: 'T1' }),
      child('B', { product_tax_code: 'T1' }),
      child('X', { parent_sku: 'FAM2', product_tax_code: 'T2' }),
      child('Y', { parent_sku: 'FAM2', product_tax_code: 'T2' }),
      child('Z', { parent_sku: 'FAM2', product_tax_code: '' }),
      child('BLANK', { product_tax_code: '' }),
    ], ['product_tax_code'])
    expect(r.cells.map((c) => c.sku).sort()).toEqual(['BLANK', 'Z'])
    expect(r.cells.find((c) => c.sku === 'Z')?.value).toBe('T2')
    expect(r.cells.find((c) => c.sku === 'BLANK')?.value).toBe('T1')
  })
})
