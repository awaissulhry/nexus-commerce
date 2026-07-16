/**
 * E2 — family-aware import planner tests: (family, sku) identity, duplicate
 * SKUs across families, grid-vs-in-file parent resolution, legacy standalone.
 */
import { describe, it, expect } from 'vitest'
import { planFamilyImport } from './importFamilies.pure'

const gridParent = (sku: string, id: string, theme = 'Taglia') => ({
  _rowId: `r-${sku}`, sku, _isParent: true, parentage: 'parent', _productId: id, variation_theme: theme,
})
const gridChild = (sku: string, parentSku: string) => ({
  _rowId: `r-${sku}-${parentSku}`, sku, parentage: 'child', parent_sku: parentSku,
})

describe('planFamilyImport', () => {
  it('imports TWO parents sharing the same child SKUs in one file (the E1 blocker)', () => {
    const imported = [
      { sku: 'P1', parentage: 'parent', shared_sku_listing: true, variation_theme: 'Taglia' },
      { sku: 'V-M', parent_sku: 'P1', aspect_Taglia: 'M' },
      { sku: 'P2', parentage: 'parent', shared_sku_listing: true, variation_theme: 'Taglia' },
      { sku: 'V-M', parent_sku: 'P2', aspect_Taglia: 'M' },
    ]
    const actions = planFamilyImport(imported, [])
    expect(actions.map((a) => a.kind)).toEqual(['add', 'add', 'add', 'add'])
    expect(actions[0].isParent).toBe(true)
    expect(actions[1].parent).toMatchObject({ sku: 'P1', inFile: true })
    expect(actions[3].parent).toMatchObject({ sku: 'P2', inFile: true }) // same SKU, second family — NOT collapsed
  })

  it('updates only within the same family; a SKU under a different family is added, not re-parented', () => {
    const grid = [gridParent('P1', 'prod-p1'), gridChild('V-M', 'P1')]
    const imported = [
      { sku: 'V-M', parent_sku: 'P1', it_price: '10' },   // same family → update
      { sku: 'P2', parentage: 'parent' },
      { sku: 'V-M', parent_sku: 'P2', it_price: '12' },   // other family → add under P2
    ]
    const actions = planFamilyImport(imported, grid)
    expect(actions[0]).toMatchObject({ kind: 'update', targetRowId: 'r-V-M-P1' })
    expect(actions[2]).toMatchObject({ kind: 'add' })
    expect(actions[2].parent).toMatchObject({ sku: 'P2', inFile: true })
  })

  it('resolves an existing grid parent (platformId + theme) for new children', () => {
    const grid = [gridParent('P1', 'prod-p1', 'Taglia,Colore')]
    const actions = planFamilyImport([{ sku: 'V-XL', parent_sku: 'P1' }], grid)
    expect(actions[0].parent).toMatchObject({ sku: 'P1', platformId: 'prod-p1', theme: 'Taglia,Colore', inFile: false })
  })

  it('keeps legacy any-match semantics for standalone rows (no parent_sku column)', () => {
    const grid = [gridChild('V-M', 'P1')]
    const actions = planFamilyImport([{ sku: 'V-M', it_price: '9' }], grid)
    expect(actions[0]).toMatchObject({ kind: 'update', targetRowId: 'r-V-M-P1' })
  })

  it('a parent row updates its existing grid family parent instead of duplicating it', () => {
    const grid = [gridParent('P1', 'prod-p1')]
    const actions = planFamilyImport([{ sku: 'P1', parentage: 'parent', title: 'New title' }], grid)
    expect(actions[0]).toMatchObject({ kind: 'update', targetRowId: 'r-P1' })
  })
})
