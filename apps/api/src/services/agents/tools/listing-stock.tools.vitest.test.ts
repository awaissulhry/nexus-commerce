/**
 * MCP full control L8 — set-listing-stock, set-listing-price and revert-listing-change, run through the one door
 * (call-tool.ts) on the Matrix door (`runMatrixVerb`, `writeMatrixCells`, `revertMatrixOperation`), against a real
 * PostgreSQL with the production schema and business-isolation policies (PGlite). eBay's out-of-stock option is faked.
 *
 * Proven here: the dry run is the Matrix's own preview and writes nothing; the run applies exactly the approved changes,
 * as the approver, and refuses one that moved since; FBA quantity is never written (refused, the FBA row byte-identical);
 * an Amazon EU market's inventory lands on the one AMAZON:EU cell; an eBay pin to 0 is refused while the option is not ON;
 * prices and a sale are set and come back through revert-listing-change or the sale's own undo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'

const state = vi.hoisted(() => ({ db: null as any, option: vi.fn() }))
vi.mock('@nexus/database', async (original) => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...(await original<object>()), default: state.db.client }
})
vi.mock('../../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn(async () => undefined) }))
vi.mock('../../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn(), emitTx: vi.fn() } }))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
vi.mock('../../channel-delist.service.js', async (original) => ({ ...(await original<object>()), readEbayOutOfStockPreference: state.option }))

import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string): UserPrincipal => ({
  kind: 'user', userId, label: userId,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: business, via: 'claude',
})
const claude = person('u-l8-asker')
const approver = person('u-l8-approver')
type Json = Record<string, any>
const db = () => state.db.client
const raw = async (id: string) => (await state.db.db.query(`SELECT quantity, "quantityOverride", "followMasterQuantity", "stockBuffer", "syncPaused", price, "salePrice", "fulfillmentMethod" FROM "ChannelListing" WHERE id = $1`, [id])).rows[0]

const dryRun = async (tool: string, args: Json) => (await inside(() => callTool(claude, tool, args))).raw as Json
const runApproved = async (tool: string, args: Json, preview: Json) =>
  (await inside(() => executeTool(approver, tool, args, { approvedPreview: JSON.parse(JSON.stringify(preview)), via: 'claude' }))).raw as Json
async function approveAndRun(tool: string, args: Json) {
  const preview = await dryRun(tool, args)
  expect(preview.ok, preview.error).toBe(true)
  return { preview: preview.preview as Json, ran: await runApproved(tool, args, preview.preview) }
}

const ids: Record<string, string> = {}
const accounts: Record<string, string> = {}

beforeAll(async () => {
  // The sale-window columns a migration adds with raw SQL (20260913_mx1_sale_price_window), as the sale suites add them.
  await state.db.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE; ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE;')
  await inside(async () => {
    for (const [channel, code] of [['EBAY', 'IT'], ['AMAZON', 'IT'], ['AMAZON', 'DE']]) {
      await db().marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } as never })
    }
    accounts.ebay = (await db().channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'Test eBay', isActive: true, isPrimary: true, externalAccountId: 'TEST-L8-EBAY' } })).id
    accounts.amazon = (await db().channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'Test Amazon', isActive: true, isPrimary: true, externalAccountId: 'TEST-L8-AMAZON' } })).id
    ids.parent = (await db().product.create({ data: { sku: 'TEST-SKU-L8', name: 'L8 jacket', basePrice: 10, isParent: true } })).id
    ids.child = (await db().product.create({ data: { sku: 'TEST-SKU-L8-M', name: 'L8 jacket M', basePrice: 10, totalStock: 9, parentId: ids.parent } })).id
    ids.fbaChild = (await db().product.create({ data: { sku: 'TEST-SKU-L8-L', name: 'L8 jacket L', basePrice: 10, totalStock: 9, parentId: ids.parent } })).id
    const listing = (productId: string, channel: string, marketplace: string, extra: Json = {}) => db().channelListing.create({ data: { productId, channel, marketplace,
      channelMarket: `${channel}_${marketplace}`, region: marketplace, channelConnectionId: channel === 'EBAY' ? accounts.ebay : accounts.amazon,
      price: 10, quantity: 5, followMasterQuantity: true, listingStatus: 'ACTIVE', isPublished: true, ...extra } as never })
    ids.ebay = (await listing(ids.child, 'EBAY', 'IT', { externalListingId: 'TEST-ITEM-L8' })).id
    ids.amazonIt = (await listing(ids.child, 'AMAZON', 'IT', { fulfillmentMethod: 'FBM' })).id
    ids.amazonDe = (await listing(ids.child, 'AMAZON', 'DE', { fulfillmentMethod: 'FBM' })).id
    ids.fbaIt = (await listing(ids.fbaChild, 'AMAZON', 'IT', { fulfillmentMethod: 'FBA' })).id
    ids.fbaDe = (await listing(ids.fbaChild, 'AMAZON', 'DE', { fulfillmentMethod: 'FBA' })).id
  })
}, 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)
beforeEach(() => { state.option.mockReset(); state.option.mockResolvedValue('UNKNOWN') })

describe('set-listing-stock', () => {
  it('pins a quantity as approved and as the approver; revert-listing-change puts it back', async () => {
    const args = { productId: ids.child, action: 'pin-quantity', quantity: 4, targets: [{ rowId: ids.child, coordinateKey: 'EBAY:IT' }] }
    const before = await raw(ids.ebay)
    const { preview, ran } = await approveAndRun('set-listing-stock', args)
    expect(preview).toMatchObject({ family: { sku: 'TEST-SKU-L8' }, verb: 'pin-quantity', changes: [{ coordinateKey: 'EBAY:IT', cell: 'syncQty', to: 4 }] })
    expect(ran.ok, ran.error).toBe(true)
    expect(await raw(ids.ebay)).toMatchObject({ quantity: 4, followMasterQuantity: false })
    const op = await inside(() => db().bulkOperation.findUniqueOrThrow({ where: { id: ran.data.operationId } }))
    expect(op).toMatchObject({ userId: 'u-l8-approver', status: 'COMPLETED' })
    const tool = getTool('set-listing-stock')!
    expect(await inside(() => tool.undo!.current(ran.change))).toEqual(ran.change.after)
    const undo = tool.undo!.request(ran.change) as Json
    expect(undo).toEqual({ tool: 'revert-listing-change', args: { productId: ids.parent, operationId: ran.data.operationId } })
    const reverted = await approveAndRun('revert-listing-change', undo.args)
    expect(reverted.ran.ok, reverted.ran.error).toBe(true)
    expect(await raw(ids.ebay)).toMatchObject({ followMasterQuantity: before.followMasterQuantity })
    expect(await inside(() => tool.undo!.current(ran.change))).toMatchObject({ reverted: true })
  })

  it('a target that moved since the approval is refused, and nothing changes', async () => {
    const args = { productId: ids.child, action: 'set-buffer', buffer: 2, targets: [{ rowId: ids.child, coordinateKey: 'EBAY:IT' }] }
    const preview = await dryRun('set-listing-stock', args)
    await inside(() => db().channelListing.update({ where: { id: ids.ebay }, data: { stockBuffer: 1, version: { increment: 1 } } }))
    const ran = await runApproved('set-listing-stock', args, preview.preview)
    expect(ran).toMatchObject({ ok: false, error: expect.stringContaining('changed since it was approved') })
    expect(await raw(ids.ebay)).toMatchObject({ stockBuffer: 1 })
  })

  it('an Amazon EU market lands on the one AMAZON:EU cell; an FBA row is refused and stays byte-identical', async () => {
    const eu = await dryRun('set-listing-stock', { productId: ids.child, action: 'set-buffer', buffer: 1, targets: [{ rowId: ids.child, coordinateKey: 'AMAZON:IT' }] })
    expect(eu.preview.changes).toEqual([expect.objectContaining({ coordinateKey: 'AMAZON:EU', cell: 'syncBuffer', to: 1 })])
    expect(eu.preview.notices.join(' ')).toMatch(/IT|DE/)
    const fba = { it: await raw(ids.fbaIt), de: await raw(ids.fbaDe) }
    const refused = await dryRun('set-listing-stock', { productId: ids.child, action: 'pin-quantity', quantity: 3, targets: [{ rowId: ids.fbaChild, coordinateKey: 'AMAZON:EU' }] })
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('Amazon') })
    expect({ it: await raw(ids.fbaIt), de: await raw(ids.fbaDe) }).toEqual(fba)
  })

  it('an eBay pin to 0 is refused while the out-of-stock option is not ON', async () => {
    const args = { productId: ids.child, action: 'pin-quantity', quantity: 0, targets: [{ rowId: ids.child, coordinateKey: 'EBAY:IT' }] }
    state.option.mockResolvedValue('OFF')
    expect(await dryRun('set-listing-stock', args)).toMatchObject({ ok: false, error: expect.stringContaining('out-of-stock option') })
    state.option.mockResolvedValue('ON')
    expect((await dryRun('set-listing-stock', args)).preview.changes).toEqual([expect.objectContaining({ to: 0 })])
  })
})

describe('set-listing-price', () => {
  it('sets a price per market as approved; its undo is the Matrix revert', async () => {
    const { preview, ran } = await approveAndRun('set-listing-price', { productId: ids.child, action: 'set-price', price: 12.5, targets: [{ rowId: ids.child, coordinateKey: 'EBAY:IT' }] })
    expect(preview.changes).toEqual([expect.objectContaining({ cell: 'price', from: 10, to: 12.5 })])
    expect(ran.ok, ran.error).toBe(true)
    expect(Number((await raw(ids.ebay)).price)).toBe(12.5)
    expect(getTool('set-listing-price')!.undo!.request(ran.change)).toMatchObject({ tool: 'revert-listing-change' })
  })

  it('sets a sale with its days, at the version read; its undo ends it again', async () => {
    const args = { productId: ids.child, action: 'sale', sale: { price: 8, start: '2026-11-01', end: '2026-11-30' }, targets: [{ rowId: ids.child, coordinateKey: 'AMAZON:IT' }] }
    const { preview, ran } = await approveAndRun('set-listing-price', args)
    expect(preview.changes).toEqual([expect.objectContaining({ coordinateKey: 'AMAZON:IT', from: { value: null, start: null, end: null }, to: { value: 8, start: '2026-11-01', end: '2026-11-30' } })])
    expect(ran.ok, ran.error).toBe(true)
    expect(Number((await raw(ids.amazonIt)).salePrice)).toBe(8)
    const tool = getTool('set-listing-price')!
    expect(await inside(() => tool.undo!.current(ran.change))).toEqual(ran.change.after)
    expect(tool.undo!.request(ran.change)).toEqual({ tool: 'set-listing-price', args: { productId: ids.parent, action: 'sale', sale: { price: null, start: null, end: null },
      targets: [{ rowId: ids.child, coordinateKey: 'AMAZON:IT' }] } })
  })

  it('another business\'s product is not found', async () => {
    expect(await dryRun('set-listing-price', { productId: 'no-such-product', action: 'set-price', price: 5, targets: [{ rowId: 'x', coordinateKey: 'EBAY:IT' }] })).toEqual({ ok: false, error: 'Product not found' })
  })
})
