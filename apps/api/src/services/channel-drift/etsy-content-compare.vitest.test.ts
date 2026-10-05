import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * E5a — the Etsy content comparison is the publish review's own. Publications come from the REAL publisher
 * (`prepareEtsyPublication`, sending off: no live read), Etsy's side from the REAL live normaliser run on a fake
 * `getListingsByShop` row (`etsyPageRaw` → `normaliseEtsyListing`). The database, the publish gate, the stock ledgers and
 * the variation projection are the E2 fixture (studio-publication-etsy.vitest.test.ts). Fake ids only: shop `90000001`,
 * listing `9000000001`, images `8000000001…`, SKUs `FAKE-SKU-…`, properties 200/513.
 */
const m = vi.hoisted(() => ({
  mode: 'gated' as string, products: ['p', 'c1', 'c2'], languages: ['en'], main: {} as Record<string, unknown>,
  values: { c1: 'Black', c2: 'Red' } as Record<string, string>, own: {} as Record<string, Record<string, unknown>>,
  basePrice: {} as Record<string, number | null>, shopCurrency: 'EUR' as string | null,
  // E2 — Etsy order import, as `etsyStockWriteRefusal` answers it (null: on and activated).
  stockRefusal: null as { code: string; sentence: string } | null,
}))

vi.mock('../../db.js', () => ({ default: { channelListing: { findFirst: async () => null } } }))
vi.mock('../../lib/queue.js', () => ({ redis: null, addJobSafely: vi.fn(), outboundSyncQueue: null, channelSyncQueue: null, readCacheQueue: null, readinessQueue: null,
  searchIndexQueue: null, bulkJobQueue: null, publicationBatchQueue: null, agentPlanQueue: null, adsSyncQueue: null }))
vi.mock('../etsy-publish-gate.service.js', () => ({ getEtsyPublishMode: () => m.mode }))
vi.mock('../etsy/order-ingest-switch.js', () => ({ etsyStockWriteRefusal: async () => m.stockRefusal }))
vi.mock('../stock-pool/sync-ledgers.js', () => ({ loadSyncLedgers: async () => new Map() }))
const AXIS = { axisKey: 'color', familyKey: 'color', label: 'Color', channelName: 'Primary color', target: 'property_200', included: true }
vi.mock('../pim/stored-variation-projection.js', async original => ({
  ...(await original<typeof import('../pim/stored-variation-projection.js')>()),
  loadStoredVariationProjection: async () => ({
    input: { family: { variants: ['c1', 'c2'].map(id => ({ id, sku: SKUS[id], included: true, axisValues: { color: m.values[id] } })) } },
    cell: { axes: [AXIS] },
  }),
}))
vi.mock('../pim/variation-rules.service.js', async original => ({
  ...(await original<typeof import('../pim/variation-rules.service.js')>()),
  resolveVariationProjection: () => ({ axes: [AXIS], dropped: [] }),
  variationReadinessItems: () => [],
}))

import { normaliseEtsyListing } from '../live-read/etsy.js'
import { prepareEtsyChanges } from '../pim/studio-publication-etsy-changes.js'
import { EtsyPublicationProblems } from '../pim/studio-publication-etsy-problems.js'
import { prepareEtsyPublication } from '../pim/studio-publication-etsy.js'
import type { EtsyLiveListing, EtsyPublication } from '../pim/studio-publication-etsy-types.js'
import { compareEtsyContent, etsyLiveImages, etsyLiveRefusal, etsyPageRaw, withEtsyLive, ETSY_COMPARED_STATES, ETSY_CONTENT_SOURCE, ETSY_IMAGES_UNREAD,
  ETSY_NOT_ON_MEDIA_PLAN, ETSY_PAGE_INCLUDES, ETSY_PROPERTIES_UNREAD, PHOTO_COUNT_FIELD, type EtsyLiveImage } from './etsy-content-compare.js'

const SKUS: Record<string, string> = { p: 'FAKE-SKU-1', c1: 'FAKE-SKU-2', c2: 'FAKE-SKU-3' }
const LISTING = '9000000001'
const MAIN = { title: 'Leather knee slider', description: 'A hand-stitched knee slider.', taxonomy_id: 1234, who_made: 'i_did', when_made: '2020_2026', is_supply: false,
  shipping_profile_id: 7001, readiness_state_id: 5001, tags: ['moto'] }
const COLOR_FIELD = { fieldKey: 'property_200', label: 'Primary color', validation: { etsyValues: [{ code: '1', label: 'Black', scaleId: null }, { code: '2', label: 'Red', scaleId: null }] } }
const cells = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, status: 'mapped', errors: [] }]))

function facts(): any {
  const family = m.products.length > 1
  const rows = m.products.map(id => ({ id, sku: SKUS[id], name: `Name ${SKUS[id]}`, isParent: family && id === 'p', parentId: id === 'p' ? null : 'p',
    basePrice: id in m.basePrice ? m.basePrice[id] : 25, totalStock: 3 }))
  const listings = m.products.map(id => ({ id: `l-${id}`, productId: id, channel: 'ETSY', marketplace: 'GLOBAL', channelConnectionId: 'acc-etsy', aliasKey: '',
    externalListingId: LISTING, listingStatus: 'ACTIVE', isPublished: true, channelSku: null, liveChannelSku: null, platformAttributes: {},
    offers: [], followMasterPrice: true, followMasterQuantity: true, price: null, priceOverride: null, pricingRule: 'FIXED', priceAdjustmentPercent: null,
    quantity: 0, quantityOverride: null, stockBuffer: 0 }))
  return {
    scope: { channel: 'ETSY', marketplace: 'GLOBAL', accountId: 'acc-etsy' },
    destination: { aliasKey: null, currency: 'EUR', familyId: 'p' },
    account: { displayName: 'abcdefghijklmnop', identity: { storeName: 'Fake Etsy shop', extra: { shopId: '90000001', currencyCode: m.shopCurrency } } },
    parent: rows[0], products: rows, listings, languages: m.languages, issues: [], skipped: [], excluded: 0,
    resolved: m.languages.map((_, locale) => ({ catalogue: { fields: [COLOR_FIELD] }, products: rows.map(row => ({ productId: row.id,
      cells: cells(row.id === 'p' ? (locale ? { title: 'Saponetta in pelle', description: 'Cucita a mano.' } : { ...MAIN, ...m.main }) : { ...(m.own[row.id] ?? {}) }) })) })),
  }
}
/** Nexus's publication as the sweep has it: built with sending off, Etsy not read. */
const ours = async () => prepareEtsyPublication(facts(), { readLive: async () => { throw new Error('not read here') } })

// ── Etsy's side: one getListingsByShop row with its includes, the shop, the listing's properties ────────────────────
const money = (amount: number) => ({ amount, divisor: 100, currency_code: 'EUR' })
const product = (sku: string, color: string, readiness: number | null = 5001): Record<string, unknown> => ({ product_id: 1, sku, is_deleted: false,
  property_values: [{ property_id: 200, property_name: 'Primary color', scale_id: null, scale_name: null, value_ids: [1], values: [color] }],
  offerings: [{ offering_id: 1, quantity: 2, is_enabled: true, is_deleted: false, price: money(2400), readiness_state_id: readiness }] })
const image = (n: number, rank = n) => ({ listing_image_id: 8000000000 + n, listing_id: 9000000001, rank, url_570xN: `https://img.example/${n}_570.jpg`, url_fullxfull: `https://img.example/${n}.jpg` })
const inventory = (over: Record<string, unknown> = {}) => ({ products: [product('FAKE-SKU-2', 'Black'), product('FAKE-SKU-3', 'Red')],
  price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [], ...over })
const pageRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ listing_id: 9000000001, shop_id: 90000001, user_id: 1, state: 'active', language: 'en',
  title: 'Leather knee slider', description: 'A hand-stitched knee slider.', tags: ['moto'], materials: ['leather'], taxonomy_id: 1234, who_made: 'i_did',
  when_made: '2020_2026', is_supply: false, listing_type: 'physical', shop_section_id: null, shipping_profile_id: 7001, return_policy_id: null,
  item_weight: null, item_weight_unit: null, item_length: null, item_width: null, item_height: null, item_dimensions_unit: null,
  is_taxable: true, should_auto_renew: false, style: [], quantity: 4, views: 9, url: 'https://www.etsy.com/listing/9000000001',
  inventory: inventory(), images: [image(1), image(2)], translations: [], ...over })
const shop = (languages = ['en']) => ({ shop_id: 90000001, shop_name: 'Fake Shop', languages, currency_code: 'EUR' })
const properties = (extra: unknown[] = []) => ({ count: 1 + extra.length, results: [{ property_id: 200, property_name: 'Primary color', scale_id: null, value_ids: [1], values: ['Black'] }, ...extra] })
const liveOf = (row = pageRow(), languages = ['en'], props: Record<string, unknown> | null = properties()) => normaliseEtsyListing(LISTING, etsyPageRaw(row, shop(languages), props).raw)
const photos = (nexus: number | null, row = pageRow(), reason?: string) => ({ nexus, ...(reason ? { reason } : {}), etsy: etsyLiveImages(row) })

async function compare(input: { publication?: EtsyPublication; row?: Record<string, unknown>; languages?: string[]; propertiesRead?: boolean; nexusPhotos?: number | null; props?: Record<string, unknown> | null } = {}) {
  const row = input.row ?? pageRow()
  const propertiesRead = input.propertiesRead ?? true
  const live = liveOf(row, input.languages ?? ['en'], propertiesRead ? (input.props ?? properties()) : null)
  return compareEtsyContent(facts(), input.publication ?? await ours(), live, { propertiesRead, photos: photos(input.nexusPhotos === undefined ? 2 : input.nexusPhotos, row) })
}
const reasonOf = (result: { notCompared: Array<{ field: string; reason: string }> }, field: string) => result.notCompared.find(entry => entry.field === field)?.reason

beforeEach(() => {
  Object.assign(m, { mode: 'gated', products: ['p', 'c1', 'c2'], languages: ['en'], main: {}, values: { c1: 'Black', c2: 'Red' }, own: {}, basePrice: {},
    shopCurrency: 'EUR', stockRefusal: null })
})

describe('the shared constants (E5 §2)', () => {
  it('names the source, the compared states, the page includes and the photo field', () => {
    expect(ETSY_CONTENT_SOURCE).toBe('etsy-content')
    expect([...ETSY_COMPARED_STATES].sort()).toEqual(['active', 'draft', 'inactive', 'sold_out'])
    expect(ETSY_PAGE_INCLUDES).toBe('Inventory,Images,Translations')
    expect(PHOTO_COUNT_FIELD).toBe('photo_count')
  })
})

describe('compareEtsyContent — the review\'s own comparison', () => {
  it('a listing Etsy holds as Nexus would send it: compared, nothing differs; a field empty in Nexus is settled (compared, no difference)', async () => {
    const result = await compare()
    expect(result.differing).toEqual([])
    expect(result.notCompared).toEqual([])
    // Materials empty in Nexus while Etsy holds "leather": Etsy keeps its value and the review never shows a difference,
    // so the field is compared with none — an older "Differs" of it clears (E5a review M2).
    expect(result.compared).toEqual(['title', 'description', 'tags', 'materials', 'taxonomy_id', 'classification', 'type', 'shop_section_id',
      'shipping_profile_id', 'return_policy_id', 'item_weight', 'item_dimensions', 'is_taxable', 'should_auto_renew', 'production_partner_ids', 'styles',
      'inventory', PHOTO_COUNT_FIELD])
  })

  it('Materials differed, then were emptied in Nexus: the line is settled, so the difference is no longer reported', async () => {
    m.main = { materials: ['wool'] }
    const before = await compare({ row: pageRow({ materials: ['cotton'] }) })
    expect(before.differing).toEqual([{ field: 'materials', ours: ['wool'], theirs: ['cotton'] }])
    m.main = {}
    const after = await compare({ row: pageRow({ materials: ['cotton'] }) })
    expect(after.compared).toContain('materials')
    expect(after.differing).toEqual([])
  })

  it('the title differs: drift with Nexus\'s and Etsy\'s values', async () => {
    m.main = { title: 'Leather knee slider, pair' }
    const result = await compare()
    expect(result.differing).toEqual([{ field: 'title', ours: 'Leather knee slider, pair', theirs: 'Leather knee slider' }])
    expect(result.compared).toContain('title')
  })

  it('tags are a set: another order and case are the same', async () => {
    m.main = { tags: ['moto', 'racing'] }
    const result = await compare({ row: pageRow({ tags: ['Racing', 'MOTO'] }) })
    expect(result.compared).toContain('tags')
    expect(result.differing).toEqual([])
  })

  it('a description with Windows line ends is the same', async () => {
    m.main = { description: 'Line one.\nLine two.' }
    const result = await compare({ row: pageRow({ description: 'Line one.\r\nLine two.' }) })
    expect(result.compared).toContain('description')
    expect(result.differing).toEqual([])
  })

  it('an attribute Nexus holds and Etsy does not: drift, Etsy\'s side null; a variation property is never an attribute line', async () => {
    const base = await ours()
    const publication = { ...base, properties: [{ property_id: 513, property_name: 'Size', value_ids: [], values: ['M'], scale_id: null }] }
    const result = await compare({ publication })
    expect(result.differing).toEqual([{ field: 'property:513', ours: { property_id: 513, property_name: 'Size', value_ids: [], values: ['M'], scale_id: null }, theirs: null }])
    expect([...result.compared, ...result.notCompared.map(entry => entry.field)]).not.toContain('property:200')
  })

  it('attributes not read in this sweep: every attribute line is not compared, none differs', async () => {
    const base = await ours()
    const publication = { ...base, properties: [{ property_id: 513, property_name: 'Size', value_ids: [], values: ['M'], scale_id: null }] }
    const result = await compare({ publication, propertiesRead: false })
    expect(result.notCompared.filter(entry => entry.field.startsWith('property:'))).toEqual([{ field: 'property:513', reason: ETSY_PROPERTIES_UNREAD }])
    expect(result.differing).toEqual([])
    expect(result.compared.some(field => field.startsWith('property:'))).toBe(false)
  })

  it('a translation in a language the shop does not offer is not part of the plan', async () => {
    m.languages = ['en', 'de']
    const result = await compare({ languages: ['en'] })
    const fields = [...result.compared, ...result.notCompared.map(entry => entry.field)]
    expect(fields.some(field => field.startsWith('translation:'))).toBe(false)
  })

  it('a translation the shop offers, compared; translations Etsy did not return are not compared', async () => {
    m.languages = ['en', 'it']
    const held = pageRow({ translations: [{ listing_id: 9000000001, language: 'it', title: 'Saponetta in pelle', description: 'Cucita a mano.', tags: [] }] })
    expect((await compare({ row: held, languages: ['en', 'it'] })).compared).toContain('translation:it')
    const { translations: _gone, ...unread } = held
    const result = await compare({ row: unread, languages: ['en', 'it'] })
    expect(reasonOf(result, 'translation:it')).toBe('Etsy\'s translations could not be read.')
    expect(result.differing).toEqual([])
  })

  it('Etsy holds a variation Nexus does not (FAKE-SKU-3): the variations differ', async () => {
    m.products = ['p', 'c1']
    const result = await compare()
    const inventory = result.differing.find(entry => entry.field === 'inventory')
    expect(inventory).toBeTruthy()
    expect((inventory!.ours as { products: Array<{ sku: string }> }).products.map(p => p.sku)).toEqual(['FAKE-SKU-2'])
    expect((inventory!.theirs as { products: Array<{ sku: string }> }).products.map(p => p.sku)).toEqual(['FAKE-SKU-2', 'FAKE-SKU-3'])
  })

  it('a processing profile empty in Nexus takes Etsy\'s, as the review does: the variations are the same', async () => {
    m.main = { readiness_state_id: null }
    const publication = await ours()
    expect(publication.structure.products.map(p => p.readiness_state_id)).toEqual([null, null])
    const result = await compare({ publication })
    expect(result.compared).toContain('inventory')
    expect(result.differing).toEqual([])
    // The publication itself is not changed by the comparison.
    expect(publication.structure.products.map(p => p.readiness_state_id)).toEqual([null, null])
  })

  it('production partners: Etsy does not report them, so they are not compared even when Nexus has some', async () => {
    const base = await ours()
    const result = await compare({ publication: { ...base, values: { ...base.values, production_partner_ids: [7] } } })
    expect(reasonOf(result, 'production_partner_ids')).toBe('Etsy does not report production partners when Nexus reads a listing.')
    expect(result.differing).toEqual([])
  })

  it('photos 3 in Nexus, 2 on Etsy: photo_count drift with Etsy\'s image list', async () => {
    const result = await compare({ nexusPhotos: 3 })
    expect(result.differing).toEqual([{ field: PHOTO_COUNT_FIELD, ours: { count: 3 }, theirs: { count: 2, images: [
      { listing_image_id: '8000000001', rank: 1, url: 'https://img.example/1_570.jpg' }, { listing_image_id: '8000000002', rank: 2, url: 'https://img.example/2_570.jpg' }] } }])
  })

  it('photos: a family not on the media plan is settled (compared, no difference); another failure, or no images from Etsy → not compared', async () => {
    const row = pageRow()
    const live = liveOf(row)
    const noPlan = compareEtsyContent(facts(), await ours(), live, { propertiesRead: true, photos: photos(null, row, ETSY_NOT_ON_MEDIA_PLAN) })
    expect(noPlan.compared).toContain(PHOTO_COUNT_FIELD)
    expect(noPlan.differing).toEqual([])
    const failed = compareEtsyContent(facts(), await ours(), live, { propertiesRead: true, photos: photos(null, row, 'This destination cannot receive photos.') })
    expect(reasonOf(failed, PHOTO_COUNT_FIELD)).toBe('This destination cannot receive photos.')
    expect(failed.compared).not.toContain(PHOTO_COUNT_FIELD)
    const { images: _none, ...withoutImages } = row
    const noImages = compareEtsyContent(facts(), await ours(), live, { propertiesRead: true, photos: photos(2, withoutImages) })
    expect(reasonOf(noImages, PHOTO_COUNT_FIELD)).toBe(ETSY_IMAGES_UNREAD)
  })

  it('the shop\'s main language is not Nexus\'s first Etsy language: the review refuses, so nothing is compared', async () => {
    const result = await compare({ languages: ['it', 'en'] })
    expect(result).toEqual({ compared: [], differing: [], notCompared: [{ field: 'listing',
      reason: 'the Etsy review refused: This Etsy shop\'s main language is it, but Nexus\'s first language for Etsy is en. Put it first in the Etsy market\'s languages.' }] })
  })

  // E5a review m7 — the live review's own refusals, pinned against the live-mode publisher: it throws, so it has no change
  // line, and drift shows no difference either.
  it.each([
    ['a variation Etsy no longer holds has no price in Nexus', () => { m.basePrice = { c2: null } }],
    ['a variation Etsy no longer holds, and the shop sells in another currency', () => { m.shopCurrency = 'USD' }],
  ])('%s: the live review refuses to build → the listing is not compared, with the review\'s own words', async (_case, arrange) => {
    arrange()
    const row = pageRow({ inventory: inventory({ products: [product('FAKE-SKU-2', 'Black')] }) })
    const live = liveOf(row)
    const gated = await ours()
    m.mode = 'live'
    const error = await prepareEtsyPublication(facts(), { readLive: async () => live }).then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(EtsyPublicationProblems)
    const expected = `the Etsy review refused: ${(error as Error).message.replace(/\n/g, ' ')}`
    expect(etsyLiveRefusal(facts(), gated, live)).toBe(expected)
    expect(compareEtsyContent(facts(), gated, live, { propertiesRead: true, photos: photos(2, row) }))
      .toEqual({ compared: [], differing: [], notCompared: [{ field: 'listing', reason: expected }] })
  })

  it('a variation Etsy no longer holds, priced and in the shop\'s currency: the review builds, and the variations differ', async () => {
    const row = pageRow({ inventory: inventory({ products: [product('FAKE-SKU-2', 'Black')] }) })
    const live = liveOf(row)
    expect(etsyLiveRefusal(facts(), await ours(), live)).toBeNull()
    const result = compareEtsyContent(facts(), await ours(), live, { propertiesRead: true, photos: photos(2, row) })
    expect(result.differing.map(entry => entry.field)).toEqual(['inventory'])
  })

  it('a change plan that cannot be built leaves the whole listing not compared, with the reason', async () => {
    const base = await ours()
    const result = await compare({ publication: { ...base, products: [] } })
    expect(result).toEqual({ compared: [], differing: [], notCompared: [{ field: 'listing',
      reason: 'the Etsy review could not compare: No included Etsy product can own this listing publication.' }] })
  })

  it('never carries the shop id', async () => {
    m.main = { title: 'Another title' }
    const result = await compare({ nexusPhotos: 5 })
    expect(result.differing.length).toBeGreaterThan(1)
    expect(JSON.stringify(result)).not.toContain('90000001')
  })
})

describe('withEtsyLive — the review\'s live-only steps, pinned against the live-mode publisher', () => {
  /** Run the publisher with sending off and in live mode on the same Etsy read; the mirrored publication must equal the live one. */
  async function pin(row: Record<string, unknown>, languages: string[]) {
    const live = liveOf(row, languages)
    const gated = await ours()
    expect(gated.liveSkipped).toBeTruthy()
    m.mode = 'live'
    const reviewed = await prepareEtsyPublication(facts(), { readLive: async () => live })
    m.mode = 'gated'
    const mirrored = withEtsyLive(gated, live)
    const fields = ['kind', 'marketplace', 'listingId', 'products', 'inventoryProducts', 'ownerProductId', 'values', 'properties', 'translations', 'structure',
      'create', 'live', 'liveRevision', 'currency', 'liveSkipped', 'liveReadError'] as const
    for (const field of fields) expect([field, mirrored[field]]).toEqual([field, reviewed[field]])
    return { live, gated, reviewed, mirrored }
  }

  it('processing profiles that differ under a processing profile Etsy shares: the rule is widened, as the review does (etsyFitReadiness)', async () => {
    m.own = { c1: { readiness_state_id: 5001 }, c2: { readiness_state_id: 5002 } }
    const row = pageRow()
    const { mirrored, reviewed, gated, live } = await pin(row, ['en'])
    expect(gated.structure.readiness_state_on_property).toEqual([200])
    expect(mirrored.structure.readiness_state_on_property).toEqual([200])
    expect(live.inventory.readiness_state_on_property).toEqual([])
    expect(prepareEtsyChanges(facts(), mirrored, new Map()).changes).toEqual(prepareEtsyChanges(facts(), reviewed, new Map()).changes)
  })

  it('the order-import refusal of a send that adds stock changes what can be sent, never SAME / DIFFERS', async () => {
    m.stockRefusal = { code: 'ETSY_ORDER_IMPORT_OFF', sentence: 'Etsy order import is off.' }
    const row = pageRow({ inventory: inventory({ products: [product('FAKE-SKU-2', 'Black')] }) })
    const { mirrored, reviewed } = await pin(row, ['en'])
    expect(reviewed.newVariationStockRefusal).toContain('Etsy order import is off.')
    const statuses = (publication: EtsyPublication) => prepareEtsyChanges(facts(), publication, new Map()).changes
      .map(change => [change.field, change.status, change.current, change.channel])
    expect(statuses(mirrored)).toEqual(statuses(reviewed))
  })

  it('equals prepareEtsyPublication in live mode reading the same listing: same publication fields, same change plan', async () => {
    // Every live-only step at work: a translation the shop does not offer (fr), a processing profile empty in Nexus, and
    // Etsy's own *_on_property rules that differ from Nexus's (a price shared by every variation).
    m.languages = ['en', 'de', 'fr']
    m.main = { readiness_state_id: null }
    const row = pageRow({ inventory: inventory({ price_on_property: [] }),
      translations: [{ listing_id: 9000000001, language: 'de', title: 'Saponetta in pelle', description: 'Cucita a mano.', tags: [] }] })
    const live = liveOf(row, ['en', 'de'])
    const gated = await ours()
    expect(gated.liveSkipped).toBeTruthy()
    m.mode = 'live'
    const readLive = vi.fn(async (): Promise<EtsyLiveListing> => live)
    const reviewed = await prepareEtsyPublication(facts(), { readLive })
    expect(readLive).toHaveBeenCalledWith({ accountId: 'acc-etsy', listingId: LISTING })

    const mirrored = withEtsyLive(gated, live)
    const fields = ['kind', 'marketplace', 'listingId', 'products', 'inventoryProducts', 'ownerProductId', 'values', 'properties', 'translations', 'structure',
      'create', 'live', 'liveRevision', 'currency', 'liveSkipped', 'liveReadError'] as const
    for (const field of fields) expect([field, mirrored[field]]).toEqual([field, reviewed[field]])
    expect(mirrored.translations.map(t => t.language)).toEqual(['de'])
    expect(mirrored.structure.price_on_property).toEqual([])
    expect(mirrored.structure.products.map(p => p.readiness_state_id)).toEqual([5001, 5001])
    expect(prepareEtsyChanges(facts(), mirrored, new Map()).changes).toEqual(prepareEtsyChanges(facts(), reviewed, new Map()).changes)
    // And so the drift: the variations and the translation are the same, as in the review.
    const result = compareEtsyContent(facts(), gated, live, { propertiesRead: true, photos: photos(2, row) })
    expect(result.compared).toEqual(expect.arrayContaining(['inventory', 'translation:de']))
    expect(result.differing).toEqual([])
  })
})

describe('etsyPageRaw and etsyLiveImages', () => {
  it('the row without its inventory and images is the listing; translations stay with it', () => {
    const { raw, inventoryRead, propertiesRead } = etsyPageRaw(pageRow(), shop(), properties())
    expect(raw.listing).not.toHaveProperty('inventory')
    expect(raw.listing).not.toHaveProperty('images')
    expect(raw.listing).toHaveProperty('translations')
    expect(raw.inventory).toEqual(inventory())
    expect(raw.translationsRead).toBe(true)
    expect([inventoryRead, propertiesRead]).toEqual([true, true])
  })

  it('no translations on the row → translations not read; no properties → not read, and none; a batch inventory wins over the row\'s', () => {
    const { translations: _t, ...row } = pageRow()
    const batch = inventory({ products: [product('FAKE-SKU-2', 'Black')] })
    const { raw, inventoryRead, propertiesRead } = etsyPageRaw(row, shop(), null, batch)
    expect(raw.translationsRead).toBe(false)
    expect(raw.properties).toEqual({ results: [] })
    expect(propertiesRead).toBe(false)
    expect(raw.inventory).toBe(batch)
    expect(inventoryRead).toBe(true)
    expect(normaliseEtsyListing(LISTING, raw).translations).toBeNull()
  })

  it('an inventory without a products list is not an inventory read', () => {
    expect(etsyPageRaw(pageRow({ inventory: {} }), shop(), null).inventoryRead).toBe(false)
    expect(etsyPageRaw(pageRow({ inventory: undefined }), shop(), null).inventoryRead).toBe(false)
    expect(etsyPageRaw(pageRow({ inventory: { products: 'x' } }), shop(), null, { listing_id: 1 }).inventoryRead).toBe(false)
  })

  it('images: Etsy\'s order by rank, a bad id skipped, the smaller url first, at most 20; none returned → null', () => {
    const row = pageRow({ images: [image(2, 2), { listing_image_id: 0, rank: 0 }, { ...image(1, 1), url_570xN: null }, image(3, 3),
      ...Array.from({ length: 25 }, (_, i) => image(10 + i, 10 + i))] })
    const images = etsyLiveImages(row) as EtsyLiveImage[]
    expect(images).toHaveLength(20)
    expect(images.slice(0, 3)).toEqual([{ listing_image_id: '8000000001', rank: 1, url: 'https://img.example/1.jpg' },
      { listing_image_id: '8000000002', rank: 2, url: 'https://img.example/2_570.jpg' }, { listing_image_id: '8000000003', rank: 3, url: 'https://img.example/3_570.jpg' }])
    expect(etsyLiveImages(pageRow({ images: undefined }))).toBeNull()
    expect(etsyLiveImages(pageRow({ images: [] }))).toEqual([])
  })
})
