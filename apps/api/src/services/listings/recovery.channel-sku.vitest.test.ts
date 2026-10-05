/**
 * S3 (per-channel SKU) — listing recovery on Amazon names the seller SKU Amazon holds for THIS listing (the product SKU
 * for a listing with none of its own, as before), and a "new SKU" recovery gives the listing its own SKU instead of
 * renaming the product (the Owner's rule, 2026-10-05: a SKU change for one channel and market belongs to that listing).
 * Real schema and tenant policies (PGlite); the Amazon delete is a stand-in, nothing reaches Amazon.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ database: null as any, remove: vi.fn() }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = await formulaDatabase()
  return { default: fixture.database.client, prisma: fixture.database.client }
})
vi.mock('../../lib/amazon-sp-client.js', async (original) => ({ ...(await original<object>()), getAmazonSellerId: async () => 'TEST-SELLER' }))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { deleteListingsItem: fixture.remove } }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { executeRecovery, previewRecovery } from './recovery.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let account = ''

async function seed(sku: string, data: Record<string, unknown> = {}, channel = 'AMAZON') {
  const product = await prisma.product.create({ data: { sku, name: sku, basePrice: 10 } as never })
  const marketplace = channel === 'AMAZON' ? 'IT' : 'GLOBAL'
  const listing = await prisma.channelListing.create({ data: {
    productId: product.id, channel, marketplace, region: marketplace, channelMarket: `${channel}_${marketplace}`, channelConnectionId: account, aliasKey: '',
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0RECOVER', ...data,
  } as never })
  return { productId: product.id, listingId: listing.id, coordinate: { productId: product.id, channel, marketplace, channelConnectionId: account, aliasKey: '' } }
}

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'APJ6JRA9NG5V4' } as never })
    account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'recovery-amazon', isActive: true, isPrimary: true } as never })).id
  })
}, 120_000)
afterAll(async () => { await fixture.database?.close() })

describe('preview — the SKU Amazon holds for this listing', () => {
  it('parity: a listing with no SKU of its own shows the product SKU', () => scoped(async () => {
    const { coordinate } = await seed('REC-PLAIN')
    const preview = await previewRecovery({ ...coordinate, action: 'DELETE_RELIST_SAME' })
    expect(preview.before.sku).toBe('REC-PLAIN')
    expect(preview.consequences.blockers).toEqual([])
  }))

  it('a listing with its own seller SKU shows that SKU, and a new SKU equal to it is refused as "the same SKU"', () => scoped(async () => {
    const { coordinate } = await seed('REC-OWN-P', { liveChannelSku: 'REC-OWN-IT' })
    expect((await previewRecovery({ ...coordinate, action: 'DELETE_RELIST_SAME' })).before.sku).toBe('REC-OWN-IT')
    expect((await previewRecovery({ ...coordinate, action: 'SAME_ASIN_NEW_SKU', newSku: 'REC-OWN-IT' })).consequences.blockers)
      .toContain('newSku "REC-OWN-IT" matches the current SKU. Pick the appropriate "same SKU" action instead.')
  }))

  it('two seller SKUs on record block a delete (Nexus cannot tell which one Amazon holds); republish in place is not blocked', () => scoped(async () => {
    const { coordinate } = await seed('REC-TWO', { platformAttributes: { sellerSku: 'TWO-1' }, flatFileSnapshot: { item_sku: 'TWO-2' } })
    expect((await previewRecovery({ ...coordinate, action: 'DELETE_RELIST_SAME' })).consequences.blockers)
      .toContain('REC-TWO: conflicting Amazon seller SKUs. Reconcile this listing\'s identity before publishing. Nothing was sent.')
    expect((await previewRecovery({ ...coordinate, action: 'REPUBLISH_IN_PLACE' })).consequences.blockers).toEqual([])
  }))

  it('a new SKU Nexus cannot store is refused before anything is deleted', () => scoped(async () => {
    const { coordinate } = await seed('REC-BAD')
    expect((await previewRecovery({ ...coordinate, action: 'SAME_ASIN_NEW_SKU', newSku: 'has space' })).consequences.blockers)
      .toContain('newSku "has space": Use only letters, numbers, dots (.), hyphens (-) and underscores (_). No spaces.')
  }))

  it('another channel keeps the product SKU (no delete there)', () => scoped(async () => {
    const { coordinate } = await seed('REC-SHOP', { platformAttributes: { sku: 'SHOP-OWN' } }, 'SHOPIFY')
    expect((await previewRecovery({ ...coordinate, action: 'REPUBLISH_IN_PLACE' })).before.sku).toBe('REC-SHOP')
  }))
})

describe('execute — the delete names the held SKU; a new SKU becomes the listing\'s own', () => {
  it('parity: DELETE_RELIST_SAME deletes the product SKU and leaves the product as it was', () => scoped(async () => {
    const { coordinate, listingId, productId } = await seed('REC-SAME')
    fixture.remove.mockReset().mockResolvedValue({ success: true, submissionId: 'sub-1' })
    expect(await executeRecovery({ ...coordinate, action: 'DELETE_RELIST_SAME' })).toMatchObject({ status: 'SUCCEEDED' })
    expect(fixture.remove).toHaveBeenCalledExactlyOnceWith({ sellerId: 'TEST-SELLER', sku: 'REC-SAME', marketplaceId: 'APJ6JRA9NG5V4' })
    expect(await prisma.product.findUnique({ where: { id: productId }, select: { sku: true } })).toEqual({ sku: 'REC-SAME' })
    expect(await prisma.channelListing.findUnique({ where: { id: listingId }, select: { listingStatus: true, channelSku: true, liveChannelSku: true } }))
      .toEqual({ listingStatus: 'ENDED', channelSku: null, liveChannelSku: null })
  }), 20_000)

  it('SAME_ASIN_NEW_SKU deletes the SKU Amazon holds, clears it, and gives THIS listing the new SKU (the product SKU stays)', () => scoped(async () => {
    const { coordinate, listingId, productId } = await seed('REC-NEW-P', { channelSku: 'REC-NEW-OLD', liveChannelSku: 'REC-NEW-OLD' })
    fixture.remove.mockReset().mockResolvedValue({ success: true, submissionId: 'sub-2' })
    expect(await executeRecovery({ ...coordinate, action: 'SAME_ASIN_NEW_SKU', newSku: 'REC-NEW-IT' })).toMatchObject({ status: 'SUCCEEDED', completedSteps: expect.arrayContaining(['renamed_sku']) })
    expect(fixture.remove).toHaveBeenCalledExactlyOnceWith({ sellerId: 'TEST-SELLER', sku: 'REC-NEW-OLD', marketplaceId: 'APJ6JRA9NG5V4' })
    expect(await prisma.product.findUnique({ where: { id: productId }, select: { sku: true } })).toEqual({ sku: 'REC-NEW-P' })
    expect(await prisma.channelListing.findUnique({ where: { id: listingId }, select: { listingStatus: true, externalListingId: true, channelSku: true, liveChannelSku: true } }))
      .toEqual({ listingStatus: 'ENDED', externalListingId: 'B0RECOVER', channelSku: 'REC-NEW-IT', liveChannelSku: null })
    // The audit row records the SKUs on both sides.
    expect(await prisma.listingRecoveryEvent.findFirst({ where: { productId }, select: { oldSku: true, newSku: true } })).toEqual({ oldSku: 'REC-NEW-OLD', newSku: 'REC-NEW-IT' })
  }), 20_000)
})
