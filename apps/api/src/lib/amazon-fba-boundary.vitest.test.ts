/**
 * D8 — the FBA boundary for Studio Publish's JSON_LISTINGS_FEED. (a) which feed entries are a merchant quantity; (b) the
 * guard refuses an FBA SKU on every kind of evidence, fails closed, and lets a genuine FBM SKU through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ products: vi.fn(), stock: vi.fn() }))
vi.mock('../db.js', () => ({ default: { product: { findMany: m.products }, stockLevel: { findMany: m.stock } } }))
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import { assertNoMerchantQuantityForFba, fbaSkusAmong, merchantQuantityEntries } from './amazon-fba-boundary.js'

const fbm = (quantity: number) => ({ fulfillment_channel_code: 'DEFAULT', quantity, lead_time_to_ship_max_days: 2 })

describe('merchantQuantityEntries', () => {
  it('an UPDATE whose fulfillment_availability is DEFAULT with a quantity', () => {
    expect(merchantQuantityEntries({ sku: 'JKT-M', attributes: { item_name: [{ value: 'Jacket' }], fulfillment_availability: [fbm(7)] } }))
      .toEqual([{ sku: 'JKT-M', entries: [{ fulfillment_channel_code: 'DEFAULT', quantity: 7, lead_time_to_ship_max_days: 2 }] }])
  })

  it('a PATCH replace and a PATCH merge of /attributes/fulfillment_availability', () => {
    expect(merchantQuantityEntries({ sku: 'JKT-M', patches: [{ op: 'replace', path: '/attributes/fulfillment_availability', value: [fbm(4)] }] }))
      .toEqual([{ sku: 'JKT-M', entries: [fbm(4)] }])
    expect(merchantQuantityEntries({ sku: 'JKT-L', patches: [{ op: 'merge', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'MFN', quantity: 0 }] }] }))
      .toEqual([{ sku: 'JKT-L', entries: [{ fulfillment_channel_code: 'MFN', quantity: 0 }] }])
  })

  it('a missing code with a quantity counts (Amazon reads it as the merchant channel), quantity 0 included', () => {
    expect(merchantQuantityEntries({ sku: 'JKT-M', attributes: { fulfillment_availability: [{ quantity: 0 }] } }))
      .toEqual([{ sku: 'JKT-M', entries: [{ quantity: 0 }] }])
    expect(merchantQuantityEntries({ sku: 'JKT-M', patches: [{ op: 'replace', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: '', quantity: 3 }] }] }))
      .toEqual([{ sku: 'JKT-M', entries: [{ fulfillment_channel_code: '', quantity: 3 }] }])
  })

  it('ignores AMAZON_EU and AMAZON_EU_RAFN entries, entries without a quantity, deletes and other roots', () => {
    expect(merchantQuantityEntries({ sku: 'JKT-M', attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU', quantity: 9 }] } })).toEqual([])
    expect(merchantQuantityEntries({ sku: 'JKT-M', patches: [{ op: 'replace', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'AMAZON_EU_RAFN', quantity: 9 }] }] })).toEqual([])
    expect(merchantQuantityEntries({ sku: 'JKT-M', attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', lead_time_to_ship_max_days: 3 }] } })).toEqual([])
    expect(merchantQuantityEntries({ sku: 'JKT-M', patches: [{ op: 'delete', path: '/attributes/fulfillment_availability', value: [fbm(1)] }] })).toEqual([])
    expect(merchantQuantityEntries({ sku: 'JKT-M', patches: [{ op: 'replace', path: '/attributes/purchasable_offer', value: [{ quantity: 1 }] }] })).toEqual([])
  })

  it('keeps only the merchant entries of a mixed value', () => {
    expect(merchantQuantityEntries({ sku: 'JKT-M', attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }, fbm(2)] } }))
      .toEqual([{ sku: 'JKT-M', entries: [fbm(2)] }])
  })
})

type Listing = { fulfillmentMethod?: string | null; platformAttributes?: unknown; flatFileSnapshot?: unknown; offers?: Array<{ sku: string; fulfillmentMethod: string; isActive: boolean }> }
const product = (sku: string, over: { fulfillmentMethod?: string | null; listings?: Listing[]; id?: string } = {}) => ({
  id: over.id ?? `id-${sku}`, sku, fulfillmentMethod: over.fulfillmentMethod ?? 'FBM',
  channelListings: (over.listings ?? []).map(l => ({ fulfillmentMethod: 'FBM', platformAttributes: {}, flatFileSnapshot: {}, offers: [], ...l })),
})
const feed = (...skus: string[]) => ({ messages: skus.map((sku, i) => ({ messageId: i + 1, sku, operationType: 'UPDATE', productType: 'COAT', attributes: { fulfillment_availability: [fbm(5)] } })) })
const refusal = (skus: string) => { const many = skus.includes(','); return { notSent: true, message: `${skus} ${many ? 'are' : 'is'} fulfilled by Amazon (FBA) — a merchant quantity would switch ${many ? 'them' : 'it'} to FBM.` } }

beforeEach(() => {
  m.products.mockReset().mockResolvedValue([])
  m.stock.mockReset().mockResolvedValue([])
})

describe('assertNoMerchantQuantityForFba', () => {
  it('refuses when the product flag says FBA', async () => {
    m.products.mockResolvedValue([product('JKT-M', { fulfillmentMethod: 'FBA' })])
    await expect(assertNoMerchantQuantityForFba(feed('JKT-M'), 'acct-1')).rejects.toMatchObject(refusal('JKT-M'))
  })

  it('refuses when 3 units sit at AMAZON-EU-FBA, though the product and listing say FBM', async () => {
    m.products.mockResolvedValue([product('JKT-M', { listings: [{ fulfillmentMethod: 'FBM' }] })])
    m.stock.mockResolvedValue([{ productId: 'id-JKT-M', quantity: 3 }])
    await expect(assertNoMerchantQuantityForFba(feed('JKT-M'), 'acct-1')).rejects.toMatchObject(refusal('JKT-M'))
    expect(m.stock).toHaveBeenCalledWith(expect.objectContaining({ where: { productId: { in: ['id-JKT-M'] }, quantity: { gt: 0 }, location: { code: 'AMAZON-EU-FBA' } } }))
  })

  it('refuses when another market\'s listing of the product reports AMAZON_EU', async () => {
    m.products.mockResolvedValue([product('JKT-M', { listings: [
      { fulfillmentMethod: 'FBM', platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT' }] } },
      { fulfillmentMethod: 'FBM', platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } },
    ] })])
    await expect(assertNoMerchantQuantityForFba(feed('JKT-M'), 'acct-1')).rejects.toMatchObject(refusal('JKT-M'))
  })

  it('refuses on an active FBA offer of any listing of the product', async () => {
    m.products.mockResolvedValue([product('JKT-M', { listings: [{}, { offers: [{ sku: 'JKT-M-FBA', fulfillmentMethod: 'FBA', isActive: true }] }] })])
    await expect(assertNoMerchantQuantityForFba(feed('JKT-M'), 'acct-1')).rejects.toMatchObject(refusal('JKT-M'))
  })

  it('finds an FBM product by its listing\'s seller SKU (offer, mirror key, flat-file snapshot) and lets it through', async () => {
    m.products.mockResolvedValue([product('JKT-M', { listings: [
      { offers: [{ sku: 'SELLER-OFFER', fulfillmentMethod: 'FBM', isActive: true }] },
      { platformAttributes: { seller_sku: 'SELLER-MIRROR' } },
      { flatFileSnapshot: { item_sku: 'SELLER-FLAT' } },
    ] })])
    await expect(assertNoMerchantQuantityForFba(feed('SELLER-OFFER', 'SELLER-MIRROR', 'SELLER-FLAT'), 'acct-1')).resolves.toBeUndefined()
  })

  it('fails closed when the evidence lookup errors', async () => {
    m.products.mockRejectedValue(new Error('connection reset'))
    await expect(assertNoMerchantQuantityForFba(feed('JKT-M'), 'acct-1')).rejects.toMatchObject(refusal('JKT-M'))
  })

  it('refuses a SKU no product claims: it cannot be proven FBM', async () => {
    await expect(assertNoMerchantQuantityForFba(feed('GHOST'), 'acct-1')).rejects.toMatchObject(refusal('GHOST'))
  })

  it('lets a genuine FBM SKU with no FBA evidence through', async () => {
    m.products.mockResolvedValue([product('JKT-M', { listings: [{ fulfillmentMethod: 'FBM', platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 2 }] },
      offers: [{ sku: 'JKT-M', fulfillmentMethod: 'FBA', isActive: false }] }] })])
    await expect(assertNoMerchantQuantityForFba(feed('JKT-M'), 'acct-1')).resolves.toBeUndefined()
  })

  it('names every refused SKU and leaves the FBM one out', async () => {
    m.products.mockResolvedValue([product('JKT-M', { fulfillmentMethod: 'FBA' }), product('JKT-L'), product('JKT-XL', { listings: [{ fulfillmentMethod: 'FBA' }] })])
    await expect(assertNoMerchantQuantityForFba(feed('JKT-M', 'JKT-L', 'JKT-XL'), 'acct-1')).rejects.toMatchObject(refusal('JKT-M, JKT-XL'))
  })

  it('reads nothing when no message carries a merchant quantity', async () => {
    await assertNoMerchantQuantityForFba({ messages: [
      { sku: 'JKT-M', attributes: { item_name: [{ value: 'Jacket' }], fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } },
      { sku: 'JKT-L', patches: [{ op: 'replace', path: '/attributes/item_name', value: [{ value: 'Jacket' }] }] },
    ] }, 'acct-1')
    expect(m.products).not.toHaveBeenCalled()
  })
})

describe('fbaSkusAmong', () => {
  it('reads the account\'s Amazon listings (and unattributed ones) in every market', async () => {
    m.products.mockResolvedValue([product('JKT-M')])
    expect(await fbaSkusAmong(['JKT-M'], 'acct-1')).toEqual(new Set())
    const where = m.products.mock.calls[0][0].select.channelListings.where
    expect(where).toEqual({ channel: 'AMAZON', OR: [{ channelConnectionId: 'acct-1' }, { channelConnectionId: null }] })
  })

  it('one FBA owner of a shared seller SKU is enough', async () => {
    m.products.mockResolvedValue([product('JKT-M'), product('OTHER', { listings: [{ fulfillmentMethod: 'FBA', platformAttributes: { sellerSku: 'JKT-M' } }] })])
    expect(await fbaSkusAmong(['JKT-M'], 'acct-1')).toEqual(new Set(['JKT-M']))
  })
})
