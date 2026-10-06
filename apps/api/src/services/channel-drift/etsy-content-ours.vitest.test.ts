import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * E5a — "ours" for one Etsy listing comes from the publisher itself, on the listing's main row only, with Etsy never read
 * here; the photo count is the media plan's Etsy gallery. The facts reader, the publisher and the media plan are mocked.
 * Fake ids only: listing `9000000001`.
 */
const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  facts: vi.fn(),
  prepare: vi.fn(),
  layout: vi.fn(),
  cachedOnly: [] as boolean[],
}))
vi.mock('../../db.js', () => ({ default: { channelListing: { findUnique: vi.fn(async () => h.row) } } }))
vi.mock('../pim/studio-publication-plan.js', () => ({ readPublicationFacts: async (...args: unknown[]) => {
  const { cachedSchemasOnly } = await import('../pim/cached-schema-context.js')
  h.cachedOnly.push(cachedSchemasOnly())
  return h.facts(...args)
} }))
vi.mock('../pim/studio-publication-etsy.js', () => ({ prepareEtsyPublication: (...args: unknown[]) => h.prepare(...args) }))
vi.mock('../images/media-plan.service.js', () => ({ mediaLayoutFor: (...args: unknown[]) => h.layout(...args) }))

import { etsyContentOurs, etsyNexusPhotoCount, ETSY_NOT_ON_MEDIA_PLAN } from './etsy-content-ours.js'

const MAIN = { id: 'cl-1', productId: 'prod-1', marketplace: 'GLOBAL', channelConnectionId: 'acc-etsy', externalListingId: '9000000001',
  product: { parentId: null, deletedAt: null } }
const FACTS = { languages: ['en'] }

beforeEach(() => {
  h.row = { ...MAIN }
  h.cachedOnly = []
  h.facts.mockReset().mockImplementation(async () => FACTS)
  h.prepare.mockReset().mockImplementation(async () => ({ kind: 'etsy', listingId: '9000000001' }))
  h.layout.mockReset().mockImplementation(async () => ({ layout: { images: ['a1', 'a2', 'a3'], videos: [], variationImages: [], cut: [], checks: [] } }))
})

describe('etsyContentOurs', () => {
  it('the main row: the facts of its own coordinate, read on cached schemas, and the publisher with a reader that never reads', async () => {
    const result = await etsyContentOurs('cl-1')
    expect(result).toEqual({ ok: true, facts: FACTS, publication: { kind: 'etsy', listingId: '9000000001' } })
    expect(h.facts).toHaveBeenCalledWith('prod-1', { channel: 'ETSY', marketplace: 'GLOBAL', accountId: 'acc-etsy', listingId: 'cl-1' })
    expect(h.cachedOnly).toEqual([true])
    const [facts, options] = h.prepare.mock.calls[0] as [unknown, { readLive: () => Promise<unknown>; createState?: unknown }]
    expect(facts).toBe(FACTS)
    await expect(options.readLive()).rejects.toThrow('not read here')
  })

  it.each([
    ['the row is gone', null, 'the listing or its product no longer exists'],
    ['its product is deleted', { ...MAIN, product: { parentId: null, deletedAt: new Date() } }, 'the listing or its product no longer exists'],
    ['a variation\'s row', { ...MAIN, product: { parentId: 'prod-0', deletedAt: null } }, 'not the Etsy listing\'s main row'],
    ['no Listing ID', { ...MAIN, externalListingId: null }, 'the listing has no Etsy Listing ID or no account'],
    ['no account', { ...MAIN, channelConnectionId: null }, 'the listing has no Etsy Listing ID or no account'],
  ])('%s → not compared, and the publisher is never asked', async (_name, row, reason) => {
    h.row = row as Record<string, unknown> | null
    expect(await etsyContentOurs('cl-1')).toEqual({ ok: false, reason })
    expect(h.prepare).not.toHaveBeenCalled()
  })

  it('the review targets another listing → not compared, saying which', async () => {
    h.prepare.mockImplementation(async () => ({ kind: 'etsy', listingId: '9000000002' }))
    expect(await etsyContentOurs('cl-1')).toEqual({ ok: false, reason: 'the review targets Etsy listing 9000000002, not 9000000001' })
  })

  it('the publisher refuses → not compared with its sentence', async () => {
    h.prepare.mockRejectedValue(new Error('Title is empty. Fill it in on the main row.'))
    expect(await etsyContentOurs('cl-1')).toEqual({ ok: false, reason: 'the Etsy review refused: Title is empty. Fill it in on the main row.' })
  })
})

describe('etsyNexusPhotoCount', () => {
  const owner = { productId: 'prod-1', channelConnectionId: 'acc-etsy', aliasKey: '' }

  it('counts the Etsy gallery the media plan lays out for this listing', async () => {
    expect(await etsyNexusPhotoCount(owner)).toEqual({ count: 3 })
    expect(h.layout).toHaveBeenCalledWith({ productId: 'prod-1', channel: 'ETSY', marketplace: 'GLOBAL', accountId: 'acc-etsy', aliasKey: '' })
  })

  it('a family not on the media plan has no Etsy photo list; a refusal is its reason', async () => {
    h.layout.mockImplementation(async () => null)
    expect(await etsyNexusPhotoCount(owner)).toEqual({ count: null, reason: ETSY_NOT_ON_MEDIA_PLAN })
    h.layout.mockRejectedValue(new Error('This listing is not one of the product\'s photo destinations yet. Reload the Media page.'))
    expect(await etsyNexusPhotoCount(owner)).toEqual({ count: null, reason: 'This listing is not one of the product\'s photo destinations yet. Reload the Media page.' })
  })
})
