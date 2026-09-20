/**
 * P1.7 — no Amazon CONTENT write without Amazon's own dry run (`mode=VALIDATION_PREVIEW`). The rule
 * itself (which payloads are content, and what a refusal says), and the two writers that are cheapest to
 * drive: the batch feed (images are content; price, stock and status are not) and the listing wizard's
 * full PUT. The preview is stubbed; `submitted` records what would have gone out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  previews: [] as any[],
  answer: { ok: true, available: true, errors: null as string | null },
  feedCalls: [] as string[],
}))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({
  amazonSpApiClient: {
    validateListing: vi.fn(async (options: any) => { h.previews.push(options); return { ...h.answer, warnings: [] } }),
    putListingsItem: vi.fn(async () => { h.feedCalls.push('putListingsItem'); return { success: true } }),
  },
}))
vi.mock('../listing-push-controls.js', () => ({ readPushControls: vi.fn(async () => []) }))
vi.mock('../amazon-market-offer.service.js', () => ({ closedMarketSet: vi.fn(async () => new Set<string>()) }))
vi.mock('../../lib/amazon-sp-client.js', () => ({
  amazonSpClient: () => ({ callAPI: vi.fn(async ({ operation }: any) => { h.feedCalls.push(operation); return operation === 'createFeedDocument' ? { feedDocumentId: 'doc', url: 'https://fixture.invalid/upload' } : { feedId: 'feed' } }) }),
}))

import { amazonContentRefusal, isAmazonContentPatchSet } from './validate-before-send.js'
import { submitAmazonListingsBatch } from '../channel-batch/amazon-batch-feed.service.js'

const imageOp = { type: 'image' as const, sku: 'SKU-1', productType: 'JACKET', slots: [{ slot: 'MAIN', url: 'https://cdn.example/a.jpg' }] }
const batch = (operations: any[]) => submitAmazonListingsBatch({ sellerId: 'seller', marketplaceIds: ['APJ6JRA9NG5V4'], operations })

beforeEach(() => {
  h.previews = []; h.feedCalls = []; h.answer = { ok: true, available: true, errors: null }
  vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH', 'true'); vi.stubEnv('AMAZON_PUBLISH_MODE', 'live'); vi.stubEnv('NEXUS_AMAZON_BATCH_DRYRUN', '0')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('P1.7 — which payloads are content', () => {
  it.each([
    [[{ op: 'replace', path: '/attributes/purchasable_offer', value: 1 }], false],
    [[{ op: 'replace', path: '/attributes/list_price', value: 1 }], false],
    [[{ op: 'replace', path: '/attributes/fulfillment_availability', value: 1 }], false],
    [[{ op: 'replace', path: '/attributes/purchasable_offer/0/our_price', value: 1 }], false],
    [[{ op: 'replace', path: '/attributes/item_name', value: 'x' }], true],
    [[{ op: 'replace', path: '/attributes/main_product_image_locator', value: 'x' }], true],
    [[{ op: 'replace', path: '/attributes/purchasable_offer', value: 1 }, { op: 'replace', path: '/attributes/bullet_point', value: 'x' }], true],
  ])('%j → content: %s', (patches, expected) => {
    expect(isAmazonContentPatchSet(patches as any)).toBe(expected)
  })
  it('no patches at all is not a content patch set', () => {
    expect(isAmazonContentPatchSet([])).toBe(false)
    expect(isAmazonContentPatchSet(undefined)).toBe(false)
  })
})

describe('P1.7 — what a refusal says', () => {
  const input = { sellerId: 's', sku: 'SKU-1', marketplaceId: 'IT', productType: 'JACKET', attributes: {} }
  it('Amazon accepts: no refusal, and the preview carried the same body', async () => {
    expect(await amazonContentRefusal(input)).toBeNull()
    expect(h.previews).toEqual([input])
  })
  it('Amazon refuses the content: the sentence names the SKU and Amazon\'s reason', async () => {
    h.answer = { ok: false, available: true, errors: 'Item specific Size is missing' }
    expect(await amazonContentRefusal(input)).toMatch(/SKU-1.*Item specific Size is missing.*Nothing was submitted/)
  })
  it('the preview cannot run: fail-closed, nothing is submitted', async () => {
    h.answer = { ok: true, available: false, errors: null }
    expect(await amazonContentRefusal(input)).toMatch(/validation is unavailable for SKU-1/)
  })
})

describe('P1.7 — the Amazon batch feed', () => {
  it('DONE-WHEN: an image message is previewed before the feed document is created', async () => {
    await batch([imageOp])
    expect(h.previews).toHaveLength(1)
    expect(h.previews[0]).toMatchObject({ sellerId: 'seller', sku: 'SKU-1', productType: 'JACKET', marketplaceId: 'APJ6JRA9NG5V4' })
    expect(h.previews[0].patches?.length).toBeGreaterThan(0)
    expect(h.feedCalls).toEqual(['createFeedDocument', 'createFeed'])
  })
  it('Amazon refuses the images: no document, no upload, no feed', async () => {
    h.answer = { ok: false, available: true, errors: 'Invalid image locator' }
    await expect(batch([imageOp])).rejects.toMatchObject({ code: 'AMAZON_PREVIEW_REFUSED' })
    expect(h.feedCalls).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })
  it('price, stock and status messages are not content: no preview, the feed still goes', async () => {
    await batch([
      { type: 'price', sku: 'SKU-1', currency: 'EUR', value: 9.9 },
      { type: 'stock', sku: 'SKU-1', quantity: 2 },
      { type: 'status', sku: 'SKU-1', status: 'ACTIVE' },
    ])
    expect(h.previews).toHaveLength(0)
    expect(h.feedCalls).toEqual(['createFeedDocument', 'createFeed'])
  })
  it('one refused image in a mixed feed stops the whole submission', async () => {
    h.answer = { ok: false, available: true, errors: 'Invalid image locator' }
    await expect(batch([{ type: 'price', sku: 'SKU-1', currency: 'EUR', value: 9.9 }, imageOp])).rejects.toThrow(/Invalid image locator/)
    expect(h.feedCalls).toEqual([])
  })
})
