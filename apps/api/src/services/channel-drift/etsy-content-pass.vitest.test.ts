import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * E5a — the content pass of the 4-hourly Etsy sweep: which calls it makes (none for a shop Nexus knows nothing of), which
 * row it records on (the listing's main row only), the property cap, the batch inventory fallback (a dead id is split
 * out), the budget, and that one failure never stops the next listing. The database, "ours" and the drift writer are
 * mocked; the comparison and the live normaliser are REAL. The E5a review probes run the REAL writer over an in-memory
 * ChannelDrift store (`h.store`): what a later sweep keeps or clears is what the sheet mark reads. Fake ids only: shop
 * `90000001`, listings `9000000001…`, SKUs `FAKE-SKU-…`, properties 200/513 (46: an attribute only Etsy holds).
 */
const h = vi.hoisted(() => ({
  listings: [] as Array<Record<string, unknown>>,
  drifts: [] as Array<Record<string, unknown>>,
  writes: [] as Array<Record<string, any>>,
  recordThrowsFor: null as string | null,
  ours: vi.fn(),
  photoCount: vi.fn(),
  listingWrites: vi.fn(),
  /** The in-memory ChannelDrift rows the real writer reads and writes (null: the stored rows are `drifts`). */
  store: null as Map<string, Record<string, any>> | null,
}))
vi.mock('../../db.js', () => ({ default: {
  channelListing: { findMany: vi.fn(async () => h.listings), update: h.listingWrites, updateMany: h.listingWrites, create: h.listingWrites, upsert: h.listingWrites },
  channelDrift: {
    findMany: vi.fn(async (args: { where: { channelListingId: { in: string[] } } }) => h.store
      ? [...h.store.values()].filter(row => args.where.channelListingId.in.includes(row.channelListingId)) : h.drifts),
    findFirst: vi.fn(async (args: { where: { channelListingId: string } }) => [...(h.store?.values() ?? [])].find(row => row.channelListingId === args.where.channelListingId) ?? null),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(h.store!.get(args.where.id)!, args.data)),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => { const row = { id: `cd-${h.store!.size + 1}`, ...args.data }; h.store!.set(row.id, row); return row }),
  },
} }))
vi.mock('./etsy-content-ours.js', () => ({
  etsyContentOurs: (...args: unknown[]) => h.ours(...args),
  etsyNexusPhotoCount: (...args: unknown[]) => h.photoCount(...args),
}))
vi.mock('../channel-drift.service.js', () => ({
  recordChannelReadback: vi.fn(async (input: Record<string, any>) => {
    if (h.recordThrowsFor === input.channelListingId) throw new Error('the drift write failed')
    h.writes.push(input)
    return { driftCount: input.differing?.length ?? 0 }
  }),
}))

import prisma from '../../db.js'
import { EtsyReadError } from '../etsy/read-client.js'
import type { EtsyPublication } from '../pim/studio-publication-etsy-types.js'
import { ETSY_CONTENT_SOURCE, ETSY_NOT_ON_MEDIA_PLAN, PHOTO_COUNT_FIELD } from './etsy-content-compare.js'
import { ETSY_BUDGET_LEFT, ETSY_CONTENT_BUDGET_MS, ETSY_INVENTORY_BATCH_CALLS_PER_RUN, ETSY_MANY_MAIN_ROWS, ETSY_NO_MAIN_ROW, ETSY_NO_VARIATIONS, ETSY_PAGE_FAILED,
  ETSY_PAGE_REFUSED, ETSY_PAGE_TIMED_OUT, ETSY_PASS_RUNNING, ETSY_PROPERTY_READS_PER_RUN, etsyContentLockKey, startEtsyContentPass, type EtsyContentDeps,
  type EtsyContentLockStore, type EtsyContentReader } from './etsy-content-pass.js'

const SHOP_PATH = '/shops/90000001'
const AT = new Date('2026-10-06T08:20:00.000Z')
const STATES = ['active', 'inactive', 'sold_out', 'draft', 'expired', 'removed']
const listingId = (n: number) => String(9000000000 + n)
const propertiesPath = (n: number) => `/shops/90000001/listings/${listingId(n)}/properties`

const VALUES = { title: 'Leather knee slider', description: 'A hand-stitched knee slider.', tags: ['moto'], materials: [], taxonomy_id: 1234,
  classification: { who_made: 'i_did', when_made: '2020_2026', is_supply: false }, type: null, shop_section_id: null, shipping_profile_id: 7001, return_policy_id: null,
  item_weight: { value: null, unit: null }, item_dimensions: { length: null, width: null, height: null, unit: null }, is_taxable: null, should_auto_renew: null,
  production_partner_ids: [], styles: [] }
const SIZE = { property_id: 513, property_name: 'Size', value_ids: [], values: ['M'], scale_id: null }
/** Nexus's side as the publisher would build it for a one-variation family (sending off: Etsy not read). */
const publication = (n = 1): EtsyPublication => ({
  kind: 'etsy', marketplace: 'GLOBAL', listingId: listingId(n), products: [{ productId: 'p', sku: 'FAKE-SKU-1' }, { productId: 'c1', sku: 'FAKE-SKU-2' }],
  inventoryProducts: [{ productId: 'c1', sku: 'FAKE-SKU-2' }], ownerProductId: 'p', values: VALUES as EtsyPublication['values'], form: {},
  inventory: { products: [] } as unknown as EtsyPublication['inventory'],
  structure: { properties: [{ property_id: 200, property_name: 'Primary color', scale_id: null }],
    products: [{ sku: 'FAKE-SKU-2', values: [{ property_id: 200, values: ['Black'] }], readiness_state_id: 5001 }],
    price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [] },
  properties: [SIZE], translations: [], create: null, live: null, liveRevision: null, liveSkipped: 'The review reads the live Etsy listing only when sending to Etsy is on.', currency: 'EUR',
})
/** The facts the live refusals read: the market's currency and language, the variation's listing (on Etsy) and price, the shop's currency. */
const FACTS = { languages: ['en'], destination: { currency: 'EUR' }, account: { identity: { extra: { currencyCode: 'EUR' } } },
  products: [{ id: 'p', sku: 'FAKE-SKU-1', basePrice: 25 }, { id: 'c1', sku: 'FAKE-SKU-2', basePrice: 25 }],
  listings: [{ productId: 'c1', externalListingId: '9000000001', followMasterPrice: true, priceOverride: null, price: null, pricingRule: 'FIXED', priceAdjustmentPercent: null }] }

const inventory = () => ({ products: [{ product_id: 1, sku: 'FAKE-SKU-2', is_deleted: false,
  property_values: [{ property_id: 200, property_name: 'Primary color', scale_id: null, value_ids: [1], values: ['Black'] }],
  offerings: [{ offering_id: 1, quantity: 2, is_enabled: true, is_deleted: false, price: { amount: 2400, divisor: 100, currency_code: 'EUR' }, readiness_state_id: 5001 }] }],
  price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [] })
const image = (k: number) => ({ listing_image_id: 8000000000 + k, rank: k, url_570xN: `https://img.example/${k}.jpg` })
/** One getListingsByShop row with its includes. */
const row = (n: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({ listing_id: Number(listingId(n)), shop_id: 90000001, state: 'active', language: 'en',
  title: VALUES.title, description: VALUES.description, tags: ['moto'], materials: [], taxonomy_id: 1234, who_made: 'i_did', when_made: '2020_2026', is_supply: false,
  listing_type: 'physical', shipping_profile_id: 7001, inventory: inventory(), images: [image(1), image(2)], translations: [], ...over })
const SHOP = { shop_id: 90000001, languages: ['en'], currency_code: 'EUR' }
const PROPERTIES = { count: 1, results: [{ property_id: 513, property_name: 'Size', scale_id: null, value_ids: [1], values: ['M'] }] }
const known = (n: number, over: Record<string, unknown> = {}) => ({ id: `cl-${n}`, productId: `prod-${n}`, marketplace: 'GLOBAL', aliasKey: '',
  externalListingId: listingId(n), channelConnectionId: 'acc-etsy', product: { parentId: null }, ...over })

/** The account's gateway reader, stubbed: `get` is the spy, `etsy` the reader the pass takes. */
function reader(answers: Record<string, unknown> = {}) {
  const paths: string[] = []
  const get = vi.fn(async (path: string): Promise<unknown> => {
    paths.push(path)
    const answer = path in answers ? answers[path] : path === SHOP_PATH ? SHOP : path.endsWith('/properties') ? PROPERTIES : undefined
    if (answer instanceof Error) throw answer
    if (answer === undefined) throw new EtsyReadError(404)
    return structuredClone(answer)
  })
  const etsy: EtsyContentReader = { shopId: '90000001', get: <T>(path: string) => get(path) as Promise<T> }
  return { paths, get, etsy }
}
/** A Redis stand-in for the lease: `SET NX PX`, the holder-only renew and release. */
function lockStore(): EtsyContentLockStore & { keys: Map<string, string> } {
  const keys = new Map<string, string>()
  return {
    keys, status: 'ready',
    eval: vi.fn(async (script: string, _keys: number, ...args: Array<string | number>) => {
      const [key, token] = [String(args[0]), String(args[1])]
      if (script.includes("'NX'")) { if (keys.has(key)) return 0; keys.set(key, token); return 1 }
      if (script.includes('pexpire')) return keys.get(key) === token ? 1 : 0
      if (script.includes("'del'")) { if (keys.get(key) !== token) return 0; keys.delete(key); return 1 }
      return 0
    }),
  }
}
const start = (r: ReturnType<typeof reader>, deps: EtsyContentDeps = {}) =>
  startEtsyContentPass({ accountId: 'acc-etsy', reader: r.etsy, at: AT, deps: { lockStore: lockStore(), ...deps } })
/** The real drift writer (channel-drift.service.ts), over `h.store`. */
const realWriter = async () => (await vi.importActual<typeof import('../channel-drift.service.js')>('../channel-drift.service.js')).recordChannelReadback
const storedFields = (listing: string) => ([...(h.store?.values() ?? [])].find(row => row.channelListingId === listing)?.driftedFields ?? [])
  .filter((entry: { source: string }) => entry.source === ETSY_CONTENT_SOURCE).map((entry: { field: string }) => entry.field).sort()
const clockOf = (listing: string) => [...(h.store?.values() ?? [])].find(row => row.channelListingId === listing)?.checkedBySource?.[ETSY_CONTENT_SOURCE]
const writeOn = (id: string) => h.writes.filter(write => write.channelListingId === id)

beforeEach(() => {
  vi.clearAllMocks()
  h.listings = [known(1)]
  h.drifts = []
  h.writes = []
  h.recordThrowsFor = null
  h.store = null
  h.ours.mockReset().mockImplementation(async (id: string) => ({ ok: true, facts: FACTS, publication: publication(Number(id.slice(3))) }))
  h.photoCount.mockReset().mockImplementation(async () => ({ count: 2 }))
})

describe('a shop Nexus knows nothing of', () => {
  it('is inert: no includes on any page, no Etsy call, nothing written', async () => {
    h.listings = []
    const r = reader()
    const pass = await start(r)
    for (const state of STATES) expect(pass.includes(state)).toBe('')
    pass.collect(row(1), 'active')
    expect(await pass.finish()).toEqual({ listings: 0, compared: 0, drifted: 0, notCompared: 0, reasons: {}, extraCalls: 0, errors: 0 })
    expect(r.get).not.toHaveBeenCalled()
    expect(h.writes).toEqual([])
    expect(h.ours).not.toHaveBeenCalled()
  })

  it('a stored id that is not an Etsy id is not a known listing', async () => {
    h.listings = [known(1, { externalListingId: 'abc' })]
    const r = reader()
    const pass = await start(r)
    expect(pass.includes('active')).toBe('')
    expect(r.get).not.toHaveBeenCalled()
  })
})

describe('a shop with a listing Nexus knows', () => {
  it('asks for the includes only on the four compared states, and reads the shop once', async () => {
    const r = reader()
    const pass = await start(r)
    expect(Object.fromEntries(STATES.map(state => [state, pass.includes(state)]))).toEqual({ active: '&includes=Inventory,Images,Translations',
      inactive: '&includes=Inventory,Images,Translations', sold_out: '&includes=Inventory,Images,Translations', draft: '&includes=Inventory,Images,Translations',
      expired: '', removed: '' })
    expect(r.paths).toEqual([SHOP_PATH])
    const where = vi.mocked(prisma.channelListing.findMany).mock.calls[0][0] as { where: unknown }
    expect(where.where).toEqual({ channel: 'ETSY', channelConnectionId: 'acc-etsy', externalListingId: { not: null }, product: { deletedAt: null } })
  })

  it('records ONE read on the main row, source etsy-content, with the properties read once', async () => {
    const r = reader()
    const pass = await start(r)
    pass.collect(row(1), 'active')
    const tally = await pass.finish()
    expect(r.paths).toEqual([SHOP_PATH, propertiesPath(1)])
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0]).toMatchObject({ channelListingId: 'cl-1', channel: 'ETSY', marketplace: 'GLOBAL', source: ETSY_CONTENT_SOURCE, checkedAt: AT,
      outcome: 'compared', differing: [] })
    // Every line of the review: the fields empty in Nexus are settled (compared, no difference).
    expect(h.writes[0].compared).toEqual(['title', 'description', 'tags', 'materials', 'taxonomy_id', 'classification', 'type', 'shop_section_id',
      'shipping_profile_id', 'return_policy_id', 'item_weight', 'item_dimensions', 'is_taxable', 'should_auto_renew', 'production_partner_ids', 'styles',
      'property:513', 'inventory', PHOTO_COUNT_FIELD])
    expect(h.writes[0].notCompared).toBe(0)
    expect(h.ours).toHaveBeenCalledWith('cl-1')
    expect(h.photoCount).toHaveBeenCalledWith({ productId: 'prod-1', channelConnectionId: 'acc-etsy', aliasKey: '' })
    expect(tally).toEqual({ listings: 1, compared: 1, drifted: 0, notCompared: 0, reasons: {}, extraCalls: 2, errors: 0 })
  })

  it('a difference is recorded with both sides, and counted', async () => {
    const pass = await start(reader())
    pass.collect(row(1, { title: 'Old title on Etsy' }), 'active')
    const tally = await pass.finish()
    expect(h.writes[0].differing).toEqual([{ field: 'title', ours: VALUES.title, theirs: 'Old title on Etsy' }])
    expect(tally).toMatchObject({ compared: 1, drifted: 1 })
  })

  it('Nexus\'s photo count is compared with the images on the row; a family with no Etsy photo list is not compared on photos', async () => {
    h.photoCount.mockImplementation(async () => ({ count: 3 }))
    let pass = await start(reader())
    pass.collect(row(1), 'active')
    await pass.finish()
    expect(h.writes[0].differing).toEqual([{ field: PHOTO_COUNT_FIELD, ours: { count: 3 }, theirs: { count: 2, images: [
      { listing_image_id: '8000000001', rank: 1, url: 'https://img.example/1.jpg' }, { listing_image_id: '8000000002', rank: 2, url: 'https://img.example/2.jpg' }] } }])
    // A family not on the media plan: nothing of Nexus's to differ — settled, so an older photo difference clears.
    h.photoCount.mockImplementation(async () => ({ count: null, reason: ETSY_NOT_ON_MEDIA_PLAN }))
    pass = await start(reader())
    pass.collect(row(1), 'active')
    await pass.finish()
    expect(h.writes[1]).toMatchObject({ outcome: 'compared', differing: [] })
    expect(h.writes[1].compared).toContain(PHOTO_COUNT_FIELD)
    // Any other failure to count Nexus's photos: not compared (an older difference is kept).
    h.photoCount.mockImplementation(async () => ({ count: null, reason: 'This destination cannot receive photos.' }))
    pass = await start(reader())
    pass.collect(row(1), 'active')
    await pass.finish()
    expect(h.writes[2].compared).not.toContain(PHOTO_COUNT_FIELD)
  })

  it('keeps the LAST row of a listing seen twice (it moved state during the sweep)', async () => {
    const pass = await start(reader())
    pass.collect(row(1, { title: 'First read' }), 'active')
    pass.collect(row(1, { state: 'inactive' }), 'inactive')
    await pass.finish()
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0].differing).toEqual([])
  })

  it('a variation-only match is not compared, written on that one row only', async () => {
    h.listings = [known(1, { product: { parentId: 'prod-0' } })]
    const r = reader()
    const pass = await start(r)
    pass.collect(row(1), 'active')
    const tally = await pass.finish()
    expect(h.writes).toEqual([expect.objectContaining({ channelListingId: 'cl-1', outcome: 'not_compared', reason: ETSY_NO_MAIN_ROW, compared: [] })])
    expect(r.paths).toEqual([SHOP_PATH])
    expect(h.ours).not.toHaveBeenCalled()
    expect(tally).toMatchObject({ compared: 0, notCompared: 1, reasons: { [ETSY_NO_MAIN_ROW]: 1 } })
  })

  it('two main rows holding one listing id: counted, written on neither', async () => {
    h.listings = [known(1), known(1, { id: 'cl-1b', productId: 'prod-1b' })]
    const pass = await start(reader())
    pass.collect(row(1), 'active')
    const tally = await pass.finish()
    expect(h.writes).toEqual([])
    expect(tally).toMatchObject({ listings: 1, notCompared: 1, reasons: { [ETSY_MANY_MAIN_ROWS]: 1 } })
  })

  it('a main row and its variation rows: the record goes on the main row only', async () => {
    h.listings = [known(1), known(1, { id: 'cl-1v', productId: 'prod-1v', product: { parentId: 'prod-1' } })]
    const pass = await start(reader())
    pass.collect(row(1), 'active')
    await pass.finish()
    expect(h.writes.map(write => write.channelListingId)).toEqual(['cl-1'])
  })

  it('an ended listing (expired) is recorded not compared, with no call and no review', async () => {
    const r = reader()
    const pass = await start(r)
    pass.collect(row(1, { state: 'expired' }), 'expired')
    await pass.finish()
    expect(h.writes).toEqual([expect.objectContaining({ channelListingId: 'cl-1', outcome: 'not_compared', reason: 'the listing ended on Etsy (expired)' })])
    expect(r.paths).toEqual([SHOP_PATH])
    expect(h.ours).not.toHaveBeenCalled()
  })

  it('a page read again without its includes is still compared: its variations from the batch read, its images and translations not', async () => {
    h.listings = [known(1), known(2)]
    const plainRow = (n: number) => row(n, { inventory: undefined, images: undefined, translations: undefined })
    const batchPath = `/listings/batch/inventory?listing_ids=${listingId(1)},${listingId(2)}`
    const r = reader({ [batchPath]: { count: 2, results: [{ listing_id: Number(listingId(1)), ...inventory() }, { listing_id: Number(listingId(2)), ...inventory() }] } })
    const pass = await start(r)
    pass.pageWithoutContent('active', [listingId(1), 'not-an-id'])
    pass.collect(plainRow(1), 'active')
    pass.pageWithoutContent('draft', [listingId(2)], 'timeout')
    pass.collect(plainRow(2), 'draft')
    const tally = await pass.finish()
    expect(r.paths.filter(path => path.startsWith('/listings/batch/'))).toEqual([batchPath])
    for (const id of ['cl-1', 'cl-2']) {
      const [write] = writeOn(id)
      expect(write).toMatchObject({ outcome: 'compared', differing: [] })
      expect(write.compared).toEqual(expect.arrayContaining(['title', 'inventory', 'property:513']))
      expect(write.compared).not.toContain(PHOTO_COUNT_FIELD)
    }
    // Each failed page with the includes cost one extra call; plus the shop, the batch and two attribute reads.
    expect(tally.extraCalls).toBe(2 + 1 + 1 + 2)
  })

  it('a page read without its includes whose variations cannot be read either: not compared, saying both', async () => {
    const r = reader({ [`/listings/batch/inventory?listing_ids=${listingId(1)}`]: new EtsyReadError(503) })
    const pass = await start(r)
    pass.pageWithoutContent('active', [listingId(1)], 'failed')
    pass.collect(row(1, { inventory: undefined, images: undefined, translations: undefined }), 'active')
    await pass.finish()
    expect(h.writes).toEqual([expect.objectContaining({ outcome: 'not_compared', reason: `${ETSY_PAGE_FAILED} ${ETSY_NO_VARIATIONS}` })])
    expect(r.paths.filter(path => path.endsWith('/properties'))).toEqual([])
  })

  it('Etsy REFUSES the includes once: they are not asked for again in this run; a timeout or another failure does not stop them', async () => {
    h.listings = [known(1)]
    let pass = await start(reader())
    pass.pageWithoutContent('active', [], 'timeout')
    pass.pageWithoutContent('inactive', [], 'failed')
    expect(pass.includes('sold_out')).toBe('&includes=Inventory,Images,Translations')
    pass.pageWithoutContent('sold_out', [], 'refused')
    for (const state of STATES) expect(pass.includes(state)).toBe('')
    expect((await pass.finish()).extraCalls).toBe(1 + 3)
    pass = await start(reader())
    expect(pass.includes('active')).toBe('&includes=Inventory,Images,Translations')
  })

  it('a review that refuses the listing: not compared with its reason, and no Etsy call for it', async () => {
    h.ours.mockImplementation(async () => ({ ok: false, reason: 'the Etsy review refused: Title is empty.' }))
    const r = reader()
    const pass = await start(r)
    pass.collect(row(1), 'active')
    const tally = await pass.finish()
    expect(h.writes).toEqual([expect.objectContaining({ outcome: 'not_compared', reason: 'the Etsy review refused: Title is empty.' })])
    expect(r.paths).toEqual([SHOP_PATH])
    expect(tally.reasons).toEqual({ 'the Etsy review refused': 1 })
  })

  it('NEVER-checked listings first, then the oldest etsy-content read', async () => {
    h.listings = [known(1), known(2), known(3)]
    h.drifts = [
      { channelListingId: 'cl-1', checkedBySource: { [ETSY_CONTENT_SOURCE]: { at: '2026-10-06T04:20:00.000Z', outcome: 'compared', differing: 0 } }, driftedFields: [] },
      { channelListingId: 'cl-2', checkedBySource: { [ETSY_CONTENT_SOURCE]: { at: '2026-10-06T00:20:00.000Z', outcome: 'compared', differing: 0 }, 'other-source': { at: '2020-01-01T00:00:00.000Z' } }, driftedFields: [] },
    ]
    const pass = await start(reader())
    for (const n of [1, 2, 3]) pass.collect(row(n), 'active')
    await pass.finish()
    expect(h.writes.map(write => write.channelListingId)).toEqual(['cl-3', 'cl-2', 'cl-1'])
  })

  it('what it recorded earlier: on neither side any more, or now empty in Nexus → cleared; unread on Etsy now → kept', async () => {
    h.drifts = [{ channelListingId: 'cl-1', checkedBySource: {}, driftedFields: [
      { field: 'translation:fr', source: ETSY_CONTENT_SOURCE, ours: {}, theirs: null, checkedAt: '2026-10-05T00:00:00.000Z' },
      { field: 'materials', source: ETSY_CONTENT_SOURCE, ours: ['x'], theirs: ['y'], checkedAt: '2026-10-05T00:00:00.000Z' },
      { field: PHOTO_COUNT_FIELD, source: ETSY_CONTENT_SOURCE, ours: { count: 3 }, theirs: { count: 2 }, checkedAt: '2026-10-05T00:00:00.000Z' },
      { field: 'translation:es', source: 'another-source', ours: 1, theirs: 2, checkedAt: '2026-10-05T00:00:00.000Z' }] }]
    const pass = await start(reader())
    // The row came without its images this time: Etsy's side of the photos is unknown.
    pass.collect(row(1, { images: undefined }), 'active')
    await pass.finish()
    expect(h.writes[0].compared).toContain('translation:fr')
    // Materials are empty in Nexus now (Etsy keeps its value; the review never shows a difference): settled (E5a review M2).
    expect(h.writes[0].compared).toContain('materials')
    expect(h.writes[0].compared).not.toContain(PHOTO_COUNT_FIELD)
    expect(h.writes[0].compared).not.toContain('translation:es')
  })

  it(`over ${ETSY_PROPERTY_READS_PER_RUN} property reads in a run, the rest are not compared on their attributes`, async () => {
    const count = ETSY_PROPERTY_READS_PER_RUN + 1
    h.listings = Array.from({ length: count }, (_, i) => known(i + 1))
    const r = reader()
    const pass = await start(r)
    for (let n = 1; n <= count; n++) pass.collect(row(n), 'active')
    const tally = await pass.finish()
    expect(r.paths.filter(path => path.endsWith('/properties'))).toHaveLength(ETSY_PROPERTY_READS_PER_RUN)
    expect(h.writes).toHaveLength(count)
    const last = writeOn(`cl-${count}`)[0]
    expect(last.outcome).toBe('compared')
    expect(last.compared).not.toContain('property:513')
    expect(writeOn('cl-1')[0].compared).toContain('property:513')
    expect(tally).toMatchObject({ compared: count, extraCalls: 1 + ETSY_PROPERTY_READS_PER_RUN })
  })

  it('a failed property read: that listing\'s attributes are not compared, the rest is', async () => {
    const r = reader({ [propertiesPath(1)]: new EtsyReadError(503) })
    const pass = await start(r)
    pass.collect(row(1), 'active')
    await pass.finish()
    expect(h.writes[0]).toMatchObject({ outcome: 'compared' })
    expect(h.writes[0].compared).not.toContain('property:513')
    expect(h.writes[0].compared).toContain('title')
  })

  it('the budget runs out: the later listings are not touched, their clocks stay as they were', async () => {
    h.listings = [known(1), known(2)]
    const clock = [0, 0, ETSY_CONTENT_BUDGET_MS]
    const pass = await start(reader(), { now: () => clock.shift() ?? ETSY_CONTENT_BUDGET_MS })
    pass.collect(row(1), 'active')
    pass.collect(row(2), 'active')
    const tally = await pass.finish()
    expect(h.writes.map(write => write.channelListingId)).toEqual(['cl-1'])
    expect(h.ours).toHaveBeenCalledTimes(1)
    expect(tally).toMatchObject({ compared: 1, notCompared: 1, reasons: { [ETSY_BUDGET_LEFT]: 1 } })
  })

  it('one failure is counted and the next listing goes on', async () => {
    h.listings = [known(1), known(2)]
    h.recordThrowsFor = 'cl-1'
    const pass = await start(reader())
    pass.collect(row(1), 'active')
    pass.collect(row(2), 'active')
    const tally = await pass.finish()
    expect(h.writes.map(write => write.channelListingId)).toEqual(['cl-2'])
    expect(tally).toMatchObject({ compared: 1, errors: 1 })
  })

  it('the same sweep twice writes the same record (idempotent)', async () => {
    for (let run = 0; run < 2; run++) {
      const pass = await start(reader())
      pass.collect(row(1, { title: 'Old title on Etsy' }), 'active')
      await pass.finish()
    }
    expect(h.writes).toHaveLength(2)
    expect(h.writes[1]).toEqual(h.writes[0])
  })

  it('never writes a ChannelListing (nor anything but the drift record)', async () => {
    h.listings = [known(1), known(2, { product: { parentId: 'prod-0' } })]
    const pass = await start(reader())
    pass.collect(row(1, { title: 'Old title on Etsy', quantity: 99, price: { amount: 1, divisor: 100 } }), 'active')
    pass.collect(row(2), 'active')
    await pass.finish()
    expect(h.writes.length).toBe(2)
    expect(h.listingWrites).not.toHaveBeenCalled()
  })
})

describe('the variations when the page row came without them: the batch read', () => {
  it('ONE batch call for two listings, then both are compared', async () => {
    h.listings = [known(1), known(2)]
    const batchPath = `/listings/batch/inventory?listing_ids=${listingId(1)},${listingId(2)}`
    const r = reader({ [batchPath]: { count: 2, results: [{ listing_id: Number(listingId(2)), ...inventory() }, { listing_id: Number(listingId(1)), ...inventory() }] } })
    const pass = await start(r)
    pass.collect(row(1, { inventory: undefined }), 'active')
    pass.collect(row(2, { inventory: undefined }), 'active')
    const tally = await pass.finish()
    expect(r.paths.filter(path => path.startsWith('/listings/batch/'))).toEqual([batchPath])
    expect(h.writes.map(write => write.outcome)).toEqual(['compared', 'compared'])
    expect(tally.extraCalls).toBe(1 + 1 + 2)
  })

  it('one dead id 404s the whole batch: it is split until the dead id stands alone; the living listing is compared', async () => {
    h.listings = [known(1), known(2)]
    const pair = `/listings/batch/inventory?listing_ids=${listingId(1)},${listingId(2)}`
    const first = `/listings/batch/inventory?listing_ids=${listingId(1)}`
    const r = reader({ [first]: { count: 1, results: [{ listing_id: Number(listingId(1)), ...inventory() }] } })
    const pass = await start(r)
    pass.collect(row(1, { inventory: undefined }), 'active')
    pass.collect(row(2, { inventory: undefined }), 'active')
    await pass.finish()
    expect(r.paths.filter(path => path.startsWith('/listings/batch/'))).toEqual([pair, first, `/listings/batch/inventory?listing_ids=${listingId(2)}`])
    expect(writeOn('cl-1')).toEqual([expect.objectContaining({ outcome: 'compared' })])
    expect(writeOn('cl-2')).toEqual([expect.objectContaining({ outcome: 'not_compared', reason: ETSY_NO_VARIATIONS })])
  })

  it('any other failure of the batch: those listings are not compared, one call', async () => {
    h.listings = [known(1), known(2)]
    const pair = `/listings/batch/inventory?listing_ids=${listingId(1)},${listingId(2)}`
    const r = reader({ [pair]: new EtsyReadError(503) })
    const pass = await start(r)
    pass.collect(row(1, { inventory: undefined }), 'active')
    pass.collect(row(2, { inventory: undefined }), 'active')
    await pass.finish()
    expect(r.paths.filter(path => path.startsWith('/listings/batch/'))).toEqual([pair])
    expect(h.writes.map(write => [write.channelListingId, write.reason])).toEqual([['cl-1', ETSY_NO_VARIATIONS], ['cl-2', ETSY_NO_VARIATIONS]])
  })

  it('a batch answer that does not name the listing is never matched by position', async () => {
    const r = reader({ [`/listings/batch/inventory?listing_ids=${listingId(1)}`]: { count: 1, results: [inventory()] } })
    const pass = await start(r)
    pass.collect(row(1, { inventory: undefined }), 'active')
    await pass.finish()
    expect(h.writes).toEqual([expect.objectContaining({ outcome: 'not_compared', reason: ETSY_NO_VARIATIONS })])
  })
})

describe('the shop cannot be read', () => {
  it('the pass is inert: no includes, nothing written, the failure named', async () => {
    const r = reader({ [SHOP_PATH]: new EtsyReadError(503) })
    const pass = await start(r)
    for (const state of STATES) expect(pass.includes(state)).toBe('')
    pass.collect(row(1), 'active')
    expect(await pass.finish()).toEqual({ listings: 0, compared: 0, drifted: 0, notCompared: 0, reasons: { 'the Etsy shop could not be read': 1 }, extraCalls: 1, errors: 1 })
    expect(h.writes).toEqual([])
    expect(r.paths).toEqual([SHOP_PATH])
  })
})

describe('E5a review probes — the REAL writer over a stored ChannelDrift row', () => {
  const stored = (listing: string, fields: Array<{ field: string; ours: unknown; theirs: unknown }>) => {
    h.store!.set(`cd-${listing}`, { id: `cd-${listing}`, channelListingId: listing, channel: 'ETSY', marketplace: 'GLOBAL', driftCount: fields.length,
      lastCheckedAt: new Date('2026-10-05T00:00:00.000Z'),
      driftedFields: fields.map(entry => ({ ...entry, source: ETSY_CONTENT_SOURCE, checkedAt: '2026-10-05T00:00:00.000Z' })),
      checkedBySource: { [ETSY_CONTENT_SOURCE]: { at: '2026-10-05T00:00:00.000Z', outcome: 'compared', differing: fields.length } } })
  }
  const ETSY_ONLY = { field: 'property:46', ours: null, theirs: { property_id: 46, property_name: 'Fake material', values: ['Wool'] } }

  it(`M1 — an attribute recorded earlier is never cleared by a run that did not read the attributes (past the ${ETSY_PROPERTY_READS_PER_RUN} cap: no flapping)`, async () => {
    h.store = new Map()
    const count = ETSY_PROPERTY_READS_PER_RUN + 1
    h.listings = Array.from({ length: count }, (_, i) => known(i + 1))
    stored('cl-1', [ETSY_ONLY])
    stored(`cl-${count}`, [ETSY_ONLY])
    const record = await realWriter()
    for (let sweep = 0; sweep < 2; sweep++) {
      const pass = await start(reader(), { record })
      for (let n = 1; n <= count; n++) pass.collect(row(n), 'active')
      await pass.finish()
      // Its attributes were read (Etsy no longer holds 46, Nexus never did): on neither side, so cleared and gone.
      expect(storedFields('cl-1')).toEqual([])
      // Past the cap, both sweeps: Etsy's side unknown, so the entry stays, every sweep.
      expect(storedFields(`cl-${count}`)).toEqual(['property:46'])
      expect(clockOf(`cl-${count}`)).toMatchObject({ outcome: 'compared', differing: 1 })
    }
  })

  it('M1 — the attributes read fails (503): the recorded attribute is kept', async () => {
    h.store = new Map()
    stored('cl-1', [ETSY_ONLY])
    const pass = await start(reader({ [propertiesPath(1)]: new EtsyReadError(503) }), { record: await realWriter() })
    pass.collect(row(1), 'active')
    await pass.finish()
    expect(storedFields('cl-1')).toEqual(['property:46'])
  })

  it('M2 — Materials differed, then were emptied in Nexus: the next sweep clears the mark', async () => {
    h.store = new Map()
    const record = await realWriter()
    const sweep = async (materials: string[]) => {
      h.ours.mockImplementation(async () => ({ ok: true, facts: FACTS, publication: { ...publication(1), values: { ...publication(1).values, materials } } }))
      const pass = await start(reader(), { record })
      pass.collect(row(1, { materials: ['cotton'] }), 'active')
      await pass.finish()
    }
    await sweep(['wool'])
    expect(storedFields('cl-1')).toEqual(['materials'])
    expect(clockOf('cl-1')).toMatchObject({ outcome: 'compared', differing: 1 })
    await sweep([])
    expect(storedFields('cl-1')).toEqual([])
    expect(clockOf('cl-1')).toMatchObject({ outcome: 'compared', differing: 0 })
  })

  it('M2 — photos: a family taken off the media plan clears its photo difference; images Etsy did not return keep it', async () => {
    h.store = new Map()
    const record = await realWriter()
    const sweep = async (photos: { count: number | null; reason?: string }, over: Record<string, unknown> = {}) => {
      h.photoCount.mockImplementation(async () => photos)
      const pass = await start(reader(), { record })
      pass.collect(row(1, over), 'active')
      await pass.finish()
    }
    await sweep({ count: 3 })
    expect(storedFields('cl-1')).toEqual([PHOTO_COUNT_FIELD])
    await sweep({ count: 3 }, { images: undefined })
    expect(storedFields('cl-1')).toEqual([PHOTO_COUNT_FIELD])
    await sweep({ count: null, reason: ETSY_NOT_ON_MEDIA_PLAN })
    expect(storedFields('cl-1')).toEqual([])
  })
})

describe('the live review\'s own refusals cost no attributes call (E5a review m5, m7)', () => {
  it('the shop\'s main language is not Nexus\'s first Etsy language: not compared, no attributes GET', async () => {
    const r = reader({ [SHOP_PATH]: { ...SHOP, languages: ['it', 'en'] } })
    const pass = await start(r)
    pass.collect(row(1), 'active')
    await pass.finish()
    expect(h.writes).toEqual([expect.objectContaining({ outcome: 'not_compared',
      reason: 'the Etsy review refused: This Etsy shop\'s main language is it, but Nexus\'s first language for Etsy is en. Put it first in the Etsy market\'s languages.' })])
    expect(r.paths).toEqual([SHOP_PATH])
  })

  it('a variation Etsy no longer holds, with no price in Nexus: not compared with the review\'s words, no attributes GET', async () => {
    h.ours.mockImplementation(async () => ({ ok: true, publication: publication(1),
      facts: { ...FACTS, products: [{ id: 'p', sku: 'FAKE-SKU-1', basePrice: 25 }, { id: 'c1', sku: 'FAKE-SKU-2', basePrice: null }] } }))
    const r = reader()
    const pass = await start(r)
    // Etsy holds another variation (FAKE-SKU-9), not FAKE-SKU-2 that Nexus records on the listing.
    const held = inventory()
    pass.collect(row(1, { inventory: { ...held, products: held.products.map(entry => ({ ...entry, sku: 'FAKE-SKU-9' })) } }), 'active')
    await pass.finish()
    expect(h.writes).toEqual([expect.objectContaining({ outcome: 'not_compared',
      reason: 'the Etsy review refused: FAKE-SKU-2: This product has no master price. Set the master price, or this listing\'s own price.' })])
    expect(r.paths).toEqual([SHOP_PATH])
  })
})

describe('the batch read\'s call cap', () => {
  it(`at most ${ETSY_INVENTORY_BATCH_CALLS_PER_RUN} batch calls a run, splits included; the rest are not compared`, async () => {
    const count = 26
    h.listings = Array.from({ length: count }, (_, i) => known(i + 1))
    const r = reader()
    const pass = await start(r)
    for (let n = 1; n <= count; n++) pass.collect(row(n, { inventory: undefined }), 'active')
    await pass.finish()
    expect(r.paths.filter(path => path.startsWith('/listings/batch/'))).toHaveLength(ETSY_INVENTORY_BATCH_CALLS_PER_RUN)
    expect(h.writes).toHaveLength(count)
    expect(h.writes.every(write => write.outcome === 'not_compared' && write.reason === ETSY_NO_VARIATIONS)).toBe(true)
  })
})

describe('one pass per account at a time (E5a review n12: the cron and a manual Run)', () => {
  it('a second pass while the first holds the lease is inert; once the first finishes, the next one runs', async () => {
    const store = lockStore()
    const first = await start(reader(), { lockStore: store })
    expect(store.keys.has(etsyContentLockKey('acc-etsy'))).toBe(true)
    const r = reader()
    const second = await start(r, { lockStore: store })
    for (const state of STATES) expect(second.includes(state)).toBe('')
    expect(r.get).not.toHaveBeenCalled()
    expect(await second.finish()).toEqual({ listings: 0, compared: 0, drifted: 0, notCompared: 0, reasons: { [ETSY_PASS_RUNNING]: 1 }, extraCalls: 0, errors: 0 })
    first.collect(row(1), 'active')
    await first.finish()
    expect(store.keys.size).toBe(0)
    const third = await start(reader(), { lockStore: store })
    expect(third.includes('active')).toBe('&includes=Inventory,Images,Translations')
    await third.finish()
  })

  it('no Redis: inert, and said as an error; Nexus knowing nothing of the shop takes no lease at all', async () => {
    const r = reader()
    const pass = await start(r, { lockStore: null })
    expect(r.get).not.toHaveBeenCalled()
    expect(await pass.finish()).toMatchObject({ errors: 1, reasons: { 'the content pass could not take its lock': 1 } })
    h.listings = []
    const store = lockStore()
    await start(reader(), { lockStore: store })
    expect(store.eval).not.toHaveBeenCalled()
  })

  // E5a review R2-3 — a Redis that never answers can hold neither this account's status sweep nor finish().
  it('a claim Redis never answers: inert within the timeout, counted and named; no Etsy call', async () => {
    const hung: EtsyContentLockStore = { status: 'ready', eval: vi.fn(() => new Promise<unknown>(() => {})) }
    const r = reader()
    const pass = await start(r, { lockStore: hung, lockTimeoutMs: 20 })
    for (const state of STATES) expect(pass.includes(state)).toBe('')
    expect(r.get).not.toHaveBeenCalled()
    expect(await pass.finish()).toMatchObject({ listings: 0, errors: 1, reasons: { 'the content pass could not take its lock': 1 } })
  })

  it('a claim that lands after the timeout is let go at once (the pass does not run)', async () => {
    let land: (answer: unknown) => void = () => {}
    const scripts: string[] = []
    const late: EtsyContentLockStore = { status: 'ready', eval: vi.fn((script: string) => {
      scripts.push(script.includes("'NX'") ? 'claim' : script.includes("'del'") ? 'release' : 'other')
      return script.includes("'NX'") ? new Promise<unknown>(resolve => { land = resolve }) : Promise.resolve(1)
    }) }
    await start(reader(), { lockStore: late, lockTimeoutMs: 20 })
    land(1)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(scripts).toEqual(['claim', 'release'])
  })

  it('a release Redis never answers: finish() still returns the tally, without throwing', async () => {
    const store = lockStore()
    const claimOnly: EtsyContentLockStore = { status: 'ready', eval: vi.fn((script: string, keys: number, ...args: Array<string | number>) =>
      script.includes("'del'") ? new Promise<unknown>(() => {}) : store.eval(script, keys, ...args)) }
    const pass = await start(reader(), { lockStore: claimOnly, lockTimeoutMs: 20 })
    pass.collect(row(1), 'active')
    expect(await pass.finish()).toMatchObject({ listings: 1, compared: 1, errors: 0 })
  })

  it('a shop that cannot be read lets go of the lease at once', async () => {
    const store = lockStore()
    await start(reader({ [SHOP_PATH]: new EtsyReadError(503) }), { lockStore: store })
    expect(store.keys.size).toBe(0)
  })
})
