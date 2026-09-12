vi.mock('../services/pim/product-category-context.js', () => ({ productCategoryContext: async () => ({ categories: ['OUTERWEAR'] }) }))
/**
 * #723/#732 — an unknown reference in a formula is an ERROR, never a silent null.
 *
 * ⚠ CONSTRUCTED fixture, legitimate here for the same reason as the axis file:
 * it asserts a DERIVATION (given these columns and these attributes, which refs
 * are unknown and where), not where a writer stores data. The shapes are taken
 * from live readings on GALE-JACKET — `waterproofRating` is a real attribute
 * resolving to null, `sku`/`name` are real columns, and `ebay_title` exists on
 * IT but not on DE, which is why `market` is part of the request at all.
 *
 * Run: npx vitest run src/routes/cell-formula-unknown-refs.vitest.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const productFindUnique = vi.fn()
const channelListingFindFirst = vi.fn()
const getStudioColumns = vi.fn()

vi.mock('../db.js', () => ({
  default: {
    product: { findUnique: (...a: unknown[]) => productFindUnique(...a) },
    channelListing: { findFirst: (...a: unknown[]) => channelListingFindFirst(...a) },
    cellFormula: { findMany: async () => [], findUnique: async () => null },
    auditLog: { findMany: async () => [] },
  },
}))
vi.mock('../services/pim/studio-columns.js', () => ({
  getStudioColumns: (...a: unknown[]) => getStudioColumns(...a),
}))
vi.mock('../services/pim/schema-mapping.service.js', () => ({
  getMappingForMarketplace: async () => ({ expressions: {} }),
}))
vi.mock('../services/pim/value-map.service.js', () => ({
  loadValueMapLookup: async () => undefined,
  loadSizeScaleLookup: async () => undefined,
}))

import cellFormulaRoutes from './cell-formula.routes.js'

const PID = 'p1'
const col = (key: string, storage: 'column' | 'categoryAttributes') => ({
  key, writeField: key, label: key, group: 'g', kind: 'text', storage,
  scope: 'global', requiredBy: [], editable: true, defaultVisible: true,
})

let app: FastifyInstance
beforeEach(async () => {
  productFindUnique.mockReset(); channelListingFindFirst.mockReset(); getStudioColumns.mockReset()
  productFindUnique.mockResolvedValue({
    id: PID, parentId: null, sku: 'GALE-JACKET', name: 'XAVIA GALE', manufacturer: null,
    productType: 'OUTERWEAR', variationAxes: [],
    // `waterproofRating` is declared and EMPTY — the case that must stay ok:true.
    categoryAttributes: { brand: 'XAVIA', waterproofRating: null },
    variantAttributes: {}, localizedContent: {},
  })
  channelListingFindFirst.mockResolvedValue(null)
  getStudioColumns.mockResolvedValue({
    columns: [col('description', 'column'), col('sku', 'column'), col('name', 'column'), col('manufacturer', 'column'),
              col('brand', 'categoryAttributes'), col('waterproofRating', 'categoryAttributes')],
  })
  app = Fastify()
  app.patch('/api/products/bulk', async () => ({ errors: [], wouldUpdate: 1 }))
  await app.register(cellFormulaRoutes)
  await app.ready()
})

const preview = async (expr: string, market = 'IT') =>
  (await app.inject({
    method: 'POST', url: '/pim/formulas/preview',
    payload: { productId: PID, fieldKey: 'description', scope: 'master', market, locale: 'it', expr },
  })).json()

describe('#723 unknown references', () => {
  it('a typo is an ERROR naming the ref and its position', async () => {
    const r = await preview('=$athlete_typo')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('$athlete_typo')
    expect(r.errorPos).toBe(0)
    expect(r.unknownRefs).toEqual([{ name: 'athlete_typo', pos: 0 }])
  })

  it('the position is the REF\'s, not the start of the expression', async () => {
    // The case that made the defect visible: the unknown half was silently
    // dropped and the expression returned "x" as if it had succeeded.
    const r = await preview('="x" + $athlete_typo')
    expect(r.ok).toBe(false)
    expect(r.errorPos).toBe(6)
    expect(r.value).toBeNull()
  })

  it('a known-but-EMPTY attribute is not an error', async () => {
    const r = await preview('=$waterproofRating')
    expect(r.ok).toBe(true)
    expect(r.value).toBeNull()
    expect(r.unknownRefs).toEqual([])
  })

  it('a known-but-empty COLUMN is not an error either', async () => {
    // Before #728 this was indistinguishable from the typo above — both
    // returned byte-identical {ok:true, value:null}, which is the whole defect.
    const r = await preview('=$manufacturer')
    expect(r.ok).toBe(true)
    expect(r.value).toBeNull()
  })

  it('a COLUMN key resolves to its value', async () => {
    expect((await preview('=$sku')).value).toBe('GALE-JACKET')
    expect((await preview('=$name')).value).toBe('XAVIA GALE')
  })

  it('a resolved Master reference remains known when the channel omits its column', async () => {
    // Formula references include resolved Master facts, even on narrower channel schemas.
    getStudioColumns.mockResolvedValue({ columns: [col('description', 'column'), col('sku', 'column')] })
    const r = await preview('=$name', 'DE')
    expect(r.ok).toBe(true)
    expect(r.value).toBe('XAVIA GALE')
    expect(r.unknownRefs).toEqual([])
  })

  it('market is REQUIRED — never guessed', async () => {
    const res = await app.inject({
      method: 'POST', url: '/pim/formulas/preview',
      payload: { productId: PID, fieldKey: 'description', scope: 'master', locale: 'it', expr: '=$sku' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('market')
  })
})
