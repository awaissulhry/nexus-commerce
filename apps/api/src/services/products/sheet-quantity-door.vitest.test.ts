/**
 * Amazon sheet gaps (design-sync §1.A) — the bulk PATCH's quantity door: a quantity saved from the product sheet (typed,
 * pasted, imported, a formula) goes through the Matrix's own Mode / Qty writes.
 *
 * 🔴 WHAT THIS GUARDS. eBay's and Etsy's quantity used to save through the generic channel writer — `quantity` +
 * `followMasterQuantity = false` only: no buffer, no shared-stock refusal, nothing queued, a number the Matrix never
 * showed. Now a number PINS the listing (snapshot + one QUANTITY_UPDATE), an empty cell or a reset FOLLOWS the stock
 * again, Amazon EU lands on every open EU row of the SKU, FBA and shared stock are refused with the Matrix's sentences
 * before anything is staged, a stale version is a 409 `VERSION_CONFLICT`, and the door joins the caller's transaction.
 *
 * Real PostgreSQL in-process (PGlite), real primitives. Every id and SKU is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, lent: new Set<string>() }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  // Shared stock by SKU: a product in `state.lent` has an active link to another business's stock (`sharedStockLender`
  // asks exactly this). The lender's own pool is covered by matrix-shared-stock.vitest.test.ts.
  const client = new Proxy(state.db.client, { get(target, property) {
    if (property === 'stockPoolLink') return new Proxy(target.stockPoolLink, { get(links, key) {
      if (key === 'findFirst') return async (args: any) => state.lent.has(args?.where?.productId) ? { grant: { ownerWorkspace: { name: 'Lender Co' } } } : links.findFirst(args)
      const v = Reflect.get(links, key); return typeof v === 'function' ? v.bind(links) : v
    } })
    const v = Reflect.get(target, property); return typeof v === 'function' ? v.bind(target) : v
  } })
  return { default: client, prisma: client }
})
vi.mock('../outbound-enqueue.js', async (importOriginal) => ({ ...await importOriginal<any>(), fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => null) }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: vi.fn(), subscribeListingEvents: vi.fn() }))
vi.mock('../listing-values-events.js', () => ({ announceListingValues: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(async () => undefined), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn() } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { ProductBulkError } from '../../lib/product-bulk-error.js'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import { PARENT_REASON, sharedStockReason } from '../pim/matrix-cells.js'
import { applySheetQuantityChanges, isSheetQuantityChange, type SheetQuantityChange, type SheetQuantityContext } from '../pim/sheet-quantity-door.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const acc: Record<string, string> = {}
let warehouse = ''
/** What a FOLLOWING listing publishes: the product's stock in its one warehouse, minus its buffer. */
const STOCK = 12

beforeAll(() => scoped(async () => {
  for (const [channel, code] of [['AMAZON', 'IT'], ['AMAZON', 'DE'], ['EBAY', 'IT'], ['ETSY', 'GLOBAL']] as const) {
    await prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  }
  for (const channel of ['AMAZON', 'EBAY', 'ETSY']) {
    acc[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `qty-door-${channel}`, isActive: true, isPrimary: true } as never })).id
  }
  warehouse = (await prisma.stockLocation.create({ data: { code: 'TEST-QTY-DOOR-WH', name: 'Quantity door warehouse', type: 'WAREHOUSE' } })).id
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

type Seed = { channel: 'AMAZON' | 'EBAY' | 'ETSY'; marketplace: string; fba?: boolean; pinned?: number; buffer?: number; closed?: boolean }
async function seed(id: string, listings: Seed[], opts: { isParent?: boolean } = {}) {
  await prisma.product.create({ data: { id, sku: `TEST-${id.toUpperCase()}`, name: id, basePrice: 10, isParent: opts.isParent ?? false, fulfillmentMethod: 'FBM' } as never })
  await prisma.stockLevel.create({ data: { productId: id, locationId: warehouse, quantity: STOCK, available: STOCK } })
  const out: Record<string, { id: string; version: number }> = {}
  for (const l of listings) {
    out[`${l.channel}:${l.marketplace}`] = await prisma.channelListing.create({ data: {
      productId: id, channel: l.channel, marketplace: l.marketplace, channelMarket: `${l.channel}_${l.marketplace}`, region: 'EU', channelConnectionId: acc[l.channel],
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `EXT-${id}-${l.marketplace}`, price: 10,
      quantity: l.pinned ?? 5, quantityOverride: l.pinned ?? null, followMasterQuantity: l.pinned === undefined, stockBuffer: l.buffer ?? 0,
      fulfillmentMethod: l.fba ? 'FBA' : 'FBM', offerClosedAt: l.closed ? new Date() : null,
    } as never, select: { id: true, version: true } })
  }
  return out
}
const raw = async (listingId: string) =>
  (await state.db.db.query(`SELECT quantity, "quantityOverride", "followMasterQuantity", "stockBuffer", version FROM "ChannelListing" WHERE id = $1`, [listingId])).rows[0]
const queued = async (listingId: string) =>
  (await state.db.db.query(`SELECT count(*)::int AS n FROM "OutboundSyncQueue" WHERE "channelListingId" = $1 AND "syncType" = 'QUANTITY_UPDATE'`, [listingId])).rows[0].n
const ctx = (channel: string, marketplace: string, over: Partial<SheetQuantityContext> = {}): SheetQuantityContext =>
  ({ contexts: [{ channel, marketplace, aliasKey: '' }], accountFor: (ch) => acc[ch] ?? null, moved: new Map(), actor: 'sheet@example.test', ...over })
const save = (changes: SheetQuantityChange[], c: SheetQuantityContext) => scoped(() => applySheetQuantityChanges(changes, c))
const refusal = (changes: SheetQuantityChange[], c: SheetQuantityContext) => save(changes, c).then(() => null, (e) => e)

describe('which bulk changes are listing quantities', () => {
  it('eBay ebay_quantity; a channel field stored in the listing quantity column; Amazon\'s quantity leaf — nothing else', () => {
    expect(isSheetQuantityChange({ field: 'ebay_quantity' }, 'EBAY')).toBe(true)
    expect(isSheetQuantityChange({ field: 'ebay_quantity' }, 'AMAZON')).toBe(false)
    expect(isSheetQuantityChange({ field: 'attr_quantity', target: 'channel' }, 'ETSY')).toBe(true)
    expect(isSheetQuantityChange({ field: 'attr_quantity', target: 'channel' }, 'EBAY', { kind: 'listingColumn', column: 'quantity', followFlag: 'followMasterQuantity' })).toBe(true)
    expect(isSheetQuantityChange({ field: 'attr_quantity', target: 'master' }, 'ETSY')).toBe(false)
    expect(isSheetQuantityChange({ field: 'attr_fulfillment_availability__quantity', target: 'channel' }, 'AMAZON')).toBe(true)
    expect(isSheetQuantityChange({ field: 'attr_quantity', target: 'channel' }, 'AMAZON')).toBe(false)
    expect(isSheetQuantityChange({ field: 'attr_availableQuantity', target: 'channel' }, 'SHOPIFY', { kind: 'platformAttributes', path: ['availableQuantity'] })).toBe(false)
    expect(isSheetQuantityChange({ field: 'attr_quantity', target: 'channel' }, 'SHOPIFY')).toBe(false)
    expect(isSheetQuantityChange({ field: 'ebay_price' }, 'EBAY')).toBe(false)
  })
})

describe('a quantity saved from the sheet goes through the Matrix\'s Mode / Qty writes', () => {
  it('eBay: a number PINS the listing at it — snapshot, one QUANTITY_UPDATE, the version moved once (and remembered for later doors)', () => scoped(async () => {
    const l = await seed('door-ebay-pin', [{ channel: 'EBAY', marketplace: 'IT', buffer: 2 }])
    const id = l['EBAY:IT']!.id
    const c = ctx('EBAY', 'IT', { expectedVersion: l['EBAY:IT']!.version })
    const [out] = await save([{ id: 'door-ebay-pin', field: 'ebay_quantity', value: '4' }], c)
    expect(out).toMatchObject({ listingId: id, outcome: 'applied', version: l['EBAY:IT']!.version + 1 })
    expect(await raw(id)).toMatchObject({ quantity: 4, quantityOverride: 4, followMasterQuantity: false, stockBuffer: 2, version: l['EBAY:IT']!.version + 1 })
    expect(await queued(id)).toBe(1)
    expect(c.moved.get(id)).toBe(l['EBAY:IT']!.version + 1)
  }))

  it('Etsy (attr_quantity) pins the same way; the same number again is a no-op (no version spent, nothing queued)', () => scoped(async () => {
    const l = await seed('door-etsy', [{ channel: 'ETSY', marketplace: 'GLOBAL' }])
    const id = l['ETSY:GLOBAL']!.id
    await save([{ id: 'door-etsy', field: 'attr_quantity', value: 6, target: 'channel' }], ctx('ETSY', 'GLOBAL'))
    const after = await raw(id)
    expect(after).toMatchObject({ quantity: 6, quantityOverride: 6, followMasterQuantity: false })
    const [again] = await save([{ id: 'door-etsy', field: 'attr_quantity', value: 6, target: 'channel' }], ctx('ETSY', 'GLOBAL'))
    expect(again).toMatchObject({ outcome: 'noop', version: after.version })
    expect(await raw(id)).toEqual(after)
    expect(await queued(id)).toBe(1)
  }))

  it('a reset (or an empty cell) makes a pinned listing FOLLOW the stock again, minus its buffer', () => scoped(async () => {
    const l = await seed('door-reset', [{ channel: 'EBAY', marketplace: 'IT', pinned: 3, buffer: 2 }])
    const id = l['EBAY:IT']!.id
    const [out] = await save([{ id: 'door-reset', field: 'ebay_quantity', value: 3, reset: true }], ctx('EBAY', 'IT'))
    expect(out!.outcome).toBe('applied')
    expect(await raw(id)).toMatchObject({ followMasterQuantity: true, quantityOverride: null, quantity: STOCK - 2 })
    expect(await queued(id)).toBe(1)
    const [empty] = await save([{ id: 'door-reset', field: 'ebay_quantity', value: '' }], ctx('EBAY', 'IT'))
    expect(empty!.outcome).toBe('noop')
  }))

  it('Amazon EU: one quantity for the SKU — every open EU row is pinned, and the answer names the markets', () => scoped(async () => {
    const l = await seed('door-amazon-eu', [{ channel: 'AMAZON', marketplace: 'IT' }, { channel: 'AMAZON', marketplace: 'DE' }])
    const [out] = await save([{ id: 'door-amazon-eu', field: 'attr_fulfillment_availability__quantity', value: 9, target: 'channel' }], ctx('AMAZON', 'DE'))
    expect(out).toMatchObject({ listingId: l['AMAZON:DE']!.id, outcome: 'applied', expandedTo: ['IT', 'DE'] })
    for (const k of ['AMAZON:IT', 'AMAZON:DE']) {
      expect(await raw(l[k]!.id)).toMatchObject({ quantity: 9, quantityOverride: 9, followMasterQuantity: false })
      expect(await queued(l[k]!.id)).toBe(1)
    }
  }))
})

describe('refused with the Matrix\'s sentence, before anything is staged', () => {
  it('🔴 Amazon quantity on an FBA listing: "Amazon-managed", 400; nothing staged, nothing queued', () => scoped(async () => {
    const l = await seed('door-fba', [{ channel: 'AMAZON', marketplace: 'IT', fba: true }])
    const before = await raw(l['AMAZON:IT']!.id)
    const c = ctx('AMAZON', 'IT')
    const err = await refusal([{ id: 'door-fba', field: 'attr_fulfillment_availability__quantity', value: 7, target: 'channel' }], c)
    expect(err).toBeInstanceOf(ProductBulkError)
    expect(err).toMatchObject({ statusCode: 400, details: { error: MATRIX_COPY.amazonManaged, code: 'QUANTITY_REFUSED' } })
    expect(await raw(l['AMAZON:IT']!.id)).toEqual(before)
    expect(await queued(l['AMAZON:IT']!.id)).toBe(0)
    expect(c.moved.size).toBe(0)
  }))

  it('a SKU selling from another business\'s stock: no fixed number (the lender sentence); back to Follow stays allowed', () => scoped(async () => {
    const l = await seed('door-shared', [{ channel: 'EBAY', marketplace: 'IT', pinned: 0 }])
    state.lent.add('door-shared')
    const before = await raw(l['EBAY:IT']!.id)
    const err = await refusal([{ id: 'door-shared', field: 'ebay_quantity', value: 5 }], ctx('EBAY', 'IT'))
    expect(err).toMatchObject({ statusCode: 400, details: { error: sharedStockReason('Lender Co') } })
    expect(await raw(l['EBAY:IT']!.id)).toEqual(before)
    const [follow] = await save([{ id: 'door-shared', field: 'ebay_quantity', value: null, reset: true }], ctx('EBAY', 'IT'))
    expect(follow!.outcome).toBe('applied')
  }))

  it('the parent and a closed offer are held as the Matrix holds them; a negative or fractional number is refused', () => scoped(async () => {
    await seed('door-parent', [{ channel: 'EBAY', marketplace: 'IT' }], { isParent: true })
    expect(await refusal([{ id: 'door-parent', field: 'ebay_quantity', value: 2 }], ctx('EBAY', 'IT'))).toMatchObject({ statusCode: 400, details: { error: PARENT_REASON } })
    await seed('door-closed', [{ channel: 'EBAY', marketplace: 'IT', closed: true }])
    expect(await refusal([{ id: 'door-closed', field: 'ebay_quantity', value: 2 }], ctx('EBAY', 'IT'))).toMatchObject({ statusCode: 400, details: { error: MATRIX_COPY.closedHint } })
    await seed('door-number', [{ channel: 'EBAY', marketplace: 'IT' }])
    for (const value of [-1, 2.5, 'ten']) {
      expect(await refusal([{ id: 'door-number', field: 'ebay_quantity', value }], ctx('EBAY', 'IT'))).toMatchObject({ statusCode: 400, details: { error: 'A pinned quantity is a whole number, zero or more' } })
    }
  }))
})

describe('the version the caller saw, and the caller\'s transaction', () => {
  it('a stale version is a 409 VERSION_CONFLICT carrying the current one; nothing written', () => scoped(async () => {
    const l = await seed('door-stale', [{ channel: 'EBAY', marketplace: 'IT' }])
    const id = l['EBAY:IT']!.id
    await prisma.channelListing.update({ where: { id }, data: { version: { increment: 1 } } })
    const before = await raw(id)
    const err = await refusal([{ id: 'door-stale', field: 'ebay_quantity', value: 4 }], ctx('EBAY', 'IT', { expectedVersion: l['EBAY:IT']!.version, originalExpectedVersion: l['EBAY:IT']!.version }))
    expect(err).toMatchObject({ statusCode: 409, details: { code: 'VERSION_CONFLICT', error: MATRIX_COPY.changedElsewhere, currentVersion: before.version, expectedVersion: l['EBAY:IT']!.version, versionOf: 'channelListing', listingId: id } })
    expect(await raw(id)).toEqual(before)
    expect(await queued(id)).toBe(0)
  }))

  it('a listing another door moved earlier in the request is checked at its new version', () => scoped(async () => {
    const l = await seed('door-moved', [{ channel: 'EBAY', marketplace: 'IT' }])
    const id = l['EBAY:IT']!.id
    await prisma.channelListing.update({ where: { id }, data: { version: { increment: 1 } } })
    const [out] = await save([{ id: 'door-moved', field: 'ebay_quantity', value: 4 }], ctx('EBAY', 'IT', { expectedVersion: l['EBAY:IT']!.version, moved: new Map([[id, l['EBAY:IT']!.version + 1]]) }))
    expect(out).toMatchObject({ outcome: 'applied', version: l['EBAY:IT']!.version + 2 })
  }))

  it('it joins the caller\'s transaction: a later failure of the save rolls the pin back', () => scoped(async () => {
    const l = await seed('door-rollback', [{ channel: 'EBAY', marketplace: 'IT' }])
    const id = l['EBAY:IT']!.id
    const before = await raw(id)
    await expect(inDatabaseTransaction(prisma as never, async () => {
      await applySheetQuantityChanges([{ id: 'door-rollback', field: 'ebay_quantity', value: 4 }], ctx('EBAY', 'IT'))
      throw new Error('a later change in the same save failed')
    })).rejects.toThrow('a later change in the same save failed')
    expect(await raw(id)).toEqual(before)
    expect(await queued(id)).toBe(0)
  }))

  it('an alias with no listing here is refused by name (an edit never creates an alias listing)', () => scoped(async () => {
    await seed('door-alias', [{ channel: 'EBAY', marketplace: 'IT' }])
    const err = await refusal([{ id: 'door-alias', field: 'ebay_quantity', value: 4 }], { ...ctx('EBAY', 'IT'), contexts: [{ channel: 'EBAY', marketplace: 'IT', aliasKey: 'alias-x' }] })
    expect(err).toMatchObject({ statusCode: 400 })
    expect(err.details.error).toContain('An edit never creates an alias listing')
  }))
})
