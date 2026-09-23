import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * PLAN R-43 (A-39 slice b2) — the eBay studio builder's listing input, extracted from `prepareEbayPublication` into
 * `buildEbayListingInput` so a READER (the nightly eBay content read) can take "ours" from the builder itself.
 *
 * What is pinned, on one family fixture (a parent + two variants, a resolved title cell, an item-specific cell that
 * overrides the stored value, a >65-character list that the builder splits into values):
 *   · golden — the Title and ItemSpecifics the builder SENDS (the XML), recorded on the builder before the extraction;
 *   · parity — the same Title and ItemSpecifics come out of `buildEbayListingInput` given the market's currency;
 *   · today — with no currency the publish path is refused (it passes none since P4.4a; stated in PLAN.md, not fixed here).
 * Everything the builder reads outside the fixture is stubbed; `buildFlatRow`, `buildSharedListingInput` and the XML
 * serialiser are REAL.
 */
const m = vi.hoisted(() => ({ currencyFill: undefined as string | undefined, findFirst: vi.fn(async () => null) }))

vi.mock('../../db.js', () => ({ default: { channelListing: { findFirst: m.findFirst } } }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => 'live' }))
vi.mock('../ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'token' } }))
vi.mock('../ebay-description-theme.service.js', () => ({ renderListingDescriptionSafe: async (_db: unknown, input: { body: string }) => ({ html: `<p>${input.body}</p>`, warnings: [] }) }))
vi.mock('./studio-publication-media.js', () => ({ publicationImages: () => ['https://img.example/fam-1.jpg'] }))
vi.mock('../images/ebay-media-workspace.service.js', () => ({ readEbayMediaGallery: async () => { throw new Error('not in this fixture') } }))
vi.mock('../stock-pool/sync-ledgers.js', () => ({ loadSyncLedgers: async () => new Map() }))
vi.mock('./channel-specs/index.js', async original => ({
  ...(await original<typeof import('./channel-specs/index.js')>()),
  loadEbaySpec: async () => ({ absent: false, fields: [
    { key: 'title', channelStore: { kind: 'listingColumn', column: 'title' } },
    { key: 'aspect_Marca', channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Marca'] } },
  ] }),
}))
vi.mock('./stored-variation-projection.js', () => ({
  loadStoredVariationProjection: async () => ({ input: { family: { variants: [
    { id: 'c1', axisValues: { color: 'Nero', size: 'M' } },
    { id: 'c2', axisValues: { color: 'Nero', size: 'L' } },
  ] } } }),
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
// The publish path passes no currency (P4.4a); the golden/parity arms fill the market's, the "today" arm does not.
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

beforeEach(() => { process.env.NEXUS_EBAY_REAL_API = 'true'; delete process.env.EBAY_SANDBOX; m.currencyFill = 'EUR' })

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

  it('today: with no currency the publish path is refused at the shared input (P4.4a) — the reader passes the market\'s', async () => {
    m.currencyFill = undefined
    await expect(builder.prepareEbayPublication(fixture())).rejects.toThrow(/No currency was resolved for the IT market/)
  })

  it('parity: buildEbayListingInput gives the same Title and ItemSpecifics the builder sends', async () => {
    const plan = await builder.prepareEbayPublication(fixture())
    const sent = parseEbayItemContent(plan.xml)
    m.currencyFill = undefined // the reader supplies its own currency; nothing is filled for it
    const built = await (builder as any).buildEbayListingInput(fixture(), { currency: 'EUR' })
    expect(built.shared.title).toBe(sent.title)
    expect(asLists(built.shared.itemSpecifics)).toEqual(sent.itemSpecifics)
    expect(built.itemId).toBe('111')
  })

  it('parity: the extracted function keeps the builder\'s own refusals (an ItemID used outside the selection)', async () => {
    m.findFirst.mockResolvedValueOnce({ id: 'other' } as never)
    await expect((builder as any).buildEbayListingInput(fixture(), { currency: 'EUR' })).rejects.toThrow(/also used by products outside this selection/)
  })
})
