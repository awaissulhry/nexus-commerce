import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const fetch = vi.fn(() => { throw new Error('Outbound call in bulk/restore regression') })
  vi.stubGlobal('fetch', fetch)
  return { fetch, product: {} as Record<string, any>, update: vi.fn(), emit: vi.fn(), audit: vi.fn() }
})
vi.mock('../../lib/queue.js', () => ({ addJobSafely: async () => null, outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: state.emit, emitMany: async () => [], emitManyTx: async () => [] } }))
vi.mock('../audit-log.service.js', () => ({ auditLogService: { writeMany: state.audit } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: async () => {}, refreshMany: async () => [] } }))
vi.mock('../pim/readiness-index.service.js', () => ({ produceReadiness: async () => {} }))
vi.mock('../pim/mapping/resolve-batch.service.js', () => ({ resolveBatch: async () => ({ products: [{ productId: 'pr1-product', cells: {} }] }) }))
vi.mock('../connection-resolver.service.js', () => ({ primaryConnectionIds: async () => new Map() }))
vi.mock('../../db.js', () => { const db = {
  product: {
    findUnique: async () => ({ ...state.product }),
    findMany: async () => [{ ...state.product }],
    update: state.update,
  },
  channelListing: { findMany: async () => [] },
  bulkOperation: { create: async () => ({ id: 'bulk-test' }) },
  $transaction: async (work: any) => typeof work === 'function' ? work(db) : Promise.all(work),
}; return { default: db } })

import { applyProductBulkEdits } from './bulk-edit.service.js'
import productsRoutes from '../../routes/products.routes.js'
import * as columns from '../pim/sheet-columns.service.js'

const context = { formulaCascade: false, userId: 'session-user', logger: { warn: vi.fn(), error: vi.fn() } }
let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(productsRoutes, { prefix: '/api' })
  await app.ready()
})
afterAll(async () => { await app.close(); vi.unstubAllGlobals() })
beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  state.product = { id: 'pr1-product', sku: 'PR1-TEST', name: 'Before', manufacturer: 'Before', version: 26, parentId: null, isParent: false, categoryAttributes: {}, variationAxes: [] }
  state.update.mockImplementation(async ({ data }) => {
    for (const [key, value] of Object.entries(data)) {
      state.product[key] = key === 'version' ? state.product.version + (value as { increment: number }).increment : value
    }
    return { ...state.product }
  })
  vi.spyOn(columns, 'getSheetColumns').mockResolvedValue({ coordinates: [], columns: [
    { key: 'manufacturer', writeField: 'manufacturer', label: 'Manufacturer', storage: 'column', kind: 'text', shape: 'scalar', editable: true },
    { key: 'name', writeField: 'name', label: 'Product title', storage: 'column', kind: 'text', shape: 'scalar', editable: true },
  ] } as never)
})

describe('PR.1 contentAddress belongs only to localizable changes', () => {
  it('accepts and writes a non-localizable change without a contentAddress', async () => {
    const result = await applyProductBulkEdits({ changes: [{ id: 'pr1-product', field: 'manufacturer', value: 'After' }], expectedVersion: 26 }, context)
    expect(result).toMatchObject({ success: true, updated: 1, currentVersion: 27 })
    expect(state.product.manufacturer).toBe('After')
    expect(state.update).toHaveBeenCalled()
    expect(state.fetch).not.toHaveBeenCalled()
  })

  it('refuses a localizable change without a contentAddress by the sheet NAME', async () => {
    const result = await applyProductBulkEdits({ changes: [{ id: 'pr1-product', field: 'name', value: 'After' }], marketplaceContexts: [{ marketplace: 'IT' } as any] }, context)
    expect(result.errors).toEqual([{ id: 'pr1-product', field: 'name', error: 'Product title needs a ContentAddress before it can be saved.' }])
    expect(state.product.name).toBe('Before')
    expect(state.update).not.toHaveBeenCalled()
  })

  it('POST restore writes a factual field without an address and reads back Product.version', async () => {
    const result = await app.inject({ method: 'POST', url: '/api/products/pr1-product/restore', payload: { at: '2026-09-12T00:00:00Z', fields: { manufacturer: 'Restored' }, expectedVersion: 26, market: 'IT', locale: 'it' } })
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json()).toMatchObject({ ok: true, restoredFields: ['manufacturer'], currentVersion: 27, versionOf: 'product' })
    expect(state.product).toMatchObject({ manufacturer: 'Restored', version: 27 })
    expect(state.emit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'PRODUCT_UPDATED', data: expect.objectContaining({ restored: true }) }))
    expect(state.fetch).not.toHaveBeenCalled()
  })

  it('POST restore refuses unaddressed localized content by name before any write', async () => {
    const result = await app.inject({ method: 'POST', url: '/api/products/pr1-product/restore', payload: { at: '2026-09-12T00:00:00Z', fields: { name: 'Restored' }, expectedVersion: 26, market: 'IT', locale: 'it' } })
    expect(result.statusCode, result.body).toBe(400)
    expect(result.json().error).toBe('Product title needs a ContentAddress before it can be saved.')
    expect(state.update).not.toHaveBeenCalled()
    expect(state.emit).not.toHaveBeenCalled()
  })
})
