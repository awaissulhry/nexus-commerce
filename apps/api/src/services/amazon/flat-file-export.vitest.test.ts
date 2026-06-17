/**
 * FX.1 — export column-spec derivation. Pure, so the manifest → { id, label }
 * flattening (order, label fallback, multi-category product_type carry-through)
 * is fully unit-testable without a DB.
 */
import { describe, it, expect } from 'vitest'
import { flatFileExportColumns } from './flat-file.service.js'

const col = (id: string, labelEn: string) => ({
  id, fieldRef: id, labelEn, labelLocal: '', required: false, kind: 'text' as const, width: 100,
})

describe('FX.1 — flatFileExportColumns', () => {
  const manifest = {
    groups: [
      { id: 'identity', labelEn: 'Identity', labelLocal: '', color: '#fff', columns: [
        col('item_sku', 'SKU'),
        col('product_type', 'Product Type'),
      ] },
      { id: 'desc', labelEn: 'Description', labelLocal: '', color: '#fff', columns: [
        col('item_name', 'Title'),
        col('no_label', ''),
      ] },
    ],
  } as any

  it('flattens groups → columns preserving group + column order', () => {
    expect(flatFileExportColumns(manifest).map((c) => c.id)).toEqual([
      'item_sku', 'product_type', 'item_name', 'no_label',
    ])
  })
  it('uses the English label as the header', () => {
    expect(flatFileExportColumns(manifest).find((c) => c.id === 'item_name')!.label).toBe('Title')
  })
  it('falls back to the column id when labelEn is blank', () => {
    expect(flatFileExportColumns(manifest).find((c) => c.id === 'no_label')!.label).toBe('no_label')
  })
  it('carries product_type so a multi-category union sheet exports every row type', () => {
    expect(flatFileExportColumns(manifest).some((c) => c.id === 'product_type')).toBe(true)
  })
})
