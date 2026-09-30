import { afterAll, beforeAll, expect, it, vi } from 'vitest'

/**
 * The Shared sheet's "Total stock" in a business with NO default warehouse (the P3 commit sweep, 2026-09-30: its CI-like
 * database has none). Stock lives in the ledger, and a ledger movement needs a location, so the edit cannot be stored.
 * The answer must say so on the cell, by name, and store nothing, on the sheet's own route (`POST /products/bulk-save`).
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
import { applyProductBulkSave } from './bulk-save.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const context = { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }
let id = ''

beforeAll(() => scoped(async () => {
  id = (await prisma.product.create({ data: { sku: 'stock-no-warehouse', name: 'no warehouse', basePrice: 10 } })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })

it('a stock edit in a business with no warehouse is refused on its cell, by name, and nothing is stored', async () => {
  const answer = await scoped(() => applyProductBulkSave({ operationId: 'op-stock-1', units: [{ key: 'u1', changes: [{ id, field: 'totalStock', value: 7, target: 'master', contentAddress: { tier: 'source' } }], expectedVersion: 1 }] } as never, context as never))
  const unit = answer.units[0]
  expect(await scoped(() => prisma.stockLocation.count())).toBe(0)
  expect((await scoped(() => prisma.product.findUniqueOrThrow({ where: { id } }))).totalStock).toBe(0)
  expect(unit.body.errors).toEqual([expect.objectContaining({ id, field: 'totalStock', error: 'Choose a default warehouse in this business before changing stock.' })])
})
