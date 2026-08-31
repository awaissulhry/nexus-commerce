// PH.3 — product graph.
//
// Three properties matter here and each has a real failure mode:
//   1. Stitching — one query returns catalog + inventory + channels.
//   2. Batching — N products cost a constant number of queries, not 3N.
//   3. Field security — costPrice is stripped for an unauthorised caller and
//      delivered to an authorised one. This is the property a probe proved
//      once; keeping it in the suite is what stops it regressing silently.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const { cacheFindFirst, cacheFindMany, stockFindMany, listingFindMany, productFindMany } = vi.hoisted(() => ({
  cacheFindFirst: vi.fn(), cacheFindMany: vi.fn(), stockFindMany: vi.fn(),
  listingFindMany: vi.fn(), productFindMany: vi.fn(),
}))

vi.mock('../db.js', () => ({
  default: {
    productReadCache: { findFirst: cacheFindFirst, findMany: cacheFindMany },
    stockLevel: { findMany: stockFindMany },
    channelListing: { findMany: listingFindMany },
    product: { findMany: productFindMany },
  },
}))

import { registerProductGraph } from './index.js'
import { financialFilterHook } from '../lib/auth/field-filter.js'

const cacheRow = (over: Record<string, unknown> = {}) => ({
  id: 'p1', sku: 'SUIT-48', name: 'Racing Suit', brand: 'Nexus', status: 'ACTIVE',
  productType: 'apparel', fulfillmentMethod: 'FBM', asin: 'B01', imageUrl: null,
  basePrice: 199, isParent: false, parentId: null,
  familyJson: { id: 'f1', code: 'SUITS', label: 'Suits' },
  workflowStageJson: { id: 'w1', code: 'LIVE', label: 'Live' },
  cacheRefreshedAt: new Date('2026-08-31T10:00:00.000Z'), ...over,
})

async function build(opts: { owner?: boolean; enforce?: boolean } = {}) {
  const app = Fastify()
  if (opts.enforce) {
    process.env.NEXUS_RBAC_MODE = 'enforce'
    app.addHook('onRequest', async (req: any) => {
      req.__rbacResolved = opts.owner ? { isOwner: true, permissions: new Set() } : undefined
    })
    app.addHook('preSerialization', financialFilterHook)
  }
  registerProductGraph(app)
  await app.ready()
  return app
}

const query = (app: any, q: string) =>
  app.inject({ method: 'POST', url: '/graphql', headers: { 'content-type': 'application/json' },
               payload: JSON.stringify({ query: q }) })

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.NEXUS_RBAC_MODE
  cacheFindFirst.mockResolvedValue(cacheRow())
  cacheFindMany.mockResolvedValue([cacheRow()])
  stockFindMany.mockResolvedValue([])
  listingFindMany.mockResolvedValue([])
  productFindMany.mockResolvedValue([])
})

describe('stitching', () => {
  it('returns catalog, inventory and channels in one round trip', async () => {
    stockFindMany.mockResolvedValue([
      { productId: 'p1', locationId: 'l1', quantity: 9, reserved: 2, available: 7, location: { code: 'IT-MAIN', type: 'WAREHOUSE' } },
      { productId: 'p1', locationId: 'l2', quantity: 50, reserved: 0, available: 50, location: { code: 'FBA-IT', type: 'AMAZON_FBA' } },
    ])
    listingFindMany.mockResolvedValue([
      { id: 'cl1', productId: 'p1', channel: 'EBAY', marketplace: 'IT', listingStatus: 'ACTIVE', quantity: 7, fulfillmentMethod: 'FBM', syncPaused: false },
    ])
    const app = await build()
    const res = await query(app, `{ product(sku:"SUIT-48") {
      sku name family { code } workflowStage { label }
      inventory { poolTotal reservedTotal availableTotal locations { code type quantity } }
      channels { channel marketplace quantity syncPaused }
    } }`)
    const p = res.json().data.product
    expect(p.sku).toBe('SUIT-48')
    expect(p.family.code).toBe('SUITS')
    expect(p.workflowStage.label).toBe('Live')
    // FBA is excluded from the pool but still listed — hiding it would make
    // the totals look wrong to anyone who knows the stock exists.
    expect(p.inventory.poolTotal).toBe(9)
    expect(p.inventory.availableTotal).toBe(7)
    expect(p.inventory.locations).toHaveLength(2)
    expect(p.channels[0]).toMatchObject({ channel: 'EBAY', quantity: 7, syncPaused: false })
    await app.close()
  })

  it('exposes the projection vintage rather than hiding it', async () => {
    const app = await build()
    const res = await query(app, `{ product(sku:"SUIT-48") { cacheRefreshedAt } }`)
    expect(res.json().data.product.cacheRefreshedAt).toBe('2026-08-31T10:00:00.000Z')
    await app.close()
  })

  it('costs nothing for a facet that is not selected', async () => {
    const app = await build()
    await query(app, `{ product(sku:"SUIT-48") { sku name } }`)
    expect(stockFindMany).not.toHaveBeenCalled()
    expect(listingFindMany).not.toHaveBeenCalled()
    expect(productFindMany).not.toHaveBeenCalled()  // costPrice unselected
    await app.close()
  })
})

describe('batching — the N+1 answer', () => {
  it('resolves three products with ONE batched query per facet', async () => {
    // Asserted on the QUERY SHAPE, not the call count. A call-count assertion
    // looked convincing and was not: bypassing the loader entirely still
    // recorded one call, so it could not tell batched from unbatched. Only a
    // batched loader issues `productId: { in: [all three] }` — a per-product
    // implementation cannot produce that argument.
    cacheFindMany.mockResolvedValue([cacheRow({ id: 'p1' }), cacheRow({ id: 'p2' }), cacheRow({ id: 'p3' })])
    const app = await build()
    await query(app, `{ products(skus:["a","b","c"]) { sku inventory { poolTotal } channels { channel } costPrice } }`)

    const batchedIds = (mock: typeof stockFindMany) => {
      const where = mock.mock.calls[0]?.[0]?.where?.productId
      return where && typeof where === 'object' && 'in' in where ? [...where.in].sort() : null
    }
    expect(cacheFindMany).toHaveBeenCalledTimes(1)
    expect(batchedIds(stockFindMany)).toEqual(['p1', 'p2', 'p3'])
    expect(batchedIds(listingFindMany)).toEqual(['p1', 'p2', 'p3'])
    // costPrice batches on the Product table for the same three ids.
    const costIds = productFindMany.mock.calls[0]?.[0]?.where?.id?.in
    expect([...(costIds ?? [])].sort()).toEqual(['p1', 'p2', 'p3'])
    await app.close()
  })

  it('keeps each product with its own rows when one has none', async () => {
    // DataLoader matches results to keys BY INDEX. Returning rows in database
    // order would hand p1's stock to p2 whenever p1 has no rows at all.
    cacheFindMany.mockResolvedValue([cacheRow({ id: 'p1', sku: 'A' }), cacheRow({ id: 'p2', sku: 'B' })])
    stockFindMany.mockResolvedValue([
      { productId: 'p2', locationId: 'l1', quantity: 4, reserved: 0, available: 4, location: { code: 'IT-MAIN', type: 'WAREHOUSE' } },
    ])
    const app = await build()
    const res = await query(app, `{ products(skus:["A","B"]) { sku inventory { poolTotal } } }`)
    const byS = Object.fromEntries(res.json().data.products.map((p: any) => [p.sku, p.inventory.poolTotal]))
    expect(byS).toEqual({ A: 0, B: 4 })
    await app.close()
  })
})

describe('field security', () => {
  it('STRIPS costPrice for a caller without the financial permission', async () => {
    productFindMany.mockResolvedValue([{ id: 'p1', costPrice: 42.5 }])
    const app = await build({ enforce: true, owner: false })
    const res = await query(app, `{ product(sku:"SUIT-48") { sku costPrice } }`)
    const p = res.json().data.product
    expect(p.sku).toBe('SUIT-48')
    expect(p.costPrice ?? null).toBeNull()
    await app.close()
  })

  it('DELIVERS costPrice to an authorised caller — it discriminates', async () => {
    // Stripping unconditionally would pass the test above while making the
    // field useless to everyone.
    productFindMany.mockResolvedValue([{ id: 'p1', costPrice: 42.5 }])
    const app = await build({ enforce: true, owner: true })
    const res = await query(app, `{ product(sku:"SUIT-48") { sku costPrice } }`)
    expect(res.json().data.product.costPrice).toBe(42.5)
    await app.close()
  })
})

describe('route gating', () => {
  it('is mapped in the permissions manifest, to the READ permission', async () => {
    // The platform denies unmapped routes 403 `route_unmapped`. Without this
    // entry /graphql would fail closed — correct, but silently, and the
    // symptom (every query 403s) points nowhere near the cause.
    const { permissionForRoute } = await import('../lib/auth/permissions-manifest.js')
    const read = permissionForRoute('POST', '/graphql')
    expect(read).toBeTruthy()
    expect(read).not.toBe('PUBLIC')
    expect(String(read)).toMatch(/products/)
  })
})

describe('limits and caller errors', () => {
  it('accepts the deepest legitimate query the schema allows', async () => {
    // HONEST SCOPE: the schema is acyclic today (no Product.parent -> Product),
    // so a query CANNOT exceed the depth cap and this test cannot exercise the
    // rejection path. The cap is a forward guard for the first recursive field
    // anyone adds — at which point this test should gain its counterpart.
    const app = await build()
    const deepest = `{ product(sku:"x") { channels { channel } inventory { locations { code } } } }`
    expect((await query(app, deepest)).statusCode).toBe(200)
    await app.close()
  })

  it('refuses a batch over the cap instead of silently truncating', async () => {
    const app = await build()
    const skus = Array.from({ length: 101 }, (_, i) => `"s${i}"`).join(',')
    const res = await query(app, `{ products(skus:[${skus}]) { sku } }`)
    expect(JSON.stringify(res.json().errors)).toMatch(/at most 100 skus/)
    await app.close()
  })

  it('refuses product() with both id and sku, or neither', async () => {
    const app = await build()
    for (const args of ['(id:"p1", sku:"s")', '']) {
      const res = await query(app, `{ product${args} { sku } }`)
      expect(JSON.stringify(res.json().errors)).toMatch(/exactly one/)
    }
    await app.close()
  })
})
