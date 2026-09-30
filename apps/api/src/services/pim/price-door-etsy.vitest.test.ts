/**
 * 2026-09-30 — an Etsy price, written in Nexus, is QUEUED for Etsy by every producer that queues one for the other
 * channels. Real PostgreSQL in-process (PGlite), with row-level security, in both business-profile modes.
 *
 * The bug: `writeChannelPrices` (the one price door: a single edit, the Matrix/Studio, the pricing bulk override)
 * queued PRICE_UPDATE rows for AMAZON, EBAY, SHOPIFY and WOOCOMMERCE only. An Etsy price was saved, audited and put
 * on the timeline, and nothing was queued: Etsy was left behind with no row and no sentence. The snapshot push
 * (`POST /pricing/push`) refused Etsy outright as "read-only (D6)", a decision overridden on 2026-09-21.
 *
 * Each arm asserts EXACTLY one PENDING Etsy PRICE_UPDATE row, the shape every other channel's row has, and that
 * another business's Etsy listing is never touched (profiles ON). Nothing is sent: the queue's dispatcher is not run
 * here (the Etsy lane is `outbound-sync.etsy-price.vitest.test.ts`).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => undefined) }))
// The bulk override refreshes the pricing engine's snapshots after writing; that engine is not what this file is about.
vi.mock('../pricing-snapshot.service.js', () => ({ refreshSnapshotsForSkus: vi.fn(async () => ({ rowsRefreshed: 0 })), refreshAllSnapshots: vi.fn(async () => ({ rowsRefreshed: 0 })) }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { writeChannelPrices } from './channel-price-write.service.js'
import { masterPriceService } from '../master-price.service.js'
import { fireOutboundJobs } from '../outbound-enqueue.js'

const PROFILES_ON = process.env.NEXUS_WORKSPACES_ENABLED === '1'
const scopeOf = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const A = scopeOf(LEGACY_WORKSPACE_ID)
const B = scopeOf('TEST-ETSY-OTHER-BUSINESS')
const inA = <T>(work: () => Promise<T>) => withWorkspace(A, work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(B, work)

const accounts: Record<string, { etsy: string; ebay: string }> = {}
let app: FastifyInstance

async function seedBusiness(key: string) {
  await prisma.marketplace.create({ data: { channel: 'ETSY', code: 'GLOBAL', name: 'Etsy Shop', currency: 'EUR', region: 'GLOBAL', language: 'en', languages: ['en'] } })
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'DE', name: 'Germany', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'] } })
  accounts[key] = {
    // One active account per (channel, market, external id) across the whole database: each business its own fake id.
    etsy: (await prisma.channelConnection.create({ data: { channelType: 'ETSY', accountLabel: `etsy-${key}`, externalAccountId: `test-shop-${key}`, isActive: true } })).id,
    ebay: (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: `ebay-${key}`, externalAccountId: `test-seller-${key}`, isActive: true } })).id,
  }
}

/**
 * A product with an Etsy listing (and, when asked, an eBay one beside it). Each listing NAMES its account, as a live
 * one does: the queue row's destination is then read through the transaction (`price-door-reset` explains why).
 */
async function seed(key: string, sku: string, opts: { following: boolean; ebay?: boolean }) {
  const product = await prisma.product.create({ data: { sku, name: sku, basePrice: 20 } })
  const listing = (channel: 'ETSY' | 'EBAY') => prisma.channelListing.create({ data: {
    productId: product.id, channel, channelConnectionId: channel === 'ETSY' ? accounts[key].etsy : accounts[key].ebay,
    channelMarket: channel === 'ETSY' ? 'ETSY_GLOBAL' : 'EBAY_DE', marketplace: channel === 'ETSY' ? 'GLOBAL' : 'DE', region: channel === 'ETSY' ? 'GLOBAL' : 'EU',
    externalListingId: channel === 'ETSY' ? '1000000001' : 'test-ebay-listing',
    price: opts.following ? 20 : 25, priceOverride: opts.following ? null : 25, followMasterPrice: opts.following, masterPrice: 20,
  } })
  const etsy = await listing('ETSY')
  const ebay = opts.ebay ? await listing('EBAY') : null
  return { product, etsy, ebay }
}

const pendingPriceRows = (channelListingId: string) => prisma.outboundSyncQueue.findMany({
  where: { channelListingId, syncType: 'PRICE_UPDATE', syncStatus: 'PENDING' },
  select: { id: true, targetChannel: true, channelConnectionId: true, externalListingId: true, holdUntil: true, createdAt: true, payload: true },
})

beforeAll(async () => {
  if (PROFILES_ON) await state.db.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [B.workspaceId])
  await inA(() => seedBusiness('A'))
  if (PROFILES_ON) await inB(() => seedBusiness('B'))
  const { default: routes } = await import('../../routes/pricing.routes.js')
  app = Fastify()
  // Every request runs inside business A, as the global workspace hook does in production.
  app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(A, done) })
  await app.register(routes)
  await app.ready()
}, 120_000)
afterAll(async () => { await app?.close(); await state.db?.close() }, 30_000)

describe('🔴 the price door queues Etsy like every other channel', () => {
  it('a single edit: ONE Etsy PRICE_UPDATE, the same grace window, audit and payload shape as eBay', () => inA(async () => {
    const { etsy, ebay } = await seed('A', 'TEST-ETSY-SINGLE', { following: false, ebay: true })
    vi.mocked(fireOutboundJobs).mockClear()
    const result = await writeChannelPrices({
      targets: [{ listingId: etsy.id, price: 27.5, expectedVersion: etsy.version }, { listingId: ebay!.id, price: 27.5, expectedVersion: ebay!.version }],
      actor: 'test@example.test', source: 'MANUAL_OVERRIDE',
    })
    expect(result.results.map((r) => [r.channel, r.outcome])).toEqual([['ETSY', 'applied'], ['EBAY', 'applied']])

    const [etsyRows, ebayRows] = [await pendingPriceRows(etsy.id), await pendingPriceRows(ebay!.id)]
    expect(etsyRows).toHaveLength(1)
    expect(result.results[0].queueId).toBe(etsyRows[0].id)
    expect(etsyRows[0]).toMatchObject({ targetChannel: 'ETSY', channelConnectionId: accounts.A.etsy, externalListingId: '1000000001' })
    expect(etsyRows[0].payload).toMatchObject({ source: 'CHANNEL_PRICE_WRITE', marketplace: 'GLOBAL', price: 27.5 })
    // The same payload keys, the same 30 s grace window, as the eBay row the same write queued.
    expect(Object.keys(etsyRows[0].payload as object).sort()).toEqual(Object.keys(ebayRows[0].payload as object).sort())
    const grace = (r: { holdUntil: Date | null; createdAt: Date }) => r.holdUntil!.getTime() - r.createdAt.getTime()
    expect(grace(etsyRows[0])).toBeGreaterThan(25_000); expect(grace(etsyRows[0])).toBeLessThanOrEqual(31_000)
    expect(Math.abs(grace(etsyRows[0]) - grace(ebayRows[0]))).toBeLessThan(2_000)
    // The instant lane is fired for it after commit, as for eBay.
    const fired = vi.mocked(fireOutboundJobs).mock.calls.flatMap((c) => c[0].map((e: { id: string }) => e.id))
    expect(fired).toEqual(expect.arrayContaining([etsyRows[0].id, ebayRows[0].id]))
    // The audit and the timeline, as before.
    expect(await prisma.channelListingOverride.count({ where: { channelListingId: etsy.id, fieldName: 'price', newValue: '27.5' } })).toBe(1)
    expect(await prisma.priceChangeEvent.count({ where: { productId: etsy.productId, channel: 'ETSY' } })).toBe(1)
    const stored = await prisma.channelListing.findUniqueOrThrow({ where: { id: etsy.id } })
    expect(Number(stored.price)).toBe(27.5)
    expect(stored.syncStatus).toBe('PENDING')
  }))

  it('a second edit inside the grace window leaves ONE row, carrying the newer price', () => inA(async () => {
    const { etsy } = await seed('A', 'TEST-ETSY-TWICE', { following: false })
    await writeChannelPrices({ targets: [{ listingId: etsy.id, price: 26, expectedVersion: etsy.version }], actor: 'test@example.test', source: 'MANUAL_OVERRIDE' })
    await writeChannelPrices({ targets: [{ listingId: etsy.id, price: 28, expectedVersion: etsy.version + 1 }], actor: 'test@example.test', source: 'MANUAL_OVERRIDE' })
    const rows = await pendingPriceRows(etsy.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].payload).toMatchObject({ price: 28 })
  }))

  it('a channel file import records the Etsy price and queues NOTHING (record-only is unchanged)', () => inA(async () => {
    const { etsy } = await seed('A', 'TEST-ETSY-IMPORT', { following: false })
    const result = await writeChannelPrices({ targets: [{ listingId: etsy.id, price: 29, expectedVersion: etsy.version }], actor: 'test@example.test', source: 'MANUAL_OVERRIDE', recordOnly: 'channel-file-import' })
    expect(result.results[0]).toMatchObject({ outcome: 'applied', queueId: null })
    expect(await pendingPriceRows(etsy.id)).toHaveLength(0)
  }))

  it('the pricing bulk override (POST /pricing/bulk-override): ONE Etsy row at the new price', () => inA(async () => {
    const { etsy } = await seed('A', 'TEST-ETSY-BULK', { following: false })
    const snapshot = await prisma.pricingSnapshot.create({ data: { sku: 'TEST-ETSY-BULK', channel: 'ETSY', marketplace: 'GLOBAL', computedPrice: 25, currency: 'EUR', source: 'CHANNEL_OVERRIDE' } })
    const response = await app.inject({ method: 'POST', url: '/pricing/bulk-override', payload: { snapshotIds: [snapshot.id], mode: 'SET_FIXED', value: 31.9 } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ ok: true, updated: 1 })
    const rows = await pendingPriceRows(etsy.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ targetChannel: 'ETSY', payload: { source: 'CHANNEL_PRICE_WRITE', price: 31.9 } })
  }))
})

describe('the other producers', () => {
  it('a master-price change on a product whose Etsy listing follows it: ONE Etsy row at the new master price', () => inA(async () => {
    const { product, etsy } = await seed('A', 'TEST-ETSY-MASTER', { following: true })
    const result = await masterPriceService.update(product.id, 34.5, { actor: 'test@example.test', reason: 'test' })
    expect(result.cascadedListingIds).toEqual([etsy.id])
    expect(result.currencyRefused).toEqual([])
    const rows = await pendingPriceRows(etsy.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ targetChannel: 'ETSY', channelConnectionId: accounts.A.etsy, payload: { source: 'MASTER_PRICE_CHANGE', price: 34.5 } })
    expect(result.queuedSyncIds).toEqual([rows[0].id])
  }))

  it('a master-price change does not queue an Etsy listing with its own price (followMasterPrice = false)', () => inA(async () => {
    const { product, etsy } = await seed('A', 'TEST-ETSY-PINNED', { following: false })
    await masterPriceService.update(product.id, 35, { actor: 'test@example.test' })
    expect(await pendingPriceRows(etsy.id)).toHaveLength(0)
  }))

  it('the snapshot push (POST /pricing/push) queues Etsy instead of refusing it as read-only', () => inA(async () => {
    const { etsy } = await seed('A', 'TEST-ETSY-PUSH', { following: false })
    await prisma.pricingSnapshot.create({ data: { sku: 'TEST-ETSY-PUSH', channel: 'ETSY', marketplace: 'GLOBAL', computedPrice: 23.4, currency: 'EUR', source: 'CHANNEL_OVERRIDE' } })
    const response = await app.inject({ method: 'POST', url: '/pricing/push', payload: { sku: 'TEST-ETSY-PUSH', channel: 'ETSY', marketplace: 'GLOBAL' } })
    expect(response.json()).toMatchObject({ ok: true, queued: true, channel: 'ETSY' })
    const rows = await pendingPriceRows(etsy.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ targetChannel: 'ETSY', payload: { source: 'PRICING_SNAPSHOT_PUSH', price: 23.4 } })
  }))
})

describe.skipIf(!PROFILES_ON)('🔴 another business\'s Etsy listing is never touched (profiles ON)', () => {
  it('A cannot price B\'s listing by id, and A\'s master price and bulk override leave B alone', async () => {
    const other = await inB(() => seed('B', 'TEST-ETSY-B', { following: true }))
    const bSnapshot = await inB(() => prisma.pricingSnapshot.create({ data: { sku: 'TEST-ETSY-B', channel: 'ETSY', marketplace: 'GLOBAL', computedPrice: 20, currency: 'EUR', source: 'CHANNEL_OVERRIDE' } }))
    const mine = await inA(() => seed('A', 'TEST-ETSY-A-SIDE', { following: true }))

    const refused = await inA(() => writeChannelPrices({ targets: [{ listingId: other.etsy.id, price: 99, expectedVersion: other.etsy.version }], actor: 'test@example.test', source: 'MANUAL_OVERRIDE' }))
    expect(refused.results[0]).toMatchObject({ outcome: 'refused', reason: 'No listing with this id', queueId: null })
    await inA(() => masterPriceService.update(mine.product.id, 44, { actor: 'test@example.test' }))
    const bulk = await app.inject({ method: 'POST', url: '/pricing/bulk-override', payload: { snapshotIds: [bSnapshot.id], mode: 'SET_FIXED', value: 1 } })
    expect(bulk.json()).toMatchObject({ ok: true, updated: 0 })

    // A's own listing moved and was queued: the control that the writes above ran at all.
    expect(await inA(() => pendingPriceRows(mine.etsy.id))).toHaveLength(1)
    // B: same price, same version, no queue row of any kind.
    const b = await inB(() => prisma.channelListing.findUniqueOrThrow({ where: { id: other.etsy.id } }))
    expect([Number(b.price), b.version, b.followMasterPrice]).toEqual([20, other.etsy.version, true])
    expect(await inB(() => prisma.outboundSyncQueue.count({ where: { channelListingId: other.etsy.id } }))).toBe(0)
    expect(await inB(() => prisma.channelListingOverride.count({ where: { channelListingId: other.etsy.id } }))).toBe(0)
  })
})
