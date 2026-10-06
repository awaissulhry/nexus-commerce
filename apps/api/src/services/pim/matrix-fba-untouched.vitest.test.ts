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

// The FBA qty column (Owner 2026-10-06): the Matrix SHOWS Amazon's FBA units next to Stock — and still writes none of them.
describe('the FBA qty column: the read shows Amazon\'s number, the door writes none of it', () => {
  let fbaLocation = ''
  let warehouse = ''
  beforeAll(() => scoped(async () => {
    fbaLocation = (await prisma.stockLocation.create({ data: { code: 'AMAZON-EU-FBA', name: 'Amazon EU FBA', type: 'AMAZON_FBA' } })).id
    warehouse = (await prisma.stockLocation.create({ data: { code: 'IT-MAIN-FBA-COL', name: 'Main', type: 'WAREHOUSE' } })).id
  }), 60_000)
  const fbaRow = async (productId: string) =>
    (await state.db.db.query(`SELECT quantity, reserved, available, "lastUpdatedAt" FROM "StockLevel" WHERE "productId" = $1 AND "locationId" = $2`, [productId, fbaLocation])).rows[0]

  it('per variant: the units at Amazon (a measured 0 is 0), null without an FBA row; the parent is the family total; warehouse stock is not FBA', () => scoped(async () => {
    await prisma.product.create({ data: { id: 'fbacol-parent', sku: 'FBACOL-P', name: 'fbacol parent', basePrice: 10, isParent: true } })
    for (const v of ['a', 'b', 'c']) await prisma.product.create({ data: { id: `fbacol-${v}`, sku: `FBACOL-${v.toUpperCase()}`, name: v, basePrice: 10, parentId: 'fbacol-parent' } })
    await prisma.stockLevel.create({ data: { productId: 'fbacol-a', locationId: fbaLocation, quantity: 14, available: 14 } })
    await prisma.stockLevel.create({ data: { productId: 'fbacol-b', locationId: fbaLocation, quantity: 0, available: 0 } })
    await prisma.stockLevel.create({ data: { productId: 'fbacol-c', locationId: warehouse, quantity: 9, available: 9 } })

    const read = await getMatrixRead({ productId: 'fbacol-parent', canEditPrice: true })
    const fba = (id: string) => read.rows.find((r) => r.id === id)!.fba
    expect(fba('fbacol-a')).toMatchObject({ units: 14, locations: [{ code: 'AMAZON-EU-FBA', units: 14 }] })
    expect(Number.isFinite(Date.parse(fba('fbacol-a')!.updatedAt!))).toBe(true)
    expect(fba('fbacol-b')).toMatchObject({ units: 0, locations: [{ code: 'AMAZON-EU-FBA', units: 0 }] })
    // 🔴 no FBA row is null, never 0 — and the 9 warehouse units are Stock, not FBA.
    expect(fba('fbacol-c')).toBeNull()
    expect(read.rows.find((r) => r.id === 'fbacol-c')!.stock.available).toBe(9)
    expect(fba('fbacol-parent')).toMatchObject({ units: 14, locations: [{ code: 'AMAZON-EU-FBA', units: 14 }] })
    expect(read.rows.find((r) => r.id === 'fbacol-parent')!.role).toBe('parent')
  }), 60_000)

  it('a family with no FBA row anywhere reads null on every row, the parent included', () => scoped(async () => {
    await prisma.product.create({ data: { id: 'nofba-parent', sku: 'NOFBA-P', name: 'nofba parent', basePrice: 10, isParent: true } })
    await prisma.product.create({ data: { id: 'nofba-a', sku: 'NOFBA-A', name: 'a', basePrice: 10, parentId: 'nofba-parent' } })
    const read = await getMatrixRead({ productId: 'nofba-parent', canEditPrice: true })
    expect(read.rows.map((r) => r.fba)).toEqual([null, null])
  }), 60_000)

  it.each([['syncQty', 7], ['syncMode', 'PINNED'], ['syncBuffer', 2]] as const)('🔴 %s on an FBA row whose SKU holds FBA units: held in the read, refused by the door; the FBA stock row and the listings are byte-identical', (cell, value) => scoped(async () => {
    const id = `fbacol-door-${cell.toLowerCase()}`
    const { it: itRow, de } = await seed(id, { fba: true })
    await prisma.stockLevel.create({ data: { productId: id, locationId: fbaLocation, quantity: 12, available: 12 } })
    const read = await getMatrixRead({ productId: id, canEditPrice: true })
    const row = read.rows.find((r) => r.id === id)!
    expect(row.fba).toMatchObject({ units: 12 })
    // FBA units on hand: the fail-closed guard holds the region's inventory cells in the READ, with the sentence.
    const cells = row.cells['AMAZON:EU']!
    expect(cells.writable[cell]).toBe(false)
    // (The IT row is stored FBM under an FBA guard, so the guard's own sentence is the one held — either names the lock.)
    const held = [MATRIX_COPY.amazonManaged, MATRIX_COPY.guardFba]
    expect(held).toContain(cells.writeBlockedReason[cell])
    const before = { stock: await fbaRow(id), it: await raw(itRow.id), de: await raw(de.id) }
    // …and a write sent anyway (a stale page, a hand-made request) is refused by the door.
    const result = await writeMatrixCells({ productId: id, actor: 'studio@example.test', can: () => true }, [
      { rowId: id, coordinateKey: 'AMAZON:EU', cell, value, expectedVersion: cells.version },
    ])
    expect(result.results[0]).toMatchObject({ outcome: 'refused' })
    expect(held).toContain(result.results[0]!.reason)
    expect(await fbaRow(id)).toEqual(before.stock)
    expect(await raw(de.id)).toEqual(before.de)
    expect(await raw(itRow.id)).toEqual(before.it)
    expect(await quantityRows(de.id)).toBe(0)
  }), 60_000)
})
