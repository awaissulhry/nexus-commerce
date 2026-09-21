/**
 * P4.5f — the Sponsored Brands create request, against Amazon's own 4.0 OpenAPI document.
 *
 * The document was read on 2026-09-21 from
 * `d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-brands/4-0/openapi.json`
 * (583 KB, `info.version: 4.0`) — the file the JavaScript-only reference page fetches.
 *
 * Every expectation below is a field name or enum value copied from that document, not one
 * derived here. Where the types differ, they differ **in the document**, and the differences are
 * the whole reason this is built per type instead of from one template.
 */
import { describe, expect, it } from 'vitest'
import { sbAdCreateRequest } from './ads-api-client.js'

const base = {
  externalCampaignId: 'C1',
  externalAdGroupId: 'AG1',
  brandName: 'Acme',
  headline: 'Lovely mugs',
  logoAssetId: 'LOGO1',
  landingType: 'store' as const,
  asins: ['B01', 'B02'],
}

describe('P4.5f — 🔴 the four things the old request got wrong', () => {
  const { path, body } = sbAdCreateRequest({ ...base, creativeType: 'productCollection' })
  const ad = body.ads[0]

  it('1. it no longer posts to /sb/v4/ads, which accepts PUT only', () => {
    expect(path).toBe('/sb/v4/ads/productCollection')
    expect(path).not.toBe('/sb/v4/ads')
  })

  it('2. adType is gone — the field does not exist in the 4.0 document', () => {
    expect(Object.keys(ad)).not.toContain('adType')
    expect(JSON.stringify(body)).not.toContain('adType')
  })

  it('3. campaignId is gone — an ad belongs to its ad group, not to a campaign', () => {
    expect(Object.keys(ad)).not.toContain('campaignId')
    expect(ad.adGroupId).toBe('AG1')
  })

  it('4. the REQUIRED name is sent', () => {
    // CreateProductCollectionAd.required = [adGroupId, creative, landingPage, name, state]
    expect(ad.name).toBe('Lovely mugs')
  })

  it('every required field of CreateProductCollectionAd is present, derived from the document', () => {
    for (const required of ['adGroupId', 'creative', 'landingPage', 'name', 'state']) {
      expect(Object.keys(ad)).toContain(required)
    }
  })
})

describe('P4.5f — the shapes genuinely differ per type', () => {
  it('productCollection: landingPage beside the creative, headline called "headline"', () => {
    const { body } = sbAdCreateRequest({ ...base, creativeType: 'productCollection' })
    const ad = body.ads[0] as { creative: Record<string, unknown>; landingPage?: unknown }
    expect(ad.landingPage).toEqual({ pageType: 'STORE' })
    expect(ad.creative).toEqual({ brandName: 'Acme', headline: 'Lovely mugs', brandLogoAssetID: 'LOGO1', asins: ['B01', 'B02'] })
    expect(ad.creative.landingPage).toBeUndefined()
  })

  it('🔴 manualCollection: landingPage INSIDE the creative, and the headline is called "title"', () => {
    // CreateManualCollectionAd.required = [adGroupId, creative, name, state] — no landingPage.
    // CreateManualCollectionCreative has `landingPage` and `title`, and requires `asins`.
    const { path, body } = sbAdCreateRequest({ ...base, creativeType: 'manualCollection' })
    const ad = body.ads[0] as { creative: Record<string, unknown>; landingPage?: unknown }
    expect(path).toBe('/sb/v4/ads/manualCollection')
    expect(ad.landingPage).toBeUndefined()
    expect(ad.creative.landingPage).toEqual({ pageType: 'STORE' })
    expect(ad.creative.title).toBe('Lovely mugs')
    expect(ad.creative.headline).toBeUndefined()
  })

  it('storeSpotlight: like productCollection', () => {
    const { path, body } = sbAdCreateRequest({ ...base, creativeType: 'storeSpotlight' })
    const ad = body.ads[0] as { creative: Record<string, unknown>; landingPage?: unknown }
    expect(path).toBe('/sb/v4/ads/storeSpotlight')
    expect(ad.landingPage).toEqual({ pageType: 'STORE' })
    expect(ad.creative.headline).toBe('Lovely mugs')
  })

  it('🔴 video: NO landing page anywhere, and NO headline — the schema has neither', () => {
    // CreateVideoAd.required = [adGroupId, creative, name, state]; CreateVideoCreative has
    // only asins / videoAssetIds / consentToTranslate.
    const { path, body } = sbAdCreateRequest({ ...base, creativeType: 'video' })
    const ad = body.ads[0] as { creative: Record<string, unknown>; landingPage?: unknown }
    expect(path).toBe('/sb/v4/ads/video')
    expect(ad.landingPage).toBeUndefined()
    expect(ad.creative.landingPage).toBeUndefined()
    expect(ad.creative.headline).toBeUndefined()
    expect(ad.creative.title).toBeUndefined()
    // …but the ad still carries the required name, which is where the operator's words survive.
    expect(ad.name).toBe('Lovely mugs')
  })
})

describe('P4.5f — the small things', () => {
  it('state is upper-cased to Amazon CreateOrUpdateEntityState', () => {
    expect(sbAdCreateRequest({ ...base, creativeType: 'video' }).body.ads[0].state).toBe('ENABLED')
    expect(sbAdCreateRequest({ ...base, creativeType: 'video', state: 'paused' }).body.ads[0].state).toBe('PAUSED')
  })

  it('a custom URL landing page sends url, not pageType', () => {
    const { body } = sbAdCreateRequest({ ...base, creativeType: 'productCollection', landingType: 'url', landingUrl: 'https://example.test/x' })
    expect((body.ads[0] as { landingPage: unknown }).landingPage).toEqual({ url: 'https://example.test/x' })
  })

  it('productList maps to PRODUCT_LIST', () => {
    const { body } = sbAdCreateRequest({ ...base, creativeType: 'productCollection', landingType: 'productList' })
    expect((body.ads[0] as { landingPage: unknown }).landingPage).toEqual({ pageType: 'PRODUCT_LIST' })
  })

  it('an explicit name wins over the headline', () => {
    expect(sbAdCreateRequest({ ...base, creativeType: 'video', name: 'Spring push' }).body.ads[0].name).toBe('Spring push')
  })

  it('a missing logo is omitted, not sent empty', () => {
    const { body } = sbAdCreateRequest({ ...base, creativeType: 'productCollection', logoAssetId: undefined })
    expect(Object.keys((body.ads[0] as { creative: Record<string, unknown> }).creative)).not.toContain('brandLogoAssetID')
  })

  it('🔴 manualCollection with no ASINs is REFUSED — its schema requires them', () => {
    expect(() => sbAdCreateRequest({ ...base, creativeType: 'manualCollection', asins: [] }))
      .toThrow('[ads] a Sponsored Brands "Manual collection" creative requires at least one ASIN — nothing was sent')
    // POSITIVE CONTROL: a type whose schema does NOT require asins is fine without them.
    expect(() => sbAdCreateRequest({ ...base, creativeType: 'productCollection', asins: [] })).not.toThrow()
  })

  it('an unknown type is refused before any request is built', () => {
    expect(() => sbAdCreateRequest({ ...base, creativeType: 'autoCollection' as never }))
      .toThrow(/not a Sponsored Brands creative type/)
  })
})
