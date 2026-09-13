/**
 * D7 (R-LX-7, on LX.R's P0-2) — the one review verdict, proved once per path.
 *
 * Before this lane the verdict lived inside the Amazon payload builder: an AI
 * draft (`source: 'ai'`, `reviewedAt: null`) was refused for Amazon and
 * published live by the eBay / Shopify / Woo drain. The arm that fires today is
 * the drain arm, so it is measured here with its positive control (a reviewed
 * row reaches the channel method).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const db = vi.hoisted(() => ({
  product: { findFirst: vi.fn() },
  channelListing: { findUnique: vi.fn(), findFirst: vi.fn() },
  productTranslation: { findMany: vi.fn() },
  marketplace: { findFirst: vi.fn() },
}))
vi.mock('../../db.js', () => ({ default: db }))
vi.mock('@nexus/database', () => ({ default: db, PrismaClient: class {} }))

import { assertListingContentReviewed, requireReviewedContent, ContentReviewRequired } from './publish-review-gate.js'

const draftRow = { language: 'de', name: 'Deutscher KI-Titel', description: 'KI', source: 'ai', reviewedAt: null }
const reviewedRow = { ...draftRow, reviewedAt: new Date('2026-09-12T00:00:00Z') }

const product = (translations: unknown[]) => ({ id: 'product', parentId: null, name: 'Giacca', description: 'Descrizione', translations, parent: null })

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.NEXUS_REQUIRE_REVIEWED_CONTENT
  db.marketplace.findFirst.mockImplementation(async ({ where }: any) => ({ languages: where.code === 'BE' ? ['nl', 'fr'] : where.code === 'DE' ? ['de'] : ['en'] }))
  db.channelListing.findUnique.mockResolvedValue(null)
  db.channelListing.findFirst.mockResolvedValue(null)
  db.productTranslation.findMany.mockResolvedValue([])
})
afterEach(() => { delete process.env.NEXUS_REQUIRE_REVIEWED_CONTENT })

describe('the one verdict', () => {
  it('refuses an unreviewed machine draft and names the language', async () => {
    db.product.findFirst.mockResolvedValue(product([draftRow]))
    await expect(assertListingContentReviewed({ productId: 'product', channel: 'EBAY', marketplace: 'DE' }))
      .rejects.toThrow('Review the German (de) title before publishing.')
    await expect(assertListingContentReviewed({ productId: 'product', channel: 'EBAY', marketplace: 'DE' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'content_review_required' })
  })

  it('POSITIVE CONTROL — the same row, reviewed, publishes', async () => {
    db.product.findFirst.mockResolvedValue(product([reviewedRow]))
    await expect(assertListingContentReviewed({ productId: 'product', channel: 'EBAY', marketplace: 'DE' })).resolves.toBeUndefined()
  })

  it('a product that does not exist is not refused', async () => {
    db.product.findFirst.mockResolvedValue(null)
    await expect(assertListingContentReviewed({ sku: 'missing', channel: 'EBAY', marketplace: 'DE' })).resolves.toBeUndefined()
  })

  it('requireReviewed is a real setting with a reader, default ON', async () => {
    expect(requireReviewedContent()).toBe(true)
    db.product.findFirst.mockResolvedValue(product([draftRow]))
    process.env.NEXUS_REQUIRE_REVIEWED_CONTENT = '0'
    expect(requireReviewedContent()).toBe(false)
    await expect(assertListingContentReviewed({ productId: 'product', channel: 'EBAY', marketplace: 'DE' })).resolves.toBeUndefined()
    expect(db.product.findFirst).not.toHaveBeenCalled()
  })

  it('fails CLOSED when the authority cannot name the destination languages', async () => {
    db.product.findFirst.mockResolvedValue(product([draftRow]))
    db.marketplace.findFirst.mockResolvedValue({ languages: [] }) // marketLanguages throws
    db.productTranslation.findMany.mockResolvedValue([{ language: 'de' }])
    await expect(assertListingContentReviewed({ productId: 'product', channel: 'ETSY', marketplace: 'GLOBAL' }))
      .rejects.toThrow('Review the German (de) content before publishing.')
    // POSITIVE CONTROL for the same branch: no drafts in the family → publishes.
    db.productTranslation.findMany.mockResolvedValue([])
    await expect(assertListingContentReviewed({ productId: 'product', channel: 'ETSY', marketplace: 'GLOBAL' })).resolves.toBeUndefined()
  })

  it('strips eBay marketplace ids (EBAY_IT) before asking the authority', async () => {
    db.product.findFirst.mockResolvedValue(product([reviewedRow]))
    await expect(assertListingContentReviewed({ productId: 'product', channel: 'EBAY', marketplace: 'EBAY_DE' })).resolves.toBeUndefined()
    expect(db.marketplace.findFirst.mock.calls[0][0].where).toMatchObject({ channel: 'EBAY', code: 'DE' })
  })
})

describe('the queue drain — the path that published unreviewed copy before R-LX-7', () => {
  const listing = { id: 'listing', productId: 'product', channel: 'EBAY', marketplace: 'DE', languages: ['de'], translations: [] }
  const item = { id: 'queue-1', productId: 'product', channelListingId: 'listing', targetChannel: 'EBAY',
    payload: { title: 'Deutscher KI-Titel', description: 'KI' } }

  it('refuses terminally, and the channel method is never reached', async () => {
    db.product.findFirst.mockResolvedValue(product([draftRow]))
    db.channelListing.findUnique.mockResolvedValue(listing)
    const service = (await import('../outbound-sync.service.js')).default as any
    const ebay = vi.fn(async () => ({ success: true, queueId: item.id, channel: 'EBAY', status: 'SUCCESS', message: 'pushed' }))
    service.syncToEbay = ebay
    const result = await service.dispatchSync(item)
    expect(result).toMatchObject({ success: false, status: 'FAILED', errorCode: 'CONTENT_REVIEW_REQUIRED', retryable: false })
    // Both content fields the payload carried are named, in the publish wording.
    expect(result.message).toBe('Review the German (de) title before publishing. Review the German (de) description before publishing.')
    expect(ebay).not.toHaveBeenCalled()
  })

  it('POSITIVE CONTROL — a reviewed row reaches the channel method, and a text-free payload is never gated', async () => {
    db.product.findFirst.mockResolvedValue(product([reviewedRow]))
    db.channelListing.findUnique.mockResolvedValue(listing)
    const service = (await import('../outbound-sync.service.js')).default as any
    const ebay = vi.fn(async () => ({ success: true, queueId: item.id, channel: 'EBAY', status: 'SUCCESS', message: 'pushed' }))
    service.syncToEbay = ebay
    expect(await service.dispatchSync(item)).toMatchObject({ success: true })
    expect(ebay).toHaveBeenCalledTimes(1)

    db.product.findFirst.mockClear()
    expect(await service.dispatchSync({ ...item, payload: { price: 42, quantity: 3 } })).toMatchObject({ success: true })
    expect(db.product.findFirst).not.toHaveBeenCalled()
  })
})

describe('the fourth eBay direct push (pushVariationGroup)', () => {
  const rows = [{ sku: 'GALE-JACKET', _isParent: true }]
  const push = async () => {
    const { pushVariationGroup } = await import('../ebay-variation-push.service.js')
    return pushVariationGroup('group', rows as any, 'DE', 'token', 'connection', {}, 'https://api.ebay.test', 'EBAY_DE')
  }
  beforeEach(() => {
    // The presentation assert runs first and reads these two.
    db.channelListing.findMany = vi.fn().mockResolvedValue([])
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('PROVIDER FORBIDDEN') }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('refuses an unreviewed draft before anything downstream runs', async () => {
    db.product.findFirst.mockResolvedValue(product([draftRow]))
    await expect(push()).rejects.toThrow('Review the German (de) title before publishing.')
  })

  it('POSITIVE CONTROL — the reviewed row gets past the gate', async () => {
    db.product.findFirst.mockResolvedValue(product([reviewedRow]))
    // Whatever it fails on next, it is no longer the review verdict: the gate let it through.
    await expect(push()).rejects.toThrow()
    await push().catch((error: Error) => expect(error.message).not.toContain('before publishing'))
  })
})

describe('every named publish path consults the one function', () => {
  // R-LX-7's list, verbatim. This is a set claim about the gate's coverage, so
  // each member is read from source and the two text-free paths are measured
  // rather than exempted by assertion.
  const gated = [
    ['Amazon payload builder', 'apps/api/src/services/pim/amazon-content-payload.ts', 'assertContentReviewed'],
    ['the queue drain (every channel)', 'apps/api/src/services/outbound-sync.service.ts', 'assertListingContentReviewed'],
    ['eBay draft publish', 'apps/api/src/services/ebay-publish.service.ts', 'assertListingContentReviewed'],
    ['eBay shared listing push', 'apps/api/src/services/ebay-shared-listing-push.service.ts', 'assertListingContentReviewed'],
    ['eBay wizard adapter', 'apps/api/src/services/listing-wizard/ebay-publish.adapter.ts', 'assertListingContentReviewed'],
    ['eBay variation group push', 'apps/api/src/services/ebay-variation-push.service.ts', 'assertListingContentReviewed'],
    ['Shopify content sync', 'apps/api/src/services/shopify/content-sync.service.ts', 'assertListingContentReviewed'],
    ['content auto-publish', 'apps/api/src/services/content-auto-publish.service.ts', 'assertListingContentReviewed'],
    ['the publish route + preflight', 'apps/api/src/routes/marketplaces.routes.ts', 'publishContentIssues'],
  ] as const
  it.each(gated)('%s calls %s', (_name, file, symbol) => {
    const source = readFileSync(new URL(`../../../../../${file}`, import.meta.url), 'utf8')
    expect(source.includes(`${symbol}(`)).toBe(true)
  })

  it('the two paths with no gate carry no localized text (measured, not assumed)', () => {
    const images = readFileSync(new URL('../../../../../apps/api/src/services/channel-publish.service.ts', import.meta.url), 'utf8')
    // MC.12 image publish: its input is an asset URL + destination id.
    expect(/\b(title|description|bulletPoints|keywords)\s*[?:]/.test(images)).toBe(false)
    const syndication = readFileSync(new URL('../../../../../apps/api/src/routes/listings-syndication.routes.ts', import.meta.url), 'utf8')
    const enqueued = [...syndication.matchAll(/syncType:\s*'([A-Z_]+)'/g)].map(match => match[1])
    expect([...new Set(enqueued)].sort()).toEqual(['PRICE_UPDATE', 'QUANTITY_UPDATE'])
  })
})

it('the refusal carries the publish sentence verbatim', () => {
  const error = new ContentReviewRequired([{ language: 'nl', field: 'description', severity: 'ERROR', message: 'Review the Dutch (nl) description before publishing.' }])
  expect(error.message).toBe('Review the Dutch (nl) description before publishing.')
  expect(error.statusCode).toBe(422)
})
