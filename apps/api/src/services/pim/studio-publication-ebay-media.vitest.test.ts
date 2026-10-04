import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Images rebuild P2c — an eBay Trading listing of a family on the media plan sends the plan's photos, and the XML is the
 * proof: Common in order as PictureDetails, one VariationSpecificPictureSet per value in the family's value order, named
 * with the value the listing receives (a pin wins), under the listing's own axis name. The variation rules, the shared
 * projection (`projectEbay`), the channel naming (`channelNames`), buildFlatRow, buildSharedListingInput and the XML
 * serialiser are REAL; only the database loaders and the plan's storage are replaced by a fixture.
 */
const m = vi.hoisted(() => ({
  onPlan: true, axis: 'color' as string | null, calls: [] as any[], plan: null as any,
  variants: [] as Array<{ id: string; sku: string; included: boolean; axisValues: Record<string, string> }>,
  keys: {} as Record<string, Record<string, string>>, order: {} as Record<string, string[]>,
}))

// E1b — the publisher reads the dictionary and the market language for the variation values' market words.
vi.mock('../../db.js', () => ({ default: { marketplace: { findFirst: async () => ({ languages: ['it'] }) }, customAttribute: { findMany: async () => [] }, channelListing: { findFirst: async () => null }, channelMappingSet: { findMany: async () => [] }, channelMappingField: { findMany: async () => [] } } }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => 'live' }))
vi.mock('../ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'token' } }))
vi.mock('../ebay-description-theme.service.js', () => ({ renderListingDescriptionSafe: async (_db: unknown, input: { body: string }) => ({ html: `<p>${input.body}</p>`, warnings: [] }) }))
vi.mock('./studio-publication-media.js', () => ({ publicationImages: () => ['https://img.example/old-gallery.jpg'] }))
vi.mock('../stock-pool/sync-ledgers.js', () => ({ loadSyncLedgers: async () => new Map() }))
// Audit P3 — a new listing with no location reads the account's from eBay; this account has none there.
vi.mock('../ebay-account.service.js', () => ({ ebayAccountService: { getSnapshot: async () => ({ fulfillmentPolicies: [], paymentPolicies: [], returnPolicies: [], locations: [] }) } }))
vi.mock('./channel-specs/index.js', async original => ({
  ...(await original<typeof import('./channel-specs/index.js')>()),
  loadEbaySpec: async () => ({ absent: false, fields: [{ key: 'title', channelStore: { kind: 'listingColumn', column: 'title' } }] }),
}))
vi.mock('./stored-variation-projection.js', async original => {
  const real = await original<typeof import('./stored-variation-projection.js')>()
  const { resolveVariationProjection } = await import('./variation-rules.service.js')
  const { limitsFor, vocabularyFor } = await import('./family-projection-limits.js')
  return { ...real, loadStoredVariationProjection: async () => {
    const input = {
      coordinate: { channel: 'EBAY', market: 'IT', accountId: 'acc', aliasKey: '', label: 'EBAY · IT' },
      family: { familyAxes: ['Colore', 'Taglia'], axisLabels: { color: 'Color', size: 'Size' }, productVersion: 1, productTheme: null, childIds: m.variants.map(v => v.id),
        variants: m.variants.map(v => ({ ...v, axisValues: { ...v.axisValues } })) },
      listing: { version: 3, variationTheme: null, variationMapping: null, platformAttributes: {}, externalListingId: null, listingStatus: 'DRAFT' },
      rule: null,
      schema: { ebay: { categoryId: '57988', aspects: [
        { name: 'Colore', englishName: 'Color', variantEligible: true, required: false },
        { name: 'Taglia', englishName: 'Size', variantEligible: true, required: false },
      ] } },
      limits: limitsFor('EBAY'), vocabulary: vocabularyFor('EBAY'),
    }
    return { input, cell: resolveVariationProjection(input as any) }
  } }
})
vi.mock('../images/media-plan-switch.js', () => ({ isOnMediaPlan: async () => m.onPlan }))
// The plan's storage and library are a fixture; its projection and channel naming are the real shared functions.
vi.mock('../images/media-plan.service.js', async () => {
  const { channelNames, projectEbay } = await import('@nexus/shared/media-plan-channels')
  return { mediaLayoutFor: async (input: any) => {
    m.calls.push(input)
    const axes = [{ code: 'color', label: 'Colore' }, { code: 'size', label: 'Taglia' }]
    const variants = m.variants.map(v => ({ productId: v.id, sku: v.sku, values: m.keys[v.id], included: input.includedIds.includes(v.id) }))
    const named = channelNames({ axes, variants, axis: m.axis, channelValues: input.channelValues })
    const asset = (id: string) => ({ id, url: `https://img.example/${id}.jpg`, mediaType: 'IMAGE', width: 1600, height: 1600, mimeType: 'image/jpeg', fileSize: 1, languageTag: 'zxx', versionGroupId: null, label: id })
    const assets = new Map(['cover', 'detail', 'n1', 'n2', 'o1', 's44', 's40', 's42'].map(id => [id, asset(id)]))
    const layout = projectEbay({ shared: m.plan }, { productId: 'p', variants, defaultAxis: m.axis, valueOrder: m.order, valueLabels: {} }, assets,
      { channel: 'EBAY', market: 'IT', languages: ['it'], mainLanguage: 'it', api: 'TRADING', valueNames: named.valueNames, axisName: named.axisName })
    return { layout: { channel: 'EBAY', revisions: ['SHARED@1'], ...layout }, url: (id: string) => assets.get(id)!.url }
  } }
})

import { prepareEbayPublication } from './studio-publication-ebay.js'

const updatedAt = new Date('2026-09-01T00:00:00Z')
const product = (id: string, sku: string, extra: Record<string, unknown> = {}) => ({ id, sku, name: `Nome ${sku}`, ean: null, parentId: null, isParent: false,
  variationTheme: null, categoryAttributes: {}, variantAttributes: {}, brand: 'Xavia', images: [], basePrice: 99, totalStock: 5, updatedAt, ...extra })
const listing = (productId: string) => ({ id: `l-${productId}`, productId,
  channel: 'EBAY', marketplace: 'IT', region: 'IT', channelConnectionId: 'acc', aliasKey: '', externalListingId: null, platformAttributes: productId === 'p' ? { categoryId: '57988', conditionId: 'NEW' } : {}, fulfillmentMethod: null,
  title: 'Titolo', description: 'Descrizione', price: null, quantity: 5, priceOverride: null, quantityOverride: null, stockBuffer: 0, listingStatus: 'DRAFT',
  syncStatus: 'IN_SYNC', followMasterPrice: true, followMasterQuantity: true, followMasterTitle: true, followMasterDescription: true, followMasterBulletPoints: true,
  masterPrice: null, masterTitle: null, masterDescription: null, masterQuantity: null, updatedAt })
const AXIS_FIELDS = [
  { fieldKey: 'color', sheetKey: 'color', channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Colore'] } },
  { fieldKey: 'size', sheetKey: 'size', channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Taglia'] } },
]
const mapped = (value: unknown) => ({ value, status: 'mapped', provenance: 'override', errors: [] })
function facts(cells: Record<string, Record<string, unknown>> = {}): any {
  const parent = product('p', 'FAM', { isParent: true })
  const kids = m.variants.map(v => product(v.id, v.sku, { parentId: 'p' }))
  return {
    scope: { channel: 'EBAY', marketplace: 'IT', accountId: 'acc' },
    destination: { aliasKey: null, currency: 'EUR', familyId: 'p' },
    account: { connectionMetadata: { ebayPolicies: { fulfillmentPolicyId: 'f', paymentPolicyId: 'pay', returnPolicyId: 'r' }, itemLocation: { country: 'IT', city: 'Roma' } } },
    parent, products: [parent, ...kids],
    listings: [listing('p'), ...kids.map(k => listing(k.id))],
    resolved: [{ catalogue: { fields: AXIS_FIELDS }, products: [parent, ...kids].map(p => ({ productId: p.id, category: { channelCategoryId: '57988' },
      cells: { title: { value: 'Giacca FAM', errors: [] }, ...(cells[p.id] ?? {}) } })) }],
  }
}
const ids = (...list: string[]) => list.map(assetId => ({ assetId }))
const pictureUrls = (xml: string) => [...xml.matchAll(/<PictureURL>([^<]+)<\/PictureURL>/g)].map(x => x[1].replace('https://img.example/', '').replace('.jpg', ''))
const gallery = (xml: string) => pictureUrls(xml.match(/<PictureDetails>[\s\S]*?<\/PictureDetails>/)?.[0] ?? '')
const sets = (xml: string) => [...xml.matchAll(/<VariationSpecificPictureSet>\s*<VariationSpecificValue>([^<]+)<\/VariationSpecificValue>([\s\S]*?)<\/VariationSpecificPictureSet>/g)].map(x => [x[1], pictureUrls(x[2])])

beforeEach(() => {
  process.env.NEXUS_EBAY_REAL_API = 'true'; delete process.env.EBAY_SANDBOX
  m.onPlan = true; m.axis = 'color'; m.calls = []
  m.variants = [
    { id: 'c1', sku: 'FAM-NERO-M', included: true, axisValues: { Colore: 'Nero', Taglia: 'M' } },
    { id: 'c2', sku: 'FAM-ARANCIA-M', included: true, axisValues: { Colore: 'Arancia', Taglia: 'M' } },
  ]
  m.keys = { c1: { color: 'color:black', size: 'size:m' }, c2: { color: 'color:orange', size: 'size:m' } }
  m.order = { color: ['color:black', 'color:orange'], size: ['size:m'] }
  m.plan = { version: 1, axis: 'color', sets: { common: ids('cover', 'detail'), values: { 'color:orange': ids('o1'), 'color:black': ids('cover', 'n1', 'n2') } } }
})

describe('eBay Trading publish of a family on the media plan', () => {
  it('sends Common as the gallery and one set per value, in the family order, named as the listing names them', async () => {
    const plan = await prepareEbayPublication(facts({ c2: { color: mapped('Arancione'), size: mapped('M') } }))
    expect(gallery(plan.xml)).toEqual(['cover', 'detail'])
    expect(plan.xml).toContain('<VariationSpecificName>Colore</VariationSpecificName>')
    expect(sets(plan.xml)).toEqual([['Nero', ['cover', 'n1', 'n2']], ['Arancione', ['o1']]])
    expect(plan.xml).not.toContain('old-gallery')
    expect(m.calls[0]).toMatchObject({ productId: 'p', channel: 'EBAY', marketplace: 'IT', accountId: 'acc', includedIds: ['p', 'c1', 'c2'] })
  })
  it('keeps number-like values in the plan order (an object would sort "40" before "44")', async () => {
    m.variants = ['44', '40', '42'].map((size, i) => ({ id: `s${i}`, sku: `FAM-${size}`, included: true, axisValues: { Colore: 'Nero', Taglia: size } }))
    m.keys = Object.fromEntries(m.variants.map(v => [v.id, { color: 'color:black', size: `size:${v.axisValues.Taglia}` }]))
    m.order = { color: ['color:black'], size: ['size:44', 'size:40', 'size:42'] }
    m.axis = 'size'
    m.plan = { version: 1, axis: 'size', sets: { common: ids('cover'), values: { 'size:40': ids('s40'), 'size:42': ids('s42'), 'size:44': ids('s44') } } }
    const plan = await prepareEbayPublication(facts())
    expect(plan.xml).toContain('<VariationSpecificName>Taglia</VariationSpecificName>')
    expect(sets(plan.xml).map(s => s[0])).toEqual(['44', '40', '42'])
  })
  it('refuses to send when the plan has a blocking problem — a value with no photos', async () => {
    m.plan.sets.values['color:orange'] = []
    await expect(prepareEbayPublication(facts())).rejects.toThrow('has no photos — eBay would show "no picture available"')
  })
  it('a family not on the plan keeps its old gallery path, untouched', async () => {
    m.onPlan = false
    const plan = await prepareEbayPublication(facts())
    expect(gallery(plan.xml)).toEqual(['old-gallery'])
    expect(m.calls).toEqual([])
  })
})

// 2026-10-01 — eBay takes the country with a postal code OR a city (Trading `Item.PostalCode` / `Item.Location`: one of the
// two). A new Motovento listing held "IT" and "47822" on its main row and was refused for the missing city.
describe('the item location of a new eBay listing', () => {
  const located = (sheet: Record<string, unknown>, account: Record<string, unknown> = {}) => {
    const f = facts()
    f.account.connectionMetadata.itemLocation = account
    f.listings[0].platformAttributes = { ...f.listings[0].platformAttributes, ...sheet }
    return f
  }
  it('a country and a postal code on the listing are enough: both are sent, with no city', async () => {
    const plan = await prepareEbayPublication(located({ itemLocationCountry: 'IT', itemPostalCode: '47822' }))
    expect(plan.xml).toContain('<Country>IT</Country>')
    expect(plan.xml).toContain('<PostalCode>47822</PostalCode>')
    expect(plan.xml).not.toMatch(/<Location>/)
  })
  it('a country and a city still work', async () => {
    const plan = await prepareEbayPublication(located({ itemLocationCountry: 'IT', itemLocation: 'Riccione' }))
    expect(plan.xml).toContain('<Location>Riccione</Location>')
  })
  it('a blank cell falls through to the account default', async () => {
    const plan = await prepareEbayPublication(located({ itemLocationCountry: 'IT', itemLocation: ' ', itemPostalCode: '' }, { postalCode: '47822' }))
    expect(plan.xml).toContain('<PostalCode>47822</PostalCode>')
  })
  it('no postal code and no city: refused, naming the cells to set', async () => {
    await expect(prepareEbayPublication(located({ itemLocationCountry: 'IT' }))).rejects.toThrow('eBay needs the item location country and a postal code or city to create a listing. Set "Item location country" and "Item location postal code"')
  })
  it('no country: refused', async () => {
    await expect(prepareEbayPublication(located({ itemPostalCode: '47822' }))).rejects.toThrow('eBay needs the item location country')
  })
})
