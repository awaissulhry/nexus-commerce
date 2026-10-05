/** E1 — the Etsy live reader on anonymised fixtures (fake shop, listing and SKUs; the reader is stubbed, no network). */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({ answers: {} as Record<string, unknown>, failures: {} as Record<string, number>, paths: [] as string[] }))
vi.mock('../etsy/read-client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../etsy/read-client.js')>()
  return { ...original, etsyReader: vi.fn(async () => ({ shopId: '90000001', get: async (path: string) => {
    s.paths.push(path)
    if (s.failures[path]) throw new original.EtsyReadError(s.failures[path])
    if (!(path in s.answers)) throw new original.EtsyReadError(404)
    return structuredClone(s.answers[path])
  } })) }
})

import { etsyReader } from '../etsy/read-client.js'
import { ETSY_OTHER_SHOP, ETSY_SHOP_NOT_SAID, etsyListingReads, normaliseEtsyListing, readEtsyLive, readEtsyServerLive, type EtsyLiveRaw } from './etsy.js'

const LISTING = '9000000001'
const PATHS = { listing: `/listings/${LISTING}?includes=Images,Translations`, plain: `/listings/${LISTING}`, inventory: `/listings/${LISTING}/inventory`,
  properties: `/shops/90000001/listings/${LISTING}/properties`, shop: '/shops/90000001' }
const listing = (over: Record<string, unknown> = {}) => ({ listing_id: 9000000001, shop_id: 90000001, user_id: 1, state: 'active', language: 'it',
  title: '  Guanti da moto  ', description: 'Pelle morbida\n', tags: ['guanti', ' moto ', ''], materials: ['pelle'], taxonomy_id: 1234,
  who_made: 'i_did', when_made: 'made_to_order', is_supply: false, listing_type: 'physical', shop_section_id: null, shipping_profile_id: 70000001,
  return_policy_id: null, item_weight: 250, item_weight_unit: 'g', item_length: null, item_width: null, item_height: null, item_dimensions_unit: 'cm',
  is_taxable: true, should_auto_renew: false, style: ['Moderno'], quantity: 7, views: 12, num_favorers: 3, url: 'https://www.etsy.com/listing/9000000001',
  created_timestamp: 1780000000, updated_timestamp: 1790000000, images: [{ listing_image_id: 1, url_fullxfull: 'https://img.example/1.jpg' }],
  translations: [{ listing_id: 9000000001, language: 'en', title: 'Motorcycle gloves', description: 'Soft leather', tags: ['gloves'] },
    { listing_id: 9000000001, language: 'de', title: 'Handschuhe', description: 'Leder', tags: [] }], ...over })
const money = (amount: number) => ({ amount, divisor: 100, currency_code: 'EUR' })
const axisValue = (property_id: number, property_name: string, value: string) => ({ property_id, property_name, scale_id: null, scale_name: null, value_ids: [property_id * 10], values: [value] })
const product = (sku: string | null, size: string, quantity: number, price = 1999, extra: Record<string, unknown> = {}) => ({ product_id: 1, sku, is_deleted: false,
  property_values: [axisValue(513, 'Taglia', size), axisValue(514, 'Colore', 'Nero')],
  offerings: [{ offering_id: 1, quantity, is_enabled: true, is_deleted: false, price: money(price), readiness_state_id: 80000001 }], ...extra })
const inventory = (products = [product('FAKE-SKU-2', 'L', 2, 1990), product('FAKE-SKU-1', 'M', 5), product('FAKE-SKU-9', 'XL', 1, 1999, { is_deleted: true }), product(null, 'S', 1)]) =>
  ({ products, price_on_property: [513, 514], quantity_on_property: [513, 514], sku_on_property: [513, 514], readiness_state_on_property: [] })
const properties = () => ({ count: 3, results: [axisValue(514, 'Colore', 'Nero'), { property_id: 200, property_name: 'Primary color', scale_id: null, scale_name: null, value_ids: [1], values: [' Black '] }, axisValue(513, 'Taglia', 'M')] })
const shop = () => ({ shop_id: 90000001, shop_name: 'Fake Shop', login_name: 'abcdefgh12345678', languages: ['it', 'en', 'de'], currency_code: 'eur', num_favorers: 9 })
const raw = (over: Partial<EtsyLiveRaw> = {}): EtsyLiveRaw => ({ listing: listing(), inventory: inventory(), properties: properties(), shop: shop(), translationsRead: true, ...over })
const destination = { productId: 'family', channel: 'ETSY' as const, marketplace: 'GLOBAL', accountId: 'account', aliasKey: '', expectedSkus: ['FAKE-SKU-1', 'FAKE-SKU-3'], listingId: LISTING }
const now = () => new Date('2026-10-05T18:00:00Z')

beforeEach(() => {
  vi.clearAllMocks()
  s.paths = []; s.failures = {}
  s.answers = { [PATHS.listing]: listing(), [PATHS.plain]: listing({ translations: undefined }), [PATHS.inventory]: inventory(), [PATHS.properties]: properties(), [PATHS.shop]: shop() }
})

describe('readEtsyLive', () => {
  it('reads exactly four paths through the account\'s gateway reader and returns the review\'s one shape', async () => {
    const live = await readEtsyLive({ accountId: 'account', listingId: LISTING })
    expect(etsyReader).toHaveBeenCalledTimes(1)
    expect(etsyReader).toHaveBeenCalledWith('account')
    expect([...s.paths].sort()).toEqual([PATHS.listing, PATHS.inventory, PATHS.properties, PATHS.shop].sort())
    expect(live).toMatchObject({ listingId: LISTING, state: 'active', language: 'it', unnamedProducts: 1, priceCurrencies: ['EUR'],
      unread: { production_partner_ids: 'Etsy does not report production partners when Nexus reads a listing.' },
      shop: { languages: ['it', 'en', 'de'], currencyCode: 'EUR' } })
    expect(live.values).toEqual({ title: 'Guanti da moto', description: 'Pelle morbida', tags: ['guanti', 'moto'], materials: ['pelle'], taxonomy_id: 1234,
      classification: { who_made: 'i_did', when_made: 'made_to_order', is_supply: false }, type: 'physical', shop_section_id: null, shipping_profile_id: 70000001,
      return_policy_id: null, item_weight: { value: 250, unit: 'g' }, item_dimensions: { length: null, width: null, height: null, unit: null },
      is_taxable: true, should_auto_renew: false, production_partner_ids: [], styles: ['Moderno'] })
    expect(live.revision).toMatch(/^[0-9a-f]{64}$/)
  })

  it('Money becomes the decimal the PUT takes; deleted products are skipped; read-only keys are dropped; output is sorted', async () => {
    const live = await readEtsyLive({ accountId: 'account', listingId: LISTING })
    expect(live.offerings).toEqual({ 'FAKE-SKU-1': { price: 19.99, quantity: 5, is_enabled: true, readiness_state_id: 80000001 },
      'FAKE-SKU-2': { price: 19.9, quantity: 2, is_enabled: true, readiness_state_id: 80000001 } })
    expect(Object.keys(live.offerings)).toEqual(['FAKE-SKU-1', 'FAKE-SKU-2'])
    // A SKU-less product stays in the structure (a full replace would remove it) and is counted; it has no offering entry.
    expect(live.inventory).toEqual({ properties: [{ property_id: 513, property_name: 'Taglia', scale_id: null }, { property_id: 514, property_name: 'Colore', scale_id: null }],
      products: [
        { sku: '', values: [{ property_id: 513, values: ['S'] }, { property_id: 514, values: ['Nero'] }], readiness_state_id: 80000001 },
        { sku: 'FAKE-SKU-1', values: [{ property_id: 513, values: ['M'] }, { property_id: 514, values: ['Nero'] }], readiness_state_id: 80000001 },
        { sku: 'FAKE-SKU-2', values: [{ property_id: 513, values: ['L'] }, { property_id: 514, values: ['Nero'] }], readiness_state_id: 80000001 }] })
    expect(live.properties.map(p => p.property_id)).toEqual([200, 513, 514])
    expect(live.properties[0]).toEqual({ property_id: 200, property_name: 'Primary color', value_ids: [1], values: ['Black'], scale_id: null })
    expect(live.translations).toEqual([{ language: 'de', title: 'Handschuhe', description: 'Leder', tags: [] },
      { language: 'en', title: 'Motorcycle gloves', description: 'Soft leather', tags: ['gloves'] }])
    const json = JSON.stringify(live)
    for (const leaked of ['FAKE-SKU-9', 'XL', 'product_id', 'offering_id', 'scale_name', 'is_deleted', 'views', 'num_favorers', '1790000000', 'img.example', '90000001']) expect(json).not.toContain(leaked)
  })

  it('includes refused (400): the listing is read once more without includes and its translations are "not read" (null), never []', async () => {
    s.failures[PATHS.listing] = 400
    const live = await readEtsyLive({ accountId: 'account', listingId: LISTING })
    expect(s.paths).toContain(PATHS.plain)
    expect(live.translations).toBeNull()
    expect(live.values.title).toBe('Guanti da moto')
  })

  it('any other failure throws with Etsy\'s reason (the studio records it as liveReadError); a 404 is not retried', async () => {
    s.failures[PATHS.listing] = 404
    await expect(readEtsyLive({ accountId: 'account', listingId: LISTING })).rejects.toThrow('Etsy could not read this resource (HTTP 404).')
    expect(s.paths).not.toContain(PATHS.plain)
    s.failures = { [PATHS.properties]: 429 }
    await expect(readEtsyLive({ accountId: 'account', listingId: LISTING })).rejects.toThrow(/HTTP 429/)
  })

  it('another shop\'s listing: only the listing and the shop were read, nothing more, and nothing of it is used', async () => {
    s.answers[PATHS.listing] = listing({ shop_id: 90000002 })
    await expect(readEtsyLive({ accountId: 'account', listingId: LISTING })).rejects.toThrow(ETSY_OTHER_SHOP)
    expect([...s.paths].sort()).toEqual([PATHS.listing, PATHS.shop].sort())
    expect(ETSY_OTHER_SHOP).toBe('This Etsy listing belongs to another shop, not this account\'s, so Nexus reads nothing more of it and uses none of it.')
  })

  it('a listing Etsy names no shop for is not taken to be this shop\'s: the studio refuses it, without reading more', async () => {
    s.answers[PATHS.listing] = listing({ shop_id: undefined })
    await expect(readEtsyLive({ accountId: 'account', listingId: LISTING })).rejects.toThrow(ETSY_SHOP_NOT_SAID)
    expect([...s.paths].sort()).toEqual([PATHS.listing, PATHS.shop].sort())
    s.paths = []; s.answers[PATHS.listing] = listing(); s.answers[PATHS.shop] = { ...shop(), shop_id: undefined }
    await expect(readEtsyLive({ accountId: 'account', listingId: LISTING })).rejects.toThrow('Etsy did not say which shop holds this listing, so Nexus does not compare it.')
  })

  it('never uses another listing, or builds a path from a bad id', async () => {
    s.answers[PATHS.listing] = listing({ listing_id: 9000000002 })
    await expect(readEtsyLive({ accountId: 'account', listingId: LISTING })).rejects.toThrow('Etsy returned another or an unreadable listing.')
    s.paths = []
    await expect(readEtsyLive({ accountId: 'account', listingId: '9000000001/../x' })).rejects.toThrow('That is not an Etsy listing id; nothing was read.')
    expect(s.paths).toEqual([])
  })
})

describe('normaliseEtsyListing', () => {
  it('is deterministic: the same Etsy state gives equal JSON, whatever the timestamps, views or product order', () => {
    const a = normaliseEtsyListing(LISTING, raw())
    const b = normaliseEtsyListing(LISTING, raw({ listing: listing({ views: 99, num_favorers: 40, updated_timestamp: 1799999999 }),
      inventory: inventory([product(null, 'S', 1), product('FAKE-SKU-1', 'M', 5), product('FAKE-SKU-2', 'L', 2, 1990)]) }))
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })

  it('the revision follows content and structure, not stock or price (they move by themselves and have their own doors)', () => {
    const base = normaliseEtsyListing(LISTING, raw())
    const stock = normaliseEtsyListing(LISTING, raw({ inventory: inventory([product('FAKE-SKU-2', 'L', 0, 2500), product('FAKE-SKU-1', 'M', 9), product(null, 'S', 1)]) }))
    expect(stock.offerings['FAKE-SKU-1'].quantity).toBe(9)
    expect(stock.revision).toBe(base.revision)
    expect(normaliseEtsyListing(LISTING, raw({ listing: listing({ title: 'Guanti' }) })).revision).not.toBe(base.revision)
    expect(normaliseEtsyListing(LISTING, raw({ inventory: inventory([product('FAKE-SKU-1', 'M', 5)]) })).revision).not.toBe(base.revision)
  })

  it('a single product: no variation property, one product without values; a unit without its value is null', () => {
    const single = { products: [{ product_id: 1, sku: 'FAKE-SKU-1', is_deleted: false, property_values: [],
      offerings: [{ offering_id: 1, quantity: 3, is_enabled: true, is_deleted: false, price: money(4500), readiness_state_id: null }] }] }
    const live = normaliseEtsyListing(LISTING, raw({ inventory: single, listing: listing({ item_weight: null, item_weight_unit: 'kg', item_length: 30 }) }))
    expect(live.inventory).toEqual({ properties: [], products: [{ sku: 'FAKE-SKU-1', values: [], readiness_state_id: null }] })
    expect(live.offerings).toEqual({ 'FAKE-SKU-1': { price: 45, quantity: 3, is_enabled: true, readiness_state_id: null } })
    expect(live.values.item_weight).toEqual({ value: null, unit: null })
    expect(live.values.item_dimensions).toEqual({ length: 30, width: null, height: null, unit: 'cm' })
  })

  it('Etsy\'s HTML-escaped text is decoded once, so a value equal to Nexus\'s never reads as different', () => {
    const live = normaliseEtsyListing(LISTING, raw({
      listing: listing({ title: 'Guanti &quot;Pro&quot; &amp; giacca', description: 'Pelle d&#39;agnello &#x2014; &amp;amp; &bogus; &#0;',
        tags: ['l&#39;originale', '&nbsp;moto&nbsp;'], materials: ['pelle &amp; tessuto'], style: ['Rock &amp; roll'],
        translations: [{ language: 'en', title: 'Rider&#39;s gloves', description: 'Soft &lt;leather&gt;', tags: ['rider&apos;s'] }] }),
      inventory: inventory([product('FAKE-SKU-1', 'M', 5, 1999, { property_values: [axisValue(513, 'Taglia', 'M'), axisValue(514, 'Colore &amp; finitura', 'Nero &amp; rosso')] })]),
      properties: { count: 1, results: [{ property_id: 200, property_name: 'Primary color', scale_id: null, value_ids: [1], values: ['Black &amp; white'] }] } }))
    expect(live.values).toMatchObject({ title: 'Guanti "Pro" & giacca', description: 'Pelle d\'agnello \u2014 &amp; &bogus; &#0;',
      tags: ['l\'originale', 'moto'], materials: ['pelle & tessuto'], styles: ['Rock & roll'] })
    expect(live.translations).toEqual([{ language: 'en', title: 'Rider\'s gloves', description: 'Soft <leather>', tags: ['rider\'s'] }])
    expect(live.properties[0].values).toEqual(['Black & white'])
    expect(live.inventory.properties[1]).toEqual({ property_id: 514, property_name: 'Colore & finitura', scale_id: null })
    expect(live.inventory.products[0].values[1]).toEqual({ property_id: 514, values: ['Nero & rosso'] })
  })

  it('an inventory Etsy\'s own transform cannot take is a failed read, never a guessed price', () => {
    const broken = inventory([product('FAKE-SKU-1', 'M', 5, 1999, { offerings: [{ offering_id: 1, quantity: 5, is_enabled: true, is_deleted: false }] })])
    expect(() => normaliseEtsyListing(LISTING, raw({ inventory: broken }))).toThrow(/Etsy returned no price/)
  })
})

describe('readEtsyServerLive', () => {
  it('content by change field, variations marked against Nexus\'s SKUs, the studio\'s revision', async () => {
    const read = await readEtsyServerLive(destination, etsyListingReads('account'), now)
    expect(read).toMatchObject({ readAt: '2026-10-05T18:00:00.000Z', source: 'etsy-listing', errors: [],
      destination: { productId: 'family', channel: 'ETSY', marketplace: 'GLOBAL', accountId: 'account', aliasKey: '' } })
    expect(read.destination).not.toHaveProperty('listingId')
    expect(read.content).toMatchObject({ title: { state: 'value', value: 'Guanti da moto' }, shop_section_id: { state: 'absent' },
      item_dimensions: { state: 'absent' }, item_weight: { state: 'value', value: { value: 250, unit: 'g' } },
      production_partner_ids: { state: 'unread', reason: 'Etsy does not report production partners when Nexus reads a listing.' },
      'property:200': { state: 'value', value: { property_id: 200, property_name: 'Primary color', value_ids: [1], values: ['Black'], scale_id: null } },
      'translation:en': { state: 'value', value: { language: 'en', title: 'Motorcycle gloves', description: 'Soft leather', tags: ['gloves'] } },
      inventory: { state: 'value' } })
    // Variation properties are the inventory's, not listing attributes.
    expect(read.content).not.toHaveProperty('property:513')
    expect(read.variations).toEqual({ axes: ['Taglia', 'Colore'], order: { Taglia: ['L', 'M', 'S'], Colore: ['Nero'] }, variants: [
      { sku: 'FAKE-SKU-2', values: { Taglia: 'L', Colore: 'Nero' }, price: { state: 'value', value: { amount: '19.9', currency: 'EUR' } }, stock: { state: 'value', value: 2 }, state: 'extra' },
      { sku: 'FAKE-SKU-1', values: { Taglia: 'M', Colore: 'Nero' }, price: { state: 'value', value: { amount: '19.99', currency: 'EUR' } }, stock: { state: 'value', value: 5 }, state: 'live' },
      { sku: '', values: { Taglia: 'S', Colore: 'Nero' }, price: { state: 'value', value: { amount: '19.99', currency: 'EUR' } }, stock: { state: 'value', value: 1 }, state: 'extra' },
      { sku: 'FAKE-SKU-3', values: {}, price: { state: 'absent' }, stock: { state: 'absent' }, state: 'missing' }] })
    expect(read.revision).toBe((await readEtsyLive({ accountId: 'account', listingId: LISTING })).revision)
    // Server side only: whose shop holds the listing and Etsy's state, for the identity check (only `active` is live).
    expect(read.raw).toMatchObject({ ownShop: true, state: 'active', documents: { translationsRead: true, listing: { listing_id: 9000000001 } } })
  })

  it('translations Etsy did not return are a field error, not an empty list', async () => {
    s.failures[PATHS.listing] = 400
    const read = await readEtsyServerLive(destination, etsyListingReads('account'), now)
    expect(read.errors).toEqual([{ scope: 'field', field: 'translations', reason: 'Etsy did not return this listing\'s translations, so they were not read.' }])
    expect(Object.keys(read.content).some(key => key.startsWith('translation:'))).toBe(false)
  })

  it('another shop\'s listing is an item error whose raw says so (no documents kept), for the identity check\'s "foreign"', async () => {
    s.answers[PATHS.listing] = listing({ shop_id: 90000002, state: 'draft' })
    const read = await readEtsyServerLive(destination, etsyListingReads('account'), now)
    expect(read).toMatchObject({ revision: null, variations: null, errors: [{ scope: 'item', reason: ETSY_OTHER_SHOP }], raw: { ownShop: false, state: null, documents: null } })
    expect(read.content.title).toEqual({ state: 'unread', reason: ETSY_OTHER_SHOP })
    expect(s.paths).not.toContain(PATHS.inventory)
    expect(s.paths).not.toContain(PATHS.properties)
  })

  it('carries Etsy\'s state as Etsy says it, and "not said" when Etsy names no shop', async () => {
    s.answers[PATHS.listing] = listing({ state: 'sold_out', shop_id: undefined })
    const read = await readEtsyServerLive(destination, etsyListingReads('account'), now)
    expect(read.raw).toMatchObject({ ownShop: null, state: 'sold_out' })
    expect(read.errors).toEqual([])
  })

  it('a failed read is an item error: every listing field unread with the reason, no revision, no variations, no raw', async () => {
    s.failures[PATHS.inventory] = 500
    const read = await readEtsyServerLive(destination, etsyListingReads('account'), now)
    expect(read).toMatchObject({ source: 'etsy-listing', revision: null, variations: null, raw: null, errors: [{ scope: 'item', reason: 'Etsy could not read this resource (HTTP 500).' }] })
    expect(read.content.title).toEqual({ state: 'unread', reason: 'Etsy could not read this resource (HTTP 500).' })
    expect(Object.keys(read.content)).toHaveLength(16)
  })
})
