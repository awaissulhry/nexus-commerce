import { describe, expect, it } from 'vitest'
import { filterProductSheetRows, productSheetRowKey, productSheetRowPath, type ProductSheetRowIdentity } from './productSheetRows'

const shared = [
  { id: 'parent', parentId: null },
  { id: 'blue', parentId: 'parent' },
  { id: 'sand', parentId: 'parent' },
]
const listings: ProductSheetRowIdentity[] = ['primary', 'secondary'].flatMap(aliasId => shared.map(row => ({
  ...row, aliasId, rowId: `${aliasId}:${row.id}`, rowKind: row.parentId ? 'variant' as const : 'parent' as const,
})))

describe('common sheet row identity', () => {
  it('retains the shared parent when a child matches without including siblings', () => {
    expect(filterProductSheetRows(shared, row => row.id === 'blue')).toEqual(shared.slice(0, 2))
  })
  it('keeps a matching parent on its own', () => {
    expect(filterProductSheetRows(shared, row => row.id === 'parent')).toEqual([shared[0]])
  })
  it('distinguishes the same SKU on different listings and retains only its own band', () => {
    expect(filterProductSheetRows(listings, row => row.rowId === 'secondary:blue').map(productSheetRowKey))
      .toEqual(['secondary:parent', 'secondary:blue'])
  })
  it('retains both bands when search finds the same product in both listings', () => {
    expect(filterProductSheetRows(listings, row => row.id === 'blue').map(productSheetRowKey))
      .toEqual(['primary:parent', 'primary:blue', 'secondary:parent', 'secondary:blue'])
  })
  it('returns no rows when a chip has no matching cells', () => {
    expect(filterProductSheetRows(listings, () => false)).toEqual([])
  })
  it('treats a null alias as primary and does not conflate keys containing separators', () => {
    expect(productSheetRowPath({ id: 'blue', rowId: 'primary:blue', parentId: 'parent', aliasId: null, rowKind: 'variant' }))
      .toEqual(['primary', 'primary:blue'])
    const rows: ProductSheetRowIdentity[] = [
      { id: 'a', parentId: null, rowId: 'a', rowKind: 'parent', aliasId: 'a,b' },
      { id: 'b', parentId: null, rowId: 'b', rowKind: 'parent', aliasId: 'a' },
      { id: 'c', parentId: 'b', rowId: 'b,c', rowKind: 'variant', aliasId: 'a' },
    ]
    expect(filterProductSheetRows(rows, row => row.id === 'c').map(row => row.id)).toEqual(['b', 'c'])
  })
})
