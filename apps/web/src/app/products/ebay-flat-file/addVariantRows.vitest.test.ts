import { describe, it, expect } from 'vitest'
import { generateVariantRowsUnderParent } from './addVariantRows'

describe('generateVariantRowsUnderParent', () => {
  it('(a) produces correct variant rows — no parent row, correct platformProductId / aspects / SKUs', () => {
    const rows = generateVariantRowsUnderParent({
      parentId: 'P',
      axes: ['Color', 'Size'],
      axisValues: { Color: ['Red', 'Blue'], Size: ['M'] },
      skuTemplate: '{PARENT}-{Color}-{Size}',
      parentSku: 'JKT',
    })

    // Exactly 2 rows (Red×M, Blue×M) — no parent row
    expect(rows).toHaveLength(2)

    for (const row of rows) {
      expect(row._isParent).toBe(false)
      expect(row.platformProductId).toBe('P')
      expect(row.parentage).toBe('child')
      expect(row.parent_sku).toBe('JKT')
      expect(row._isNew).toBe(true)
      expect(row._dirty).toBe(true)
      expect(row._status).toBe('idle')
    }

    const [r0, r1] = rows
    expect(r0.sku).toBe('JKT-Red-M')
    expect(r0.aspect_Color).toBe('Red')
    expect(r0.aspect_Size).toBe('M')

    expect(r1.sku).toBe('JKT-Blue-M')
    expect(r1.aspect_Color).toBe('Blue')
    expect(r1.aspect_Size).toBe('M')
  })

  it('(b) every _rowId is unique across rows and across multiple calls', () => {
    const rows1 = generateVariantRowsUnderParent({
      parentId: 'P1',
      axes: ['Color'],
      axisValues: { Color: ['Red', 'Green', 'Blue'] },
      skuTemplate: '{PARENT}-{Color}',
      parentSku: 'SKU',
    })

    const rows2 = generateVariantRowsUnderParent({
      parentId: 'P2',
      axes: ['Size'],
      axisValues: { Size: ['S', 'M', 'L'] },
      skuTemplate: '{PARENT}-{Size}',
      parentSku: 'SKU',
    })

    const allIds = [...rows1, ...rows2].map((r) => r._rowId)
    const unique = new Set(allIds)
    expect(unique.size).toBe(allIds.length)
  })
})
