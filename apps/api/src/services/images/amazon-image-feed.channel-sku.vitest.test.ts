/**
 * S3 (per-channel SKU) — the Amazon image feed names, per variation, the seller SKU Amazon holds for its listing on this
 * market (the product SKU for a listing with none of its own, as before). The job keeps the product SKUs (the result
 * poll reads Amazon's report by them), and the push-lock read is told the products. Real schema and tenant policies
 * (PGlite); the feed submission is a stand-in, nothing reaches Amazon. A listing whose seller SKU cannot be told is left
 * out with the reason; the rest of the feed is sent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ database: null as any, submit: vi.fn() }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = await formulaDatabase()
  return { default: fixture.database.client, prisma: fixture.database.client }
})
vi.mock('../channel-batch/amazon-batch-feed.service.js', async (original) => ({
  ...(await original<object>()),
  submitAmazonListingsBatch: async (input: unknown) => { fixture.submit(input); return { feedId: 'feed-1', feedDocumentId: 'doc-1', messageCount: 1, dryRun: true } },
}))
vi.mock('./amazon-slot-taxonomy.service.js', async (original) => {
  const actual = await original<typeof import('./amazon-slot-taxonomy.service.js')>()
  return { ...actual, resolveSlotTaxonomy: async () => actual.fallbackTaxonomy() }
})
vi.mock('../../lib/amazon-sp-client.js', async (original) => ({ ...(await original<object>()), getAmazonSellerId: async () => 'TEST-SELLER', amazonAccount: async () => null }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { submitAmazonImageFeed } from './amazon-image-feed.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let account = ''

async function family(prefix: string, children: Array<{ size: string; listing?: Record<string, unknown> | null }>) {
  const root = await prisma.product.create({ data: { sku: prefix, name: prefix, basePrice: 10, isParent: true, productType: 'COAT' } as never })
  const ids: Record<string, string> = {}
  for (const child of children) {
    const p = await prisma.product.create({ data: { sku: `${prefix}-${child.size}`, name: `${prefix} ${child.size}`, basePrice: 10, parentId: root.id, amazonAsin: `B0${prefix}${child.size}` } as never })
    ids[child.size] = p.id
    if (child.listing !== null) await prisma.channelListing.create({ data: {
      productId: p.id, channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', channelConnectionId: account, aliasKey: '',
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `B0${prefix}${child.size}`, ...(child.listing ?? {}),
    } as never })
  }
  // One product-level MAIN image for every variation.
  await prisma.listingImage.create({ data: { productId: root.id, scope: 'GLOBAL', url: `https://example.invalid/${prefix}.jpg`, position: 0, amazonSlot: 'MAIN', mediaType: 'IMAGE' } as never })
  return { root: root.id, ids }
}

beforeAll(async () => {
  await scoped(async () => {
    account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'image-feed-amazon', isActive: true, isPrimary: true } as never })).id
  })
}, 120_000)
beforeEach(() => { fixture.submit.mockReset() })
afterAll(async () => { await fixture.database?.close() })

describe('the image feed names each listing\'s seller SKU', () => {
  it('own SKU for a listing that has one, the product SKU otherwise (and for a variation with no listing here)', () => scoped(async () => {
    const f = await family('IMGA', [{ size: 'S', listing: { liveChannelSku: 'IMGA-S-IT' } }, { size: 'M' }, { size: 'L', listing: null }])
    const out = await submitAmazonImageFeed({ productId: f.root, marketplace: 'IT', mode: 'additive' })
    const input = fixture.submit.mock.calls[0][0]
    expect(input.operations.map((op: { sku: string }) => op.sku)).toEqual(['IMGA-L', 'IMGA-M', 'IMGA-S-IT'])
    // The job and the result keep the product SKUs: Amazon's report is read back by them.
    expect(out.skus).toEqual(['IMGA-L', 'IMGA-M', 'IMGA-S'])
    expect(await prisma.amazonImageFeedJob.findUnique({ where: { id: out.jobId }, select: { skus: true } })).toEqual({ skus: ['IMGA-L', 'IMGA-M', 'IMGA-S'] })
    // The push-lock read is told the products with a listing here.
    expect([...input.productIds].sort()).toEqual([f.ids.M, f.ids.S].sort())
    expect(out.skippedSkuConflicts).toEqual([])
  }))

  it('parity: no listing has a SKU of its own → every message names the product SKU', () => scoped(async () => {
    const f = await family('IMGB', [{ size: 'S' }, { size: 'M', listing: { platformAttributes: { sellerSku: 'IMGB-M' } } }])
    await submitAmazonImageFeed({ productId: f.root, marketplace: 'IT', mode: 'additive' })
    expect(fixture.submit.mock.calls[0][0].operations.map((op: { sku: string }) => op.sku)).toEqual(['IMGB-M', 'IMGB-S'])
  }))

  it('two seller SKUs on record → only that variation is left out, with the reason; the normal one is sent', () => scoped(async () => {
    const f = await family('IMGC', [{ size: 'S' }, { size: 'M', listing: { platformAttributes: { sellerSku: 'C-1' }, flatFileSnapshot: { item_sku: 'C-2' } } }])
    const out = await submitAmazonImageFeed({ productId: f.root, marketplace: 'IT', mode: 'additive' })
    expect(fixture.submit).toHaveBeenCalledOnce()
    expect(fixture.submit.mock.calls[0][0].operations.map((op: { sku: string }) => op.sku)).toEqual(['IMGC-S'])
    expect(out.skus).toEqual(['IMGC-S'])
    expect(out.skippedSkuConflicts).toEqual([{ sku: 'IMGC-M', reason: 'IMGC-M: conflicting Amazon seller SKUs. Reconcile this listing\'s identity before publishing. Nothing was sent.' }])
    // Not reported as anything it is not.
    expect(out.skippedNoImages).toEqual([])
    expect(out.skippedNoAsin).toEqual([])
  }))

  it('every variation in conflict → nothing is sent, and the job row says why', () => scoped(async () => {
    const f = await family('IMGD', [{ size: 'S', listing: { platformAttributes: { sellerSku: 'D-1' }, flatFileSnapshot: { item_sku: 'D-2' } } }])
    const out = await submitAmazonImageFeed({ productId: f.root, marketplace: 'IT', mode: 'additive' })
    expect(fixture.submit).not.toHaveBeenCalled()
    expect(out).toMatchObject({ feedId: null, skus: [], skippedSkuConflicts: [{ sku: 'IMGD-S', reason: expect.stringMatching(/^IMGD-S: conflicting Amazon seller SKUs/) }] })
    expect(await prisma.amazonImageFeedJob.findUnique({ where: { id: out.jobId }, select: { status: true, errorMessage: true } })).toEqual({ status: 'DONE',
      errorMessage: 'Nothing was sent. Skipped no-ASIN: [], no-images: [], no single seller SKU: [IMGD-S]. IMGD-S: conflicting Amazon seller SKUs. Reconcile this listing\'s identity before publishing. Nothing was sent.' })
  }))
})
