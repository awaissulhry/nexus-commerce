import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({
  marketplace: { findFirst: vi.fn() },
  amazonPut: vi.fn(() => { throw new Error('Provider call forbidden in payload tests') }),
  amazonPatch: vi.fn(() => { throw new Error('Provider call forbidden in payload tests') }),
  network: vi.fn(() => { throw new Error('Network forbidden in payload tests') }),
}))
vi.mock('../../db.js', () => ({ default: { marketplace: fixture.marketplace } }))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { putListingsItem: fixture.amazonPut, patchListingsItem: fixture.amazonPatch } }))
import { buildAmazonListingPatch, resolveAmazonMarketplaceId } from '../outbound-sync.service.js'
import { buildMarketplaceAmazonAttributes } from '../../routes/marketplaces.routes.js'
import { extractLocaleTitle } from '../../routes/listings-syndication.routes.js'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fixture.network)
  fixture.marketplace.findFirst.mockImplementation(async ({ where }) => {
    expect(where.channel).toBe('AMAZON')
    return { languages: where.code === 'BE' ? ['nl', 'fr'] : where.code === 'DE' ? ['de'] : ['en'] }
  })
})
afterEach(() => {
  expect(fixture.amazonPut).not.toHaveBeenCalled()
  expect(fixture.amazonPatch).not.toHaveBeenCalled()
  expect(fixture.network).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

describe('LX.2 real builders, no publish rehearsal', () => {
  it.each([
    { market: 'DE', language: undefined, tag: 'de_DE', resolved: 'de' },
    { market: 'BE', language: undefined, tag: 'nl_BE', resolved: 'nl' },
    { market: 'BE', language: 'fr', tag: 'fr_BE', resolved: 'fr' },
    { market: 'UK', language: undefined, tag: 'en_GB', resolved: 'en' },
  ])('$market / $tag agrees across outbound-sync, marketplaces and syndication', async ({ market, language, tag, resolved }) => {
    const content = { title: `Title ${resolved}`, description: `Description ${resolved}`, bulletPoints: ['One', 'Two'], language }
    const patch = await buildAmazonListingPatch(content, market, 'OUTERWEAR')
    const outbound = Object.fromEntries(patch.patches.map((p: any) => [p.path.replace('/attributes/', ''), p.value])) as Record<string, any[]>
    const route = await buildMarketplaceAmazonAttributes({ ...content, marketplace: market, marketplaceId: resolveAmazonMarketplaceId(market), attributes: {} })
    for (const built of [outbound, route]) {
      for (const key of ['item_name', 'product_description', 'bullet_point']) {
        expect(built[key].length).toBeGreaterThan(0)
        expect(built[key].every((entry: any) => entry.language_tag === tag)).toBe(true)
      }
      // Deliberately wrong first entry catches the old BE first-entry fallback.
      const payload = { attributes: { item_name: [{ value: 'Wrong language', language_tag: 'it_IT' }, ...built.item_name] } }
      expect(extractLocaleTitle(payload, market, resolved)).toBe(content.title)
    }
  })
  it('refuses a Belgian language outside the configured row before building outbound content', async () => {
    await expect(buildAmazonListingPatch({ title: 'Wrong', language: 'de' }, 'BE', 'OUTERWEAR')).rejects.toThrow('nl, fr')
    await expect(buildMarketplaceAmazonAttributes({ marketplace: 'BE', marketplaceId: 'BE-fixture', language: 'de', title: 'Wrong', attributes: {} })).rejects.toThrow('nl, fr')
  })
})
