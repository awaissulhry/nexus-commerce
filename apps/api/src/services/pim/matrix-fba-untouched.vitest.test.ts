/**
 * The Studio matrix never writes an FBA listing's quantity (Owner rule: FBA quantity is untouchable).
 *
 * 🔴 WHAT THIS GUARDS. The matrix's inventory cells on the Amazon EU coordinate land on every open EU row of the SKU.
 * The typed-quantity edit staged the number into EVERY target's `quantity` (and bumped its version) BEFORE the pin
 * step looked at fulfilment — so an FBA sibling's quantity was overwritten, the FBM rows were pinned, and only then
 * was the cell reported "Amazon-managed". Now an Amazon-managed target refuses the cell before anything is written,
 * with the same sentence the pin step gave.
 *
 * Real matrix read and write (`writeMatrixCells`) over a real PostgreSQL in-process (PGlite).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => undefined) }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import { writeMatrixCells } from './matrix-write.service.js'
import { getMatrixRead } from './matrix.service.js'
import { attachStudioStock, sheetStockWriteCell, type StudioRowStock } from './studio-stock.js'
import { applySheetQuantityChanges } from './sheet-quantity-door.js'
import { ProductBulkError } from '../../lib/product-bulk-error.js'
import type { StudioRow } from './studio-sheet.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let account = ''
beforeAll(() => scoped(async () => {
  for (const code of ['IT', 'DE']) {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  }
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'matrix-fba', isActive: true, isPrimary: true } })).id
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

/** A family (the matrix edits variants; the root is the parent) whose one variant is on Amazon IT and DE. */
async function seed(id: string, de: { fba: boolean }) {
  await prisma.product.create({ data: { id: `${id}-parent`, sku: `${id.toUpperCase()}-P`, name: `${id} parent`, basePrice: 10, isParent: true } })
  await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 10, totalStock: 9, parentId: `${id}-parent` } })
  const make = (marketplace: string, fba: boolean) => prisma.channelListing.create({ data: {
    productId: id, channel: 'AMAZON', channelConnectionId: account, channelMarket: `AMAZON_${marketplace}`, marketplace, region: 'EU',
    price: 10, quantity: 5, followMasterQuantity: true, fulfillmentMethod: fba ? 'FBA' : 'FBM', listingStatus: 'ACTIVE', isPublished: true,
  } })
  return { it: await make('IT', false), de: await make('DE', de.fba) }
}
const raw = async (listingId: string) =>
  (await state.db.db.query(`SELECT quantity, "quantityOverride", "followMasterQuantity", "stockBuffer", version FROM "ChannelListing" WHERE id = $1`, [listingId])).rows[0]
const quantityRows = async (listingId: string) =>
  (await state.db.db.query(`SELECT count(*)::int AS n FROM "OutboundSyncQueue" WHERE "channelListingId" = $1 AND "syncType" = 'QUANTITY_UPDATE'`, [listingId])).rows[0].n
async function write(productId: string, cell: 'syncQty' | 'syncMode' | 'syncBuffer', value: unknown) {
  const read = await getMatrixRead({ productId, canEditPrice: true })
  const row = read.rows.find((r) => r.id === productId)!
  const cells = row.cells['AMAZON:EU']!
  expect(cells.writable[cell], `the ${cell} cell of the EU coordinate is writable`).toBe(true)
  const result = await writeMatrixCells({ productId, actor: 'studio@example.test', can: () => true }, [
    { rowId: productId, coordinateKey: 'AMAZON:EU', cell, value, expectedVersion: cells.version },
  ])
  return result.results[0]!
}

describe('the matrix inventory cells never write an FBA row', () => {
  it.each([
    ['syncQty', 7],
    ['syncMode', 'PINNED'],
    ['syncBuffer', 2],
  ] as const)('🔴 %s on the EU group with an FBA sibling: refused Amazon-managed, and NOTHING is written — the FBA row byte-identical', (cell, value) => scoped(async () => {
    const id = `fba-sibling-${cell.toLowerCase()}`
    const { it: itRow, de } = await seed(id, { fba: true })
    const before = { it: await raw(itRow.id), de: await raw(de.id) }
    const outcome = await write(id, cell, value)
    expect(outcome).toMatchObject({ outcome: 'refused', reason: MATRIX_COPY.amazonManaged })
    expect(await raw(de.id)).toEqual(before.de)
    // The FBM sibling is not half-done either: a refused cell writes nothing.
    expect(await raw(itRow.id)).toEqual(before.it)
    expect(await quantityRows(itRow.id)).toBe(0)
    expect(await quantityRows(de.id)).toBe(0)
  }), 60_000)

  it('positive control: the same typed quantity on an all-FBM EU group is applied to both rows', () => scoped(async () => {
    const { it: itRow, de } = await seed('fbm-group', { fba: false })
    const outcome = await write('fbm-group', 'syncQty', 7)
    expect(outcome).toMatchObject({ outcome: 'applied' })
    for (const row of [itRow, de]) {
      expect(await raw(row.id)).toMatchObject({ quantity: 7, quantityOverride: 7, followMasterQuantity: false })
      expect(await quantityRows(row.id)).toBe(1)
    }
  }), 60_000)
})

// Amazon sheet gaps (gaps 4–5) — the product sheet reaches the same door, and the bulk quantity door refuses the same way.
describe('a product sheet write never writes an FBA row either', () => {
  /** The sheet row of the FBA DE listing, with its stock pass run (the cells are the Matrix's EU group cells). */
  async function sheetRow(id: string, listingId: string) {
    const l = await prisma.channelListing.findUniqueOrThrow({ where: { id: listingId }, select: { id: true, version: true, externalListingId: true } })
    const r = { id, aliasId: null, isParent: false, values: {}, listing: { ...l, syncPaused: false, follows: {} } } as unknown as StudioRow & { stock?: StudioRowStock }
    await attachStudioStock({ rows: [r], rootId: `${id}-parent`, channel: 'AMAZON', marketplace: 'DE', accountId: account })
    return r
  }

  it.each([['stock_qty', 7], ['stock_mode', 'PINNED'], ['stock_buffer', 2]] as const)('🔴 the sheet\'s %s cell on the FBA DE row: refused Amazon-managed through the Matrix door; NOTHING written', (column, value) => scoped(async () => {
    const id = `sheet-fba-${column.replace('_', '-')}`
    const { it: itRow, de } = await seed(id, { fba: true })
    const before = { it: await raw(itRow.id), de: await raw(de.id) }
    const cell = sheetStockWriteCell(await sheetRow(id, de.id), column, value)
    expect(cell).toMatchObject({ coordinateKey: 'AMAZON:EU' })
    const result = await writeMatrixCells({ productId: id, actor: 'studio@example.test', can: () => true, accountId: account }, [cell!])
    expect(result.results[0]).toMatchObject({ outcome: 'refused', reason: MATRIX_COPY.amazonManaged })
    expect(await raw(de.id)).toEqual(before.de)
    expect(await raw(itRow.id)).toEqual(before.it)
    expect(await quantityRows(itRow.id)).toBe(0)
    expect(await quantityRows(de.id)).toBe(0)
  }), 60_000)

  it('🔴 a pasted / imported Amazon quantity (the bulk PATCH): refused Amazon-managed by the quantity door; NOTHING staged', () => scoped(async () => {
    const { it: itRow, de } = await seed('sheet-fba-bulk', { fba: true })
    const before = { it: await raw(itRow.id), de: await raw(de.id) }
    const moved = new Map<string, number>()
    const err = await applySheetQuantityChanges([{ id: 'sheet-fba-bulk', field: 'attr_fulfillment_availability__quantity', value: 7, target: 'channel' }], {
      contexts: [{ channel: 'AMAZON', marketplace: 'IT' }], accountFor: () => account, moved, actor: 'studio@example.test',
    }).catch((e) => e)
    expect(err).toBeInstanceOf(ProductBulkError)
    expect(err).toMatchObject({ statusCode: 400, details: { error: MATRIX_COPY.amazonManaged, code: 'QUANTITY_REFUSED' } })
    expect(moved.size).toBe(0)
    expect(await raw(de.id)).toEqual(before.de)
    expect(await raw(itRow.id)).toEqual(before.it)
    expect(await quantityRows(itRow.id)).toBe(0)
  }), 60_000)
})
