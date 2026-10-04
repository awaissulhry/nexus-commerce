import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * PLAN R-43 (A-39 slice b2) — the eBay studio builder's listing input, extracted from `prepareEbayPublication` into
 * `buildEbayListingInput` so a READER (the nightly eBay content read) can take "ours" from the builder itself.
 *
 * What is pinned, on one family fixture (a parent + two variants, a resolved title cell, an item-specific cell that
 * overrides the stored value, a >65-character list that the builder splits into values):
 *   · golden — the Title and ItemSpecifics the builder SENDS (the XML), recorded on the builder before the extraction;
 *   · parity — the same Title and ItemSpecifics come out of `buildEbayListingInput` given the market's currency;
 *   · currency (A-41, R-46) — the publish path passes the market's own currency; a market with none is refused by name.
 * Everything the builder reads outside the fixture is stubbed; `buildFlatRow`, `buildSharedListingInput` and the XML
 * serialiser are REAL.
 */
const m = vi.hoisted(() => ({ currencyFill: undefined as string | undefined, findFirst: vi.fn(async () => null), sets: vi.fn(async (): Promise<unknown[]> => []), mapFields: vi.fn(async (): Promise<unknown[]> => []) }))

// CHMAP M4: no ACTIVE mapping version, so the builder sends exactly what it sent before.
// Images rebuild P2c — not on the media plan: the builder keeps its per-product galleries (studio-publication-ebay-media tests the plan path).
vi.mock('../images/media-plan-switch.js', () => ({ isOnMediaPlan: async () => false }))
// E1b — the publisher reads the dictionary and the market language for the variation values' market words.
vi.mock('../../db.js', () => ({ default: { marketplace: { findFirst: async () => ({ languages: ['it'] }) }, customAttribute: { findMany: async () => [] }, channelListing: { findFirst: m.findFirst }, channelMappingSet: { findMany: (...a: unknown[]) => m.sets(...a) }, channelMappingField: { findMany: (...a: unknown[]) => m.mapFields(...a) } } }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => 'live' }))
vi.mock('../ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'token' } }))
vi.mock('../ebay-description-theme.service.js', () => ({ renderListingDescriptionSafe: async (_db: unknown, input: { body: string }) => ({ html: `<p>${input.body}</p>`, warnings: [] }) }))
vi.mock('./studio-publication-media.js', () => ({ publicationImages: () => ['https://img.example/fam-1.jpg'] }))
vi.mock('../images/ebay-media-workspace.service.js', () => ({ readEbayMediaGallery: async () => { throw new Error('not in this fixture') } }))
vi.mock('../stock-pool/sync-ledgers.js', () => ({ loadSyncLedgers: async () => new Map() }))
// A-56 (2026-09-24) — the stub reads its argument the way the REAL `loadEbaySpec(marketplace, categoryIds: string[])` does
// (`categoryIds.map(String)`). The old stub ignored it, so the builder passed ONE category string for months and every
// test stayed green while production refused 4 GALE-JACKET eBay listings with "categoryIds.map is not a function".
vi.mock('./channel-specs/index.js', async original => ({
  ...(await original<typeof import('./channel-specs/index.js')>()),
  loadEbaySpec: async (_marketplace: string, categoryIds: string[]) => (categoryIds.map(String), { absent: false, fields: [
    { key: 'title', channelStore: { kind: 'listingColumn', column: 'title' } },
    { key: 'aspect_Marca', channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Marca'] } },
  ] }),
}))
// VTR step 0: the real `channelAxisValues`; no axis cell is resolved here, so the stored values go out unchanged.
vi.mock('./stored-variation-projection.js', async original => ({
  ...(await original<typeof import('./stored-variation-projection.js')>()),
  loadStoredVariationProjection: async () => ({ input: { family: { variants: [
    { id: 'c1', axisValues: { color: 'Nero', size: 'M' } },
    { id: 'c2', axisValues: { color: 'Nero', size: 'L' } },
  ] } }, cell: { axes: [] } }),
}))
vi.mock('./variation-rules.service.js', () => ({
  resolveVariationProjection: () => ({ axes: [
    { included: true, channelName: 'Colore', familyKey: 'color' },
    { included: true, channelName: 'Taglia', familyKey: 'size' },
  ] }),
  variationReadinessItems: () => [],
}))
// The live-revision read (`liveItem`) is the only Trading call the builder makes before it returns.
vi.mock('../ebay-trading-api.service.js', async original => ({
  ...(await original<typeof import('../ebay-trading-api.service.js')>()),
  callTradingApi: async () => ({ ack: 'Success', errors: [], raw: '<Item><ItemID>111</ItemID><SellingStatus><ListingStatus>Active</ListingStatus></SellingStatus></Item>' }),
}))
// A-41: nothing is filled any more (`currencyFill` stays undefined) — the builder must pass the market's currency itself.
vi.mock('../ebay-shared-listing-push.service.js', async original => {
  const real = await original<typeof import('../ebay-shared-listing-push.service.js')>()
  return { ...real, buildSharedListingInput: (...args: Parameters<typeof real.buildSharedListingInput>) => {
    const next = [...args] as Parameters<typeof real.buildSharedListingInput>
    if (next[5] === undefined) next[5] = m.currencyFill
    return real.buildSharedListingInput(...next)
  } }
})

import * as builder from './studio-publication-ebay.js'
import { parseEbayItemContent } from '../channel-drift/ebay-content-compare.js'

const LONG = 'Ventilata, Impermeabile, Protezioni CE spalle e gomiti, Tasca interna, Inserti riflettenti, Fodera termica'
const updatedAt = new Date('2026-09-01T00:00:00Z')
const product = (id: string, sku: string, extra: Record<string, unknown> = {}) => ({ id, sku, name: `Nome ${sku}`, ean: null, parentId: null, isParent: false,
  variationTheme: null, categoryAttributes: {}, variantAttributes: {}, brand: 'Xavia', images: [], basePrice: 99, totalStock: 5, updatedAt, ...extra })
const listing = (productId: string, platformAttributes: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: `l-${productId}`, productId,
  channel: 'EBAY', marketplace: 'IT', region: 'IT', channelConnectionId: 'acc', aliasKey: '', externalListingId: '111', platformAttributes, fulfillmentMethod: null,
  title: 'Titolo salvato', description: 'Descrizione', price: null, quantity: 5, priceOverride: null, quantityOverride: null, stockBuffer: 0, listingStatus: 'ACTIVE',
  syncStatus: 'IN_SYNC', followMasterPrice: true, followMasterQuantity: true, followMasterTitle: true, followMasterDescription: true, followMasterBulletPoints: true,
  masterPrice: null, masterTitle: null, masterDescription: null, masterQuantity: null, updatedAt, ...extra })

function fixture(): any {
  const parent = product('p', 'FAM', { isParent: true, variationTheme: 'Colore,Taglia' })
  const c1 = product('c1', 'FAM-NERO-M', { parentId: 'p', variantAttributes: { Colore: 'Nero', Taglia: 'M' } })
  const c2 = product('c2', 'FAM-NERO-L', { parentId: 'p', variantAttributes: { Colore: 'Nero', Taglia: 'L' } })
  const cells = (extra: Record<string, unknown> = {}) => Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { value: v, errors: [] }]))
  return {
    scope: { channel: 'EBAY', marketplace: 'IT', accountId: 'acc' },
    destination: { aliasKey: null, currency: 'EUR', familyId: 'p' },
    account: { connectionMetadata: { ebayPolicies: { fulfillmentPolicyId: 'f1', paymentPolicyId: 'p1', returnPolicyId: 'r1' }, itemLocation: { country: 'IT', city: 'Rimini', postalCode: '47921' } } },
    parent, products: [parent, c1, c2],
    listings: [listing('p', { itemSpecifics: { Marca: 'Xavia', Materiale: 'Pelle', Caratteristiche: LONG }, categoryId: '57988' }), listing('c1', {}), listing('c2', {})],
    resolved: [{ products: [
      { productId: 'p', category: { channelCategoryId: '57988' }, cells: cells({ title: 'Giacca FAM Racing', aspect_Marca: 'Xavia Racing' }) },
      { productId: 'c1', category: { channelCategoryId: '57988' }, cells: cells() },
      { productId: 'c2', category: { channelCategoryId: '57988' }, cells: cells() },
    ] }],
  }
}

const GOLDEN_TITLE = 'Giacca FAM Racing'
const GOLDEN_SPECIFICS: Record<string, string[]> = {
  Marca: ['Xavia Racing'],
  Materiale: ['Pelle'],
  Caratteristiche: ['Ventilata', 'Impermeabile', 'Protezioni CE spalle e gomiti', 'Tasca interna', 'Inserti riflettenti', 'Fodera termica'],
}
const asLists = (specifics: Record<string, string | string[]>) => Object.fromEntries(Object.entries(specifics).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]))

beforeEach(() => { process.env.NEXUS_EBAY_REAL_API = 'true'; delete process.env.EBAY_SANDBOX; m.currencyFill = undefined; m.sets.mockResolvedValue([]); m.mapFields.mockResolvedValue([]) })
const mappingRow = (channelKey: string, targetKind: string, targetKey: string, extra: Record<string, unknown> = {}) => ({ id: channelKey, setId: 'set-1', channelKey, columnKey: channelKey, label: null, aliases: [], productTypes: [],
  requirement: 'optional', templateRequirement: null, targetKind, targetKey, transform: [], direction: 'both', state: 'mapped', reason: null, decidedBy: 'rule', sortOrder: 0, ...extra })


describe('the eBay studio builder — Title and ItemSpecifics', () => {
  it('golden: sends the resolved title and the overlaid, split item specifics (recorded before the extraction)', async () => {
    const plan = await builder.prepareEbayPublication(fixture())
    const sent = parseEbayItemContent(plan.xml)
    if (process.env.S5_DUMP_XML) (await import('node:fs')).writeFileSync(process.env.S5_DUMP_XML, plan.xml)
    expect(sent.title).toBe(GOLDEN_TITLE)
    expect(sent.itemSpecifics).toEqual(GOLDEN_SPECIFICS)
    // The axes are variation specifics, never item-level specifics.
    expect(Object.keys(sent.itemSpecifics)).not.toContain('Colore')
  })

  it('A-41: the publish path passes the market\'s own currency', async () => {
    const plan = await builder.prepareEbayPublication(fixture())
    expect(plan.xml).toMatch(/<Currency>EUR<\/Currency>/)
  })

  it('A-41: a market with no currency is still refused by name', async () => {
    const facts = fixture()
    facts.destination.currency = null
    await expect(builder.prepareEbayPublication(facts)).rejects.toThrow(/No currency was resolved for the IT market/)
  })

  it('parity: buildEbayListingInput gives the same Title and ItemSpecifics the builder sends', async () => {
    const plan = await builder.prepareEbayPublication(fixture())
    const sent = parseEbayItemContent(plan.xml)
    const built = await (builder as any).buildEbayListingInput(fixture(), { currency: 'EUR' })
    expect(built.shared.title).toBe(sent.title)
    expect(asLists(built.shared.itemSpecifics)).toEqual(sent.itemSpecifics)
    expect(built.itemId).toBe('111')
  })

  it('CHMAP M4: item specifics the Owner ignored in the ACTIVE mapping version are left out of the set eBay receives', async () => {
    m.sets.mockResolvedValue([{ id: 'set-1', version: 3, formKey: '57988', marketplace: 'IT' }])
    m.mapFields.mockResolvedValue([
      mappingRow('aspect:Marca', 'channelField', 'aspect_Marca', { state: 'ignored', decidedBy: 'owner', reason: 'brand comes from the account' }),
      mappingRow('specific:materiale', 'itemSpecific', 'itemSpecifics.materiale', { state: 'ignored', decidedBy: 'owner', reason: 'Amazon workaround' }),
      mappingRow('Caratteristiche', 'channelField', 'aspect_Caratteristiche'),
    ])
    const sent = parseEbayItemContent((await builder.prepareEbayPublication(fixture())).xml)
    expect(Object.keys(sent.itemSpecifics)).toEqual(['Caratteristiche'])
    expect(sent.title).toBe(GOLDEN_TITLE)
  })

  it('parity: the extracted function keeps the builder\'s own refusals (an ItemID used outside the selection)', async () => {
    m.findFirst.mockResolvedValueOnce({ id: 'other' } as never)
    await expect((builder as any).buildEbayListingInput(fixture(), { currency: 'EUR' })).rejects.toThrow(/also used by products outside this selection/)
  })
})

// ── Round 6 (2026-10-01) — each variation goes out at the listing's send price (`listingSendPrice`) ──────────────────
describe('🔴 the eBay studio builder sends each variation its send price, never the master for a follower', () => {
  /** The StartPrice of the variation with this SKU, from the XML eBay receives. */
  const startPrice = (xml: string, sku: string) => {
    const block = xml.split('<Variation>').find(part => part.includes(`<SKU>${sku}</SKU>`))
    return block?.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/)?.[1]
  }
  it('a variation at "master +10%" goes out at 108.9 (it went out at the master 99); a FIXED one at 99; a pin at its own', async () => {
    const facts = fixture()
    facts.listings[1] = listing('c1', {}, { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10, price: 108.9 })
    facts.listings[2] = listing('c2', {}, { followMasterPrice: false, priceOverride: 95, price: 95 })
    const plan = await builder.prepareEbayPublication(facts)
    expect([startPrice(plan.xml, 'FAM-NERO-M'), startPrice(plan.xml, 'FAM-NERO-L')]).toEqual(['108.9', '95'])
    const fixed = await builder.prepareEbayPublication(fixture())
    expect([startPrice(fixed.xml, 'FAM-NERO-M'), startPrice(fixed.xml, 'FAM-NERO-L')]).toEqual(['99', '99'])
  })
  it('🔴 on eBay UK (GBP) a follower that holds no price is refused by name — the EUR master number is never sent as pounds', async () => {
    const facts = fixture()
    facts.scope.marketplace = 'UK'; facts.destination.currency = 'GBP'
    await expect(builder.prepareEbayPublication(facts)).rejects.toThrow(
      'FAM-NERO-M: eBay UK sells in GBP, and this listing follows the master price in EUR. Nexus does not convert it. Set this listing\'s own GBP price.')
  })
})
