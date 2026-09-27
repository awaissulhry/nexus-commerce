import { beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Images rebuild P2b — once a family's photos live in the media plan (it has a Shared layer), every older photo path
 * refuses it with one sentence instead of overwriting the photos. Real schema, real tenant policies (PGlite); the eBay
 * publish gate is opened so each path reaches its own guard, and nothing can reach a channel because the guard answers
 * first.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../ebay-publish-gate.service.js', async original => ({ ...await original<object>(), ebayWriteRefusal: () => null }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { isOnMediaPlan, MEDIA_PLAN_REFUSAL, mediaPlanProducts } from './media-plan-switch.js'
import { submitAmazonImageFeed } from './amazon-image-feed.service.js'
import { publishEbayImagesViaInventory } from './ebay-inventory-image-publish.service.js'
import { publishEbaySharedListingImages } from './ebay-shared-image-publish.service.js'
import { saveProductMedia, copyProductMedia } from './product-media.service.js'
import { saveEbayMediaGallery } from './ebay-media-workspace.service.js'
import { runScheduledImagePublishOnce } from '../../jobs/scheduled-image-publish.job.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}

beforeAll(async () => {
  await scoped(async () => {
    const product = (data: Record<string, unknown>) => prisma.product.create({ data: { basePrice: 10, name: String(data.sku), ...data } as never })
    ids.on = (await product({ sku: 'ON', isParent: true })).id
    ids.onChild = (await product({ sku: 'ON-M', parentId: ids.on })).id
    ids.off = (await product({ sku: 'OFF', isParent: true })).id
    ids.offChild = (await product({ sku: 'OFF-M', parentId: ids.off })).id
    await prisma.productMediaPlan.create({ data: { productId: ids.on, layer: 'SHARED', plan: { version: 1, sets: {} } } as never })
    // A live eBay listing, so the Trading lane's own push controls pass and the call reaches the media-plan guard.
    await prisma.channelListing.create({ data: { productId: ids.on, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'IT', listingStatus: 'ACTIVE' } as never })
    // A plan row on a lower layer alone does not switch a family: only the Shared layer does.
    await prisma.productMediaPlan.create({ data: { productId: ids.off, layer: 'CHANNEL', channel: 'EBAY', plan: { version: 1, sets: {} } } as never })
  })
}, 120_000)

describe('which families are on the media plan', () => {
  it('a Shared layer switches the whole family — parent and children — and nothing else', async () => {
    expect([...await scoped(() => mediaPlanProducts([ids.on, ids.onChild, ids.off, ids.offChild, 'missing']))].sort()).toEqual([ids.on, ids.onChild].sort())
    expect(await scoped(() => isOnMediaPlan(ids.onChild))).toBe(true)
    expect(await scoped(() => isOnMediaPlan(ids.off))).toBe(false)
  })
})

describe('older photo paths refuse a family on the media plan', () => {
  it('the legacy Amazon image feed', async () => {
    await expect(scoped(() => submitAmazonImageFeed({ productId: ids.onChild, marketplace: 'IT' }))).rejects.toThrow(MEDIA_PLAN_REFUSAL)
  })
  it('the legacy eBay Inventory image publish and the Trading shell lane', async () => {
    expect(await scoped(() => publishEbayImagesViaInventory(ids.onChild))).toMatchObject({ success: false, message: MEDIA_PLAN_REFUSAL })
    expect(await scoped(() => publishEbaySharedListingImages(ids.on))).toMatchObject({ success: false, message: MEDIA_PLAN_REFUSAL })
  })
  it('the older Product media and eBay gallery editors', async () => {
    const input = { productId: ids.onChild, scope: 'MASTER', market: 'GLOBAL', locale: 'und' } as never
    await expect(scoped(() => saveProductMedia(input, {}))).rejects.toMatchObject({ statusCode: 409, message: MEDIA_PLAN_REFUSAL })
    await expect(scoped(() => copyProductMedia(input, {}))).rejects.toMatchObject({ statusCode: 409, message: MEDIA_PLAN_REFUSAL })
    await expect(scoped(() => saveEbayMediaGallery(ids.on, {}, {} as never))).rejects.toMatchObject({ statusCode: 409, message: MEDIA_PLAN_REFUSAL })
  })
  it('a photo schedule made earlier fails with the reason instead of publishing', async () => {
    const schedule = await scoped(() => prisma.scheduledImagePublish.create({ data: { productId: ids.on, channel: 'EBAY', scheduledFor: new Date(Date.now() - 60_000) } as never }))
    await scoped(() => runScheduledImagePublishOnce())
    expect(await scoped(() => prisma.scheduledImagePublish.findUniqueOrThrow({ where: { id: schedule.id } }))).toMatchObject({ status: 'FAILED', fireError: MEDIA_PLAN_REFUSAL })
  })
  it('a family not on the plan is not refused: the Amazon feed dry run goes on and sends nothing', async () => {
    await expect(scoped(() => submitAmazonImageFeed({ productId: ids.offChild, marketplace: 'IT', dryRun: true }))).resolves.toMatchObject({ feedId: null })
  })
})
