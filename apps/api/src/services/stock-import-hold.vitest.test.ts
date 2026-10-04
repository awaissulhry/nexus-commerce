/**
 * Build shape v2 (P13) — the stock import's Follow / Pinned / Buffer columns leave a listing whose selling is paused
 * (Inactive: the product sheet's Pause offer, or Amazon's market close) alone: nothing is written on it and no quantity
 * is queued for it, and the import counts it. Positive control: the same product's listing that sells on another
 * market takes the change.
 *
 * Runs the real import step (`applyControlColumns`) and follow-master service on PostgreSQL (PGlite).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('./product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('./pim/readiness-index.service.js', async () => (await import('../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
vi.mock('./pim/channel-price-write.service.js', () => ({ sendHeldPrices: vi.fn(async () => undefined) }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { applyControlColumns } from './stock-import.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}

beforeAll(() => scoped(async () => {
  const ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'import-hold', externalAccountId: 'TEST-IMPORT-HOLD', isActive: true, isPrimary: true } as never })).id
  ids.product = (await prisma.product.create({ data: { sku: 'TEST-SKU-IMPORT-HOLD', name: 'Import hold', basePrice: 10 } as never })).id
  const listing = async (marketplace: string, extra: Record<string, unknown> = {}) => (await prisma.channelListing.create({ data: {
    productId: ids.product, channel: 'EBAY', marketplace, region: marketplace, channelMarket: `EBAY_${marketplace}`, channelConnectionId: ebay, aliasKey: '',
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: `TEST-ITEM-${marketplace}`, followMasterQuantity: true, quantity: 5, price: 10, stockBuffer: 0, ...extra,
  } as never })).id
  // Paused from the product sheet: quantity 0 on eBay, held by Nexus.
  ids.held = await listing('IT', { quantity: 0, offerClosedAt: new Date(), offerCloseReason: 'sheet-pause', offerActive: false })
  ids.selling = await listing('DE')
}), 120_000)
afterAll(async () => { await state.db?.close() })

const row = (extra: Record<string, unknown>) => ({
  raw: 'TEST-SKU-IMPORT-HOLD', resolvedSku: 'TEST-SKU-IMPORT-HOLD', productId: ids.product, productName: 'Import hold', quantity: 5, tier: 'EXACT', candidates: [],
  currentWarehouseQty: 5, wouldBeWarehouseQty: 5, currentChannelQty: null, wouldBeChannelQty: null, channelListings: [], warnings: [], error: null,
  channel: 'EBAY', ...extra,
}) as never
const stored = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id }, select: { quantity: true, quantityOverride: true, followMasterQuantity: true, stockBuffer: true, offerClosedAt: true } })
const queued = (id: string) => prisma.outboundSyncQueue.count({ where: { channelListingId: id } })

describe('the stock import leaves a listing whose selling is paused alone', () => {
  it('Pinned: the paused listing is counted, unchanged, and gets no queued quantity; the selling one is pinned', () => scoped(async () => {
    const before = await stored(ids.held)
    const out = await applyControlColumns([row({ follow: 'Pinned' })], 'job-hold-pin')
    expect(out).toMatchObject({ pinned: 1, skippedInactive: 1 })
    expect(await stored(ids.held)).toEqual(before)
    expect(await queued(ids.held)).toBe(0)
    expect(await stored(ids.selling)).toMatchObject({ followMasterQuantity: false })
  }))

  it('Follow: the same; a sheet that names only the paused market writes nothing at all', () => scoped(async () => {
    const before = await stored(ids.held)
    expect(await applyControlColumns([row({ follow: 'Follow' })], 'job-hold-follow')).toMatchObject({ followSet: 1, skippedInactive: 1 })
    expect(await applyControlColumns([row({ follow: 'Pinned', marketplace: 'IT' })], 'job-hold-it')).toMatchObject({ pinned: 0, skippedInactive: 1 })
    expect(await stored(ids.held)).toEqual(before)
    expect(await queued(ids.held)).toBe(0)
    expect(await stored(ids.selling)).toMatchObject({ followMasterQuantity: true })
  }))
})
