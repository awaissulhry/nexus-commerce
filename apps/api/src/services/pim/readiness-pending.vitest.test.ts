/**
 * P2 (docs/attributes/PLAN.md §4.7, §10.1) — readiness rebuilt AFTER a big bulk edit instead of inside it.
 *
 * Measured before this change (10,000 products): a bulk edit rebuilt every touched family inside its transaction, at
 * 3–5 s per family, so an edit across 15+ families crossed the 60 s limit and nothing was saved. These tests pin the
 * new contract:
 *   · up to INLINE_READINESS_MAX_FAMILIES families: rebuilt inside the save, exactly as before;
 *   · above it: the values commit, the readiness rows are marked pending IN THE SAME TRANSACTION, no sheet is built
 *     during the save, and the drain rebuilds them later;
 *   · a pending mark never outlives its rollback, and never survives a rebuild (no endless drain).
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, sheets: [] as Array<{ channel?: string; market: string; accountId?: string; locale?: string }> }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
const queue = vi.hoisted(() => ({ addJobSafely: vi.fn(async () => ({ enqueued: true })) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: { name: 'readiness' }, addJobSafely: queue.addJobSafely }))
vi.mock('./studio-sheet.service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./studio-sheet.service.js')>()
  return { ...actual, getStudioSheet: async (input: Parameters<typeof actual.getStudioSheet>[0]) => {
    state.sheets.push(input)
    return actual.getStudioSheet(input)
  } }
})
import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import {
  INLINE_READINESS_MAX_FAMILIES, drainPendingReadiness, produceReadinessForProducts, reconcileFamilyReadiness,
} from './readiness-index.service.js'
import { applyProductBulkEdits } from '../products/bulk-edit.service.js'
import { getProductReadiness } from './scope-readiness.service.js'

const FAMILIES = ['rp-a', 'rp-b', 'rp-c']
const child = (root: string) => `${root}-child`
const context = { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() } }

async function pendingRows(roots = FAMILIES) {
  return prisma.readinessIndex.count({ where: { pendingSince: { not: null }, product: { OR: [{ id: { in: roots } }, { parentId: { in: roots } }] } } })
}
async function familyRows(roots = FAMILIES) {
  return prisma.readinessIndex.findMany({ where: { product: { OR: [{ id: { in: roots } }, { parentId: { in: roots } }] } }, orderBy: { id: 'asc' } })
}

beforeAll(async () => {
  await prisma.channelConnection.create({ data: { id: 'rp-ebay', channelType: 'EBAY', isActive: true } as any })
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  for (const root of FAMILIES) {
    await prisma.product.create({ data: { id: root, sku: root.toUpperCase(), name: `Parent ${root}`, basePrice: 10, isParent: true, status: 'DRAFT' } })
    await prisma.product.create({ data: { id: child(root), sku: `${root.toUpperCase()}-CHILD`, name: `Child ${root}`, basePrice: 10, parentId: root, status: 'DRAFT' } })
    for (const productId of [root, child(root)]) {
      await prisma.channelListing.create({ data: { productId, channel: 'EBAY', channelMarket: 'EBAY_IT' as any, marketplace: 'IT', region: 'EU', channelConnectionId: 'rp-ebay', price: 10 } })
    }
  }
}, 60_000)

beforeEach(async () => {
  for (const root of FAMILIES) await reconcileFamilyReadiness(root)
  state.sheets.length = 0
  queue.addJobSafely.mockClear()
}, 60_000)

afterAll(async () => { await state.db?.close() })

it('keeps the inline limit small enough that a single-cell edit behaves exactly as before', () => {
  expect(INLINE_READINESS_MAX_FAMILIES).toBe(2)
})

it('rebuilds readiness INSIDE the save when the edit touches few families (today’s behaviour)', async () => {
  const before = await familyRows(['rp-a'])
  expect(before.length).toBeGreaterThan(0)
  const result = await applyProductBulkEdits({ changes: [{ id: child('rp-a'), field: 'manufacturer', value: 'Inline Co', target: 'master' }] }, context)
  expect(result).toMatchObject({ success: true, updated: 1 })
  expect(result).not.toHaveProperty('readinessPendingFamilies')
  expect(state.sheets.length).toBeGreaterThan(0)
  expect(await pendingRows()).toBe(0)
  const after = await familyRows(['rp-a'])
  expect(after.every(row => row.computedAt.getTime() >= Math.max(...before.map(b => b.computedAt.getTime())))).toBe(true)
  expect(queue.addJobSafely).not.toHaveBeenCalled()
}, 60_000)

it('commits a big edit WITHOUT building a sheet, marks the families pending with the values, and enqueues one job each', async () => {
  const rowsBefore = (await familyRows()).length
  const result = await applyProductBulkEdits({ changes: FAMILIES.map(root => ({ id: child(root), field: 'manufacturer', value: 'Pending Co', target: 'master' })) }, context)
  expect(result).toMatchObject({ success: true, updated: 3, readinessPendingFamilies: 3 })
  // No readiness work in the save: this is what removes the 60 s failure.
  expect(state.sheets).toHaveLength(0)
  // The values are saved…
  const saved = await prisma.product.findMany({ where: { id: { in: FAMILIES.map(child) } }, select: { manufacturer: true } })
  expect(saved.map(p => p.manufacturer)).toEqual(['Pending Co', 'Pending Co', 'Pending Co'])
  // …and every readiness row of the three families says it is not current.
  expect(await pendingRows()).toBe(rowsBefore)
  expect(queue.addJobSafely.mock.calls.map(call => (call as unknown[])[3])).toEqual(FAMILIES.map(root => ({ jobId: `readiness:${root}` })))
  // The reader says so: every scope of the family carries `pendingSince`, so no screen shows the old verdict as current.
  const whilePending = await getProductReadiness({ productId: 'rp-a', market: 'IT' })
  expect(whilePending.scopes.length).toBeGreaterThan(1)
  expect(whilePending.scopes.every(scope => typeof scope.pendingSince === 'string')).toBe(true)
  expect(Object.values(whilePending.matrix[0].byProduct).every(entry => typeof entry.pendingSince === 'string')).toBe(true)

  const report = await drainPendingReadiness({ budgetMs: 60_000 })
  expect(report).toMatchObject({ planned: 3, processed: 3, failed: 0, remaining: 0, stoppedBecause: 'complete' })
  expect(await pendingRows()).toBe(0)
  expect((await familyRows()).length).toBe(rowsBefore)
  const afterDrain = await getProductReadiness({ productId: 'rp-a', market: 'IT' })
  expect(afterDrain.scopes.some(scope => 'pendingSince' in scope)).toBe(false)
}, 120_000)

it('rebuilds only the channel coordinate when a listing-only edit is drained', async () => {
  // The scope `applyProductBulkEdits` passes for a listing-only edit (`readinessScope`, bulk-edit.service.ts).
  const scope = { channel: 'EBAY', market: 'IT', accountId: 'rp-ebay' }
  const produced = await inDatabaseTransaction(prisma as never, () => produceReadinessForProducts(FAMILIES.map(child), scope))
  expect(produced).toEqual({ inline: 0, pending: 3 })
  const pending = await prisma.readinessIndex.findMany({ where: { pendingSince: { not: null } } })
  expect(pending.length).toBeGreaterThan(0)
  expect(pending.every(row => row.channel === 'EBAY' && row.market === 'IT' && row.accountId === 'rp-ebay')).toBe(true)
  // The shared rows were not marked: a listing edit cannot change them.
  expect(await prisma.readinessIndex.count({ where: { channel: null, pendingSince: { not: null } } })).toBe(0)

  state.sheets.length = 0
  await drainPendingReadiness({ budgetMs: 60_000 })
  expect(await pendingRows()).toBe(0)
  expect(state.sheets.length).toBeGreaterThan(0)
  expect(state.sheets.every(sheet => sheet.channel === 'EBAY' && sheet.market === 'IT' && sheet.accountId === 'rp-ebay')).toBe(true)
}, 120_000)

it('rolls the pending marks back with the transaction that set them', async () => {
  await expect(inDatabaseTransaction(prisma as never, async () => {
    const produced = await produceReadinessForProducts(FAMILIES.map(child))
    expect(produced).toEqual({ inline: 0, pending: 3 })
    expect(await pendingRows()).toBeGreaterThan(0)
    throw new Error('the write failed after marking')
  })).rejects.toThrow('the write failed after marking')
  expect(await pendingRows()).toBe(0)
}, 60_000)

it('never leaves a mark the drain cannot clear (a product deleted after it was marked)', async () => {
  await inDatabaseTransaction(prisma as never, () => produceReadinessForProducts(FAMILIES.map(child)))
  expect(await pendingRows()).toBeGreaterThan(0)
  await prisma.product.update({ where: { id: child('rp-c') }, data: { deletedAt: new Date() } })
  try {
    const report = await drainPendingReadiness({ budgetMs: 60_000 })
    expect(report).toMatchObject({ failed: 0, remaining: 0 })
    expect(await pendingRows()).toBe(0)
  } finally {
    await prisma.product.update({ where: { id: child('rp-c') }, data: { deletedAt: null } })
  }
}, 120_000)
