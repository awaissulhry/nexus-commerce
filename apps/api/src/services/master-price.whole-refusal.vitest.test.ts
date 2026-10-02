/**
 * A master price outside the product's own floor or ceiling — or not above 0 — is refused WHOLE (2026-10-01).
 *
 * 🔴 WHAT THIS GUARDS. `MasterPriceService.update` stored any master price and refused only the following listings
 * whose price left the bounds, one by one: Nexus then held a master price its own floor/ceiling forbid, a FIXED listing
 * that follows it at exactly that price was refused, and the channels disagreed with Nexus. Now the whole edit is
 * refused before anything is written — no master price, no listing, no queue row, no audit — with ONE sentence, the
 * bulk PRICING_UPDATE preview's own ("Not changed: …", `storedPriceReason`). A listing's per-listing refusal stays only
 * for a PERCENT follower whose computed price leaves the bounds.
 *
 * Every caller names the refusal: the products grid and drawer (PATCH /products/:id → 400 with the sentence), the
 * product sheet / grid bulk writer (its per-cell error), the bulk job (a skipped row with the same sentence). The
 * Products-sheet import's FAILED row is in `flat-file/import/__tests__/apply.vitest.test.ts`.
 *
 * Real PostgreSQL in-process (PGlite). Every id is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('./outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn(async () => null) }))
vi.mock('./product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('./product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
vi.mock('./pim/readiness-index.service.js', async () => (await import('../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
vi.mock('../routes/saved-view-persistence.routes.js', () => ({ default: async () => {} }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { MasterPriceRefusedError, MasterPriceService } from './master-price.service.js'
import { pricingUpdateOutcome } from './bulk-action/pricing-update.js'
import { applyProductBulkEdits } from './products/bulk-edit.service.js'
import { BulkActionService } from './bulk-action.service.js'

const LEGACY = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const scoped = <T>(work: () => Promise<T>) => withWorkspace(LEGACY, work)
let account = ''
let app: FastifyInstance

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'DE', name: 'EBAY DE', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'] } })
    account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'whole-refusal', isActive: true } })).id
  })
  const { default: routes } = await import('../routes/products-catalog.routes.js')
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    request.authUser = { id: 'operator' } as never
    Object.assign(request, { __rbacResolved: { isOwner: true, permissions: new Set<string>() } }) // the Owner, as the RBAC gate resolves him: price writes check the person's permissions (S1 F5)
    withWorkspace(LEGACY, done)
  })
  await app.register(routes, { prefix: '/api' })
  await app.ready()
}, 120_000)
afterAll(async () => { await app?.close(); await state.db?.close() }, 60_000)

/** A product at master 10 with a floor of 5 and a ceiling of 15, and two live eBay listings following it: FIXED and +10%. */
async function seed(id: string) {
  const product = await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 10, minPrice: 5, maxPrice: 15 } as never })
  const listing = (suffix: string, rule: 'FIXED' | 'PERCENT_OF_MASTER', adj: number | null, price: number) => prisma.channelListing.create({ data: {
    productId: id, channel: 'EBAY', channelConnectionId: account, channelMarket: 'EBAY_DE', marketplace: 'DE', region: 'EU', aliasKey: suffix,
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${id}-${suffix}`,
    price, masterPrice: 10, followMasterPrice: true, pricingRule: rule, priceAdjustmentPercent: adj,
  } as never })
  return { product, fixed: await listing('fixed', 'FIXED', null, 10), percent: await listing('pct', 'PERCENT_OF_MASTER', 10, 11) }
}
/** Everything a refused edit must leave exactly as it was. */
const footprint = async (productId: string) => ({
  product: await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { basePrice: true, version: true } }),
  listings: await prisma.channelListing.findMany({ where: { productId }, orderBy: { aliasKey: 'asc' }, select: { price: true, masterPrice: true, version: true, syncStatus: true } }),
  queue: await prisma.outboundSyncQueue.count({ where: { productId } }),
  audits: await prisma.auditLog.count({ where: { entityId: productId } }),
  overrides: await prisma.channelListingOverride.count({ where: { channelListing: { productId } } }),
})
const refusalOf = async (work: Promise<unknown>) => {
  const err = await work.then(() => null, (e) => e)
  expect(err).toBeInstanceOf(MasterPriceRefusedError)
  return err as MasterPriceRefusedError
}

describe('🔴 MasterPriceService.update refuses the whole edit outside the product\'s own floor / ceiling, or at 0', () => {
  it('above the ceiling: one sentence, nothing written (no master, no listing, no queue row, no audit)', () => scoped(async () => {
    const { product } = await seed('wr-ceiling')
    const before = await footprint(product.id)
    const err = await refusalOf(new MasterPriceService(prisma).update(product.id, 19.9, { actor: 'person-1' }))
    expect(err).toMatchObject({ statusCode: 400, code: 'MASTER_PRICE_REFUSED', message: 'Not changed: 19.90 is above its pricing ceiling of 15.00.' })
    expect(await footprint(product.id)).toEqual(before)
  }))

  it('below the floor, and 0: refused with the same clauses', () => scoped(async () => {
    const { product } = await seed('wr-floor')
    const before = await footprint(product.id)
    expect((await refusalOf(new MasterPriceService(prisma).update(product.id, 4.99))).message).toBe('Not changed: 4.99 is below its pricing floor of 5.00.')
    expect((await refusalOf(new MasterPriceService(prisma).update(product.id, 0))).message).toBe('Not changed: the new price would be 0.00, and a price must be above 0.')
    // 0.004 is stored as 0.00: refused as 0, not compared as a positive number.
    expect((await refusalOf(new MasterPriceService(prisma).update(product.id, 0.004))).message).toBe('Not changed: the new price would be 0.00, and a price must be above 0.')
    expect(await footprint(product.id)).toEqual(before)
  }))

  it('the bulk PRICING_UPDATE preview says the very same sentence for the same case', () => scoped(async () => {
    const { product } = await seed('wr-same-words')
    const err = await refusalOf(new MasterPriceService(prisma).update(product.id, 19.9))
    const row = { basePrice: 10, minPrice: 5, maxPrice: 15 }
    expect(pricingUpdateOutcome(row, { adjustmentType: 'ABSOLUTE', value: 19.9 })).toMatchObject({ status: 'skipped', reason: err.message })
    const zero = await refusalOf(new MasterPriceService(prisma).update(product.id, 0))
    expect(pricingUpdateOutcome(row, { adjustmentType: 'ABSOLUTE', value: 0 })).toMatchObject({ status: 'skipped', reason: zero.message })
  }))

  it('ON the ceiling is fine: FIXED follows at 15 and is queued; only the +10% follower (16.50) is refused, per listing', () => scoped(async () => {
    const { product, fixed, percent } = await seed('wr-on-bound')
    const r = await new MasterPriceService(prisma).update(product.id, 15, { actor: 'person-1' })
    expect(r.changed).toBe(true)
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).basePrice)).toBe(15)
    expect(Number((await prisma.channelListing.findUniqueOrThrow({ where: { id: fixed.id } })).price)).toBe(15)
    expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: fixed.id, syncType: 'PRICE_UPDATE' } })).toBe(1)
    expect(r.boundsRefused.map((x) => x.listingId)).toEqual([percent.id])
    expect(Number((await prisma.channelListing.findUniqueOrThrow({ where: { id: percent.id } })).price)).toBe(11)
    expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: percent.id, syncType: 'PRICE_UPDATE' } })).toBe(0)
  }))
})

describe('🔴 every caller names the refusal', () => {
  it('the products grid / drawer (PATCH /products/:id): 400 with the sentence; nothing written, the version not bumped', async () => {
    const { product } = await scoped(() => seed('wr-patch'))
    const before = await scoped(() => footprint(product.id))
    const res = await app.inject({ method: 'PATCH', url: `/api/products/${product.id}`, payload: { basePrice: 19.9 } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'Not changed: 19.90 is above its pricing ceiling of 15.00.', code: 'MASTER_PRICE_REFUSED' })
    expect(await scoped(() => footprint(product.id))).toEqual(before)
    // Inside the bounds the same route saves.
    const ok = await app.inject({ method: 'PATCH', url: `/api/products/${product.id}`, payload: { basePrice: 12 } })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(Number((await scoped(() => prisma.product.findUniqueOrThrow({ where: { id: product.id } }))).basePrice)).toBe(12)
  })

  it('the product sheet / grid bulk writer: the cell\'s error is the sentence; the master price is unchanged', () => scoped(async () => {
    const { product } = await seed('wr-bulk-edit')
    const saved = await applyProductBulkEdits({ changes: [{ id: product.id, field: 'basePrice', value: 19.9 }] },
      { formulaCascade: false, userId: 'person-1', logger: { warn: vi.fn(), error: vi.fn() } }) as { errors?: Array<{ id: string; field: string; error: string }> }
    expect(saved.errors).toEqual([{ id: product.id, field: 'basePrice', error: 'Not changed: 19.90 is above its pricing ceiling of 15.00.' }])
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).basePrice)).toBe(10)
    expect(await prisma.outboundSyncQueue.count({ where: { productId: product.id } })).toBe(0)
  }))

  it('the bulk job: a row whose ceiling changed after the job read it is SKIPPED with the same sentence, not failed', () => scoped(async () => {
    const { product } = await seed('wr-bulk-job')
    // The job read the row before its ceiling was set to 15 (no bounds then); the write meets the ceiling.
    const stale = { ...product, minPrice: null, maxPrice: null }
    const service = new BulkActionService(prisma as never) as unknown as { processPricingUpdate: (item: unknown, payload: unknown, jobId: string) => Promise<unknown> }
    const r = await service.processPricingUpdate(stale, { adjustmentType: 'ABSOLUTE', value: 19.9 }, 'job-wr')
    expect(r).toEqual({ status: 'skipped', reason: 'Not changed: 19.90 is above its pricing ceiling of 15.00.' })
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).basePrice)).toBe(10)
  }))
})
