/**
 * Amazon sheet gaps (gaps 4–5) — the product sheet's stock cell and the Matrix tab's cell are ONE write.
 *
 * 🔴 WHAT THIS GUARDS. "One fact = one write path": an edit in the sheet's Mode / Qty / Buffer column must become exactly
 * the write cell the Matrix tab sends for that cell (same coordinate, cell, CAS version and listing), go through the same
 * door (`writeMatrixCells`), call the same primitives with the same arguments, and leave the listings in the same state.
 *
 * Two identical families: one edited from sheet rows (`attachStudioStock` → `sheetStockWriteCell`), one from the Matrix
 * read (the cell the Matrix page builds: `useMatrix` `withListing`). Real read, door and primitives over PGlite; the
 * primitives are spied on, never replaced. Every id and SKU is invented.
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
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: vi.fn(), subscribeListingEvents: vi.fn() }))
vi.mock('../listing-values-events.js', () => ({ announceListingValues: vi.fn() }))
vi.mock('../follow-master.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../follow-master.service.js')>()
  return { ...real, setFollowMasterQuantity: vi.fn(real.setFollowMasterQuantity), setStockBuffer: vi.fn(real.setStockBuffer) }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import type { MatrixRead, MatrixWritableKind, MatrixWriteCell } from '@nexus/shared/matrix-contract'
import { setFollowMasterQuantity, setStockBuffer } from '../follow-master.service.js'
import { getMatrixRead } from './matrix.service.js'
import { writeMatrixCells } from './matrix-write.service.js'
import type { StudioRow } from './studio-sheet.service.js'
import { attachStudioStock, sheetStockWriteCell, type StudioRowStock, type StudioStockKey } from './studio-stock.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const acc: Record<string, string> = {}
let warehouse = ''
type Row = StudioRow & { stock?: StudioRowStock }

beforeAll(() => scoped(async () => {
  for (const [channel, code] of [['AMAZON', 'IT'], ['AMAZON', 'DE'], ['EBAY', 'IT']] as const) {
    await prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  }
  for (const channel of ['AMAZON', 'EBAY']) {
    acc[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `same-door-${channel}`, isActive: true, isPrimary: true } as never })).id
  }
  warehouse = (await prisma.stockLocation.create({ data: { code: 'TEST-SAME-DOOR-WH', name: 'Same door warehouse', type: 'WAREHOUSE' } })).id
  for (const family of ['sheet', 'matrix']) {
    await prisma.product.create({ data: { id: `${family}-p`, sku: `TEST-${family.toUpperCase()}-P`, name: family, basePrice: 10, isParent: true } as never })
    await prisma.product.create({ data: { id: `${family}-c`, sku: `TEST-${family.toUpperCase()}-C`, name: family, basePrice: 10, parentId: `${family}-p`, fulfillmentMethod: 'FBM' } as never })
    await prisma.stockLevel.create({ data: { productId: `${family}-c`, locationId: warehouse, quantity: 12, available: 12 } })
    for (const [channel, marketplace] of [['AMAZON', 'IT'], ['AMAZON', 'DE'], ['EBAY', 'IT']]) {
      await prisma.channelListing.create({ data: {
        productId: `${family}-c`, channel, marketplace, channelMarket: `${channel}_${marketplace}`, region: 'EU', channelConnectionId: acc[channel],
        listingStatus: 'ACTIVE', isPublished: true, externalListingId: `EXT-${family}-${channel}-${marketplace}`,
        price: 10, quantity: 5, followMasterQuantity: true, stockBuffer: 0, fulfillmentMethod: 'FBM',
      } as never })
    }
  }
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

const ctx = (family: string) => ({ productId: `${family}-p`, actor: 'tester@example.test', can: () => true })
/** The sheet row of the family's variant on a coordinate, as `studioSheetRead` builds it, with its stock pass run. */
async function sheetRow(channel: string, marketplace: string): Promise<Row> {
  const l = await prisma.channelListing.findFirstOrThrow({ where: { productId: 'sheet-c', channel, marketplace, aliasKey: '' }, select: { id: true, version: true, externalListingId: true } })
  const r = { id: 'sheet-c', aliasId: null, isParent: false, values: {}, listing: { ...l, syncPaused: false, follows: {} } } as unknown as Row
  await attachStudioStock({ rows: [r], rootId: 'sheet-p', channel, marketplace, accountId: acc[channel]! })
  return r
}
/** The cell the Matrix page sends: its read's version, and the listing it read (`useMatrix` `withListing`). */
function matrixCell(read: MatrixRead, rowId: string, coordinateKey: string, cell: MatrixWritableKind, value: unknown): MatrixWriteCell {
  const cells = read.rows.find((r) => r.id === rowId)!.cells[coordinateKey]!
  return { rowId, coordinateKey, cell, value, expectedVersion: cells.version, expectedListingId: cells.listingId! }
}
const normalise = (v: unknown, family: string) => JSON.parse(JSON.stringify(v).replaceAll(`${family}-`, 'family-'))
const listingState = async (family: string) => (await state.db.db.query(
  `SELECT channel, marketplace, quantity, "quantityOverride", "followMasterQuantity", "stockBuffer", version FROM "ChannelListing" WHERE "productId" = $1 ORDER BY channel, marketplace`, [`${family}-c`])).rows

describe('a sheet stock edit is the Matrix tab\'s cell write', () => {
  it.each([
    ['stock_qty', 'AMAZON', 'DE', 'AMAZON:EU', 'syncQty', 7],
    ['stock_mode', 'AMAZON', 'DE', 'AMAZON:EU', 'syncMode', 'FOLLOW'],
    ['stock_buffer', 'EBAY', 'IT', 'EBAY:IT', 'syncBuffer', 3],
    ['stock_mode', 'EBAY', 'IT', 'EBAY:IT', 'syncMode', 'PINNED'],
  ] as const)('%s on %s %s → the %s %s cell: same write cell, same primitive calls, same result', (column, channel, marketplace, key, cell, value) => scoped(async () => {
    // The write cell the sheet builds equals the one the Matrix tab builds for the same family and read.
    const row = await sheetRow(channel, marketplace)
    const sheetRead = await getMatrixRead({ productId: 'sheet-p', accountId: acc[channel]!, canEditPrice: true })
    const fromSheet = sheetStockWriteCell(row, column as StudioStockKey, value)
    expect(fromSheet).toEqual(matrixCell(sheetRead, 'sheet-c', key, cell, value))

    // The same door, the same primitive calls, the same result on the twin family.
    vi.mocked(setFollowMasterQuantity).mockClear(); vi.mocked(setStockBuffer).mockClear()
    const a = await writeMatrixCells({ ...ctx('sheet'), accountId: acc[channel] }, [fromSheet!])
    const sheetCalls = normalise([vi.mocked(setFollowMasterQuantity).mock.calls, vi.mocked(setStockBuffer).mock.calls], 'sheet')
    vi.mocked(setFollowMasterQuantity).mockClear(); vi.mocked(setStockBuffer).mockClear()
    const matrixRead = await getMatrixRead({ productId: 'matrix-p', accountId: acc[channel]!, canEditPrice: true })
    const b = await writeMatrixCells({ ...ctx('matrix'), accountId: acc[channel] }, [matrixCell(matrixRead, 'matrix-c', key, cell, value)])
    const matrixCalls = normalise([vi.mocked(setFollowMasterQuantity).mock.calls, vi.mocked(setStockBuffer).mock.calls], 'matrix')

    expect(a.results[0]!.outcome).toBe('applied')
    expect(sheetCalls).toEqual(matrixCalls)
    expect(sheetCalls.flat().length).toBe(1)
    const shape = (r: typeof a.results[number]) => ({ ...r, rowId: undefined, listings: r.listings?.map((l) => ({ version: l.version })) })
    expect(shape(a.results[0]!)).toEqual(shape(b.results[0]!))
    expect(await listingState('sheet')).toEqual(await listingState('matrix'))
  }), 60_000)

  it('a row the Matrix holds with another listing gives no write cell at all', async () => {
    const r = { id: 'sheet-c', stock: { key: 'AMAZON:EU', marketKey: 'AMAZON:DE', cells: null, coordinate: null } } as Row
    expect(sheetStockWriteCell(r, 'stock_qty', 3)).toBeNull()
  })
})
