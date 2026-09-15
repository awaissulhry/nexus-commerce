import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

type Row = { id: string; sku: string; parentId: string | null; deletedAt: Date | null }
let products: Row[] = [], cache: Row[] = [], audits: any[] = []
let failProjection = false
const matching = (rows: Row[], where: any) => rows.filter(row =>
  (!where.id?.in || where.id.in.includes(row.id)) &&
  (!where.parentId?.in || where.parentId.in.includes(row.parentId)) &&
  (where.deletedAt !== null || row.deletedAt === null))
vi.mock('../db.js', () => ({ default: {
  product: { findMany: async ({ where }: any) => matching(products, where) },
  $transaction: async (work: (tx: any) => Promise<unknown>) => {
    const staged = structuredClone(products), projected = structuredClone(cache), history: any[] = []
    const tx = {
      product: {
        findMany: async ({ where }: any) => matching(staged, where),
        updateMany: async ({ where, data }: any) => {
          const rows = matching(staged, where); rows.forEach(row => Object.assign(row, data)); return { count: rows.length }
        },
      },
      auditLog: { createMany: async ({ data }: any) => history.push(...data) },
      staged, projected,
    }
    const result = await work(tx)
    products = staged; cache = projected; audits.push(...history)
    return result
  },
} }))
vi.mock('../services/product-read-cache.service.js', () => ({ productReadCacheService: {
  refreshInTransaction: async (tx: any, ids: string[]) => {
    if (failProjection) throw Error('projection unavailable')
    for (const id of ids) {
      const row = tx.staged.find((r: Row) => r.id === id)
      const index = tx.projected.findIndex((r: Row) => r.id === id)
      if (row && index >= 0) tx.projected[index] = structuredClone(row)
    }
  },
} }))
vi.mock('../lib/queue.js', () => ({ addJobSafely: async () => null, outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('./saved-view-persistence.routes.js', () => ({ default: async () => {} }))
import routes from './products-catalog.routes.js'

const app = Fastify()
beforeAll(async () => {
  app.addHook('preHandler', async request => { request.authUser = { id: 'operator' } as never })
  await app.register(routes, { prefix: '/api' }); await app.ready()
})
afterAll(() => app.close())
beforeEach(() => {
  products = ['selected', 'unselected', 'child'].map(id => ({ id, sku: id, parentId: id === 'child' ? 'selected' : null, deletedAt: null }))
  cache = structuredClone(products); audits = []; failProjection = false
})
const post = (action: string, productIds = ['selected'], includeChildren = true) => app.inject({
  method: 'POST', url: `/api/products/bulk-${action}`, payload: { productIds, includeChildren },
})
describe('product recycle-bin consistency', () => {
  it('deletes exactly the selected family, refreshes its projection, and preserves the other row', async () => {
    const res = await post('soft-delete')
    expect(res.statusCode).toBe(200); expect(res.json()).toMatchObject({ changed: 2 })
    expect(products.filter(r => r.deletedAt).map(r => r.id)).toEqual(['selected', 'child'])
    expect(cache).toEqual(products)
    expect(audits.map(r => r.entityId)).toEqual(['selected', 'child'])
  })
  it('rolls back deletion and audit when the projection cannot be updated', async () => {
    failProjection = true
    expect((await post('soft-delete')).statusCode).toBe(500)
    expect(products.every(r => r.deletedAt === null)).toBe(true)
    expect(cache).toEqual(products); expect(audits).toHaveLength(0)
  })
  it('restores only the requested IDs and their cached bin state', async () => {
    await post('soft-delete')
    expect((await post('restore', ['selected'])).json()).toMatchObject({ changed: 1 })
    expect(products.filter(r => r.deletedAt).map(r => r.id)).toEqual(['child'])
    expect(cache).toEqual(products)
  })
  it('repairs a stale projection even when an already-deleted row is submitted again', async () => {
    products[0].deletedAt = new Date()
    expect((await post('soft-delete', ['selected'], false)).json()).toMatchObject({ changed: 0 })
    expect(cache).toEqual(products)
  })
  it('permits an expanded family over 200 rows but rejects over 200 selected IDs', async () => {
    products.push(...Array.from({ length: 220 }, (_, i) => ({ id: `kid-${i}`, sku: `kid-${i}`, parentId: 'selected', deletedAt: null })))
    cache = structuredClone(products)
    expect((await post('soft-delete')).json()).toMatchObject({ changed: 222 })
    expect((await post('soft-delete', Array.from({ length: 201 }, (_, i) => `id-${i}`))).statusCode).toBe(400)
  })
})
