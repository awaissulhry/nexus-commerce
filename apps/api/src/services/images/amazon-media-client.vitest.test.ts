import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({ account: {} as any, market: {} as any, token: vi.fn(), envToken: vi.fn(), writable: vi.fn(), fetch: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { channelConnection: { findUnique: async () => f.account }, marketplace: { findFirst: async () => f.market } } }))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { region: 'eu', getAccessToken: f.envToken } }))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: f.token, assertWritable: f.writable }))
import { amazonMediaClient, amazonVariationAttributes, marketValue } from './amazon-media-client'
const item = { id: 'l', productId: 'p', sku: 'SELLER/SKU', asin: 'ASIN', label: 'Shirt', parent: false, productType: 'SHIRT', theme: null, attributes: {} }
function listing(extra: object = {}) { return { sku: item.sku, summaries: [{ marketplaceId: 'IT-ID', asin: 'ASIN', productType: 'SHIRT' }], productTypes: [{ marketplaceId: 'IT-ID', productType: 'SHIRT' }], attributes: { main_product_image_locator: [{ marketplace_id: 'IT-ID', media_location: 'https://cdn.example/a.jpg' }] }, ...extra } }
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }) }
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('fetch', f.fetch)
  f.account = { id: 'a', channelType: 'AMAZON', managedBy: 'oauth', region: 'EU', isActive: true, externalAccountId: 'seller-123' }
  f.market = { marketplaceId: 'IT-ID', region: 'EU' }
  f.token.mockResolvedValue('account-token'); f.envToken.mockResolvedValue('env-token'); f.writable.mockResolvedValue(undefined)
  f.fetch.mockImplementation(async (url: URL) => {
    if (url.hostname.endsWith('amazonaws.com')) return response({ properties: {
      main_product_image_locator: { items: {} }, other_product_image_locator_1: { editable: false }, swatch_product_image_locator: { readOnly: true }, image_locator_ps01: {},
    } })
    if (url.pathname.includes('/definitions/')) return response({ schema: { link: { resource: 'https://schema.s3.amazonaws.com/definition.json' } } })
    if (url.pathname.includes('/catalog/')) return response({ images: [{ marketplaceId: 'DE-ID', images: [{ variant: 'MAIN', link: 'wrong-market', width: 800, height: 800 }] }, { marketplaceId: 'IT-ID', images: [{ variant: 'MAIN', link: 'small', width: 80, height: 80 }, { variant: 'MAIN', link: 'large', width: 1600, height: 1600 }] }] })
    return response(listing())
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
describe('account-scoped Amazon image client', () => {
  it('uses the selected seller token, region and marketplace and retains the largest catalog rendition', async () => {
    const c = await amazonMediaClient('a', 'IT'); const observed = await c.observe(item)
    expect(f.token).toHaveBeenCalledWith('a')
    expect(f.envToken).not.toHaveBeenCalled()
    const [url, options] = f.fetch.mock.calls[0]
    expect(url.href).toContain('sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/seller-123/SELLER%2FSKU')
    expect(url.searchParams.get('marketplaceIds')).toBe('IT-ID')
    expect(options.headers['x-amz-access-token']).toBe('account-token')
    expect(observed.catalog).toEqual([{ slot: 'MAIN', url: 'large', width: 1600, height: 1600 }])
    expect(observed.supported).toEqual(['MAIN'])
  })
  it('refuses an env credential whose seller identity or region does not match the selected account', async () => {
    vi.stubEnv('AMAZON_SELLER_ID', 'another-seller')
    f.account.managedBy = 'env'; f.account.isPrimary = true
    await expect(amazonMediaClient('a', 'IT')).rejects.toThrow('do not belong')
    expect(f.fetch).not.toHaveBeenCalled()
    vi.stubEnv('AMAZON_SELLER_ID', 'seller-123'); f.market.region = 'NA'
    await expect(amazonMediaClient('a', 'US')).rejects.toThrow('do not belong')
  })
  it('refuses disconnected accounts, missing marketplace metadata and revoked credentials', async () => {
    f.account.isActive = false; await expect(amazonMediaClient('a', 'IT')).rejects.toThrow('identity')
    f.account.isActive = true; f.market.marketplaceId = null; await expect(amazonMediaClient('a', 'IT')).rejects.toThrow('marketplace ID')
    f.market.marketplaceId = 'IT-ID'; f.writable.mockRejectedValue(new Error('Revoked')); await expect(amazonMediaClient('a', 'IT')).rejects.toThrow('Revoked')
  })
  it.each([listing({ sku: 'WRONG' }), listing({ summaries: [{ marketplaceId: 'IT-ID', asin: 'OTHER' }] }), listing({ summaries: [] })])('does not treat an identity mismatch as live image evidence', async data => {
    f.fetch.mockResolvedValue(response(data)); await expect((await amazonMediaClient('a', 'IT')).observe(item)).rejects.toThrow()
  })
  it('treats 404 as an unavailable listing, never a successful empty gallery', async () => {
    f.fetch.mockResolvedValue(response({ errors: [{ code: 'NOT_FOUND', message: 'No listing' }] }, 404))
    await expect((await amazonMediaClient('a', 'IT')).observe(item)).rejects.toThrow('404')
  })
  it('does not retry a timed-out PATCH, and adds preview mode only to validation calls', async () => {
    const c = await amazonMediaClient('a', 'IT')
    f.fetch.mockRejectedValue(new Error('Timed out'))
    await expect(c.patch('SKU', 'SHIRT', [], false)).rejects.toThrow('Timed out')
    expect(f.fetch).toHaveBeenCalledTimes(1)
    expect(f.fetch.mock.calls[0][0].searchParams.has('mode')).toBe(false)
    f.fetch.mockResolvedValue(response({ status: 'VALID' })); await c.patch('SKU', 'SHIRT', [], true)
    expect(f.fetch.mock.calls[1][0].searchParams.get('mode')).toBe('VALIDATION_PREVIEW')
  })
  it('refuses ambiguous image arrays rather than deleting them as empty', async () => {
    f.fetch.mockResolvedValue(response(listing({ attributes: { main_product_image_locator: [{ media_location: 'one' }, { media_location: 'two' }] } })))
    await expect((await amazonMediaClient('a', 'IT')).observe(item)).rejects.toThrow('ambiguous')
  })
  it('uses the variation theme attribute names returned by Amazon relationships', async () => {
    const original = f.fetch.getMockImplementation()!
    f.fetch.mockImplementation(async (url: URL, options: any) => url.pathname.includes('/listings/') ? response(listing({
      relationships: [{ marketplaceId: 'IT-ID', relationships: [{ type: 'VARIATION', variationTheme: { theme: 'COLOR_NAME/SIZE_NAME', attributes: ['color', 'shirt_size'] } }] }],
      attributes: { color: [{ value: 'Blu', marketplace_id: 'IT-ID' }], shirt_size: [{ size: 'M', size_system: 'eu' }], variation_theme: [{ name: 'COLOR_NAME/SIZE_NAME' }] },
    })) : original(url, options))
    const observed = await (await amazonMediaClient('a', 'IT')).observe(item)
    expect(observed.attributes).toEqual({ color: 'Blu', shirt_size: 'size: M · size system: eu' })
  })
})
describe('Amazon variation values', () => {
  it('keeps native values and does not borrow another market’s value', () => {
    expect(marketValue([{ value: 'Rot', marketplace_id: 'DE' }, { value: 'Rosso', marketplace_id: 'IT' }], 'IT')).toBe('Rosso')
    expect(marketValue([{ value: 'Rot', marketplace_id: 'DE' }], 'IT')).toBeNull()
    expect(amazonVariationAttributes({ material: [{ value: 'Cotone' }], unrelated: [{ value: 'Other' }] }, 'MATERIAL', 'IT')).toEqual({ material: 'Cotone' })
  })
})
