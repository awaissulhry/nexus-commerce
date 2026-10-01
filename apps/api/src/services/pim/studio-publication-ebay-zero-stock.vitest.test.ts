import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Owner 2026-10-01: a NEW eBay listing may start at stock 0 and get its stock later ("We do not want to limit the publish").
 * eBay holds a listing at 0 (hidden from search) only while the account's out-of-stock option is on, so Nexus reads that
 * option: on → the listing is built with quantity 0 and a review note; off or unreadable → refused with what to do. The
 * builder, buildFlatRow, buildSharedListingInput and the XML serialiser are REAL; the loaders and the eBay read are a fixture.
 */
const m = vi.hoisted(() => ({ stock: 0, outOfStock: 'ON' as 'ON' | 'OFF' | 'UNKNOWN', reads: 0, pa: {} as Record<string, Record<string, unknown>> }))

vi.mock('../images/media-plan-switch.js', () => ({ isOnMediaPlan: async () => false }))
vi.mock('../../db.js', () => ({ default: { channelListing: { findFirst: async () => null }, channelMappingSet: { findMany: async () => [] }, channelMappingField: { findMany: async () => [] } } }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => 'live' }))
vi.mock('../ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'token' } }))
vi.mock('../ebay-description-theme.service.js', () => ({ renderListingDescriptionSafe: async (_db: unknown, input: { body: string }) => ({ html: `<p>${input.body}</p>`, warnings: [] }) }))
vi.mock('./studio-publication-media.js', () => ({ publicationImages: () => ['https://img.example/fam-1.jpg'] }))
vi.mock('../stock-pool/sync-ledgers.js', () => ({ loadSyncLedgers: async () => new Map() }))
vi.mock('../channel-delist.service.js', () => ({ readEbayOutOfStockPreference: async () => { m.reads++; return m.outOfStock } }))
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
      family: { familyAxes: ['Colore', 'Taglia'], axisLabels: { color: 'Color', size: 'Size' }, productVersion: 1, productTheme: null, childIds: ['c1', 'c2'],
        variants: [{ id: 'c1', sku: 'FAM-NERO-M', included: true, axisValues: { Colore: 'Nero', Taglia: 'M' } }, { id: 'c2', sku: 'FAM-NERO-L', included: true, axisValues: { Colore: 'Nero', Taglia: 'L' } }] },
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

import { ebayPackageXml, prepareEbayPublication } from './studio-publication-ebay.js'

const updatedAt = new Date('2026-09-01T00:00:00Z')
const product = (id: string, sku: string, extra: Record<string, unknown> = {}) => ({ id, sku, name: `Nome ${sku}`, ean: null, parentId: null, isParent: false,
  variationTheme: null, categoryAttributes: {}, variantAttributes: {}, brand: 'Xavia', images: [], basePrice: 99, totalStock: m.stock, updatedAt, ...extra })
const listing = (productId: string) => ({ id: `l-${productId}`, productId,
  channel: 'EBAY', marketplace: 'IT', region: 'IT', channelConnectionId: 'acc', aliasKey: '', externalListingId: null, platformAttributes: { ...(productId === 'p' ? { categoryId: '57988' } : {}), ...(m.pa[productId] ?? {}) }, fulfillmentMethod: null,
  title: 'Titolo', description: 'Descrizione', price: null, quantity: 0, priceOverride: null, quantityOverride: null, stockBuffer: 0, listingStatus: 'DRAFT',
  syncStatus: 'IN_SYNC', followMasterPrice: true, followMasterQuantity: true, followMasterTitle: true, followMasterDescription: true, followMasterBulletPoints: true,
  masterPrice: null, masterTitle: null, masterDescription: null, masterQuantity: null, updatedAt })
const AXIS_FIELDS = [
  { fieldKey: 'color', sheetKey: 'color', channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Colore'] } },
  { fieldKey: 'size', sheetKey: 'size', channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Taglia'] } },
]
function facts(): any {
  const parent = product('p', 'FAM', { isParent: true })
  const kids = [product('c1', 'FAM-NERO-M', { parentId: 'p' }), product('c2', 'FAM-NERO-L', { parentId: 'p' })]
  return {
    scope: { channel: 'EBAY', marketplace: 'IT', accountId: 'acc' },
    destination: { aliasKey: null, currency: 'EUR', familyId: 'p' },
    account: { connectionMetadata: { ebayPolicies: { fulfillmentPolicyId: 'f', paymentPolicyId: 'pay', returnPolicyId: 'r' }, itemLocation: { country: 'IT', postalCode: '47822' } } },
    parent, products: [parent, ...kids],
    listings: [listing('p'), ...kids.map(k => listing(k.id))],
    resolved: [{ catalogue: { fields: AXIS_FIELDS }, products: [parent, ...kids].map(p => ({ productId: p.id, category: { channelCategoryId: '57988' },
      cells: { title: { value: 'Giacca FAM', errors: [] } } })) }],
  }
}
const quantities = (xml: string) => [...xml.matchAll(/<Variation>[\s\S]*?<Quantity>(\d+)<\/Quantity>/g)].map(x => Number(x[1]))

beforeEach(() => {
  process.env.NEXUS_EBAY_REAL_API = 'true'; delete process.env.EBAY_SANDBOX
  m.stock = 0; m.outOfStock = 'ON'; m.reads = 0; m.pa = {}
})

describe('a new eBay listing at stock 0', () => {
  it('positive control: with stock, nothing is asked and no note is added', async () => {
    m.stock = 3
    const plan = await prepareEbayPublication(facts())
    expect(quantities(plan.xml)).toEqual([3, 3])
    expect(plan.notices).toBeUndefined()
    expect(m.reads).toBe(0)
  })

  it('out-of-stock option on: built with quantity 0 on every variation, with a review note', async () => {
    const plan = await prepareEbayPublication(facts())
    expect(quantities(plan.xml)).toEqual([0, 0])
    expect(plan.notices).toEqual(['The stock is 0. eBay keeps this listing hidden from search until it has stock.'])
    expect(m.reads).toBe(1)
  })

  it('out-of-stock option off: refused, saying what to turn on', async () => {
    m.outOfStock = 'OFF'
    await expect(prepareEbayPublication(facts())).rejects.toThrow('The stock is 0, and this eBay account\'s out-of-stock option is off')
  })

  it('out-of-stock option unreadable: refused, never sent on a guess', async () => {
    m.outOfStock = 'UNKNOWN'
    await expect(prepareEbayPublication(facts())).rejects.toThrow('Nexus could not read this eBay account\'s out-of-stock option')
  })
})

// #36 (2026-10-01) — a new listing's package goes to eBay as ONE item-level ShippingPackageDetails, in metric whole numbers.
// It was refused ("packageWeight needs the eBay offer publication workflow"), so an imported weight blocked every publish.
describe('the package of a new eBay listing', () => {
  const GALE = { packageWeight: 2, weightUnit: 'KILOGRAM', packageLength: 45, packageWidth: 30, packageHeight: 8, dimensionUnit: 'CENTIMETER' }
  it('sends weight and size as eBay Trading wants them', () => {
    expect(ebayPackageXml(GALE, 'FAM')).toBe('<ShippingPackageDetails><MeasurementUnit>Metric</MeasurementUnit><WeightMajor unit="kg">2</WeightMajor><WeightMinor unit="gr">0</WeightMinor>'
      + '<PackageDepth unit="cm">8</PackageDepth><PackageLength unit="cm">45</PackageLength><PackageWidth unit="cm">30</PackageWidth></ShippingPackageDetails>')
  })
  it('converts other units to kilograms, grams and whole centimetres, and names the package type eBay\'s way', () => {
    const xml = ebayPackageXml({ packageType: 'PACKAGE_THICK_ENVELOPE', packageWeight: { value: 1.5, unit: 'POUND' }, packageLength: 10.2, dimensionUnit: 'INCH' }, 'FAM')
    expect(xml).toContain('<ShippingPackage>PackageThickEnvelope</ShippingPackage>')
    expect(xml).toContain('<WeightMajor unit="kg">0</WeightMajor><WeightMinor unit="gr">680</WeightMinor>')
    expect(xml).toContain('<PackageLength unit="cm">26</PackageLength>')
  })
  it('sends nothing when nothing is set, and refuses what it cannot send', () => {
    expect(ebayPackageXml({ packageWeight: 0, packageType: '' }, 'FAM')).toBe('')
    expect(() => ebayPackageXml({ packageType: 'SHOEBOX' }, 'FAM')).toThrow('FAM: eBay does not know the package type "SHOEBOX"')
    expect(() => ebayPackageXml({ packageWeight: 2 }, 'FAM')).toThrow('FAM: set the package weight unit')
    expect(() => ebayPackageXml({ packageLength: 45 }, 'FAM')).toThrow('FAM: set the package dimension unit')
  })
  it('a new listing with the same package on every row is built and sends it once', async () => {
    m.stock = 3
    m.pa = { p: GALE, c1: GALE, c2: {} }
    const plan = await prepareEbayPublication(facts())
    expect(plan.xml.match(/<ShippingPackageDetails>/g)).toHaveLength(1)
    expect(plan.xml).toContain('<WeightMajor unit="kg">2</WeightMajor>')
  })
  it('a row with another package than the main row is refused by name', async () => {
    m.stock = 3
    m.pa = { p: GALE, c2: { ...GALE, packageWeight: 3 } }
    await expect(prepareEbayPublication(facts())).rejects.toThrow('eBay takes one package type, weight and size for the whole listing. FAM-NERO-L holds a different package than the main row')
  })
})
