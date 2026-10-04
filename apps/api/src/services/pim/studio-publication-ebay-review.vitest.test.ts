import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Publish without surprises (2026-10-01, audit P1–P4, P7–P10, P13) — the eBay review names every problem at once, by SKU
 * and column label; fills what Nexus can (policies, item location, a variation row's category); checks with eBay itself
 * for a new listing; and runs every check in dry-run mode with ONE gate message.
 *
 * The builder, buildFlatRow, buildSharedListingInput, the XML serialiser, `reconcileEbayPolicies`, the review service and
 * the Verify mapping are REAL; the database loaders, eBay's answers and the account snapshot are a fixture.
 */
const m = vi.hoisted(() => ({
  mode: 'live' as string, stock: 3, pa: {} as Record<string, Record<string, unknown>>, listing: {} as Record<string, Record<string, unknown>>,
  category: {} as Record<string, string | null>, metadata: {} as Record<string, unknown>, products: ['p', 'c1', 'c2'], market: 'IT',
  snapshot: vi.fn(), specs: [] as string[], trading: vi.fn(), created: [] as unknown[], factsIssues: [] as unknown[],
}))

vi.mock('../images/media-plan-switch.js', () => ({ isOnMediaPlan: async () => false }))
vi.mock('../../db.js', () => ({ default: {
  channelListing: { findFirst: async () => null }, channelMappingSet: { findMany: async () => [] }, channelMappingField: { findMany: async () => [] },
  // Delete and relist: no listing here was deleted by Nexus.
  channelListingSnapshot: { findMany: async () => [] },
  bulkOperation: { findFirst: async () => null, create: async (input: unknown) => { m.created.push(input); return input } },
} }))
vi.mock('@nexus/database/workspace-context', () => ({ workspaceIdForQuery: () => 'business-a' }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => m.mode }))
vi.mock('../ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'token' } }))
vi.mock('../ebay-account.service.js', () => ({ ebayAccountService: { getSnapshot: m.snapshot } }))
vi.mock('../ebay-description-theme.service.js', () => ({ renderListingDescriptionSafe: async (_db: unknown, input: { body: string }) => ({ html: `<p>${input.body}</p>`, warnings: [] }) }))
vi.mock('./studio-publication-media.js', () => ({ publicationImages: () => ['https://img.example/fam-1.jpg'] }))
vi.mock('../stock-pool/sync-ledgers.js', () => ({ loadSyncLedgers: async () => new Map() }))
vi.mock('../channel-delist.service.js', () => ({ readEbayOutOfStockPreference: async () => 'ON' }))
vi.mock('../assortment/shared-listing-warning.js', () => ({ sharedListingWarnings: async () => [] }))
vi.mock('./studio-publication-overwrite.js', () => ({ readPublicationOverwrite: async () => undefined }))
vi.mock('./studio-publication-baseline.js', () => ({ readPublicationBaseline: async () => ({ values: new Map(), revision: 'baseline-1' }) }))
vi.mock('../ebay-trading-api.service.js', async original => ({ ...(await original<typeof import('../ebay-trading-api.service.js')>()), callTradingApi: m.trading }))
vi.mock('./studio-publication-plan.js', async original => ({ ...(await original<typeof import('./studio-publication-plan.js')>()), readPublicationFacts: async () => facts() }))
vi.mock('./channel-specs/index.js', async original => ({
  ...(await original<typeof import('./channel-specs/index.js')>()),
  loadEbaySpec: async (_market: string, ids: string[]) => { m.specs.push(ids[0]); return { absent: false, fields: [{ key: 'title', channelStore: { kind: 'listingColumn', column: 'title' } }] } },
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

import { EBAY_EU_SAFETY_NOTE, prepareEbayPublication } from './studio-publication-ebay.js'
import { EbayPublicationProblems, EbaySendingOff, ebayCheckIssue, tradingErrors } from './studio-publication-ebay-problems.js'
import { previewStudioPublication } from './studio-publication.service.js'
import { TradingApiFailure } from '../ebay-trading-api.service.js'

const updatedAt = new Date('2026-09-01T00:00:00Z')
const SKUS: Record<string, string> = { p: 'FAM', c1: 'FAM-NERO-M', c2: 'FAM-NERO-L', solo: 'SOLO' }
const product = (id: string, extra: Record<string, unknown> = {}) => ({ id, sku: SKUS[id], name: `Nome ${SKUS[id]}`, ean: null, parentId: null, isParent: false,
  variationTheme: null, categoryAttributes: {}, variantAttributes: {}, brand: 'Xavia', images: [], basePrice: 99, totalStock: m.stock, updatedAt, ...extra })
const listing = (productId: string) => ({ id: `l-${productId}`, productId,
  channel: 'EBAY', marketplace: 'IT', region: 'IT', channelConnectionId: 'acc', aliasKey: '', externalListingId: null,
  platformAttributes: { ...(productId === 'p' || productId === 'solo' ? { categoryId: '57988', conditionId: 'NEW' } : {}), ...(m.pa[productId] ?? {}) }, fulfillmentMethod: null,
  title: 'Titolo', description: 'Descrizione', price: null, quantity: 0, priceOverride: null, quantityOverride: null, stockBuffer: 0, listingStatus: 'DRAFT',
  syncStatus: 'IN_SYNC', followMasterPrice: true, followMasterQuantity: true, followMasterTitle: true, followMasterDescription: true, followMasterBulletPoints: true,
  masterPrice: null, masterTitle: null, masterDescription: null, masterQuantity: null, updatedAt, ...(m.listing[productId] ?? {}) })
const AXIS_FIELDS = [
  { fieldKey: 'color', sheetKey: 'color', channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Colore'] } },
  { fieldKey: 'size', sheetKey: 'size', channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Taglia'] } },
]
function facts(): any {
  const single = m.products.length === 1
  const rows = m.products.map(id => product(id, id === 'p' ? { isParent: true } : id.startsWith('c') ? { parentId: 'p' } : {}))
  return {
    scope: { channel: 'EBAY', marketplace: m.market, accountId: 'acc' },
    destination: { aliasKey: null, currency: 'EUR', familyId: rows[0].id },
    account: { displayName: 'Motovento eBay', connectionMetadata: m.metadata },
    aliasLabel: 'Primary listing', excluded: 0, skipped: [], issues: m.factsIssues, revision: 'facts-1',
    parent: rows[0], products: rows, listings: rows.map(p => listing(p.id)),
    resolved: [{ catalogue: { fields: single ? [] : AXIS_FIELDS }, products: rows.map(p => ({ productId: p.id,
      category: { channelCategoryId: p.id in m.category ? m.category[p.id] : '57988' }, cells: { title: { value: 'Giacca FAM', errors: [] } } })) }],
  }
}
const SNAPSHOT = {
  fulfillmentPolicies: [{ id: 'ship-it', name: 'Spedizione', marketplaceId: 'EBAY_IT' }], paymentPolicies: [{ id: 'pay-it', name: 'Pagamento', marketplaceId: 'EBAY_IT' }],
  returnPolicies: [{ id: 'ret-it', name: 'Reso', marketplaceId: 'EBAY_IT' }],
  // A made-up town and postal code (never a real address in a fixture).
  locations: [{ key: 'warehouse', name: 'Magazzino', country: 'IT', postalCode: '99999', city: 'Testville', enabled: true }],
}
const DEFAULTS = { ebayPolicies: { fulfillmentPolicyId: 'f', paymentPolicyId: 'pay', returnPolicyId: 'r' }, itemLocation: { country: 'IT', postalCode: '99999' } }
async function problemsOf(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (e: unknown) => e)
  expect(error).toBeInstanceOf(EbayPublicationProblems)
  return (error as EbayPublicationProblems).issues
}

beforeEach(() => {
  process.env.NEXUS_EBAY_REAL_API = 'true'; delete process.env.EBAY_SANDBOX
  delete process.env.EBAY_ITEM_COUNTRY; delete process.env.EBAY_ITEM_LOCATION; delete process.env.EBAY_ITEM_POSTAL_CODE
  m.mode = 'live'; m.stock = 3; m.pa = {}; m.listing = {}; m.category = {}; m.metadata = structuredClone(DEFAULTS); m.products = ['p', 'c1', 'c2']; m.factsIssues = []; m.market = 'IT'
  m.snapshot.mockReset().mockResolvedValue(structuredClone(SNAPSHOT)); m.specs = []; m.created = []
  m.trading.mockReset().mockResolvedValue({ ack: 'Success', errors: [], raw: '<VerifyAddFixedPriceItemResponse><Ack>Success</Ack></VerifyAddFixedPriceItemResponse>' })
})

describe('every problem in one review (P1, P13)', () => {
  it('names four problems at once, each by SKU and column label, never by an internal key', async () => {
    m.pa = { p: { conditionId: 'Nuovissimo', videoId: 'v-123' } }
    m.listing = { c2: { followMasterPrice: false } }
    m.metadata = { ebayPolicies: DEFAULTS.ebayPolicies }
    m.snapshot.mockResolvedValue({ ...structuredClone(SNAPSHOT), locations: [] })
    const issues = await problemsOf(prepareEbayPublication(facts()))
    expect(issues.length).toBeGreaterThanOrEqual(4)
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ sku: 'FAM', field: 'videoId', severity: 'error', message: 'Video id: Nexus cannot send a video with a new eBay listing yet. Clear the "Video id" cell on this row in the sheet.' }),
      expect.objectContaining({ sku: 'FAM', field: 'conditionId', message: 'Condition: eBay does not know "Nuovissimo". Choose a condition from the list on the main row.' }),
      expect.objectContaining({ sku: 'FAM-NERO-L', field: 'price', message: 'This listing has no price of its own for eBay IT. Set its price first.' }),
      expect.objectContaining({ sku: 'FAM', field: 'itemPostalCode', message: expect.stringContaining('eBay needs the item location country and a postal code or city') }),
    ]))
    expect(issues.map(i => i.message).join('\n')).not.toMatch(/videoId|bestOfferFloor|needs the eBay offer publication workflow/)
    // The same price is named once, not again by the later "valid price" check.
    expect(issues.filter(i => i.sku === 'FAM-NERO-L' && i.field === 'price')).toHaveLength(1)
  })

  it('a reader without a collector still gets one refusal naming them all (the old one-line contract)', async () => {
    m.pa = { p: { videoId: 'v-123', listingFormat: 'AUCTION' } }
    await expect(prepareEbayPublication(facts())).rejects.toThrow(/FAM: Video id[\s\S]*Listing format: Nexus publishes fixed-price eBay listings only/)
  })
})

describe('defaults Nexus fills (P2, P3, P7, P10)', () => {
  it('P2: a listing with no policy takes this market\'s own through reconcileEbayPolicies', async () => {
    m.metadata = { itemLocation: DEFAULTS.itemLocation }
    const plan = await prepareEbayPublication(facts())
    expect(m.snapshot).toHaveBeenCalledWith('acc', 'EBAY_IT')
    expect(plan.xml).toContain('<ShippingProfileID>ship-it</ShippingProfileID>')
    expect(plan.xml).toContain('<PaymentProfileID>pay-it</PaymentProfileID>')
    expect(plan.xml).toContain('<ReturnProfileID>ret-it</ReturnProfileID>')
  })
  it('P2: a market with no policy of a kind is named, by which policy', async () => {
    m.metadata = { itemLocation: DEFAULTS.itemLocation }
    m.snapshot.mockResolvedValue({ ...structuredClone(SNAPSHOT), returnPolicies: [] })
    const issues = await problemsOf(prepareEbayPublication(facts()))
    expect(issues).toEqual([expect.objectContaining({ sku: 'FAM', field: 'returnPolicyId',
      message: 'Return policy: this eBay account has no return policy for eBay IT. Create one in eBay (Account › Business policies), then review again.' })])
  })
  it('P2 control: policies on the row or the account are used as they are, without reading eBay', async () => {
    const plan = await prepareEbayPublication(facts())
    expect(plan.xml).toContain('<ShippingProfileID>f</ShippingProfileID>')
    expect(m.snapshot).not.toHaveBeenCalled()
  })

  it('P3: a new listing with no location takes the eBay account\'s (country, postal code and city)', async () => {
    m.metadata = { ebayPolicies: DEFAULTS.ebayPolicies }
    const plan = await prepareEbayPublication(facts())
    expect(plan.xml).toContain('<Country>IT</Country>')
    expect(plan.xml).toContain('<PostalCode>99999</PostalCode>')
    expect(plan.xml).toContain('<Location>Testville</Location>')
  })
  it('P3: eBay\'s location never completes another country', async () => {
    m.metadata = { ebayPolicies: DEFAULTS.ebayPolicies }
    m.pa = { p: { itemLocationCountry: 'DE' } }
    const issues = await problemsOf(prepareEbayPublication(facts()))
    expect(issues).toEqual([expect.objectContaining({ field: 'itemPostalCode', message: expect.stringContaining('Set "Item location country" and "Item location postal code"') })])
  })

  it('P7: a variation row without its own category uses the main row\'s', async () => {
    m.category = { c1: null, c2: null }
    const plan = await prepareEbayPublication(facts())
    expect(m.specs).toEqual(['57988', '57988', '57988'])
    expect(plan.xml).toContain('<CategoryID>57988</CategoryID>')
  })
  it('P7: a main row without a category is named once, on the main row (not once per variation)', async () => {
    m.category = { p: null, c1: null, c2: null }
    const issues = await problemsOf(prepareEbayPublication(facts()))
    expect(issues.filter(i => i.field === 'categoryId')).toEqual([expect.objectContaining({ sku: 'FAM', message: 'Category is empty. Choose an eBay category on this listing\'s main row.' })])
  })

  it('P10: a main row without a condition is ONE problem, on the main row; nothing is sent as New', async () => {
    m.pa = { p: { conditionId: '' } }
    const issues = await problemsOf(prepareEbayPublication(facts()))
    expect(issues).toEqual([{ productId: 'p', sku: 'FAM', field: 'conditionId', severity: 'error', message: 'Condition is empty. Choose a condition on this listing\'s main row.' }])
  })
  it('P10: the review names it once, with no note, whether readiness already named it or not', async () => {
    m.pa = { p: { conditionId: '' } }
    for (const named of [[], [{ productId: 'p', sku: 'FAM', field: 'conditionId', severity: 'error', message: 'Condition: Field \'Condition\' is required.' }]]) {
      m.factsIssues = named
      const review = await previewStudioPublication('p', { channel: 'EBAY', marketplace: 'IT', accountId: 'acc' }, 'user')
      expect(review.issues.filter(i => i.field === 'conditionId' || /Condition/.test(i.message))).toEqual([expect.objectContaining({ sku: 'FAM', field: 'conditionId', severity: 'error' })])
    }
  })
})

describe('Best Offer prices are sent (E1, Owner decision 8)', () => {
  beforeEach(() => { m.products = ['solo'] })
  const listingDetails = (xml: string) => xml.match(/<ListingDetails>[\s\S]*?<\/ListingDetails>/)?.[0] ?? null
  const live = () => { m.listing = { solo: { externalListingId: '456' } } }

  it('Best Offer off: the prices are not sent, and the review says so (no refusal)', async () => {
    m.pa = { solo: { bestOffer: false, bestOfferFloor: 50, bestOfferCeiling: 80 } }
    const plan = await prepareEbayPublication(facts())
    expect(plan.xml).toContain('<BestOfferEnabled>false</BestOfferEnabled>')
    expect(listingDetails(plan.xml)).toBeNull()
    expect(plan.notices).toContain('Best offer auto-decline below and Best offer auto-accept from: not sent to eBay while "Best offer" is off.')
  })
  it('Best Offer on: auto-accept and auto-decline go to eBay, two decimals, in the market currency', async () => {
    m.pa = { solo: { bestOffer: true, bestOfferFloor: 50, bestOfferCeiling: 80.5 } }
    const plan = await prepareEbayPublication(facts())
    expect(plan.xml).toContain('<BestOfferEnabled>true</BestOfferEnabled>')
    expect(listingDetails(plan.xml)).toBe('<ListingDetails><BestOfferAutoAcceptPrice currencyID="EUR">80.50</BestOfferAutoAcceptPrice><MinimumBestOfferPrice currencyID="EUR">50.00</MinimumBestOfferPrice></ListingDetails>')
  })
  it('only the price that is set is sent', async () => {
    m.pa = { solo: { bestOffer: true, bestOfferFloor: 50, bestOfferCeiling: 0 } }
    expect(listingDetails((await prepareEbayPublication(facts())).xml)).toBe('<ListingDetails><MinimumBestOfferPrice currencyID="EUR">50.00</MinimumBestOfferPrice></ListingDetails>')
  })
  it.each([[0, 0], ['', ''], [null, null]])('Best Offer on, both prices not set (%j, %j): nothing sent, no problem, no block — new and live', async (floor, ceiling) => {
    for (const isLive of [false, true]) {
      m.listing = isLive ? { solo: { externalListingId: '456' } } : {}
      m.pa = { solo: { bestOffer: true, bestOfferFloor: floor, bestOfferCeiling: ceiling } }
      const plan = await prepareEbayPublication(facts())
      expect(listingDetails(plan.xml)).toBeNull()
      expect((plan.notices ?? []).filter(note => /Best offer/.test(note))).toEqual([])
    }
  })
  it('a new listing: auto-decline at or above auto-accept is refused by name', async () => {
    m.pa = { solo: { bestOffer: true, bestOfferFloor: 80, bestOfferCeiling: 50 } }
    expect(await problemsOf(prepareEbayPublication(facts()))).toEqual([expect.objectContaining({ sku: 'SOLO', field: 'bestOfferFloor',
      message: 'Best offer auto-decline below (80.00) must be below Best offer auto-accept from (50.00).' })])
  })
  it('a new listing: auto-accept at or above the price is refused by name', async () => {
    m.pa = { solo: { bestOffer: true, bestOfferCeiling: 99 } }
    expect(await problemsOf(prepareEbayPublication(facts()))).toEqual([expect.objectContaining({ sku: 'SOLO', field: 'bestOfferCeiling',
      message: 'Best offer auto-accept from (99.00) must be below the price (99.00).' })])
  })
  it('a new listing: a negative price is refused by name', async () => {
    m.pa = { solo: { bestOffer: true, bestOfferFloor: -5 } }
    expect(await problemsOf(prepareEbayPublication(facts()))).toEqual([expect.objectContaining({ sku: 'SOLO', field: 'bestOfferFloor',
      message: 'Best offer auto-decline below: set an amount above 0, or leave it blank (this row has -5).' })])
  })
  it('a LIVE listing: prices that cannot be sent are a note, never a block; eBay keeps its own', async () => {
    live()
    m.pa = { solo: { bestOffer: true, bestOfferFloor: 80, bestOfferCeiling: 50 } }
    const plan = await prepareEbayPublication(facts())
    expect(plan.xml).toContain('ReviseFixedPriceItemRequest')
    expect(listingDetails(plan.xml)).toBeNull()
    expect(plan.notices).toContain('Best offer auto-decline below (80.00) must be below Best offer auto-accept from (50.00). Nexus does not send the Best Offer prices; eBay keeps the ones it holds.')
  })
})

describe('Max per buyer (E1)', () => {
  beforeEach(() => { m.products = ['solo'] })
  const restriction = (xml: string) => xml.match(/<QuantityRestrictionPerBuyer>[\s\S]*?<\/QuantityRestrictionPerBuyer>/)?.[0] ?? null
  it('a whole number, 1 or more, is sent', async () => {
    m.pa = { solo: { quantityLimitPerBuyer: 3 } }
    expect(restriction((await prepareEbayPublication(facts())).xml)).toBe('<QuantityRestrictionPerBuyer><MaximumQuantity>3</MaximumQuantity></QuantityRestrictionPerBuyer>')
  })
  it.each([null, ''])('blank (%j): nothing is sent and nothing is said — new and live', async (value) => {
    for (const isLive of [false, true]) {
      m.listing = isLive ? { solo: { externalListingId: '456' } } : {}
      m.pa = { solo: { quantityLimitPerBuyer: value } }
      const plan = await prepareEbayPublication(facts())
      expect(restriction(plan.xml)).toBeNull()
      expect((plan.notices ?? []).filter(note => /Max per buyer/.test(note))).toEqual([])
    }
  })
  it.each([0, 2.5, -1])('a new listing: %j is refused by name', async (value) => {
    m.pa = { solo: { quantityLimitPerBuyer: value } }
    expect(await problemsOf(prepareEbayPublication(facts()))).toEqual([expect.objectContaining({ sku: 'SOLO', field: 'quantityLimitPerBuyer',
      message: `Max per buyer: eBay takes a whole number, 1 or more (this row has ${value}). Fix it on this listing's main row, or leave it blank.` })])
  })
  it('a LIVE listing: a value eBay cannot take is not sent, and is a note, never a block', async () => {
    m.listing = { solo: { externalListingId: '456' } }
    m.pa = { solo: { quantityLimitPerBuyer: 0 } }
    const plan = await prepareEbayPublication(facts())
    expect(restriction(plan.xml)).toBeNull()
    expect(plan.notices).toContain('Max per buyer: eBay takes a whole number, 1 or more (this row has 0). Fix it on this listing\'s main row, or leave it blank. Nexus does not send it; eBay keeps the limit it holds.')
  })
})

describe('EU product safety and parts compatibility (E1, item 3)', () => {
  const SAFETY = 'Product safety information: Nexus does not send this to eBay; the saved value is not sent.'
  const PARTS = 'Parts compatibility: Nexus does not send this to eBay; the saved value is not sent.'
  it('a saved value is a note, never a block, on a new listing', async () => {
    m.pa = { p: { regulatory: { manufacturer: 'Fixture maker' }, compatibility: 'Fixture fit' } }
    const plan = await prepareEbayPublication(facts())
    expect(plan.notices).toEqual(expect.arrayContaining([SAFETY, PARTS]))
  })
  it('… and on a live listing', async () => {
    m.products = ['solo']; m.listing = { solo: { externalListingId: '456' } }
    m.pa = { solo: { regulatory: { manufacturer: 'Fixture maker' } } }
    const plan = await prepareEbayPublication(facts())
    expect(plan.notices).toContain(SAFETY)
  })
  it('a new listing on an EU site is told to add the manufacturer and EU responsible person in Seller Hub; not the UK, not a live listing', async () => {
    expect((await prepareEbayPublication(facts())).notices).toContain(EBAY_EU_SAFETY_NOTE)
    m.market = 'UK'
    expect((await prepareEbayPublication(facts())).notices ?? []).not.toContain(EBAY_EU_SAFETY_NOTE)
    m.market = 'IT'; m.products = ['solo']; m.listing = { solo: { externalListingId: '456' } }
    expect((await prepareEbayPublication(facts())).notices ?? []).not.toContain(EBAY_EU_SAFETY_NOTE)
  })
})

describe('Condition on a live listing (E1, Owner decision 7)', () => {
  beforeEach(() => { m.products = ['solo']; m.listing = { solo: { externalListingId: '456' } } })
  it('blank: no <ConditionID> is sent, so eBay keeps its own; nothing blocks', async () => {
    m.pa = { solo: { conditionId: '' } }
    const plan = await prepareEbayPublication(facts())
    expect(plan.xml).toContain('ReviseFixedPriceItemRequest')
    expect(plan.xml).not.toContain('<ConditionID>')
  })
  it('a word eBay does not know: not sent, said in a note, nothing blocks', async () => {
    m.pa = { solo: { conditionId: 'Nuovissimo' } }
    const plan = await prepareEbayPublication(facts())
    expect(plan.xml).not.toContain('<ConditionID>')
    expect(plan.notices).toContain('Condition: eBay does not know "Nuovissimo", so Nexus does not send it; eBay keeps the listing\'s current condition.')
  })
  it('control: a condition Nexus holds is sent', async () => {
    expect((await prepareEbayPublication(facts())).xml).toContain('<ConditionID>1000</ConditionID>')
  })
})

describe('dry-run: every check runs, nothing reaches eBay (P9)', () => {
  beforeEach(() => { m.mode = 'dry-run' })
  it('a clean listing ends in the silent "sending off" marker, carrying its notes; eBay is never read', async () => {
    m.metadata = {}
    const error = await prepareEbayPublication(facts()).then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(EbaySendingOff)
    expect((error as EbaySendingOff).notes).toEqual(expect.arrayContaining([expect.stringContaining('Item location postal code is not set on the main row'),
      expect.stringContaining('Shipping policy is not set. When sending is on, Nexus uses this eBay account\'s first shipping policy')]))
    expect(m.snapshot).not.toHaveBeenCalled()
    expect(m.trading).not.toHaveBeenCalled()
  })
  it('the review lists the data problems and ONE gate message', async () => {
    m.listing = { c1: { followMasterPrice: false }, c2: { followMasterPrice: false } }
    m.pa = { p: { videoId: 'v-1' } }
    const review = await previewStudioPublication('p', { channel: 'EBAY', marketplace: 'IT', accountId: 'acc' }, 'user')
    const errors = review.issues.filter(i => i.severity === 'error')
    expect(errors.map(i => i.sku)).toEqual(expect.arrayContaining(['FAM', 'FAM-NERO-M', 'FAM-NERO-L']))
    const gates = errors.filter(i => /Sending is off|Live eBay publication|Live publishing/.test(i.message))
    expect(gates).toEqual([expect.objectContaining({ message: expect.stringContaining('Sending is off: publishing to eBay is in dry-run mode on this server.') })])
    expect(review.id).toBeNull()
    expect(m.trading).not.toHaveBeenCalled()
  })
})

describe('eBay\'s own check in the review (P1)', () => {
  const answer = (...blocks: string[]) => `<VerifyAddFixedPriceItemResponse><Ack>Failure</Ack>${blocks.join('')}</VerifyAddFixedPriceItemResponse>`
  const block = (severity: string, code: string, short: string, long: string) =>
    `<Errors><ShortMessage>${short}</ShortMessage><LongMessage>${long}</LongMessage><ErrorCode>${code}</ErrorCode><SeverityCode>${severity}</SeverityCode></Errors>`

  it('a new listing is checked by eBay during the review; its errors become named review problems', async () => {
    const raw = answer(block('Error', '37', 'Input data is invalid.', 'Input data for tag &lt;Item.PostalCode&gt; is invalid or missing. Please check API documentation.'),
      block('Error', '21919303', 'The item specific Marca is missing.', 'The item specific Marca is missing. Add Marca to this listing, enter a valid value, and then try again.'),
      block('Warning', '21917236', 'Funds from your sales may be unavailable.', 'Funds from your sales may be unavailable and show as pending in your PayPal account.'))
    m.trading.mockRejectedValue(new TradingApiFailure('eBay VerifyAddFixedPriceItem Failure: …', false, undefined, [], raw))
    const review = await previewStudioPublication('p', { channel: 'EBAY', marketplace: 'IT', accountId: 'acc' }, 'user')
    expect(m.trading).toHaveBeenCalledTimes(1)
    expect(m.trading.mock.calls[0][0]).toBe('VerifyAddFixedPriceItem')
    expect(m.trading.mock.calls[0][1]).toContain('<VerifyAddFixedPriceItemRequest')
    expect(review.issues).toEqual(expect.arrayContaining([
      { severity: 'error', field: 'itemPostalCode', message: 'Item location postal code: eBay says this is missing or not valid.',
        detail: 'Input data for tag <Item.PostalCode> is invalid or missing. Please check API documentation. (eBay code 37)' },
      expect.objectContaining({ severity: 'error', message: 'eBay says: The item specific Marca is missing.', detail: expect.stringContaining('(eBay code 21919303)') }),
      expect.objectContaining({ severity: 'warning', message: 'eBay says: Funds from your sales may be unavailable.' }),
    ]))
    expect(review.id).toBeNull()
  })
  it('a clean answer adds nothing and the review can be sent', async () => {
    const review = await previewStudioPublication('p', { channel: 'EBAY', marketplace: 'IT', accountId: 'acc' }, 'user')
    expect(m.trading).toHaveBeenCalledTimes(1)
    expect(review.issues.filter(i => i.severity === 'error')).toEqual([])
    expect(review.id).not.toBeNull()
  })
  it('no answer from eBay is a note, never a refusal: the send checks again', async () => {
    m.trading.mockRejectedValue(new Error('eBay VerifyAddFixedPriceItem HTTP 503'))
    const review = await previewStudioPublication('p', { channel: 'EBAY', marketplace: 'IT', accountId: 'acc' }, 'user')
    expect(review.issues).toContainEqual({ severity: 'warning', message: 'Nexus could not ask eBay to check this listing now (eBay VerifyAddFixedPriceItem HTTP 503). eBay checks it again when you publish.' })
    expect(review.id).not.toBeNull()
  })
  it('Nexus\'s own problems come first: eBay is not asked to name them again', async () => {
    m.pa = { p: { videoId: 'v-1' } }
    await previewStudioPublication('p', { channel: 'EBAY', marketplace: 'IT', accountId: 'acc' }, 'user')
    expect(m.trading).not.toHaveBeenCalled()
  })
  it('E1: maps eBay\'s Best Offer price errors to the two columns, by tag or by its words', () => {
    const [byTag, byWords] = tradingErrors(`${block('Error', '37', 'Input data is invalid.', 'Input data for tag &lt;Item.ListingDetails.BestOfferAutoAcceptPrice&gt; is invalid.')}${block('Error', '0', 'Auto decline price is invalid.', 'The auto decline price must be lower than the Buy It Now price.')}`).map(ebayCheckIssue)
    expect(byTag).toMatchObject({ field: 'bestOfferCeiling', message: 'Best offer auto-accept from: eBay says this is missing or not valid.' })
    expect(byWords).toMatchObject({ field: 'bestOfferFloor', message: 'Best offer auto-decline below: eBay says: Auto decline price is invalid.' })
  })
  it('maps eBay\'s policy and condition tags to the sheet\'s columns', () => {
    const [policy, condition] = tradingErrors(`${block('Error', '21916582', 'Invalid shipping policy.', 'The shipping policy for &lt;Item.SellerProfiles.SellerShippingProfile.ShippingProfileID&gt; is not valid.')}${block('Error', '37', 'Input data is invalid.', 'Input data for tag &lt;Item.ConditionID&gt; is invalid.')}`).map(ebayCheckIssue)
    expect(policy).toMatchObject({ field: 'fulfillmentPolicyId', message: 'Shipping policy: eBay says: Invalid shipping policy.' })
    expect(condition).toMatchObject({ field: 'conditionId', message: 'Condition: eBay says this is missing or not valid.' })
  })
})
