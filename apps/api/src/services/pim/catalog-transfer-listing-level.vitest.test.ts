/**
 * Audit A25 — an import writes the row it names, while eBay takes ONE value per listing for an item specific that is not
 * an axis (the parent's, else the first variation's that holds one). The import review now says so: a variation row's
 * value is stored but not what eBay receives, and a parent clear leaves the variations' copies, which eBay then sends.
 * (The sheet's save writes such values where eBay reads them; `ebay-listing-level-write.vitest.test.ts`.)
 */
import { describe, expect, it } from 'vitest'
import { ebayListingLevelImportWarning, type TransferContext, type TransferProduct } from './catalog-transfer-plan.js'
import type { CatalogueField } from './mapping/field-catalogue.service.js'

const aspect = (name: string, fieldKey: string) => ({ fieldKey, sheetKey: fieldKey, label: name, channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', name] } }) as unknown as CatalogueField
const ORIGIN = aspect('Paese di origine', 'paese_di_origine')
const COLOUR = aspect('Colore', 'color')
const parent = { id: 'p', sku: 'LL-FAM', parentId: null, isParent: true, variationAxes: ['Colore', 'Taglia'] } as unknown as TransferProduct
const variation = { id: 'a', sku: 'LL-FAM-A', parentId: 'p', isParent: false, parent } as unknown as TransferProduct
const single = { id: 's', sku: 'SOLO', parentId: null, isParent: false } as unknown as TransferProduct
const context = { parentsWithChildren: new Set(['p']) } as unknown as TransferContext

describe('the import review names an eBay listing-level value eBay does not receive from that row', () => {
  it('a variation row\'s "Paese di origine" is stored but not sent while the parent holds one: import it on the parent', () => {
    expect(ebayListingLevelImportWarning(ORIGIN, 'SET', variation, context)).toBe('eBay takes one value for the whole listing, from the parent LL-FAM (or, when it holds none, the first variation that does). This row\'s value is stored but sent only in that case: import it on LL-FAM.')
  })
  it('a CLEAR on the parent row warns that a variation\'s copy is then what eBay receives', () => {
    expect(ebayListingLevelImportWarning(ORIGIN, 'CLEAR', parent, context)).toMatch(/sends the first variation that still stores one/)
  })
  it('control: an axis (Colore) is the variation\'s own; a single product, and a SET on the parent, say nothing', () => {
    expect(ebayListingLevelImportWarning(COLOUR, 'SET', variation, context)).toBeNull()
    expect(ebayListingLevelImportWarning(ORIGIN, 'SET', single, context)).toBeNull()
    expect(ebayListingLevelImportWarning(ORIGIN, 'SET', parent, context)).toBeNull()
  })
})
