/**
 * Editing speed (2026-10-13) — the product sheet's Shared save answers before its family's readiness is rebuilt.
 *
 * Measured on the private stack before this (a 21-product family, 46 readiness destinations): a 1-cell Shared save took
 * 2.4–3.5 s, ~95% of it the family's readiness rebuild inside the save (46 studio sheet reads). These tests pin the new
 * contract on PostgreSQL (PGlite), with the real door, writer, readiness rebuild and reader:
 *   · a sheet save (a stamped PATCH, an operation) builds NO studio sheet inside the save; the family's rows are marked
 *     pending in the save's transaction and rebuilt right after the answer — to the same rows an inline rebuild writes;
 *   · the readiness read the page makes after a save answers with the rebuilt rows;
 *   · a refused save marks nothing; a failed rebuild leaves the marks for the drain; a listing-only save and any other
 *     writer still rebuild inside the write, as before.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, sheets: [] as Array<{ scope?: string; channel?: string }>, failSheets: false }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
const queue = vi.hoisted(() => ({ addJobSafely: vi.fn(async () => ({ enqueued: true })) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: { name: 'readiness' }, addJobSafely: queue.addJobSafely }))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../pim/studio-sheet.service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../pim/studio-sheet.service.js')>()
  return { ...actual, getStudioSheet: async (input: Parameters<typeof actual.getStudioSheet>[0]) => {
    state.sheets.push(input)
    // A programming error in the rebuild is never written down as an "absent" row; it fails the rebuild.
    if (state.failSheets) throw new TypeError('the rebuild failed')
    return actual.getStudioSheet(input)
  } }
})
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('provider calls are forbidden in this fixture') }))

import { sheetCellStamp } from '@nexus/shared/sheet-stamp'
import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { getStudioSheet } from '../pim/studio-sheet.service.js'
import { drainPendingReadiness, produceReadinessForProducts, reconcileFamilyReadiness } from '../pim/readiness-index.service.js'
import { familiesRebuildingAfterResponse, familyReadinessSettled } from '../pim/readiness-after-response.js'
import { getProductReadiness } from '../pim/scope-readiness.service.js'
import { applyProductBulkEdits, type ProductBulkInput } from './bulk-edit.service.js'
import { applyProductBulkSave } from './bulk-save.service.js'
import { applySheetBulkEdits } from './sheet-stamp-door.js'

vi.setConfig({ testTimeout: 120_000 })
const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const context = { formulaCascade: false, contentPerRow: true, logger: { warn: vi.fn(), error: vi.fn() } }
const SHARED_IT = [{ marketplace: 'IT', locale: 'it' }]
const FAMILIES = ['sr-a', 'sr-b']
const child = (root: string) => `${root}-child`

const pendingRows = (roots: string[]) => scoped(() => prisma.readinessIndex.count({ where: { pendingSince: { not: null }, product: { OR: [{ id: { in: roots } }, { parentId: { in: roots } }] } } }))
/** The family's derived rows as a reader sees them: everything but the row id and when it was computed. */
const familyRows = (root: string) => scoped(async () => (await prisma.readinessIndex.findMany({ where: { product: { OR: [{ id: root }, { parentId: root }] } } }))
  .map(({ id: _id, computedAt: _at, ...row }) => row)
  .sort((a, b) => `${a.productId}|${a.coordinateKey}|${a.language}`.localeCompare(`${b.productId}|${b.coordinateKey}|${b.language}`)))
const computedAt = (root: string) => scoped(async () => (await prisma.readinessIndex.findMany({ where: { product: { OR: [{ id: root }, { parentId: root }] } }, select: { computedAt: true } }))
  .map(row => row.computedAt.getTime()))
const version = (id: string) => scoped(async () => (await prisma.product.findUniqueOrThrow({ where: { id }, select: { version: true } })).version)

/** A Shared edit the way the page sends it: the cell's write field, its text address, and the stamp of the cell as read. */
async function stampedEdit(productId: string, key: string, value: unknown, locale = 'it'): Promise<ProductBulkInput> {
  const sheet = await scoped(() => getStudioSheet({ productId, scope: 'master', market: 'IT', locale }))
  const cell = sheet.rows.find(row => row.id === productId)!.values[key]
  return { changes: [{ id: productId, field: cell.writeField, value, column: key, expected: sheetCellStamp(cell),
    ...(cell.contentAddress ? { contentAddress: cell.contentAddress } : {}), ...(cell.contentVersion !== undefined ? { contentVersion: cell.contentVersion } : {}) }],
    marketplaceContexts: [{ marketplace: 'IT', locale }], expectedVersion: await version(productId) } as ProductBulkInput
}
const sheetSave = (input: ProductBulkInput) => scoped(async () => {
  try { return { status: 200, body: await applySheetBulkEdits(input, context) as Record<string, unknown> } }
  catch (error: any) { return { status: error?.statusCode ?? 500, body: error?.details ?? { error: String(error) } } }
})

beforeAll(() => scoped(async () => {
  await prisma.channelConnection.create({ data: { id: 'sr-ebay', channelType: 'EBAY', isActive: true } as never })
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  for (const root of FAMILIES) {
    await prisma.product.create({ data: { id: root, sku: root.toUpperCase(), name: `Parent ${root}`, brand: 'Brand P', basePrice: 10, isParent: true, status: 'DRAFT' } })
    await prisma.product.create({ data: { id: child(root), sku: `${root.toUpperCase()}-CHILD`, name: `Child ${root}`, basePrice: 10, parentId: root, status: 'DRAFT' } })
    for (const productId of [root, child(root)]) {
      await prisma.channelListing.create({ data: { productId, channel: 'EBAY', channelMarket: 'EBAY_IT' as never, marketplace: 'IT', region: 'EU', channelConnectionId: 'sr-ebay', price: 10 } })
    }
  }
}), 120_000)

beforeEach(() => scoped(async () => {
  state.failSheets = false
  for (const root of FAMILIES) await reconcileFamilyReadiness(root)
  state.sheets.length = 0
  queue.addJobSafely.mockClear()
}), 120_000)

afterAll(async () => {
  for (const root of familiesRebuildingAfterResponse()) await familyReadinessSettled(root)
  await state.db?.close()
}, 60_000)

it('a stamped Shared save builds no sheet before it answers; its family is rebuilt right after, to the rows an inline rebuild writes', async () => {
  const before = Math.max(...await computedAt('sr-a'))
  const preSave = await familyRows('sr-a')
  const rows = preSave.length
  // The product's title: its readiness rows carry it (`sortTitle`), so a rebuild that read the old values is visible.
  const edit = await stampedEdit(child('sr-a'), 'name', 'Renamed child')
  state.sheets.length = 0

  const answer = await sheetSave(edit)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  expect(answer.body).toMatchObject({ success: true, updated: 1, versionOf: 'product', readinessPendingFamilies: 1 })
  // The skipped work: not one studio sheet was built inside the save (an inline rebuild builds one per destination).
  expect(state.sheets).toHaveLength(0)
  // Every readiness row of THIS family says it is not current — committed with the value — and still holds the old title.
  expect(await pendingRows(['sr-a'])).toBe(rows)
  const stillOld = await scoped(() => prisma.readinessIndex.findMany({ where: { productId: child('sr-a') }, select: { sortTitle: true } }))
  expect(stillOld.length).toBeGreaterThan(0)
  expect(stillOld.every(row => row.sortTitle === 'Child sr-a')).toBe(true)
  expect(await pendingRows(['sr-b'])).toBe(0)
  expect(familiesRebuildingAfterResponse()).toEqual(['sr-a'])
  // The fast lane is this process, not the worker queue (the drain stays the backstop).
  expect(queue.addJobSafely).not.toHaveBeenCalled()

  // The page reads readiness after the save: the answer waits for the rebuild and carries no pending row.
  const read = await scoped(() => getProductReadiness({ productId: child('sr-a'), market: 'IT' }))
  expect(read.scopes.length).toBeGreaterThan(1)
  expect(read.scopes.some(scope => 'pendingSince' in scope)).toBe(false)
  expect(state.sheets.length).toBeGreaterThan(0)
  expect(await pendingRows(['sr-a'])).toBe(0)
  expect(Math.min(...await computedAt('sr-a'))).toBeGreaterThanOrEqual(before)

  // The rebuild read the saved values: the rows moved, and the renamed product's rows carry its new title…
  const afterResponse = await familyRows('sr-a')
  expect(afterResponse.map(({ pendingSince: _p, ...row }) => row)).not.toEqual(preSave.map(({ pendingSince: _p, ...row }) => row))
  const renamed = afterResponse.filter(row => row.productId === child('sr-a'))
  expect(renamed.length).toBeGreaterThan(0)
  expect(renamed.every(row => row.sortTitle === 'Renamed child')).toBe(true)
  // …and they are the same rows an inline rebuild of the stored values writes.
  await scoped(() => reconcileFamilyReadiness('sr-a'))
  expect(afterResponse).toEqual(await familyRows('sr-a'))
})

it('a Shared text save in another language (its own translation row) also answers before the rebuild', async () => {
  const edit = await stampedEdit('sr-b', 'name', 'Neuer Name', 'de')
  expect((edit.changes[0] as { contentAddress?: { tier?: string } }).contentAddress?.tier).toBe('language')
  state.sheets.length = 0
  const answer = await sheetSave(edit)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  expect(answer.body).toMatchObject({ updated: 1, readinessPendingFamilies: 1 })
  expect(state.sheets).toHaveLength(0)
  expect(await pendingRows(['sr-b'])).toBeGreaterThan(0)
  await familyReadinessSettled('sr-b')
  expect(await pendingRows(['sr-b'])).toBe(0)
})

it('an operation of several rows of one family marks the family once and rebuilds it once, after the answer', async () => {
  const units = [
    { key: 'parent', ...await stampedEdit('sr-a', 'brand', 'Operation Co') },
    { key: 'child', ...await stampedEdit(child('sr-a'), 'brand', 'Operation Co') },
  ]
  state.sheets.length = 0
  const result = await scoped(() => applyProductBulkSave({ operationId: 'op-speed', units }, { ...context, readinessAfterResponse: true }))
  expect(result).toMatchObject({ saved: 2, failed: 0 })
  for (const unit of result.units) expect(unit.body).toMatchObject({ readinessPendingFamilies: 1 })
  expect(state.sheets).toHaveLength(0)
  expect(familiesRebuildingAfterResponse()).toEqual(['sr-a'])
  await familyReadinessSettled('sr-a')
  const oneRebuild = state.sheets.length
  expect(oneRebuild).toBeGreaterThan(0)
  expect(await pendingRows(['sr-a'])).toBe(0)
  // One family rebuild builds one sheet per destination; a second rebuild would have doubled them.
  state.sheets.length = 0
  await scoped(() => reconcileFamilyReadiness('sr-a'))
  expect(state.sheets).toHaveLength(oneRebuild)
})

it('a refused save marks nothing and starts no rebuild', async () => {
  const mine = await stampedEdit('sr-b', 'brand', 'Brand Mine')
  // Someone else changes the same field first: my stamp no longer holds.
  await scoped(() => applyProductBulkEdits({ changes: [{ id: 'sr-b', field: 'brand', value: 'Brand X' }], marketplaceContexts: SHARED_IT, expectedVersion: mine.expectedVersion } as never, context))
  state.sheets.length = 0
  const answer = await sheetSave(mine)
  expect(answer.status).toBe(409)
  expect(answer.body).toMatchObject({ code: 'VERSION_CONFLICT', current: { brand: { value: 'Brand X' } } })
  expect(await pendingRows(['sr-b'])).toBe(0)
  expect(familiesRebuildingAfterResponse()).toEqual([])
})

it('a failed rebuild after the save loses nothing: the marks stay and the drain rebuilds the family', async () => {
  const edit = await stampedEdit(child('sr-b'), 'brand', 'Drained Co')
  const rows = (await familyRows('sr-b')).length
  state.failSheets = true
  expect((await sheetSave(edit)).status).toBe(200)
  await familyReadinessSettled('sr-b')
  expect(context.logger.warn).not.toHaveBeenCalled() // the save itself was clean
  expect(await pendingRows(['sr-b'])).toBe(rows)
  state.failSheets = false
  const report = await scoped(() => drainPendingReadiness({ budgetMs: 60_000 }))
  expect(report).toMatchObject({ failed: 0, remaining: 0 })
  expect(await pendingRows(['sr-b'])).toBe(0)
})

it('a family with no readiness row yet is built after the save', async () => {
  await scoped(() => prisma.readinessIndex.deleteMany({ where: { product: { OR: [{ id: 'sr-b' }, { parentId: 'sr-b' }] } } }))
  expect((await sheetSave(await stampedEdit('sr-b', 'brand', 'New Co'))).status).toBe(200)
  await familyReadinessSettled('sr-b')
  expect((await familyRows('sr-b')).length).toBeGreaterThan(0)
  expect(await pendingRows(['sr-b'])).toBe(0)
})

it('every other write keeps rebuilding inside itself: a write without stamps, and a listing-only save', async () => {
  const plain = await scoped(() => applySheetBulkEdits({ changes: [{ id: child('sr-a'), field: 'brand', value: 'Inline Co' }], marketplaceContexts: SHARED_IT } as never, context))
  expect(plain).not.toHaveProperty('readinessPendingFamilies')
  expect(state.sheets.length).toBeGreaterThan(0)
  expect(await pendingRows(['sr-a'])).toBe(0)
  expect(familiesRebuildingAfterResponse()).toEqual([])

  // A listing-only edit rebuilds its one coordinate inline even when the sheet asks for the rebuild after the answer.
  state.sheets.length = 0
  const scope = { channel: 'EBAY', market: 'IT', accountId: 'sr-ebay' }
  const produced = await scoped(() => inDatabaseTransaction(prisma as never, () => produceReadinessForProducts([child('sr-a')], scope, { afterResponse: true })))
  expect(produced).toEqual({ inline: 1, pending: 0 })
  expect(state.sheets.length).toBeGreaterThan(0)
  expect(state.sheets.every(sheet => sheet.channel === 'EBAY')).toBe(true)
  expect(await pendingRows(['sr-a'])).toBe(0)
  expect(familiesRebuildingAfterResponse()).toEqual([])
})
