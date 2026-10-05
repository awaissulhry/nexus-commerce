import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * E1 (Etsy publisher) — `prepareEtsyPublication`: one listing per selection, every problem named at once, the review
 * built in every mode (lead amendment A1), and the live Etsy listing read only in live mode for a listing that exists.
 *
 * The builder, the SKU rules, the price rule and the variation-collision helper are REAL; the database, the publish gate,
 * the stock ledgers and the variation projection are a fixture, and the live read is a spy. Fake ids only: shop
 * `90000001` (in the account identity, never in a publication), listing `9000000001`, SKUs `FAKE-SKU-…`.
 */
const m = vi.hoisted(() => ({
  mode: 'gated' as string, holder: null as unknown, listingId: null as string | null, products: ['p', 'c1', 'c2'], languages: ['en'],
  currency: 'EUR' as string | null, shopCurrency: 'EUR' as string | null, stock: 3, main: {} as Record<string, unknown>, own: {} as Record<string, Record<string, unknown>>,
  listing: {} as Record<string, Record<string, unknown>>, sku: {} as Record<string, string>, values: { c1: 'Black', c2: 'Red' } as Record<string, string>,
  dropped: [] as string[], readiness: [] as Array<{ kind: string; message: string; severity: string }>, skuConflict: null as string | null,
  mainLeftOut: false, skipped: [] as Array<{ productId: string; sku: string; reason: string }>,
}))

vi.mock('../../db.js', () => ({ default: { channelListing: { findFirst: async () => m.holder } } }))
// The main-row refusal (N7) loads the facts' row rule from studio-publication-plan.ts, whose imports open the job queues:
// no Redis in a unit test.
vi.mock('../../lib/queue.js', () => ({ redis: null, addJobSafely: vi.fn(), outboundSyncQueue: null, channelSyncQueue: null, readCacheQueue: null, readinessQueue: null,
  searchIndexQueue: null, bulkJobQueue: null, publicationBatchQueue: null, agentPlanQueue: null, adsSyncQueue: null }))
vi.mock('../etsy-publish-gate.service.js', () => ({ getEtsyPublishMode: () => m.mode }))
vi.mock('../stock-pool/sync-ledgers.js', () => ({ loadSyncLedgers: async () => new Map() }))
vi.mock('../listings/channel-sku.pure.js', async original => {
  const real = await original<typeof import('../listings/channel-sku.pure.js')>()
  return { ...real, liveChannelSku: (...args: Parameters<typeof real.liveChannelSku>) => m.skuConflict
    ? { sku: null, source: null, conflict: { code: 'CONFLICTING_SKUS', candidates: [], sentence: `${args[1]}: ${m.skuConflict}` } } : real.liveChannelSku(...args) }
})
const AXIS = { axisKey: 'color', familyKey: 'color', label: 'Color', channelName: 'Primary color', target: 'property_200', included: true }
vi.mock('./stored-variation-projection.js', async original => ({
  ...(await original<typeof import('./stored-variation-projection.js')>()),
  loadStoredVariationProjection: async () => ({
    input: { family: { variants: ['c1', 'c2'].map(id => ({ id, sku: SKUS[id], included: true, axisValues: { color: m.values[id] } })) } },
    cell: { axes: [AXIS] },
  }),
}))
vi.mock('./variation-rules.service.js', async original => ({
  ...(await original<typeof import('./variation-rules.service.js')>()),
  resolveVariationProjection: () => ({ axes: [AXIS, ...m.dropped.map(label => ({ ...AXIS, axisKey: label.toLowerCase(), familyKey: label.toLowerCase(), label, target: null, included: false }))], dropped: m.dropped.map(label => label.toLowerCase()) }),
  variationReadinessItems: () => m.readiness,
}))

import { prepareEtsyPublication, ETSY_LIVE_SKIPPED, ETSY_NO_SHIPPING_PROFILE, ETSY_PHOTOS_LATER } from './studio-publication-etsy.js'
import { ETSY_NEEDS_READINESS } from './studio-publication-etsy-build.js'
import { EtsyPublicationProblems } from './studio-publication-etsy-problems.js'
import type { EtsyLiveListing } from './studio-publication-etsy-types.js'

const SKUS: Record<string, string> = { p: 'FAKE-SKU-1', c1: 'FAKE-SKU-2', c2: 'FAKE-SKU-3' }
const MAIN = { title: 'Leather knee slider', description: 'A hand-stitched knee slider.', taxonomy_id: 1234, who_made: 'i_did', when_made: '2020_2026', is_supply: false,
  shipping_profile_id: 7001, readiness_state_id: 5001, tags: ['moto'] }
const COLOR_FIELD = { fieldKey: 'property_200', label: 'Primary color', validation: { etsyValues: [{ code: '1', label: 'Black', scaleId: null }, { code: '2', label: 'Red', scaleId: null }] } }
const cells = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, status: 'mapped', errors: [] }]))

function facts(): any {
  const family = m.products.length > 1
  const rows = m.products.map(id => ({ id, sku: m.sku[id] ?? SKUS[id], name: `Name ${SKUS[id]}`, isParent: family && id === 'p', parentId: id === 'p' ? null : 'p', basePrice: 25, totalStock: m.stock }))
  const listings = m.products.map(id => ({ id: `l-${id}`, productId: id, channel: 'ETSY', marketplace: 'GLOBAL', channelConnectionId: 'acc-etsy', aliasKey: '',
    externalListingId: m.listingId, listingStatus: m.listingId ? 'ACTIVE' : 'DRAFT', isPublished: !!m.listingId, channelSku: null, liveChannelSku: null, platformAttributes: {},
    offers: [], followMasterPrice: true, followMasterQuantity: true, price: null, priceOverride: null, pricingRule: 'FIXED', priceAdjustmentPercent: null,
    quantity: 0, quantityOverride: null, stockBuffer: 0, ...(m.listing[id] ?? {}) }))
  return {
    scope: { channel: 'ETSY', marketplace: 'GLOBAL', accountId: 'acc-etsy' },
    destination: { aliasKey: null, currency: m.currency, familyId: 'p' },
    // A 16-character login name in displayName (Etsy's), the shop id only in the identity.
    account: { displayName: 'abcdefghijklmnop', identity: { storeName: 'Fake Etsy shop', extra: { shopId: '90000001', currencyCode: m.shopCurrency } } },
    parent: rows[0], products: m.mainLeftOut ? rows.slice(1) : rows, listings, languages: m.languages, issues: [], skipped: m.skipped, excluded: 0,
    resolved: m.languages.map((_, locale) => ({ catalogue: { fields: [COLOR_FIELD] }, products: rows.map(row => ({ productId: row.id,
      cells: cells(row.id === 'p' ? (locale ? { title: 'Saponetta in pelle', description: 'Cucita a mano.' } : { ...MAIN, ...m.main }) : { ...(m.own[row.id] ?? {}) }) })) })),
  }
}

/** Etsy's live listing as the reader normalises it, holding exactly what Nexus would send. */
function liveListing(extra: Partial<EtsyLiveListing> = {}): EtsyLiveListing {
  return {
    listingId: '9000000001', state: 'active', language: 'en',
    values: { title: MAIN.title, description: MAIN.description, tags: ['moto'], materials: [], taxonomy_id: 1234, classification: { who_made: 'i_did', when_made: '2020_2026', is_supply: false },
      type: 'physical', shop_section_id: null, shipping_profile_id: 7001, return_policy_id: null, item_weight: { value: null, unit: null },
      item_dimensions: { length: null, width: null, height: null, unit: null }, is_taxable: null, should_auto_renew: null, production_partner_ids: [], styles: [] },
    unread: { production_partner_ids: 'Etsy does not report production partners when Nexus reads a listing.' },
    properties: [{ property_id: 200, property_name: 'Primary color', value_ids: [1], values: ['Black'], scale_id: null }],
    inventory: { properties: [{ property_id: 200, property_name: 'Primary color', scale_id: null }], products: [
      { sku: 'FAKE-SKU-2', values: [{ property_id: 200, values: ['Black'] }], readiness_state_id: 5001 },
      { sku: 'FAKE-SKU-3', values: [{ property_id: 200, values: ['Red'] }], readiness_state_id: 5001 },
    ] },
    offerings: { 'FAKE-SKU-2': { price: 24, quantity: 2, is_enabled: true, readiness_state_id: 5001 }, 'FAKE-SKU-3': { price: 24, quantity: 1, is_enabled: true, readiness_state_id: 5001 } },
    unnamedProducts: 0, translations: [], shop: { languages: ['en'], currencyCode: 'EUR' }, priceCurrencies: ['EUR'], revision: 'live-rev-1', ...extra,
  }
}
const readLive = vi.fn(async (): Promise<EtsyLiveListing> => liveListing())
async function problemsOf(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (e: unknown) => e)
  expect(error).toBeInstanceOf(EtsyPublicationProblems)
  return error as EtsyPublicationProblems
}

beforeEach(() => {
  Object.assign(m, { mode: 'gated', holder: null, listingId: null, products: ['p', 'c1', 'c2'], languages: ['en'], currency: 'EUR', shopCurrency: 'EUR', stock: 3,
    main: {}, own: {}, listing: {}, sku: {}, values: { c1: 'Black', c2: 'Red' }, dropped: [], readiness: [], skuConflict: null, mainLeftOut: false, skipped: [] })
  readLive.mockReset().mockImplementation(async () => liveListing())
})

describe('built in every mode, read only in live mode (A1)', () => {
  it('gated, new family: the whole publication is built, Etsy is never read, and the draft is the default', async () => {
    const publication = await prepareEtsyPublication(facts(), { readLive })
    expect(readLive).not.toHaveBeenCalled()
    expect(publication).toMatchObject({ kind: 'etsy', marketplace: 'GLOBAL', listingId: null, ownerProductId: 'p', live: null, liveRevision: null,
      create: { state: 'draft', price: 25, quantity: 6 }, products: [{ productId: 'p', sku: 'FAKE-SKU-1' }, { productId: 'c1', sku: 'FAKE-SKU-2' }, { productId: 'c2', sku: 'FAKE-SKU-3' }],
      inventoryProducts: [{ productId: 'c1', sku: 'FAKE-SKU-2' }, { productId: 'c2', sku: 'FAKE-SKU-3' }] })
    expect(publication.liveSkipped).toBeUndefined()
    expect(publication.inventory.products.map(p => p.property_values?.[0].values)).toEqual([['Black'], ['Red']])
    expect(publication.notices).toEqual([ETSY_PHOTOS_LATER])
  })

  it('gated, existing listing: nothing is read, and the publication says why', async () => {
    m.listingId = '9000000001'
    const publication = await prepareEtsyPublication(facts(), { readLive })
    expect(readLive).not.toHaveBeenCalled()
    expect(publication).toMatchObject({ listingId: '9000000001', live: null, liveRevision: null, liveSkipped: ETSY_LIVE_SKIPPED, create: null })
  })

  it('problems win in every mode: every one is named at once, with the notes', async () => {
    m.main = { title: '', taxonomy_id: null }
    const error = await problemsOf(prepareEtsyPublication(facts(), { readLive }))
    expect(error.issues.map(issue => issue.message)).toEqual(['Title is empty. Fill it in on the main row.', 'Category is empty. Choose an Etsy category on the main row.'])
    expect(error.notes).toContain(ETSY_PHOTOS_LATER)
    expect(readLive).not.toHaveBeenCalled()
  })

  it('live, new listing: no read, the create state passed through', async () => {
    m.mode = 'live'
    const publication = await prepareEtsyPublication(facts(), { readLive, createState: 'active' })
    expect(readLive).not.toHaveBeenCalled()
    expect(publication.create?.state).toBe('active')
  })

  it('live, existing listing: Etsy is read once, for this account and listing', async () => {
    m.mode = 'live'; m.listingId = '9000000001'
    const publication = await prepareEtsyPublication(facts(), { readLive })
    expect(readLive).toHaveBeenCalledTimes(1)
    expect(readLive).toHaveBeenCalledWith({ accountId: 'acc-etsy', listingId: '9000000001' })
    expect(publication).toMatchObject({ live: { revision: 'live-rev-1' }, liveRevision: 'live-rev-1' })
    expect(publication.liveReadError).toBeUndefined()
  })

  it('live, the read fails: the error is kept and nothing throws', async () => {
    m.mode = 'live'; m.listingId = '9000000001'
    readLive.mockRejectedValue(new Error('Etsy answered 503.'))
    const publication = await prepareEtsyPublication(facts(), { readLive })
    expect(publication).toMatchObject({ live: null, liveRevision: null, liveReadError: 'Etsy answered 503.' })
  })

  it('the shop id never reaches a stored publication, and the publication survives a JSON round trip', async () => {
    m.mode = 'live'; m.listingId = '9000000001'
    const publication = await prepareEtsyPublication(facts(), { readLive })
    expect(JSON.stringify(publication)).not.toContain('90000001')
    expect(JSON.parse(JSON.stringify(publication))).toStrictEqual(publication)
  })
})

describe('one listing, held by this selection only', () => {
  it('two Etsy listing ids are refused', async () => {
    m.listing = { c1: { externalListingId: '9000000001' }, c2: { externalListingId: '9000000002' } }
    await expect(prepareEtsyPublication(facts(), { readLive })).rejects.toThrow('These products belong to different Etsy listings. Choose one listing alias before publishing.')
  })

  it('a listing another product holds is refused', async () => {
    m.listingId = '9000000001'; m.holder = { id: 'l-foreign' }
    await expect(prepareEtsyPublication(facts(), { readLive })).rejects.toThrow('This Etsy listing is also used by products outside this selection. Review its complete shared listing before publishing.')
  })
})

describe('the problems prepare names (E13, E18–E20, E22, E24, W3–W5, W7–W9)', () => {
  it('E13 — a dropped property that makes two variations alike', async () => {
    m.values = { c1: 'Black', c2: 'Black' }; m.dropped = ['Size']
    m.readiness = [{ kind: 'collision', message: '2 variants cannot be told apart on ETSY · GLOBAL after Size is dropped.', severity: 'error' }]
    const error = await problemsOf(prepareEtsyPublication(facts(), { readLive }))
    expect(error.issues).toEqual([{ field: 'variationTheme', severity: 'error',
      message: 'Etsy takes at most 2 variation properties; Size left out makes FAKE-SKU-2 and FAKE-SKU-3 the same variation.' }])
  })

  it('the variation check\'s own errors are named as they are', async () => {
    m.readiness = [{ kind: 'theme-unset', message: 'No variation theme on ETSY GLOBAL.', severity: 'error' }, { kind: 'attribute-unbound', message: 'A warning.', severity: 'warning' }]
    expect((await problemsOf(prepareEtsyPublication(facts(), { readLive }))).issues.map(issue => issue.message)).toEqual(['No variation theme on ETSY GLOBAL.'])
  })

  it('E18 — a row without a SKU', async () => {
    m.products = ['p']; m.sku = { p: '' }
    m.main = {}
    const error = await problemsOf(prepareEtsyPublication(facts(), { readLive }))
    expect(error.issues).toContainEqual({ productId: 'p', sku: '', field: 'sku', severity: 'error', message: 'Seller SKU is empty. Set this row\'s SKU.' })
  })

  it('E19 — two SKUs on record for a live row', async () => {
    m.listingId = '9000000001'; m.skuConflict = 'this Etsy listing has more than one SKU on record (A-1, A-2). Set this listing\'s own SKU before sending it.'
    const error = await problemsOf(prepareEtsyPublication(facts(), { readLive }))
    expect(error.issues).toContainEqual({ productId: 'c1', sku: 'FAKE-SKU-2', field: 'sku', severity: 'error',
      message: 'this Etsy listing has more than one SKU on record (A-1, A-2). Set this listing\'s own SKU before sending it.' })
  })

  it('E20 — one SKU on two variations', async () => {
    m.listing = { c2: { channelSku: 'FAKE-SKU-2' } }
    const error = await problemsOf(prepareEtsyPublication(facts(), { readLive }))
    expect(error.issues).toContainEqual({ productId: 'c2', sku: 'FAKE-SKU-3', field: 'sku', severity: 'error', message: 'FAKE-SKU-2 is the SKU of more than one row; each Etsy variation needs its own.' })
  })

  it('E22 — a price Publish sends is never converted: a new listing, and a new variation of a listing on Etsy (m2)', async () => {
    m.shopCurrency = 'USD'
    expect((await problemsOf(prepareEtsyPublication(facts(), { readLive }))).issues.map(issue => issue.message))
      .toEqual(['This Etsy shop sells in USD and Nexus holds Etsy prices in EUR. A price is never converted: set the Etsy market\'s currency to USD.'])
    m.shopCurrency = null
    expect((await problemsOf(prepareEtsyPublication(facts(), { readLive }))).issues.map(issue => issue.message))
      .toEqual(['Nexus does not know this Etsy shop\'s currency. Reconnect the Etsy account, then review again.'])
    // A listing on Etsy whose every row Etsy holds sends no price (D3): nothing to check.
    m.listingId = '9000000001'
    await expect(prepareEtsyPublication(facts(), { readLive })).resolves.toMatchObject({ listingId: '9000000001' })
    // A new variation of it sends its price with Publish: checked.
    m.shopCurrency = 'USD'
    m.listing = { c2: { externalListingId: null, listingStatus: 'DRAFT', isPublished: false } }
    expect((await problemsOf(prepareEtsyPublication(facts(), { readLive }))).issues.map(issue => issue.message))
      .toEqual(['This Etsy shop sells in USD and Nexus holds Etsy prices in EUR. A price is never converted: set the Etsy market\'s currency to USD.'])
  })

  it('E24 — after a read, the shop\'s main language must be Nexus\'s first', async () => {
    m.mode = 'live'; m.listingId = '9000000001'
    readLive.mockImplementation(async () => liveListing({ shop: { languages: ['de', 'en'], currencyCode: 'EUR' } }))
    expect((await problemsOf(prepareEtsyPublication(facts(), { readLive }))).issues.map(issue => issue.message))
      .toEqual(['This Etsy shop\'s main language is de, but Nexus\'s first language for Etsy is en. Put de first in the Etsy market\'s languages.'])
  })

  it('E24 / W7 compare languages by their primary subtag (n1): en-US is en, it-IT is it', async () => {
    m.mode = 'live'; m.listingId = '9000000001'; m.languages = ['en', 'it']
    readLive.mockImplementation(async () => liveListing({ shop: { languages: ['en-US', 'it-IT'], currencyCode: 'EUR' } }))
    const publication = await prepareEtsyPublication(facts(), { readLive })
    expect(publication.translations.map(t => t.language)).toEqual(['it'])
    expect(publication.notices?.some(note => note.includes('does not offer that language'))).toBe(false)
  })

  it('M1 — a new listing with a variation without a processing profile is refused, on the main row; W4 / W5 are notes', async () => {
    m.main = { readiness_state_id: null, shipping_profile_id: null }
    const error = await problemsOf(prepareEtsyPublication(facts(), { readLive }))
    expect(error.issues).toEqual([{ productId: 'p', sku: 'FAKE-SKU-1', field: 'readiness_state_id', severity: 'error', message: ETSY_NEEDS_READINESS }])
    expect(ETSY_NEEDS_READINESS).toBe('Processing profile is not set. Etsy needs one for every variation: choose it on the main row (or on each row).')
    expect(error.notes).toEqual([ETSY_PHOTOS_LATER])
    m.main = { shipping_profile_id: null }
    expect((await prepareEtsyPublication(facts(), { readLive })).notices).toEqual([ETSY_PHOTOS_LATER, ETSY_NO_SHIPPING_PROFILE])
    expect(ETSY_NO_SHIPPING_PROFILE).toBe('Shipping profile is not set. Etsy needs one before the listing can go live.')
    expect(ETSY_PHOTOS_LATER).toBe('Photos are not sent to Etsy yet; they come in a later Nexus update.')
  })

  it('M1 — one row without a profile refuses a create too; on a listing on Etsy the row takes Etsy\'s profile (never cleared by accident)', async () => {
    m.main = { readiness_state_id: null }; m.own = { c2: { readiness_state_id: 5002 } }
    expect((await problemsOf(prepareEtsyPublication(facts(), { readLive }))).issues.map(issue => issue.message)).toEqual([ETSY_NEEDS_READINESS])
    m.mode = 'live'; m.listingId = '9000000001'
    const publication = await prepareEtsyPublication(facts(), { readLive })
    expect(publication.structure.products.find(p => p.sku === 'FAKE-SKU-2')?.readiness_state_id).toBe(5001)
    expect(publication.notices).toEqual([ETSY_PHOTOS_LATER])
  })

  it('M1 — without a read, a new variation without a profile is said now (nothing of the inventory is sent)', async () => {
    m.listingId = '9000000001'; m.main = { readiness_state_id: null }
    m.listing = { c2: { externalListingId: null, listingStatus: 'DRAFT', isPublished: false } }
    const publication = await prepareEtsyPublication(facts(), { readLive })
    expect(publication.notices).toEqual([ETSY_PHOTOS_LATER, `FAKE-SKU-3: ${ETSY_NEEDS_READINESS}`])
  })

  it('W7 / W8 / W9 — after a read: a language the shop does not offer, variations Nexus does not hold, another currency', async () => {
    m.mode = 'live'; m.listingId = '9000000001'; m.languages = ['en', 'it']
    // The reader keeps Etsy's products without a SKU in the structure as sku '' (a send would delete them) and counts them.
    readLive.mockImplementation(async () => liveListing({ unnamedProducts: 2, priceCurrencies: ['USD'],
      inventory: { ...liveListing().inventory, products: [{ sku: '', values: [{ property_id: 200, values: ['Blue'] }], readiness_state_id: 5001 },
        { sku: '', values: [{ property_id: 200, values: ['White'] }], readiness_state_id: 5001 }, ...liveListing().inventory.products,
        { sku: 'FAKE-SKU-9', values: [{ property_id: 200, values: ['Green'] }], readiness_state_id: 5001 }] } }))
    const publication = await prepareEtsyPublication(facts(), { readLive })
    expect(publication.translations).toEqual([])
    expect(publication.notices).toEqual([
      ETSY_PHOTOS_LATER,
      'it: this Etsy shop does not offer that language, so its translation is not sent.',
      'Etsy holds variation FAKE-SKU-9 that Nexus does not; sending the variations would delete it on Etsy. Add it to the family in Nexus, or remove it on Etsy first.',
      'Etsy holds 2 variations without a SKU; sending the variations would delete them on Etsy.',
      'Etsy prices this listing in USD; Nexus holds EUR. Prices of the variations already on Etsy go through the price push, which refuses a different currency; prices of new variations go with Publish.',
    ])
  })

  it('m1 — a row Nexus records on the listing whose SKU Etsy does not hold is a new variation: its price is judged, never sent as 0', async () => {
    m.mode = 'live'; m.listingId = '9000000001'
    m.listing = { c2: { channelSku: 'FAKE-SKU-3-NEW', liveChannelSku: 'FAKE-SKU-3-NEW', followMasterPrice: false, priceOverride: null } }
    const error = await problemsOf(prepareEtsyPublication(facts(), { readLive }))
    expect(error.issues).toEqual([{ productId: 'c2', sku: 'FAKE-SKU-3', field: 'price', severity: 'error', message: 'This listing has no price of its own for Etsy. Set its price first.' }])
    // With a price of its own, the publication carries it, and Etsy's FAKE-SKU-3 is named (a send would delete it).
    m.listing.c2 = { ...m.listing.c2, priceOverride: 31 }
    const publication = await prepareEtsyPublication(facts(), { readLive })
    expect(publication.inventory.products.find(p => p.sku === 'FAKE-SKU-3-NEW')?.offerings).toEqual([{ price: 31, quantity: 3, is_enabled: true, readiness_state_id: 5001 }])
    expect(publication.notices).toContain('Etsy holds variation FAKE-SKU-3 that Nexus does not; sending the variations would delete it on Etsy. Add it to the family in Nexus, or remove it on Etsy first.')
    // N5 — said before the variations line (ticked by default) puts it back.
    expect(publication.notices).toContain('Etsy no longer holds FAKE-SKU-3-NEW; Publish adds it back as a new variation.')
    expect(error.notes).toContain('Etsy no longer holds FAKE-SKU-3-NEW; Publish adds it back as a new variation.')
  })

  it('m1 / m2 — a row Etsy does not hold sends its price, so the shop\'s currency is checked (the read\'s, when the account has none)', async () => {
    m.mode = 'live'; m.listingId = '9000000001'; m.shopCurrency = null
    m.listing = { c2: { channelSku: 'FAKE-SKU-3-NEW', liveChannelSku: 'FAKE-SKU-3-NEW' } }
    readLive.mockImplementation(async () => liveListing({ shop: { languages: ['en'], currencyCode: 'USD' } }))
    expect((await problemsOf(prepareEtsyPublication(facts(), { readLive }))).issues.map(issue => issue.message))
      .toEqual(['This Etsy shop sells in USD and Nexus holds Etsy prices in EUR. A price is never converted: set the Etsy market\'s currency to USD.'])
  })
  it('a second language is a translation; one language has none', async () => {
    m.languages = ['en', 'it']
    expect((await prepareEtsyPublication(facts(), { readLive })).translations).toEqual([{ language: 'it', title: 'Saponetta in pelle', description: 'Cucita a mano.', tags: [] }])
    m.languages = ['en']
    expect((await prepareEtsyPublication(facts(), { readLive })).translations).toEqual([])
  })
})

describe('rows and their numbers', () => {
  it('a single product is its own main row and its one Etsy product', async () => {
    m.products = ['p']
    const publication = await prepareEtsyPublication(facts(), { readLive })
    expect(publication.inventoryProducts).toEqual([{ productId: 'p', sku: 'FAKE-SKU-1' }])
    expect(publication.inventory.products).toEqual([{ sku: 'FAKE-SKU-1', offerings: [{ price: 25, quantity: 3, is_enabled: true, readiness_state_id: 5001 }] }])
    expect(publication.create).toEqual({ state: 'draft', price: 25, quantity: 3 })
  })

  it('a new variation of a live listing is judged on its price; a live row is not (D3)', async () => {
    m.listingId = '9000000001'
    m.listing = { c2: { externalListingId: null, listingStatus: 'DRAFT', isPublished: false, followMasterPrice: false, priceOverride: null } }
    m.listing.c1 = { followMasterPrice: false, priceOverride: null }
    const error = await problemsOf(prepareEtsyPublication(facts(), { readLive }))
    expect(error.issues).toEqual([{ productId: 'c2', sku: 'FAKE-SKU-3', field: 'price', severity: 'error', message: 'This listing has no price of its own for Etsy. Set its price first.' }])
  })

  it('a listing\'s own channel SKU is the SKU Etsy is sent', async () => {
    m.listing = { c1: { channelSku: 'FAKE-SKU-2-ETSY' } }
    const publication = await prepareEtsyPublication(facts(), { readLive })
    expect(publication.products).toContainEqual({ productId: 'c1', sku: 'FAKE-SKU-2-ETSY' })
    expect(publication.inventory.products.map(p => p.sku)).toEqual(['FAKE-SKU-2-ETSY', 'FAKE-SKU-3'])
  })

  it('M2 — a variation new on a listing on Etsy, set Inactive, is sent switched off; one set Active is on', async () => {
    m.listingId = '9000000001'
    m.listing = { c2: { externalListingId: null, listingStatus: 'DRAFT', isPublished: false } }
    const off = await prepareEtsyPublication(facts(), { readLive, inactiveProductIds: new Set(['c2']) })
    expect(off.inventory.products.map(p => [p.sku, p.offerings[0].is_enabled])).toEqual([['FAKE-SKU-2', true], ['FAKE-SKU-3', false]])
    const on = await prepareEtsyPublication(facts(), { readLive })
    expect(on.inventory.products.map(p => p.offerings[0].is_enabled)).toEqual([true, true])
    // A row already on Etsy keeps Etsy's own offering whatever the set says.
    const live = await prepareEtsyPublication(facts(), { readLive, inactiveProductIds: new Set(['c1']) })
    expect(live.inventory.products.map(p => p.offerings[0].is_enabled)).toEqual([true, true])
  })

  it('M2 — a brand-new listing is a draft as a whole: every variation is on', async () => {
    const publication = await prepareEtsyPublication(facts(), { readLive, inactiveProductIds: new Set(['c1', 'c2']) })
    expect(publication.create?.state).toBe('draft')
    expect(publication.inventory.products.map(p => p.offerings[0].is_enabled)).toEqual([true, true])
  })

  it('n7 / N7 — a main row left out says why, with its OWN reason only, never "could not be read"', async () => {
    // The main row itself ended on Etsy: its own reason.
    m.mainLeftOut = true; m.listingId = '9000000001'; m.listing = { p: { listingStatus: 'ENDED' } }
    m.skipped = [{ productId: 'p', sku: 'FAKE-SKU-1', reason: 'Ended on the channel. Set Active to relist it first.' }]
    await expect(prepareEtsyPublication(facts(), { readLive })).rejects.toThrow('This Etsy listing is not reviewed: its main row FAKE-SKU-1 is skipped. Ended on the channel. Set Active to relist it first.')
    // A discontinued variation skips the whole listing: the main row carries that row's reason, which is not its own.
    m.listing = { c2: { presenceIntent: 'DISCONTINUED' } }
    m.skipped = [{ productId: 'p', sku: 'FAKE-SKU-1', reason: 'This listing is discontinued.' }, { productId: 'c2', sku: 'FAKE-SKU-3', reason: 'This listing is discontinued.' }]
    const error = await prepareEtsyPublication(facts(), { readLive }).then(() => null, (e: Error) => e)
    expect(error?.message).toBe('This Etsy listing is not reviewed: its main row FAKE-SKU-1 is skipped.')
    m.skipped = []
    await expect(prepareEtsyPublication(facts(), { readLive })).rejects.toThrow('This Etsy listing is not reviewed: its main row is not included here (excluded, or Not listed).')
  })
})
