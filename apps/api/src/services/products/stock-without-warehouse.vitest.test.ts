import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

/**
 * The Shared sheet's "Total stock" in a business with NO default warehouse (the P3 commit sweep, 2026-09-30: its CI-like
 * database has none). Stock lives in the ledger, and a ledger movement needs a location, so the edit cannot be stored.
 * The route must refuse only that cell, by name, and commit the other changes on the same row.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn(), { reconcileFamilyReadiness: vi.fn() }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import productsBulkSaveRoutes from '../../routes/products-bulk-save.routes.js'

const workspace = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const scoped = <T>(work: () => Promise<T>) => withWorkspace(workspace, work)
const app = Fastify()
let id = ''

beforeAll(() => scoped(async () => {
  id = (await prisma.product.create({ data: { sku: 'stock-no-warehouse', name: 'no warehouse', basePrice: 10 } })).id
  app.addHook('preHandler', (request, _reply, done) => {
    Object.assign(request, { __rbacResolved: { isOwner: true, permissions: new Set<string>() } }) // the Owner, as the RBAC gate resolves him: price writes check the person's permissions (S1 F5)
    withWorkspace(workspace, done)
  })
  await app.register(productsBulkSaveRoutes)
  await app.ready()
}), 60_000)
afterAll(async () => { await app.close(); await state.db?.close() })

it('POST /products/bulk-save commits the price on a row whose stock cell is refused for having no warehouse', async () => {
  const response = await scoped(() => app.inject({ method: 'POST', url: '/products/bulk-save', payload: {
    operationId: 'op-stock-1', units: [{ key: 'u1', changes: [
      { id, field: 'totalStock', value: 7, target: 'master', contentAddress: { tier: 'source' } },
      { id, field: 'basePrice', value: 12, target: 'master' },
    ], expectedVersion: 1 }],
  } }))
  expect(response.statusCode).toBe(200)
  const answer = response.json()
  const unit = answer.units[0]
  expect(unit.status).toBe(200)
  expect(answer).toMatchObject({ saved: 1, failed: 0 })
  expect(await scoped(() => prisma.stockLocation.count())).toBe(0)
  const product = await scoped(() => prisma.product.findUniqueOrThrow({ where: { id } }))
  expect(product.totalStock).toBe(0)
  expect(Number(product.basePrice)).toBe(12)
  expect(unit.body.errors).toEqual([expect.objectContaining({ id, field: 'totalStock', error: 'Choose a default warehouse in this business before changing stock.' })])
})
