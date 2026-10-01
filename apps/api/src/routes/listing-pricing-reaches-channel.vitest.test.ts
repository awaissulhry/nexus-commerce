/**
 * Every path that changes a listing's pricing rule, adjustment percent, follow-master flag or own price sends the
 * resulting price through the ONE channel price door (2026-10-01, "pricing rules reach the channels").
 *
 * 🔴 WHAT THIS GUARDS. Each writer below wrote the columns and queued nothing, so the channel kept the old price:
 *   - PATCH /api/listings/:id (the listing drawer: rule, percent, follow; and its version check read the row, then
 *     wrote it without the version in the `where`);
 *   - the grid's inline price cell (it sent `{ price }`, which the PATCH refused, so it always failed);
 *   - POST /api/listings/bulk-action set-price / set-pricing-rule / follow-master;
 *   - the bulk MARKETPLACE_OVERRIDE_UPDATE rule and percent;
 *   - the master sheet's "price follows" cell (PATCH /api/products/:id/channel-follows);
 *   - the product page's reset to master (POST /api/products/:id/channel-listing/:clId/reset);
 *   - the FF2 flat-file import's pricing cells.
 *
 * Real PostgreSQL in-process (PGlite), the routes through Fastify inject. Every id is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import Fastify from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async (importOriginal) => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: state.db.client, prisma: state.db.client }
})
vi.mock('../services/outbound-enqueue.js', async (importOriginal) => ({ ...await importOriginal<any>(), fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => null) }))
vi.mock('../services/listing-events.service.js', () => ({ publishListingEvent: vi.fn(), subscribeListingEvents: vi.fn() }))
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emit: vi.fn(async () => undefined), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../services/product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { applyChannelFollows } from '../services/pim/channel-follows.service.js'
import { resetListingToMaster } from '../services/listings/listing-pricing-edit.service.js'
import { BulkActionService } from '../services/bulk-action.service.js'
import { applyChanges } from '../services/flat-file/import/apply.js'
import type { CellChange, ImportDiff } from '../services/flat-file/import/diff.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const accounts: Record<string, string> = {}
let app: ReturnType<typeof Fastify>

beforeAll(async () => {
  await scoped(async () => {
    const market = (channel: string, code: string, currency: string) => prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency, region: 'EU', language: 'en', languages: ['en'] } })
    await market('EBAY', 'DE', 'EUR')
    await market('EBAY', 'UK', 'GBP')
    await market('AMAZON', 'IT', 'EUR')
    for (const channel of ['EBAY', 'AMAZON']) {
      accounts[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `rules-reach-${channel}`, isActive: true } })).id
    }
  })
  const { listingsSyndicationRoutes } = await import('./listings-syndication.routes.js')
  app = Fastify()
  // The request runs in the business, as the workspace hook puts it there (business profiles ON or OFF).
  app.addHook('onRequest', (_request, _reply, done) => { withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done) })
  await app.register(listingsSyndicationRoutes, { prefix: '/api' })
}, 180_000)
afterAll(async () => { await app?.close(); await state.db?.close() }, 60_000)

/** A product at master 10 and one live listing following it at 10 (FIXED) unless told otherwise. */
async function seed(id: string, s: { marketplace?: string; channel?: 'EBAY' | 'AMAZON'; follow?: boolean; price?: number; rule?: string; adj?: number; product?: Record<string, unknown> } = {}) {
  const channel = s.channel ?? 'EBAY'
  const marketplace = s.marketplace ?? (channel === 'AMAZON' ? 'IT' : 'DE')
  await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 10, ...s.product } as never })
  return prisma.channelListing.create({ data: {
    productId: id, channel, channelConnectionId: accounts[channel], channelMarket: `${channel}_${marketplace}`, marketplace, region: 'EU',
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${id}`,
    price: s.price ?? 10, masterPrice: 10, followMasterPrice: s.follow ?? true, priceOverride: s.follow === false ? (s.price ?? 10) : null,
    pricingRule: (s.rule ?? 'FIXED') as never, priceAdjustmentPercent: s.adj ?? null,
  } as never })
}
const listing = (id: string) => scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id } }))
const queued = (channelListingId: string) => scoped(() => prisma.outboundSyncQueue.findMany({ where: { channelListingId, syncStatus: 'PENDING' } }))
const prices = async (channelListingId: string) => (await queued(channelListingId)).map((row) => (row.payload as any).price)
const patch = (id: string, payload: Record<string, unknown>) => scoped(async () => app.inject({ method: 'PATCH', url: `/api/listings/${id}`, payload }))
const inThirtySeconds = (at: Date | null) => {
  const ms = (at?.getTime() ?? 0) - Date.now()
  return ms > 20_000 && ms <= 30_000
}

describe('PATCH /api/listings/:id — the listing drawer', () => {
  it('🔴 PERCENT +10 on a listing following master 10: 200, price 11.00, ONE pending PRICE_UPDATE at 11 on the 30 s hold; the same PATCH again adds nothing', async () => {
    const l = await scoped(() => seed('patch-percent'))
    const res = await patch(l.id, { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10, expectedVersion: l.version })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, listing: { id: l.id, version: l.version + 1 }, queued: true })
    expect(Number((await listing(l.id)).price)).toBe(11)
    const rows = await queued(l.id)
    expect(rows.map((row) => [row.syncType, (row.payload as any).price])).toEqual([['PRICE_UPDATE', 11]])
    expect(inThirtySeconds(rows[0].holdUntil)).toBe(true)

    const again = await patch(l.id, { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10, expectedVersion: l.version + 1 })
    expect(again.statusCode).toBe(200)
    expect(again.json()).toMatchObject({ listing: { version: l.version + 1 }, queued: false })
    expect(await queued(l.id)).toEqual(rows)
  })

  it('🔴 a stale version is 409 and writes nothing — the price door and the other columns alike', async () => {
    const l = await scoped(() => seed('patch-stale'))
    const before = await listing(l.id)
    for (const body of [{ pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10 }, { stockBuffer: 3 }]) {
      const res = await patch(l.id, { ...body, expectedVersion: l.version - 1 })
      expect(res.statusCode).toBe(409)
      expect(await listing(l.id)).toEqual(before)
    }
    expect(await queued(l.id)).toEqual([])
  })

  it('🔴 a price outside the floor/ceiling is refused with its sentence and nothing is written', async () => {
    const l = await scoped(() => seed('patch-ceiling', { product: { maxPrice: 10.5 } }))
    const before = await listing(l.id)
    const res = await patch(l.id, { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10, stockBuffer: 2, expectedVersion: l.version })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('above its pricing ceiling of 10.50')
    expect(await listing(l.id)).toEqual(before)
    expect(await queued(l.id)).toEqual([])
  })

  it('a GBP market: 200 with the refusal sentence, the price kept, nothing queued; paused: stored, nothing queued', async () => {
    const gbp = await scoped(() => seed('patch-gbp', { marketplace: 'UK' }))
    const res = await patch(gbp.id, { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10, expectedVersion: gbp.version })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ queued: false, notSent: expect.stringContaining('sells in GBP') })
    expect(Number((await listing(gbp.id)).price)).toBe(10)
    expect(await queued(gbp.id)).toEqual([])

    const paused = await scoped(() => seed('patch-paused'))
    await scoped(() => prisma.channelListing.update({ where: { id: paused.id }, data: { syncPaused: true } }))
    const p = await patch(paused.id, { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10 })
    expect(p.json()).toMatchObject({ queued: false, notSent: expect.stringContaining('paused') })
    expect(Number((await listing(paused.id)).price)).toBe(11)
    expect(await queued(paused.id)).toEqual([])
  })

  it('MATCH_AMAZON and an unfollow send nothing; a follow back sends the rule\'s price', async () => {
    const l = await scoped(() => seed('patch-follow', { rule: 'PERCENT_OF_MASTER', adj: 20, price: 12 }))
    const off = await patch(l.id, { followMasterPrice: false, expectedVersion: l.version })
    expect(off.statusCode).toBe(200)
    expect(await queued(l.id)).toEqual([])
    const on = await patch(l.id, { followMasterPrice: true, expectedVersion: off.json().listing.version })
    expect(on.json()).toMatchObject({ queued: true })
    expect(await prices(l.id)).toEqual([12])

    const match = await scoped(() => seed('patch-match'))
    const m = await patch(match.id, { pricingRule: 'match_amazon', expectedVersion: match.version })
    expect(m.statusCode).toBe(200)
    expect((await listing(match.id)).pricingRule).toBe('MATCH_AMAZON')
    expect(await queued(match.id)).toEqual([])
  })

  it('🔴 the grid\'s price cell pins through the door: price + priceOverride, follow off, one row', async () => {
    const l = await scoped(() => seed('patch-cell'))
    const res = await patch(l.id, { priceOverride: 12.5, expectedVersion: l.version })
    expect(res.statusCode).toBe(200)
    expect(await listing(l.id)).toMatchObject({ followMasterPrice: false })
    expect(Number((await listing(l.id)).price)).toBe(12.5)
    expect(Number((await listing(l.id)).priceOverride)).toBe(12.5)
    expect(await prices(l.id)).toEqual([12.5])
  })

  it('🔴 a typed price above the product\'s EUR ceiling is refused at the edit; the same price on a GBP market is not compared', async () => {
    const eur = await scoped(() => seed('patch-pin-eur', { product: { maxPrice: 20 } }))
    const before = await listing(eur.id)
    const refused = await patch(eur.id, { priceOverride: 25, expectedVersion: eur.version })
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error).toContain('cannot be pinned at 25.00: 25.00 is above its pricing ceiling of 20.00')
    expect(await listing(eur.id)).toEqual(before)
    expect(await queued(eur.id)).toEqual([])
    const gbp = await scoped(() => seed('patch-pin-gbp', { marketplace: 'UK', product: { maxPrice: 20 } }))
    expect((await patch(gbp.id, { priceOverride: 25, expectedVersion: gbp.version })).statusCode).toBe(200)
    expect(await prices(gbp.id)).toEqual([25])
    // 0 is not a price.
    expect((await patch(gbp.id, { priceOverride: 0 })).statusCode).toBe(400)
  })

  it('a bad percent or rule is a 400 before anything is read or written; a version-less reset button still works', async () => {
    const l = await scoped(() => seed('patch-bad', { follow: false, price: 25, rule: 'PERCENT_OF_MASTER', adj: 10 }))
    for (const body of [{ priceAdjustmentPercent: -100 }, { priceAdjustmentPercent: 1.234 }, { pricingRule: 'CHEAPEST' }]) {
      expect((await patch(l.id, body)).statusCode).toBe(400)
    }
    expect(await queued(l.id)).toEqual([])
    // OverrideBadge's reset sends no version: the door names why (`listing-patch-unversioned`) and sends 11.
    const reset = await patch(l.id, { followMasterPrice: true, followMasterTitle: true })
    expect(reset.statusCode).toBe(200)
    expect(await listing(l.id)).toMatchObject({ followMasterPrice: true, followMasterTitle: true, priceOverride: null })
    expect(await prices(l.id)).toEqual([11])
  })
})

describe('POST /api/listings/bulk-action', () => {
  async function run(action: string, listingIds: string[], payload?: Record<string, unknown>) {
    const res = await scoped(async () => app.inject({ method: 'POST', url: '/api/listings/bulk-action', payload: { action, listingIds, payload } }))
    expect(res.statusCode).toBe(202)
    const { jobId } = res.json()
    for (let i = 0; i < 100; i++) {
      const job = await scoped(() => prisma.bulkActionJob.findUniqueOrThrow({ where: { id: jobId } }))
      if (['COMPLETED', 'FAILED', 'PARTIALLY_COMPLETED'].includes(job.status)) return job
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('the bulk job did not finish')
  }

  it('🔴 set-pricing-rule (lower case accepted) recomputes and queues; set-price pins and queues; follow-master sends the rule price', async () => {
    const a = await scoped(() => seed('bulk-rule'))
    expect(await run('set-pricing-rule', [a.id], { pricingRule: 'percent_of_master', priceAdjustmentPercent: 10 })).toMatchObject({ status: 'COMPLETED' })
    expect(await listing(a.id)).toMatchObject({ pricingRule: 'PERCENT_OF_MASTER' })
    expect(await prices(a.id)).toEqual([11])

    const b = await scoped(() => seed('bulk-price'))
    expect(await run('set-price', [b.id], { price: 15 })).toMatchObject({ status: 'COMPLETED' })
    expect(await listing(b.id)).toMatchObject({ followMasterPrice: false })
    expect(Number((await listing(b.id)).priceOverride)).toBe(15)
    expect(await prices(b.id)).toEqual([15])

    const c = await scoped(() => seed('bulk-follow', { follow: false, price: 25, rule: 'PERCENT_OF_MASTER', adj: 10 }))
    expect(await run('follow-master', [c.id])).toMatchObject({ status: 'COMPLETED' })
    expect(await listing(c.id)).toMatchObject({ followMasterPrice: true, followMasterTitle: true, followMasterQuantity: true })
    expect(await prices(c.id)).toEqual([11])
  })

  it('🔴 bulk Set price on a paused listing: stored, nothing queued, and the job names it (not a failure)', async () => {
    const l = await scoped(async () => {
      const row = await seed('bulk-pin-paused')
      return prisma.channelListing.update({ where: { id: row.id }, data: { syncPaused: true } })
    })
    const sentence = 'Not sent: The price 15.00 is saved in Nexus. Nothing was sent: this listing\'s sync is paused.'
    const job = await run('set-price', [l.id], { price: 15 })
    expect(job).toMatchObject({ status: 'COMPLETED', processedItems: 1, failedItems: 0, lastError: sentence })
    expect(Number((await listing(l.id)).priceOverride)).toBe(15)
    expect(await queued(l.id)).toEqual([])
  })

  it('🔴 follow-master on an Amazon-managed (FBA) listing: the price follows, the quantity is Amazon\'s — left alone and named on the job, not a failure', async () => {
    const l = await scoped(async () => {
      const row = await seed('bulk-follow-fba', { channel: 'AMAZON', follow: false, price: 25 })
      return prisma.channelListing.update({ where: { id: row.id }, data: { fulfillmentMethod: 'FBA', followMasterQuantity: false, quantity: 4, quantityOverride: 4 } as never })
    })
    const job = await run('follow-master', [l.id])
    expect(job).toMatchObject({ status: 'COMPLETED', processedItems: 1, failedItems: 0, lastError: `Quantity not changed: ${MATRIX_COPY.amazonManaged}` })
    expect(job.errorLog).toEqual([{ listingId: l.id, reason: `Quantity not changed: ${MATRIX_COPY.amazonManaged}` }])
    expect(await listing(l.id)).toMatchObject({ followMasterPrice: true, followMasterQuantity: false, quantity: 4, quantityOverride: 4 })
    expect(await prices(l.id)).toEqual([10])
    expect((await queued(l.id)).map((row) => row.syncType)).toEqual(['PRICE_UPDATE'])
    // No "followMasterQuantity changed" journal row for a flag that did not change.
    const journal = await scoped(() => prisma.auditLog.findMany({ where: { entityId: l.id } }))
    expect(journal.filter((row) => (row.metadata as { field?: string } | null)?.field === 'followMasterQuantity')).toEqual([])
  })

  it('🔴 bulk Set price above a EUR ceiling fails that listing by name; 0 is a 400 before any job', async () => {
    const l = await scoped(() => seed('bulk-pin-ceiling', { product: { maxPrice: 20 } }))
    expect(await run('set-price', [l.id], { price: 25 })).toMatchObject({ status: 'FAILED', lastError: expect.stringContaining('above its pricing ceiling of 20.00') })
    expect(await queued(l.id)).toEqual([])
    const zero = await scoped(async () => app.inject({ method: 'POST', url: '/api/listings/bulk-action', payload: { action: 'set-price', listingIds: [l.id], payload: { price: 0 } } }))
    expect(zero.statusCode).toBe(400)
  })

  it('a refusal fails that listing by name and writes nothing; a bad percent is a 400 before any job', async () => {
    const l = await scoped(() => seed('bulk-refused', { product: { maxPrice: 10.5 } }))
    const job = await run('set-pricing-rule', [l.id], { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10 })
    expect(job).toMatchObject({ status: 'FAILED', lastError: expect.stringContaining('pricing ceiling') })
    expect((await listing(l.id)).pricingRule).toBe('FIXED')
    expect(await queued(l.id)).toEqual([])
    const bad = await scoped(async () => app.inject({ method: 'POST', url: '/api/listings/bulk-action', payload: { action: 'set-pricing-rule', listingIds: [l.id], payload: { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10.555 } } }))
    expect(bad.statusCode).toBe(400)
  })
})

describe('the other writers send the computed price', () => {
  it('🔴 the bulk MARKETPLACE_OVERRIDE_UPDATE rule and percent recompute and queue', () => scoped(async () => {
    const l = await seed('override-rule')
    const service = new BulkActionService(prisma as never)
    const job = await service.createJob({ jobName: 'rule', actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'EBAY', targetProductIds: ['override-rule'],
      actionPayload: { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10 }, createdBy: 'person-1' })
    expect(await service.processJob(job.id)).toMatchObject({ status: 'COMPLETED', processedItems: 1 })
    expect(Number((await prisma.channelListing.findUniqueOrThrow({ where: { id: l.id } })).price)).toBe(11)
    expect((await prisma.outboundSyncQueue.findMany({ where: { channelListingId: l.id } })).map((row) => (row.payload as any).price)).toEqual([11])
  }))

  it('🔴 the master sheet\'s "price follows" cell: following again sends the rule price; pinning sends nothing', () => scoped(async () => {
    const l = await seed('follows-cell', { follow: false, price: 25, rule: 'PERCENT_OF_MASTER', adj: 10 })
    const [on] = await applyChannelFollows('follows-cell', [{ channel: 'EBAY', marketplace: 'DE', field: 'price', follows: true }], 'person-1')
    expect(on).toMatchObject({ ok: true, follows: true, queued: true })
    expect(Number((await prisma.channelListing.findUniqueOrThrow({ where: { id: l.id } })).price)).toBe(11)
    expect((await prisma.outboundSyncQueue.findMany({ where: { channelListingId: l.id } })).map((row) => (row.payload as any).price)).toEqual([11])
    const [off] = await applyChannelFollows('follows-cell', [{ channel: 'EBAY', marketplace: 'DE', field: 'price', follows: false }], 'person-1')
    expect(off).toMatchObject({ ok: true, follows: false, queued: false, stillPinned: ['price'] })
    expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: l.id } })).toBe(1)
  }))

  it('🔴 the reset to master sends the rule price; a refusal writes nothing, not even the other fields', () => scoped(async () => {
    const l = await seed('reset-all', { follow: false, price: 25, rule: 'PERCENT_OF_MASTER', adj: 10 })
    await prisma.channelListing.update({ where: { id: l.id }, data: { followMasterTitle: false, titleOverride: 'Own title' } })
    expect(await resetListingToMaster({ productId: 'reset-all', listingId: l.id, fields: ['title', 'price'], actor: 'person-1' })).toMatchObject({ quantityFollowTurnedOn: false })
    expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: l.id } })).toMatchObject({ followMasterPrice: true, followMasterTitle: true, titleOverride: null })
    expect((await prisma.outboundSyncQueue.findMany({ where: { channelListingId: l.id } })).map((row) => (row.payload as any).price)).toEqual([11])

    const refused = await seed('reset-refused', { follow: false, price: 25, product: { minPrice: 20 } })
    await prisma.channelListing.update({ where: { id: refused.id }, data: { followMasterTitle: false, titleOverride: 'Own title' } })
    const before = await prisma.channelListing.findUniqueOrThrow({ where: { id: refused.id } })
    await expect(resetListingToMaster({ productId: 'reset-refused', listingId: refused.id, fields: ['title', 'price'], actor: 'person-1' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('pricing floor') })
    expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: refused.id } })).toEqual(before)
  }))

  it('🔴 the FF2 import: a rule cell recomputes and queues, a price cell pins and queues, a refused cell FAILS by name', () => scoped(async () => {
    const rule = await seed('ff2-rule')
    const pin = await seed('ff2-pin')
    const refused = await seed('ff2-refused', { product: { maxPrice: 10.5 } })
    const cell = (sku: string, column: string, base: string, to: string): CellChange => ({ sku, sheet: 'eBay', channel: 'EBAY', market: 'DE', column, base, from: null, to, kind: 'update' } as unknown as CellChange)
    const diff: ImportDiff = { changes: [
      cell('FF2-RULE', 'pricing_rule@DE', 'pricing_rule', 'PERCENT_OF_MASTER'),
      cell('FF2-RULE', 'price_adj_pct@DE', 'price_adj_pct', '10'),
      cell('FF2-PIN', 'price@DE', 'price', '14.5'),
      cell('FF2-REFUSED', 'price_adj_pct@DE', 'price_adj_pct', '10'),
      cell('FF2-REFUSED', 'pricing_rule@DE', 'pricing_rule', 'PERCENT_OF_MASTER'),
    ], masterChanges: [], deletes: [], stats: { adds: 0, updates: 5, deletes: 0, conflicts: 0, outOfScope: 0 } } as ImportDiff
    const result = await applyChanges(prisma, diff, { scope: { channel: 'EBAY', markets: ['DE'], includeMaster: false } as never, actor: 'person-1' })
    expect(result).toMatchObject({ applied: 4, failed: 1 })
    expect(result.rows.find((r) => r.status === 'FAILED')).toMatchObject({ sku: 'FF2-REFUSED', detail: expect.stringContaining('pricing ceiling') })
    const pending = (id: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId: id, syncStatus: 'PENDING' } })
    expect(Number((await prisma.channelListing.findUniqueOrThrow({ where: { id: rule.id } })).price)).toBe(11)
    expect((await pending(rule.id)).map((row) => (row.payload as any).price)).toEqual([11])
    expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: pin.id } })).toMatchObject({ followMasterPrice: false })
    expect((await pending(pin.id)).map((row) => (row.payload as any).price)).toEqual([14.5])
    // The refused cell wrote nothing: still FIXED at 10 (its percent cell, alone, was written: a FIXED listing's price does not move).
    expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: refused.id } })).toMatchObject({ pricingRule: 'FIXED' })
    expect(await pending(refused.id)).toEqual([])
  }))

  it('🔴 the FF2 import\'s Products-sheet base price goes through the master-price writer: following listings are recomputed and queued', () => scoped(async () => {
    const l = await seed('ff2-master', { rule: 'PERCENT_OF_MASTER', adj: 10, price: 11 })
    const masterCell = { sku: 'FF2-MASTER', sheet: 'Products', channel: undefined, market: undefined, column: 'base_price', base: 'base_price', from: 10, to: '20', kind: 'update' } as unknown as CellChange
    const result = await applyChanges(prisma, { changes: [], masterChanges: [masterCell], deletes: [], stats: { adds: 0, updates: 1, deletes: 0, conflicts: 0, outOfScope: 0 } } as ImportDiff,
      { scope: { channel: 'EBAY', markets: ['DE'], includeMaster: true } as never, actor: 'person-1' })
    expect(result).toMatchObject({ applied: 1, failed: 0 })
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: 'ff2-master' } })).basePrice)).toBe(20)
    expect(Number((await prisma.channelListing.findUniqueOrThrow({ where: { id: l.id } })).price)).toBe(22)
    const rows = await prisma.outboundSyncQueue.findMany({ where: { channelListingId: l.id, syncStatus: 'PENDING' } })
    expect(rows.map((row) => [(row.payload as any).source, (row.payload as any).price])).toEqual([['MASTER_PRICE_CHANGE', 22]])
  }))
})
