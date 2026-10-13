/**
 * `PATCH /api/listings/:id` answers the version it WROTE (the listing drawer's save line, editing-correctness group 3).
 *
 * 🔴 WHAT THIS GUARDS. The drawer sends its next write at the version this PATCH answers. The route used to answer the
 * version of a read made AFTER the commit: when someone else's write landed right after ours, that read already carried
 * it, and the drawer's next write went out at the other person's version and passed over their change unseen. Now the
 * answer is the version this request's own compare-and-set wrote, so that next write is a 409.
 *
 * The other write is made to land "right after ours" by wrapping the service each path calls: it runs once that
 * service's transaction has committed, before the route answers. Real PostgreSQL in-process (PGlite), the route through
 * Fastify inject. Every id is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
/** One foreign write, armed for the next commit of the named step. */
const race = vi.hoisted(() => ({ armed: null as null | { after: 'patchListing' | 'quantityFollow' | 'pin'; write: () => Promise<void> } }))
const landAfter = vi.hoisted(() => async (step: 'patchListing' | 'quantityFollow' | 'pin') => {
  const armed = race.armed
  if (!armed || armed.after !== step) return
  race.armed = null
  await armed.write()
})

vi.mock('@nexus/database', async (importOriginal) => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: state.db.client, prisma: state.db.client }
})
vi.mock('../services/outbound-enqueue.js', async (importOriginal) => ({ ...await importOriginal<any>(), fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => null) }))
vi.mock('../services/listing-events.service.js', () => ({ publishListingEvent: vi.fn(), subscribeListingEvents: vi.fn() }))
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emit: vi.fn(async () => undefined), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../services/product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn() } }))
vi.mock('../services/listings/listing-pricing-edit.service.js', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, patchListing: async (input: any) => { const out = await real.patchListing(input); await landAfter('patchListing'); return out } }
})
vi.mock('../services/listings/listing-matrix-cell.service.js', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, setListingQuantityFollow: async (input: any) => { const out = await real.setListingQuantityFollow(input); await landAfter('quantityFollow'); return out } }
})
vi.mock('../services/pim/matrix-write.service.js', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, pinTypedQuantity: async (input: any) => { const out = await real.pinTypedQuantity(input); await landAfter('pin'); return out } }
})

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const STOCK = 12
let account = ''
let warehouse = ''
let app: ReturnType<typeof Fastify>

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'DE', name: 'EBAY DE', currency: 'EUR', region: 'EU', language: 'en', languages: ['en'] } })
    account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'written-version-EBAY', isActive: true, isPrimary: true } as never })).id
    warehouse = (await prisma.stockLocation.create({ data: { code: 'TEST-WRITTEN-VERSION-WH', name: 'Written version warehouse', type: 'WAREHOUSE' } })).id
  })
  const { listingsSyndicationRoutes } = await import('./listings-syndication.routes.js')
  app = Fastify()
  app.addHook('onRequest', (request, _reply, done) => {
    (request as any).__rbacResolved = { isOwner: true, permissions: new Set<string>() }
    withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done)
  })
  await app.register(listingsSyndicationRoutes, { prefix: '/api' })
}, 180_000)
afterAll(async () => { await app?.close(); await state.db?.close() }, 60_000)

/** A product with STOCK units and one eBay DE listing that shows 5 and follows the stock. */
async function seed(id: string) {
  return scoped(async () => {
    await prisma.product.create({ data: { id, sku: `TEST-${id.toUpperCase()}`, name: id, basePrice: 10, totalStock: STOCK, fulfillmentMethod: 'FBM' } as never })
    await prisma.stockLevel.create({ data: { productId: id, locationId: warehouse, quantity: STOCK, available: STOCK } })
    return prisma.channelListing.create({ data: {
      productId: id, channel: 'EBAY', channelConnectionId: account, channelMarket: 'EBAY_DE', marketplace: 'DE', region: 'EU',
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${id}`, price: 10, masterPrice: 10, followMasterPrice: true,
      quantity: 5, followMasterQuantity: true, fulfillmentMethod: 'FBM',
    } as never })
  })
}
const patch = (id: string, payload: Record<string, unknown>) => scoped(async () => app.inject({ method: 'PATCH', url: `/api/listings/${id}`, payload }))
const listing = (id: string) => scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id } }))
/** Someone else's write on the listing (another tab, a job): it moves the version. */
const otherPersonWrites = (id: string) => () => scoped(async () => {
  await prisma.channelListing.update({ where: { id }, data: { followMasterDescription: false, version: { increment: 1 } } })
})

describe('PATCH /api/listings/:id answers the version it wrote, never a later one', () => {
  it('🔴 a drawer toggle (columns): another write lands right after ours → our answer is our version, and the next drawer write is a 409', async () => {
    const l = await seed('wv-columns')
    race.armed = { after: 'patchListing', write: otherPersonWrites(l.id) }
    const first = await patch(l.id, { followMasterTitle: false, expectedVersion: l.version })
    expect(first.statusCode, first.body).toBe(200)
    expect((await listing(l.id)).version).toBe(l.version + 2) // the other write is on file

    const next = await patch(l.id, { followMasterTitle: true, expectedVersion: first.json().listing.version })
    expect(next.statusCode, next.body).toBe(409)
    expect((await listing(l.id)).followMasterTitle).toBe(false)
    expect(first.json().listing).toEqual({ id: l.id, version: l.version + 1 })
  })

  it('🔴 the drawer\'s quantity toggle: another write lands right after ours → the next drawer write is a 409', async () => {
    const l = await seed('wv-quantity')
    race.armed = { after: 'quantityFollow', write: otherPersonWrites(l.id) }
    const first = await patch(l.id, { followMasterQuantity: false, expectedVersion: l.version })
    expect(first.statusCode, first.body).toBe(200)

    const next = await patch(l.id, { followMasterQuantity: true, expectedVersion: first.json().listing.version })
    expect(next.statusCode, next.body).toBe(409)
    expect((await listing(l.id)).followMasterQuantity).toBe(false)
    expect(first.json()).toMatchObject({ listing: { version: l.version + 1 }, quantity: { outcome: 'applied' } })
  })

  it('🔴 a typed quantity (the grid\'s stock cell): another write lands right after the pin → the next write is a 409', async () => {
    const l = await seed('wv-pin')
    race.armed = { after: 'pin', write: otherPersonWrites(l.id) }
    const first = await patch(l.id, { quantity: 7, expectedVersion: l.version })
    expect(first.statusCode, first.body).toBe(200)

    const next = await patch(l.id, { quantity: 8, expectedVersion: first.json().listing.version })
    expect(next.statusCode, next.body).toBe(409)
    expect((await listing(l.id)).quantity).toBe(7)
    expect(first.json().listing).toEqual({ id: l.id, version: l.version + 1 })
  })

  it('a toggle and the quantity in one request: both steps are ours → the answer counts both, and the next write goes through', async () => {
    const l = await seed('wv-both')
    const first = await patch(l.id, { followMasterTitle: false, followMasterQuantity: false, expectedVersion: l.version })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().listing.version).toBe(l.version + 2)
    const next = await patch(l.id, { followMasterTitle: true, expectedVersion: first.json().listing.version })
    expect(next.statusCode, next.body).toBe(200)
  })

  it('🔴 a toggle and the quantity in one request, another write between the two steps → the answer stops at our first step, and the next write is a 409', async () => {
    const l = await seed('wv-between')
    race.armed = { after: 'patchListing', write: otherPersonWrites(l.id) }
    const first = await patch(l.id, { followMasterTitle: false, followMasterQuantity: false, expectedVersion: l.version })
    expect(first.statusCode, first.body).toBe(200)
    expect((await listing(l.id)).version).toBe(l.version + 3)
    const next = await patch(l.id, { followMasterTitle: true, expectedVersion: first.json().listing.version })
    expect(next.statusCode, next.body).toBe(409)
    expect(first.json().listing.version).toBe(l.version + 1)
  })

  it('no other write: two drawer writes in a row, each at the version the one before answered, both land', async () => {
    const l = await seed('wv-quiet')
    const first = await patch(l.id, { followMasterTitle: false, expectedVersion: l.version })
    expect(first.statusCode, first.body).toBe(200)
    const second = await patch(l.id, { followMasterQuantity: false, expectedVersion: first.json().listing.version })
    expect(second.statusCode, second.body).toBe(200)
    const third = await patch(l.id, { stockBuffer: 2, expectedVersion: second.json().listing.version })
    expect(third.statusCode, third.body).toBe(200)
    expect(await listing(l.id)).toMatchObject({ followMasterTitle: false, followMasterQuantity: false, stockBuffer: 2, version: l.version + 3 })
  })
})
