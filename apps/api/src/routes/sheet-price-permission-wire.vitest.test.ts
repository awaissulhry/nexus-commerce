/**
 * Amazon sheet gaps (bug 8) — the product sheet's routes hand the request's own `products.price.edit` answer to the
 * services that hold the Amazon offer price columns, as the Matrix does: `can` to the bulk save (`PATCH /products/bulk`,
 * `POST /products/bulk-save`) and `canEditPrice` to every sheet read. The holds themselves are proven on PostgreSQL in
 * services/pim/studio-sheet-amazon-offer-draft.vitest.test.ts; this pins the wiring. Services mocked; ids invented.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'

const mocks = vi.hoisted(() => ({ bulk: vi.fn(), bulkSave: vi.fn(), sheet: vi.fn(), info: vi.fn(), permissions: new Set<string>() }))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('../lib/queue.js', () => ({ addJobSafely: async () => null, outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('../services/products/bulk-edit.service.js', () => ({ applyProductBulkEdits: mocks.bulk, ProductBulkError: class extends Error {} }))
vi.mock('../services/products/bulk-save.service.js', () => ({ applyProductBulkSave: mocks.bulkSave, BulkSaveError: class extends Error {}, parseBulkSaveInput: (body: unknown) => ({ operationId: 'op-1', units: [], ...(body as object) }) }))
vi.mock('../services/pim/studio-sheet.service.js', () => ({ getStudioSheet: mocks.sheet, UnknownProductError: class extends Error {}, ScopeNotAvailableError: class extends Error {} }))
vi.mock('../services/pim/information-sheet.js', () => ({ getInformationSheet: mocks.info }))
vi.mock('../services/pim/sheet-reference-names.js', () => ({ withSelectedReferenceNames: async (sheet: unknown) => sheet }))

import productsRoutes from './products.routes.js'
import bulkSaveRoutes from './products-bulk-save.routes.js'
import studioRoutes from './product-studio.routes.js'

const SHEET = { scope: { kind: 'channel', channel: 'AMAZON', marketplace: 'IT' }, family: {}, columns: [], groups: [], aliases: [], rows: [], meta: { tookMs: 1, coverage: [] } }
let app: FastifyInstance
beforeAll(async () => {
  mocks.bulk.mockResolvedValue({ success: true, updated: 1 })
  mocks.bulkSave.mockResolvedValue({ operationId: 'op-1', units: [], saved: 0, failed: 0, elapsedMs: 0 })
  mocks.sheet.mockResolvedValue(SHEET)
  mocks.info.mockResolvedValue(SHEET)
  app = Fastify()
  // What the RBAC gate resolves for a signed-in member (`req.__rbacResolved`).
  app.addHook('onRequest', async (request) => { (request as any).__rbacResolved = { isOwner: false, permissions: mocks.permissions } })
  await app.register(multipart)
  await app.register(productsRoutes); await app.register(bulkSaveRoutes); await app.register(studioRoutes)
  await app.ready()
})
afterAll(() => app.close())
beforeEach(() => { mocks.bulk.mockClear(); mocks.bulkSave.mockClear(); mocks.sheet.mockClear(); mocks.info.mockClear() })

const asMember = (...permissions: string[]) => { mocks.permissions.clear(); for (const p of permissions) mocks.permissions.add(p) }

describe('the request\'s price permission reaches the sheet services', () => {
  it('PATCH /products/bulk and POST /products/bulk-save pass `can` — the request\'s own permission check', async () => {
    asMember('products.edit')
    expect((await app.inject({ method: 'PATCH', url: '/products/bulk', payload: { changes: [{ id: 'p-1', field: 'name', value: 'x' }] } })).statusCode).toBe(200)
    const can = mocks.bulk.mock.calls[0]![1].can as (permission: string) => boolean
    expect([can('products.edit'), can('products.price.edit')]).toEqual([true, false])

    asMember('products.edit', 'products.price.edit')
    expect((await app.inject({ method: 'POST', url: '/products/bulk-save', payload: {} })).statusCode).toBe(200)
    expect((mocks.bulkSave.mock.calls[0]![1].can as (permission: string) => boolean)('products.price.edit')).toBe(true)
  })

  it('the sheet reads pass `canEditPrice` from the same check', async () => {
    asMember('products.view')
    await app.inject('/products/p-1/studio/sheet?scope=channel&channel=AMAZON&market=IT&locale=it')
    await app.inject('/products/p-1/studio/columns?scope=channel&channel=AMAZON&market=IT&locale=it')
    expect(mocks.info.mock.calls.map((call) => call[0].canEditPrice)).toEqual([false, false])

    asMember('products.view', 'products.price.edit')
    await app.inject('/products/p-1/studio/sheet?scope=channel&channel=AMAZON&market=IT&locale=it')
    expect(mocks.info.mock.calls.at(-1)![0].canEditPrice).toBe(true)
  })
})
