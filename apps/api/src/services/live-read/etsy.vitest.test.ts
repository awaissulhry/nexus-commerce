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
import { ETSY_OTHER_SHOP, ETSY_SHOP_NOT_SAID, ETSY_TOO_MANY_DRAFTS, EtsyDraftUnconfirmed, etsyListingReads, findEtsyDrafts, normaliseEtsyListing, readEtsyLive, readEtsyServerLive, readEtsyShop,
  type EtsyLiveRaw } from './etsy.js'

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
        { sku: 'FAKE-SKU-2', values: [{ property_id: 513, values: ['L'] }, { property_id: 514, values: ['Nero'] }], readiness_state_id: 80000001 }],
      price_on_property: [513, 514], quantity_on_property: [513, 514], sku_on_property: [513, 514], readiness_state_on_property: [] })
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

  it('E2: Etsy\'s sharing rule (*_on_property) is read into the structure, ids ascending and once each', () => {
    const shared = { ...inventory(), price_on_property: [514, 513], quantity_on_property: [], sku_on_property: [514, 513, 514], readiness_state_on_property: [513] }
    const live = normaliseEtsyListing(LISTING, raw({ inventory: shared }))
    expect(live.inventory).toMatchObject({ price_on_property: [513, 514], quantity_on_property: [], sku_on_property: [513, 514], readiness_state_on_property: [513] })
    // Etsy's order is not a change: the same rule in another order gives the same revision.
    expect(normaliseEtsyListing(LISTING, raw({ inventory: { ...shared, price_on_property: [513, 514] } })).revision).toBe(live.revision)
  })

  it('E2: the revision changes when Etsy\'s sharing rule changes (shared stock ↔ stock per variation), never when a quantity does', () => {
    const base = normaliseEtsyListing(LISTING, raw())
    const sharedStock = normaliseEtsyListing(LISTING, raw({ inventory: { ...inventory(), quantity_on_property: [] } }))
    expect(sharedStock.inventory.quantity_on_property).toEqual([])
    expect(sharedStock.revision).not.toBe(base.revision)
    for (const key of ['price_on_property', 'sku_on_property', 'readiness_state_on_property'] as const) {
      expect(normaliseEtsyListing(LISTING, raw({ inventory: { ...inventory(), [key]: [513] } })).revision).not.toBe(base.revision)
    }
    const restocked = normaliseEtsyListing(LISTING, raw({ inventory: inventory([product('FAKE-SKU-2', 'L', 40, 1990), product('FAKE-SKU-1', 'M', 0), product(null, 'S', 9)]) }))
    expect(restocked.offerings['FAKE-SKU-2'].quantity).toBe(40)
    expect(restocked.revision).toBe(base.revision)
  })

  it('E2: sold_out and active give one revision (a sale must not refuse a send); inactive gives another; the state stays raw', () => {
    const active = normaliseEtsyListing(LISTING, raw())
    const soldOut = normaliseEtsyListing(LISTING, raw({ listing: listing({ state: 'sold_out' }) }))
    const inactive = normaliseEtsyListing(LISTING, raw({ listing: listing({ state: 'inactive' }) }))
    expect(soldOut.state).toBe('sold_out')
    expect(soldOut.revision).toBe(active.revision)
    expect(inactive.state).toBe('inactive')
    expect(inactive.revision).not.toBe(active.revision)
    expect(inactive.revision).not.toBe(soldOut.revision)
  })

  it('a single product: no variation property, one product without values; a unit without its value is null', () => {
    const single = { products: [{ product_id: 1, sku: 'FAKE-SKU-1', is_deleted: false, property_values: [],
      offerings: [{ offering_id: 1, quantity: 3, is_enabled: true, is_deleted: false, price: money(4500), readiness_state_id: null }] }] }
    const live = normaliseEtsyListing(LISTING, raw({ inventory: single, listing: listing({ item_weight: null, item_weight_unit: 'kg', item_length: 30 }) }))
    // An inventory with no `*_on_property` arrays reads them as [] (one price, stock, SKU and profile for all).
    expect(live.inventory).toEqual({ properties: [], products: [{ sku: 'FAKE-SKU-1', values: [], readiness_state_id: null }],
      price_on_property: [], quantity_on_property: [], sku_on_property: [], readiness_state_on_property: [] })
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

describe('E3 — readEtsyShop (a create review\'s shop read)', () => {
  it('reads GET /shops/{own shop} through the account\'s reader: languages as Etsy lists them, the currency upper-cased', async () => {
    expect(await readEtsyShop('account')).toEqual({ languages: ['it', 'en', 'de'], currencyCode: 'EUR' })
    expect(etsyReader).toHaveBeenCalledWith('account')
    expect(s.paths).toEqual([PATHS.shop])
  })

  it('a shop that states no languages or currency gives [] and null (never a guess); a failed read throws', async () => {
    s.answers[PATHS.shop] = { shop_id: 90000001, languages: [' ', 7], currency_code: ' ' }
    expect(await readEtsyShop('account')).toEqual({ languages: [], currencyCode: null })
    s.failures[PATHS.shop] = 503
    await expect(readEtsyShop('account')).rejects.toThrow('HTTP 503')
  })
})

describe('E3 — findEtsyDrafts (a create\'s recovery: this shop\'s drafts that match)', () => {
  const SINCE = '2026-10-05T18:00:00.000Z'
  const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)
  const page = (offset: number) => `/shops/90000001/listings?state=draft&limit=100&offset=${offset}`
  const batch = (ids: string[]) => `/listings/batch/inventory?listing_ids=${ids.join(',')}`
  const draft = (id: number, title: string, created: number | null = at('2026-10-05T18:00:05Z'), extra: Record<string, unknown> = {}) => ({
    listing_id: id, shop_id: 90000001, state: 'draft', title, ...(created === null ? {} : { created_timestamp: created }), ...extra })
  const filler = (from: number, n: number) => Array.from({ length: n }, (_, i) => draft(from + i, `Altro ${i}`))
  const inventoryOf = (id: number, skus: Array<string | null>, deleted: string[] = []) => ({ listing_id: id,
    inventory: { products: [...skus.map(sku => ({ product_id: 1, sku, is_deleted: false, offerings: [] })), ...deleted.map(sku => ({ product_id: 2, sku, is_deleted: true, offerings: [] }))] } })
  const find = (over: Partial<{ title: string; since: string; skus: string[] }> = {}) =>
    findEtsyDrafts('account', { title: 'Guanti da moto "Pro"', since: SINCE, skus: ['FAKE-SKU-1', 'FAKE-SKU-2'], ...over })

  it('pages the drafts (two pages), keeps the same title (entities decoded, whitespace and case ignored) created since the marker, then ONE batch inventory read of those only', async () => {
    s.answers[page(0)] = { count: 103, results: [...filler(9000000100, 98), draft(9000000001, '  guanti DA  moto &quot;Pro&quot; '), draft(9000000002, 'Guanti da moto "Pro" XL')] }
    s.answers[page(100)] = { count: 103, results: [draft(9000000003, 'Guanti da moto &quot;Pro&quot;', at('2026-10-05T17:30:00Z')),
      draft(9000000004, 'Guanti da moto "Pro"', null), draft(9000000005, 'Guanti da moto "Pro"', at('2026-10-05T17:52:00Z'))] }
    s.answers[batch(['9000000001', '9000000004', '9000000005'])] = { count: 3, results: [inventoryOf(9000000001, ['FAKE-SKU-1', 'FAKE-SKU-2']),
      inventoryOf(9000000004, ['']), inventoryOf(9000000005, ['FAKE-SKU-1'], ['FAKE-SKU-OLD'])] }
    expect(await find()).toEqual([
      { listingId: '9000000001', title: 'guanti DA  moto "Pro"', createdAt: '2026-10-05T18:00:05.000Z' },
      // No creation time from Etsy: kept on the title and SKUs alone.
      { listingId: '9000000004', title: 'Guanti da moto "Pro"', createdAt: null },
      // 8 minutes before the marker is inside the 10 minutes' slack; a deleted product's SKU does not count.
      { listingId: '9000000005', title: 'Guanti da moto "Pro"', createdAt: '2026-10-05T17:52:00.000Z' },
    ])
    // 9000000002: another title; 9000000003: created 30 minutes before the marker.
    expect(s.paths).toEqual([page(0), page(100), batch(['9000000001', '9000000004', '9000000005'])])
  })

  it('the SKU rule: all empty (Etsy\'s first product) or all among the create\'s SKUs; a foreign or a mixed draft is not ours', async () => {
    s.answers[page(0)] = { count: 4, results: [draft(9000000001, 'Guanti da moto "Pro"'), draft(9000000002, 'Guanti da moto "Pro"'),
      draft(9000000003, 'Guanti da moto "Pro"'), draft(9000000004, 'Guanti da moto "Pro"')] }
    s.answers[batch(['9000000001', '9000000002', '9000000003', '9000000004'])] = { results: [inventoryOf(9000000001, [null]), inventoryOf(9000000002, ['FAKE-SKU-2']),
      inventoryOf(9000000003, ['FAKE-SKU-1', 'FAKE-SKU-9']), inventoryOf(9000000004, ['', 'FAKE-SKU-1'])] }
    expect((await find()).map(d => d.listingId)).toEqual(['9000000001', '9000000002'])
  })

  it('no draft with that title → [] without an inventory read; an active listing in the answer is never a candidate', async () => {
    s.answers[page(0)] = { count: 2, results: [draft(9000000001, 'Altro'), draft(9000000002, 'Guanti da moto "Pro"', undefined, { state: 'active' })] }
    expect(await find()).toEqual([])
    expect(s.paths).toEqual([page(0)])
  })

  it('more than 5,000 drafts: refused by name after 50 pages (a partial search is never "none")', async () => {
    for (let n = 0; n < 50; n++) s.answers[page(n * 100)] = { count: 5001, results: filler(9000001000 + n * 100, 100) }
    await expect(find()).rejects.toThrow('This shop has more than 5,000 Etsy drafts; Nexus cannot search them all.')
    expect(ETSY_TOO_MANY_DRAFTS).toContain('5,000')
    expect(s.paths).toHaveLength(50)
  })

  it('exactly 5,000 drafts (and 1,001, past the old cap) are searched whole', async () => {
    for (let n = 0; n < 50; n++) s.answers[page(n * 100)] = { count: 5000, results: filler(9000001000 + n * 100, 100) }
    await expect(find()).resolves.toEqual([])
    expect(s.paths).toHaveLength(50)
    s.paths = []
    for (let n = 0; n < 10; n++) s.answers[page(n * 100)] = { count: 1001, results: filler(9000001000 + n * 100, 100) }
    s.answers[page(1000)] = { count: 1001, results: [draft(9000000001, 'Guanti da moto "Pro"')] }
    s.answers[batch(['9000000001'])] = { results: [inventoryOf(9000000001, ['FAKE-SKU-1'])] }
    expect((await find()).map(d => d.listingId)).toEqual(['9000000001'])
    expect(s.paths).toHaveLength(12)
  })

  it('R1 §16: one candidate deleted meanwhile makes the whole batch 404 — the batch is split until that draft is alone, and it is dropped', async () => {
    const ids = ['9000000001', '9000000002', '9000000003', '9000000004', '9000000005']
    s.answers[page(0)] = { count: 5, results: ids.map(id => draft(Number(id), 'Guanti da moto "Pro"')) }
    // 9000000004 is gone: every batch that names it answers 404 (absent from the answers → 404).
    const alive = ids.filter(id => id !== '9000000004')
    const answer = (chunk: string[]) => ({ results: chunk.map(id => inventoryOf(Number(id), id === '9000000002' ? ['FAKE-SKU-9'] : ['FAKE-SKU-1'])) })
    for (const chunk of [['9000000001', '9000000002', '9000000003'], ['9000000005']]) s.answers[batch(chunk)] = answer(chunk)
    // N2: the lone 404 is proven with its own GET /listings/{id} — a 404 there too: gone.
    expect((await find()).map(d => d.listingId)).toEqual(alive.filter(id => id !== '9000000002'))
    expect(s.paths).toEqual([page(0), batch(ids), batch(['9000000001', '9000000002', '9000000003']), batch(['9000000004', '9000000005']), batch(['9000000004']),
      '/listings/9000000004', batch(['9000000005'])])
  })

  it('N2: a batch 404 whose lone id still answers its own GET (200) is still a candidate, judged by its own inventory', async () => {
    s.answers[page(0)] = { count: 1, results: [draft(9000000002, 'Guanti da moto "Pro"')] }
    s.answers['/listings/9000000002'] = draft(9000000002, 'Guanti da moto "Pro"')
    s.answers['/listings/9000000002/inventory'] = { products: [{ product_id: 1, sku: 'FAKE-SKU-1', is_deleted: false, offerings: [] }] }
    expect((await find()).map(d => d.listingId)).toEqual(['9000000002'])
    expect(s.paths).toEqual([page(0), batch(['9000000002']), '/listings/9000000002', '/listings/9000000002/inventory'])
    // ...and its own inventory with a foreign SKU is not ours.
    s.paths = []
    s.answers['/listings/9000000002/inventory'] = { products: [{ product_id: 1, sku: 'FAKE-SKU-9', is_deleted: false, offerings: [] }] }
    expect(await find()).toEqual([])
  })

  it('N2: a batch 404 whose lone id cannot be proven (its GET answers 500, or its inventory cannot be read) throws EtsyDraftUnconfirmed — never "gone"', async () => {
    s.answers[page(0)] = { count: 1, results: [draft(9000000002, 'Guanti da moto "Pro"')] }
    s.failures['/listings/9000000002'] = 500
    const refused = await find().catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(EtsyDraftUnconfirmed)
    expect((refused as Error).message).toBe('Nexus could not tell whether Etsy still holds draft 9000000002 (Etsy could not read this resource (HTTP 500).); check again later.')
    delete s.failures['/listings/9000000002']
    s.answers['/listings/9000000002'] = draft(9000000002, 'Guanti da moto "Pro"')
    s.failures['/listings/9000000002/inventory'] = 503
    await expect(find()).rejects.toThrow('Nexus could not tell whether Etsy still holds draft 9000000002')
  })

  it('a batch error other than 404 is still a failed search (never "none")', async () => {
    s.answers[page(0)] = { count: 2, results: [draft(9000000001, 'Guanti da moto "Pro"'), draft(9000000002, 'Guanti da moto "Pro"')] }
    s.failures[batch(['9000000001', '9000000002'])] = 500
    await expect(find()).rejects.toThrow('HTTP 500')
  })

  it('every failure throws, never "none": a page read, an answer without results, a batch read, a candidate missing from the batch', async () => {
    s.failures[page(0)] = 503
    await expect(find()).rejects.toThrow('HTTP 503')
    delete s.failures[page(0)]
    s.answers[page(0)] = { count: 1 }
    await expect(find()).rejects.toThrow('without its listings')
    s.answers[page(0)] = { count: 1, results: [draft(9000000001, 'Guanti da moto "Pro"')] }
    s.failures[batch(['9000000001'])] = 503
    await expect(find()).rejects.toThrow('HTTP 503')
    delete s.failures[batch(['9000000001'])]
    // A lone draft Etsy no longer holds (404 in the batch AND on its own GET) is not a candidate: "none", not a failure.
    s.failures[batch(['9000000001'])] = 404
    s.failures[PATHS.plain] = 404
    await expect(find()).resolves.toEqual([])
    delete s.failures[batch(['9000000001'])]; delete s.failures[PATHS.plain]
    s.answers[batch(['9000000001'])] = { results: [{ listing_id: 9000000001, inventory: null }] }
    await expect(find()).rejects.toThrow('did not return the inventory of draft 9000000001')
    await expect(find({ title: '  ' })).rejects.toThrow('no title')
    await expect(find({ since: 'yesterday' })).rejects.toThrow('no start time')
  })

  it('reads only this account\'s own shop (the shop id comes from the account), and takes injected reads', async () => {
    const reads = { drafts: vi.fn(async () => ({ count: 1, results: [draft(9000000001, 'Guanti da moto "Pro"')] })),
      inventories: vi.fn(async () => ({ results: [inventoryOf(9000000001, ['FAKE-SKU-1'])] })), listingPlain: vi.fn(), inventory: vi.fn() }
    expect((await findEtsyDrafts('account', { title: 'Guanti da moto "Pro"', since: SINCE, skus: ['FAKE-SKU-1'] }, reads)).map(d => d.listingId)).toEqual(['9000000001'])
    expect(reads.drafts).toHaveBeenCalledWith(0)
    expect(reads.inventories).toHaveBeenCalledWith(['9000000001'])
    expect(etsyReader).not.toHaveBeenCalled()
    // The default reads: the drafts and batch paths are built from the account's shop, and a bad id never becomes a path.
    expect(() => etsyListingReads('account').inventories(['12x'])).toThrow('not an Etsy listing id')
    expect(() => etsyListingReads('account').inventories([])).toThrow()
    expect(() => etsyListingReads('account').drafts(-1)).toThrow()
  })
})
