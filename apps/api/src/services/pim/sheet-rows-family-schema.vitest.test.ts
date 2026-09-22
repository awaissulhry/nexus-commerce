import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Step 2.4 move 2 for the grid (A-20 (b), unblocked by R-14 (a)) — the products grid lets the FAMILY
 * decide its Shared columns, as the product editor already does. This pins the WIRING: the real
 * `getSheetRows`, on a fake database, must hand the column build the page's families (judged by each
 * row's root), the master scope, and every attribute the page already holds a value for.
 */
const db = vi.hoisted(() => ({ count: vi.fn(), products: vi.fn(), listings: vi.fn(), columns: vi.fn() }))
vi.mock('../../db.js', () => ({ default: {
  product: { count: db.count, findMany: db.products },
  channelListing: { findMany: db.listings },
} }))
vi.mock('./sheet-columns.service.js', async (original) => ({
  ...(await original<typeof import('./sheet-columns.service.js')>()),
  getSheetColumns: db.columns,
}))
import { getSheetRows } from './sheet-rows.service.js'

const family = (id: string, over: Record<string, unknown>, children: Array<Record<string, unknown>> = []) =>
  ({ id, sku: id, name: id, parentId: null, isParent: children.length > 0, productType: 'OUTERWEAR', familyId: null, categoryAttributes: {}, children, ...over })
const child = (id: string, parentId: string, over: Record<string, unknown> = {}) =>
  ({ id, sku: id, name: id, parentId, isParent: false, productType: 'OUTERWEAR', familyId: null, categoryAttributes: {}, ...over })

beforeEach(() => {
  for (const m of Object.values(db)) m.mockReset()
  db.listings.mockResolvedValue([])
  db.columns.mockResolvedValue({ market: 'IT', locale: 'it', coordinates: [], productTypes: [], columns: [], groups: [], droppedKeys: [],
    schemaMissing: [], schemaAge: [], coverage: [], availableMarkets: [], coordinatesNotListed: [] })
})

describe('the products grid asks the FAMILY for its Shared columns', () => {
  it('passes the families of the page roots, the master scope and the saved attributes; a shell is not a missing family', async () => {
    const page = [
      family('A', { familyId: 'fam-jackets', categoryAttributes: { chest: 'M' } }, [child('a1', 'A', { categoryAttributes: { closure: 'zip' } })]),
      family('B', { familyId: 'fam-gloves' }),
      family('C', {}), // a real product with no family
      family('S', { productType: 'EBAY_LISTING_SHELL' }), // an extra eBay listing of another product
    ]
    db.count.mockResolvedValue(page.length)
    db.products.mockResolvedValue(page)
    const result = await getSheetRows({ market: 'IT', page: 1, limit: 25 })

    expect(db.columns).toHaveBeenCalledTimes(1)
    const input = db.columns.mock.calls[0][0]
    expect(input).toMatchObject({ market: 'IT', scopeKind: 'master', familyIds: ['fam-gloves', 'fam-jackets'] })
    expect(input.savedFields.map((f: { id: string }) => f.id)).toEqual(['attr_chest', 'attr_closure'])
    expect(result.productsWithoutFamily).toEqual({ count: 1, of: 3 })
  })

  it('exact rows: a variation opened on its own takes its PARENT\'s family, not its own empty one', async () => {
    const parent = family('A', { familyId: 'fam-jackets' })
    db.products.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.includes('a1') ? [child('a1', 'A')] : where.id.in.includes('A') ? [parent] : [])
    const result = await getSheetRows({ market: 'IT', page: 1, limit: 25, ids: ['a1'] } as never)
    expect(db.columns.mock.calls[0][0]).toMatchObject({ familyIds: ['fam-jackets'] })
    expect(result.productsWithoutFamily).toEqual({ count: 0, of: 1 })
  })

  it('a page with no family at all still asks the family path, so no channel ever decides the columns', async () => {
    db.count.mockResolvedValue(1)
    db.products.mockResolvedValue([family('S', { productType: 'EBAY_LISTING_SHELL' })])
    const result = await getSheetRows({ market: 'IT', page: 1, limit: 25 })
    expect(db.columns.mock.calls[0][0]).toMatchObject({ scopeKind: 'master', familyIds: [] })
    expect(result.productsWithoutFamily).toEqual({ count: 0, of: 0 })
  })
})
