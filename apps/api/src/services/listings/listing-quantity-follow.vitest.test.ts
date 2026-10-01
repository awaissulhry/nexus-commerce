/**
 * A listing's quantity FOLLOW toggles go through the Studio matrix's own Mode write (2026-10-01).
 *
 * 🔴 WHAT THIS GUARDS. The listing drawer's "follow master quantity" toggle (`PATCH /api/listings/:id`), the listings
 * bulk bar's follow / unfollow master and the reset to master wrote `followMasterQuantity` as a bare column: the
 * quantity was never recomputed from the stock (or pinned at what the listing showed), nothing was queued, so the
 * channel kept its old number; and an Amazon-managed (FBA) listing's flag was flipped although Amazon owns its
 * quantity. They now go through `setListingQuantityFollow` → `writeQuantityMode` (the matrix's Mode cell) →
 * `setFollowMasterQuantity`: FOLLOW rejoins the stock and queues ONE QUANTITY_UPDATE, PIN snapshots the number the
 * listing shows, FBA is refused by the matrix's sentence (or left to Amazon and said, beside other fields), and on an
 * Amazon EU market the whole EU group of the SKU on the same account moves together.
 *
 * Real PostgreSQL in-process (PGlite); the drawer's PATCH through Fastify inject. Every id and SKU is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async (importOriginal) => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: state.db.client, prisma: state.db.client }
})
vi.mock('../outbound-enqueue.js', async (importOriginal) => ({ ...await importOriginal<any>(), fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => null) }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: vi.fn(), subscribeListingEvents: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(async () => undefined), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn() } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { writeQuantityMode } from '../pim/matrix-write.service.js'
import { applyListingBulkPricing, ListingPricingError, resetListingToMaster } from './listing-pricing-edit.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const accounts: Record<string, string> = {}
let warehouse = ''
let app: ReturnType<typeof Fastify>

/** The stock every product holds in its one warehouse: what a FOLLOWING listing publishes. */
const STOCK = 12

beforeAll(async () => {
  await scoped(async () => {
    const market = (channel: string, code: string) => prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'en', languages: ['en'] } })
    await market('AMAZON', 'IT'); await market('AMAZON', 'DE'); await market('EBAY', 'DE')
    for (const channel of ['AMAZON', 'EBAY']) {
      accounts[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `qty-follow-${channel}`, isActive: true, isPrimary: true } as never })).id
    }
    warehouse = (await prisma.stockLocation.create({ data: { code: 'TEST-QTY-FOLLOW-WH', name: 'Quantity follow warehouse', type: 'WAREHOUSE' } })).id
  })
  const { listingsSyndicationRoutes } = await import('../../routes/listings-syndication.routes.js')
  app = Fastify()
  // The request runs in the business, as the workspace hook puts it there, by a person who may edit listings.
  app.addHook('onRequest', (request, _reply, done) => {
    (request as any).__rbacResolved = { isOwner: true, permissions: new Set<string>() }
    withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done)
  })
  await app.register(listingsSyndicationRoutes, { prefix: '/api' })
}, 180_000)
afterAll(async () => { await app?.close(); await state.db?.close() }, 60_000)

type ListingSeed = { channel: 'AMAZON' | 'EBAY'; marketplace: string; fba?: boolean; follow?: boolean; quantity?: number }
/** A product with STOCK units in the warehouse, and its listings: each shows `quantity` (5), following unless told. */
async function seed(id: string, listings: ListingSeed[]) {
  await prisma.product.create({ data: { id, sku: `TEST-${id.toUpperCase()}`, name: id, basePrice: 10, totalStock: STOCK, fulfillmentMethod: 'FBM' } as never })
  await prisma.stockLevel.create({ data: { productId: id, locationId: warehouse, quantity: STOCK, available: STOCK } })
  const rows = []
  for (const l of listings) {
    const quantity = l.quantity ?? 5
    const follow = l.follow ?? true
    rows.push(await prisma.channelListing.create({ data: {
      productId: id, channel: l.channel, channelConnectionId: accounts[l.channel], channelMarket: `${l.channel}_${l.marketplace}`,
      marketplace: l.marketplace, region: 'EU', listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${id}-${l.marketplace}`,
      price: 10, masterPrice: 10, followMasterPrice: true,
      quantity, quantityOverride: follow ? null : quantity, followMasterQuantity: follow, fulfillmentMethod: l.fba ? 'FBA' : 'FBM',
    } as never }))
  }
  return rows
}
const patch = (id: string, payload: Record<string, unknown>) => scoped(async () => app.inject({ method: 'PATCH', url: `/api/listings/${id}`, payload }))
const listing = (id: string) => scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id } }))
const quantityRows = (channelListingId: string) => scoped(() => prisma.outboundSyncQueue.findMany({ where: { channelListingId, syncType: 'QUANTITY_UPDATE', syncStatus: 'PENDING' } }))
const quantityColumns = async (id: string) => {
  const l = await listing(id)
  return { followMasterQuantity: l.followMasterQuantity, quantity: l.quantity, quantityOverride: l.quantityOverride }
}
const refusalOf = async (work: () => Promise<unknown>) => {
  try { await work() } catch (err) { return err }
  throw new Error('expected a refusal')
}

describe('the listing drawer\'s quantity toggle (PATCH /api/listings/:id) is the matrix\'s Mode write', () => {
  it('🔴 FOLLOW on a pinned eBay listing: the quantity is recomputed from the stock and ONE QUANTITY_UPDATE is queued; the same again is a no-op', async () => {
    const [l] = await scoped(() => seed('qf-drawer-follow', [{ channel: 'EBAY', marketplace: 'DE', follow: false, quantity: 3 }]))
    const res = await patch(l.id, { followMasterQuantity: true, expectedVersion: l.version })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, listing: { id: l.id, version: l.version + 1 }, quantity: { outcome: 'applied' } })
    // Before: only the flag flipped — the listing kept showing (and the channel kept) 3.
    expect(await quantityColumns(l.id)).toEqual({ followMasterQuantity: true, quantity: STOCK, quantityOverride: null })
    const rows = await quantityRows(l.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].payload).toMatchObject({ source: 'FOLLOW_MASTER', marketplace: 'DE', quantity: STOCK, oldQuantity: 3, follow: true })

    const again = await patch(l.id, { followMasterQuantity: true, expectedVersion: l.version + 1 })
    expect(again.statusCode, again.body).toBe(200)
    expect(again.json()).toMatchObject({ listing: { version: l.version + 1 }, quantity: { outcome: 'noop' } })
    expect(await quantityRows(l.id)).toHaveLength(1)
  })

  it('a stale version is 409 and nothing is written', async () => {
    const [l] = await scoped(() => seed('qf-drawer-stale', [{ channel: 'EBAY', marketplace: 'DE', follow: false, quantity: 3 }]))
    const res = await patch(l.id, { followMasterQuantity: true, expectedVersion: l.version - 1 })
    expect(res.statusCode).toBe(409)
    expect(await quantityColumns(l.id)).toEqual({ followMasterQuantity: false, quantity: 3, quantityOverride: 3 })
    expect(await quantityRows(l.id)).toEqual([])
  })

  it('🔴 PIN (follow off) pins the number the listing shows — exactly what the matrix\'s Mode write does for the same change', async () => {
    const [viaDrawer] = await scoped(() => seed('qf-drawer-pin', [{ channel: 'EBAY', marketplace: 'DE', quantity: 5 }]))
    const [viaMatrix] = await scoped(() => seed('qf-matrix-pin', [{ channel: 'EBAY', marketplace: 'DE', quantity: 5 }]))
    const res = await patch(viaDrawer.id, { followMasterQuantity: false, expectedVersion: viaDrawer.version })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ quantity: { outcome: 'applied' } })
    expect(await scoped(() => writeQuantityMode({ productId: viaMatrix.productId, channel: 'EBAY', targets: [{ id: viaMatrix.id, marketplace: 'DE', version: viaMatrix.version }], follow: false, actor: 'matrix' }))).toEqual({})

    expect(await quantityColumns(viaDrawer.id)).toEqual({ followMasterQuantity: false, quantity: 5, quantityOverride: 5 })
    expect(await quantityColumns(viaDrawer.id)).toEqual(await quantityColumns(viaMatrix.id))
    expect((await listing(viaDrawer.id)).version).toBe((await listing(viaMatrix.id)).version)
    const shape = (rows: Array<{ payload: unknown }>) => rows.map((r) => { const { actor: _actor, productId: _product, ...rest } = r.payload as Record<string, unknown>; return rest })
    expect(shape(await quantityRows(viaDrawer.id))).toEqual([{ source: 'FOLLOW_MASTER', channel: 'EBAY', marketplace: 'DE', quantity: 5, oldQuantity: 5, follow: false }])
    expect(shape(await quantityRows(viaDrawer.id))).toEqual(shape(await quantityRows(viaMatrix.id)))
  })

  it('🔴 an Amazon-managed (FBA) listing: the toggle alone is refused with the matrix\'s sentence and nothing is written', async () => {
    const [l] = await scoped(() => seed('qf-drawer-fba', [{ channel: 'AMAZON', marketplace: 'IT', fba: true }]))
    const before = await listing(l.id)
    const res = await patch(l.id, { followMasterQuantity: false, expectedVersion: l.version })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe(MATRIX_COPY.amazonManaged)
    expect(await listing(l.id)).toEqual(before)
    expect(await quantityRows(l.id)).toEqual([])
  })

  it('an FBA listing with other fields: those are saved, the quantity is left to Amazon and the answer says so', async () => {
    const [l] = await scoped(() => seed('qf-drawer-fba-more', [{ channel: 'AMAZON', marketplace: 'IT', fba: true }]))
    const res = await patch(l.id, { followMasterQuantity: false, followMasterTitle: false, expectedVersion: l.version })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, quantity: { outcome: 'skipped', note: MATRIX_COPY.amazonManaged } })
    const after = await listing(l.id)
    expect(after.followMasterTitle).toBe(false)
    expect(after.version).toBe(l.version + 1)
    expect(await quantityColumns(l.id)).toEqual({ followMasterQuantity: true, quantity: 5, quantityOverride: null })
    expect(await quantityRows(l.id)).toEqual([])
  })

  it('🔴 Amazon EU: the toggle on IT moves the SKU\'s whole EU group on the same account, as the matrix\'s EU rule does, and says which markets', async () => {
    const [it_, de] = await scoped(() => seed('qf-drawer-eu', [
      { channel: 'AMAZON', marketplace: 'IT', follow: false, quantity: 2 },
      { channel: 'AMAZON', marketplace: 'DE', follow: false, quantity: 2 },
    ]))
    const res = await patch(it_.id, { followMasterQuantity: true, expectedVersion: it_.version })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().quantity.outcome).toBe('applied')
    expect([...res.json().quantity.expandedTo].sort()).toEqual(['DE', 'IT'])
    for (const l of [it_, de]) {
      expect(await quantityColumns(l.id)).toEqual({ followMasterQuantity: true, quantity: STOCK, quantityOverride: null })
      expect(await quantityRows(l.id)).toHaveLength(1)
    }
    // The same toggle again, from DE: the whole group already follows — a no-op, as the matrix's Mode cell answers:
    // no row, and no version spent on any market (a bump would cost IT's open editor a needless 409).
    const versions = async () => scoped(async () => (await prisma.channelListing.findMany({ where: { id: { in: [it_.id, de.id] } }, orderBy: { marketplace: 'asc' }, select: { version: true } })).map((r) => r.version))
    const before = await versions()
    const again = await patch(de.id, { followMasterQuantity: true })
    expect(again.statusCode, again.body).toBe(200)
    expect(again.json().quantity.outcome).toBe('noop')
    expect(await versions()).toEqual(before)
    for (const l of [it_, de]) expect(await quantityRows(l.id)).toHaveLength(1)
  })

  it('Amazon EU: a group with an FBA member is refused whole — not half of the group', async () => {
    const [it_, de] = await scoped(() => seed('qf-drawer-eu-fba', [
      { channel: 'AMAZON', marketplace: 'IT', follow: false, quantity: 2 },
      { channel: 'AMAZON', marketplace: 'DE', follow: false, quantity: 2, fba: true },
    ]))
    const res = await patch(it_.id, { followMasterQuantity: true, expectedVersion: it_.version })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe(MATRIX_COPY.amazonManaged)
    for (const l of [it_, de]) {
      expect(await quantityColumns(l.id)).toEqual({ followMasterQuantity: false, quantity: 2, quantityOverride: 2 })
      expect(await quantityRows(l.id)).toEqual([])
    }
  })
})

describe('the listings bulk bar\'s follow / unfollow master moves the quantity through the same write', () => {
  it('🔴 follow-master: a pinned eBay listing follows the stock and is queued; an FBA listing\'s quantity is left to Amazon and named', async () => {
    const [ebay] = await scoped(() => seed('qf-bulk-follow', [{ channel: 'EBAY', marketplace: 'DE', follow: false, quantity: 3 }]))
    const [fba] = await scoped(() => seed('qf-bulk-follow-fba', [{ channel: 'AMAZON', marketplace: 'IT', fba: true, follow: false, quantity: 4 }]))
    const e = await scoped(() => applyListingBulkPricing({ action: 'follow-master', listingId: ebay.id, actor: 'bulk-test' }))
    expect(e.quantitySkipped).toBeUndefined()
    expect(await quantityColumns(ebay.id)).toEqual({ followMasterQuantity: true, quantity: STOCK, quantityOverride: null })
    expect(await quantityRows(ebay.id)).toHaveLength(1)
    expect((await listing(ebay.id)).followMasterTitle).toBe(true)

    const f = await scoped(() => applyListingBulkPricing({ action: 'follow-master', listingId: fba.id, actor: 'bulk-test' }))
    expect(f.quantitySkipped).toBe(MATRIX_COPY.amazonManaged)
    expect(await quantityColumns(fba.id)).toEqual({ followMasterQuantity: false, quantity: 4, quantityOverride: 4 })
    expect(await quantityRows(fba.id)).toEqual([])
  })

  it('unfollow-master: a following eBay listing is pinned at the number it shows and queued', async () => {
    const [ebay] = await scoped(() => seed('qf-bulk-unfollow', [{ channel: 'EBAY', marketplace: 'DE', quantity: 5 }]))
    const r = await scoped(() => applyListingBulkPricing({ action: 'unfollow-master', listingId: ebay.id, actor: 'bulk-test' }))
    expect(r.quantitySkipped).toBeUndefined()
    expect(await quantityColumns(ebay.id)).toEqual({ followMasterQuantity: false, quantity: 5, quantityOverride: 5 })
    const rows = await quantityRows(ebay.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].payload).toMatchObject({ quantity: 5, follow: false })
  })
})

describe('reset to master hands the quantity back through the same write', () => {
  it('🔴 reset quantity: a pinned eBay listing follows the stock again and is queued', async () => {
    const [l] = await scoped(() => seed('qf-reset', [{ channel: 'EBAY', marketplace: 'DE', follow: false, quantity: 3 }]))
    const r = await scoped(() => resetListingToMaster({ productId: l.productId, listingId: l.id, fields: ['quantity'], actor: 'reset-test' }))
    expect(r).toMatchObject({ quantityFollowTurnedOn: true })
    expect(r.quantitySkipped).toBeUndefined()
    expect(await quantityColumns(l.id)).toEqual({ followMasterQuantity: true, quantity: STOCK, quantityOverride: null })
    expect(await quantityRows(l.id)).toHaveLength(1)
  })

  it('🔴 an FBA listing: reset quantity alone is refused with the matrix\'s sentence, nothing written', async () => {
    const [l] = await scoped(() => seed('qf-reset-fba', [{ channel: 'AMAZON', marketplace: 'IT', fba: true, follow: false, quantity: 4 }]))
    const before = await listing(l.id)
    const err = await refusalOf(() => scoped(() => resetListingToMaster({ productId: l.productId, listingId: l.id, fields: ['quantity'], actor: 'reset-test' })))
    expect(err).toBeInstanceOf(ListingPricingError)
    expect(err).toMatchObject({ statusCode: 400, message: MATRIX_COPY.amazonManaged })
    expect(await listing(l.id)).toEqual(before)
    expect(await quantityRows(l.id)).toEqual([])
  })

  it('an FBA listing in a reset of several fields: the others are reset, the quantity is left to Amazon and named', async () => {
    const [l] = await scoped(() => seed('qf-reset-fba-all', [{ channel: 'AMAZON', marketplace: 'IT', fba: true, follow: false, quantity: 4 }]))
    await scoped(() => prisma.channelListing.update({ where: { id: l.id }, data: { followMasterTitle: false, titleOverride: 'A title of its own' } }))
    const r = await scoped(() => resetListingToMaster({ productId: l.productId, listingId: l.id, fields: ['title', 'quantity'], actor: 'reset-test' }))
    expect(r).toMatchObject({ quantityFollowTurnedOn: false, quantitySkipped: MATRIX_COPY.amazonManaged })
    expect(await listing(l.id)).toMatchObject({ followMasterTitle: true, titleOverride: null })
    expect(await quantityColumns(l.id)).toEqual({ followMasterQuantity: false, quantity: 4, quantityOverride: 4 })
    expect(await quantityRows(l.id)).toEqual([])
  })
})
