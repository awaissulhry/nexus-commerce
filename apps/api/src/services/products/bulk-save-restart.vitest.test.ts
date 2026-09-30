/**
 * P2 (2026-09-30) — a lost race while a row loads its attribute contract restarts the whole save.
 *
 * Measured on the private copy: a 41-row bulk save met a serialization failure (40001) inside the contract load. The
 * writer refused that row with "Could not load attribute requirements" and carried on in a transaction PostgreSQL had
 * already doomed, so every next statement failed (25P02) and the operation answered 503. A lost race is rolled back
 * by PostgreSQL and is safe to run again from the start (`inDatabaseTransaction`), which is what must happen.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, columnReads: 0, raceOnce: false }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../pim/sheet-columns.service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../pim/sheet-columns.service.js')>()
  return { ...actual, getSheetColumns: async (...args: Parameters<typeof actual.getSheetColumns>) => {
    state.columnReads++
    if (state.raceOnce) {
      state.raceOnce = false
      // Prisma 7's shape for a serialization failure (see database-context-retry.vitest.test.ts).
      throw Object.assign(new Error('Transaction failed due to a write conflict or a deadlock. Please retry your transaction'), { code: 'P2034' })
    }
    return actual.getSheetColumns(...args)
  } }
})
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyProductBulkSave } from './bulk-save.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

beforeAll(() => scoped(async () => {
  await prisma.product.create({ data: { id: 'restart-p', sku: 'RESTART-P', name: 'Restart', basePrice: 10 } })
}), 120_000)
afterAll(async () => { await state.db?.close() })

it('runs the whole save again instead of refusing the row', async () => {
  state.columnReads = 0
  state.raceOnce = true
  const result = await scoped(() => applyProductBulkSave({ operationId: 'restart-op', units: [{
    key: 'MASTER::restart-p', expectedVersion: 1,
    changes: [{ id: 'restart-p', field: 'attr_material', value: 'Mesh', target: 'master' } as never],
  }] }, { logger: { warn: vi.fn(), error: vi.fn() } } as never))
  // The first attempt lost the race; the second read the contract again and answered the row.
  expect(state.columnReads).toBeGreaterThanOrEqual(2)
  expect(result.units[0].status).not.toBe(503)
  expect(result.units[0].body.error).not.toBe('Could not load attribute requirements. Reload the sheet before saving attributes.')
})
