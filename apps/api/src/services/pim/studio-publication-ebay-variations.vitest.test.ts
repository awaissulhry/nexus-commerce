import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * VTR step 0 — the eBay studio builder's VARIATIONS, against the REAL variation rules (only the loader is replaced).
 *
 *  · values: publish sends the channel cell the Information sheet shows (a pinned eBay value), not the Shared value.
 *    Measured on a private copy (2026-09-26): xavia-knee-slider-orange shows "Arancione" on eBay IT, and the builder
 *    put "Arancia" (Shared) in the listing.
 *  · live re-publish: a live item is validated like a new one (missing value, collision), never silently passed.
 */
const m = vi.hoisted(() => ({ itemId: null as string | null, variants: [] as Array<{ id: string; sku: string; included: boolean; axisValues: Record<string, string> }>, platformAttributes: {} as Record<string, unknown> }))

// Images rebuild P2c — not on the media plan: the builder keeps its per-product galleries (studio-publication-ebay-media tests the plan path).
vi.mock('../images/media-plan-switch.js', () => ({ isOnMediaPlan: async () => false }))
vi.mock('../../db.js', () => ({ default: { channelListing: { findFirst: async () => null }, channelMappingSet: { findMany: async () => [] }, channelMappingField: { findMany: async () => [] } } }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => 'live' }))
vi.mock('../ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'token' } }))
vi.mock('../ebay-description-theme.service.js', () => ({ renderListingDescriptionSafe: async (_db: unknown, input: { body: string }) => ({ html: `<p>${input.body}</p>`, warnings: [] }) }))
vi.mock('./studio-publication-media.js', () => ({ publicationImages: () => ['https://img.example/fam-1.jpg'] }))
vi.mock('../stock-pool/sync-ledgers.js', () => ({ loadSyncLedgers: async () => new Map() }))
vi.mock('./channel-specs/index.js', async original => ({
  ...(await original<typeof import('./channel-specs/index.js')>()),
  loadEbaySpec: async (_marketplace: string, categoryIds: string[]) => (categoryIds.map(String), { absent: false, fields: [{ key: 'title', channelStore: { kind: 'listingColumn', column: 'title' } }] }),
}))
// The loader reads the database; everything after it — the resolver, collisions, readiness — is real.
vi.mock('./stored-variation-projection.js', async original => {
  const real = await original<typeof import('./stored-variation-projection.js')>()
  const { resolveVariationProjection } = await import('./variation-rules.service.js')
  const { limitsFor, vocabularyFor } = await import('./family-projection-limits.js')
  return { ...real, loadStoredVariationProjection: async () => {
    const input = {
      coordinate: { channel: 'EBAY', market: 'IT', accountId: 'acc', aliasKey: '', label: 'EBAY · IT' },
      family: { familyAxes: ['Colore', 'Taglia'], axisLabels: { color: 'Color', size: 'Size' }, productVersion: 1, productTheme: null, childIds: m.variants.map(v => v.id),
        variants: m.variants.map(v => ({ ...v, axisValues: { ...v.axisValues } })) },
      listing: { version: 3, variationTheme: null, variationMapping: null, platformAttributes: m.platformAttributes, externalListingId: m.itemId, listingStatus: m.itemId ? 'ACTIVE' : 'DRAFT' },
      rule: null,
      schema: { ebay: { categoryId: '57988', aspects: [
        { name: 'Colore', englishName: 'Color', variantEligible: true, required: false, columnKey: 'color' },
        { name: 'Taglia', englishName: 'Size', variantEligible: true, required: false, columnKey: 'size' },
        { name: 'Scollatura', englishName: 'Neckline', variantEligible: true, required: false, columnKey: 'scollatura' },
      ], nonVariationAspects: ['Marca', 'Brand'] } },
      limits: limitsFor('EBAY'), vocabulary: vocabularyFor('EBAY'),
    }
    return { input, cell: resolveVariationProjection(input as any) }
  } }
})

import { buildEbayListingInput } from './studio-publication-ebay.js'

const updatedAt = new Date('2026-09-01T00:00:00Z')
const product = (id: string, sku: string, extra: Record<string, unknown> = {}) => ({ id, sku, name: `Nome ${sku}`, ean: null, parentId: null, isParent: false,
  variationTheme: null, categoryAttributes: {}, variantAttributes: {}, brand: 'Xavia', images: [], basePrice: 99, totalStock: 5, updatedAt, ...extra })
const listing = (productId: string, extra: Record<string, unknown> = {}) => ({ id: `l-${productId}`, productId,
  channel: 'EBAY', marketplace: 'IT', region: 'IT', channelConnectionId: 'acc', aliasKey: '', externalListingId: m.itemId, platformAttributes: productId === 'p' ? { categoryId: '57988' } : {}, fulfillmentMethod: null,
  title: 'Titolo', description: 'Descrizione', price: null, quantity: 5, priceOverride: null, quantityOverride: null, stockBuffer: 0, listingStatus: 'ACTIVE',
  syncStatus: 'IN_SYNC', followMasterPrice: true, followMasterQuantity: true, followMasterTitle: true, followMasterDescription: true, followMasterBulletPoints: true,
  masterPrice: null, masterTitle: null, masterDescription: null, masterQuantity: null, updatedAt, ...extra })
const AXIS_FIELDS = [
  { fieldKey: 'color', sheetKey: 'color', channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Colore'] } },
  { fieldKey: 'size', sheetKey: 'size', channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Taglia'] } },
  { fieldKey: 'scollatura', sheetKey: 'scollatura', channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Scollatura'] } },
]
const mapped = (value: unknown) => ({ value, status: 'mapped', provenance: value == null ? 'missing' : 'override', errors: [] })

/** A parent and two variants; `cells` are the resolved channel cells publish already holds (the sheet's values). */
function facts(cells: Record<string, Record<string, unknown>> = {}): any {
  const parent = product('p', 'FAM', { isParent: true })
  const kids = m.variants.map(v => product(v.id, v.sku, { parentId: 'p' }))
  return {
    scope: { channel: 'EBAY', marketplace: 'IT', accountId: 'acc' },
    destination: { aliasKey: null, currency: 'EUR', familyId: 'p' },
    account: { connectionMetadata: {} },
    parent, products: [parent, ...kids],
    listings: [listing('p'), ...kids.map(k => listing(k.id))],
    resolved: [{ catalogue: { fields: AXIS_FIELDS }, products: [parent, ...kids].map(p => ({ productId: p.id, category: { channelCategoryId: '57988' },
      cells: { title: { value: 'Giacca FAM', errors: [] }, ...(cells[p.id] ?? {}) } })) }],
  }
}
const aspects = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([k]) => k.startsWith('aspect_')))

beforeEach(() => {
  process.env.NEXUS_EBAY_REAL_API = 'true'; delete process.env.EBAY_SANDBOX
  m.itemId = null
  m.platformAttributes = {}
  m.variants = [
    { id: 'c1', sku: 'FAM-NERO-M', included: true, axisValues: { Colore: 'Nero', Taglia: 'M' } },
    { id: 'c2', sku: 'FAM-ARANCIA-M', included: true, axisValues: { Colore: 'Arancia', Taglia: 'M' } },
  ]
})

describe('eBay studio publish — the variation values are the channel cells', () => {
  it('positive control: with no channel value, the Shared values go out', async () => {
    const built = await buildEbayListingInput(facts(), { currency: 'EUR' })
    expect(built.variants.map(aspects)).toEqual([{ aspect_Colore: 'Nero', aspect_Taglia: 'M' }, { aspect_Colore: 'Arancia', aspect_Taglia: 'M' }])
  })

  it('a pinned eBay value is what eBay receives — the value the Information sheet shows', async () => {
    const built = await buildEbayListingInput(facts({ c2: { color: mapped('Arancione'), size: mapped('M') } }), { currency: 'EUR' })
    expect(built.variants.map(aspects)).toEqual([{ aspect_Colore: 'Nero', aspect_Taglia: 'M' }, { aspect_Colore: 'Arancione', aspect_Taglia: 'M' }])
    expect([...(built.shared.variationSpecificsSet?.Colore ?? [])].sort()).toEqual(['Arancione', 'Nero'])
  })

  it('a channel value that makes two variants identical is refused, as the sheet would count it', async () => {
    await expect(buildEbayListingInput(facts({ c2: { color: mapped('Nero') } }), { currency: 'EUR' })).rejects.toThrow(/cannot be told apart/)
  })

  it('a channel cell mapped to nothing is a missing value, not a silent fallback to Shared', async () => {
    await expect(buildEbayListingInput(facts({ c2: { size: mapped(null) } }), { currency: 'EUR' })).rejects.toThrow('1 variant has no value for an axis on EBAY · IT: FAM-ARANCIA-M (Size).')
  })
})

describe('eBay studio publish — a LIVE re-publish is validated too', () => {
  beforeEach(() => { m.itemId = '111' })

  it('positive control: a valid live family builds', async () => {
    const built = await buildEbayListingInput(facts(), { currency: 'EUR' })
    expect(built.itemId).toBe('111')
    expect(built.variants).toHaveLength(2)
  })

  it('a live item with a missing value is refused, like a new one', async () => {
    m.variants[1].axisValues = { Colore: 'Arancia' }
    await expect(buildEbayListingInput(facts(), { currency: 'EUR' })).rejects.toThrow('1 variant has no value for an axis on EBAY · IT: FAM-ARANCIA-M (Size).')
  })

  it('a live item whose variants collide is refused, like a new one', async () => {
    m.variants[1].axisValues = { Colore: 'Nero', Taglia: 'M' }
    await expect(buildEbayListingInput(facts(), { currency: 'EUR' })).rejects.toThrow(/cannot be told apart/)
  })
})

/**
 * Sheet pop-up P3, slice A1 — a CHANNEL-ONLY axis reaches eBay exactly as the sheet shows it. Trading and Inventory both take
 * their variation names and values from this one builder (`prepareEbayInventoryPublication` reads `shared.variationSpecificNames`
 * and each variation's `specifics`), so this is the parity check for both.
 */
describe('eBay studio publish — channel-only axes (sheet pop-up P3)', () => {
  const NECK = 'own:channel:scollatura', FIT = 'own:shared:fit'
  const own = (key: string, name: string) => ({ _variationAxesMode: 'override', _variationAxes: ['Colore', 'Taglia', key], _axisNameLabels: { Colore: 'Colore', Taglia: 'Taglia', [key]: name } })
  const specifics = (built: Awaited<ReturnType<typeof buildEbayListingInput>>) => built.shared.variations.map(v => v.specifics)

  it('an aspect from eBay\'s list goes out under its eBay name with the eBay column\'s value, and never as a plain item specific', async () => {
    m.platformAttributes = own(NECK, 'Scollatura')
    const built = await buildEbayListingInput(facts({ c1: { scollatura: mapped('V') }, c2: { scollatura: mapped('Tondo') } }), { currency: 'EUR' })
    expect(built.variants.map(aspects)).toEqual([
      { aspect_Colore: 'Nero', aspect_Taglia: 'M', aspect_Scollatura: 'V' },
      { aspect_Colore: 'Arancia', aspect_Taglia: 'M', aspect_Scollatura: 'Tondo' },
    ])
    expect(built.shared.variationSpecificNames).toEqual(['Colore', 'Taglia', 'Scollatura'])
    expect(specifics(built)).toEqual([{ Colore: 'Nero', Taglia: 'M', Scollatura: 'V' }, { Colore: 'Arancia', Taglia: 'M', Scollatura: 'Tondo' }])
    expect(built.shared.itemSpecifics ?? {}).not.toHaveProperty('Scollatura')
  })

  it('an axis under the operator\'s own name goes out under that name with the Shared attribute\'s value', async () => {
    m.platformAttributes = own(FIT, 'Vestibilità')
    m.variants[0].axisValues[FIT] = 'Slim'
    m.variants[1].axisValues[FIT] = 'Regular'
    const built = await buildEbayListingInput(facts(), { currency: 'EUR' })
    expect(built.shared.variationSpecificNames).toEqual(['Colore', 'Taglia', 'Vestibilità'])
    expect(specifics(built)).toEqual([{ Colore: 'Nero', Taglia: 'M', Vestibilità: 'Slim' }, { Colore: 'Arancia', Taglia: 'M', Vestibilità: 'Regular' }])
  })

  it('a variant with no value on a channel-only axis blocks the publish with its SKU (the save allowed it — Q-D3 a)', async () => {
    m.platformAttributes = own(NECK, 'Scollatura')
    await expect(buildEbayListingInput(facts({ c1: { scollatura: mapped('V') } }), { currency: 'EUR' })).rejects.toThrow('1 variant has no value for an axis on EBAY · IT: FAM-ARANCIA-M (Neckline).')
  })

  it('a stored name eBay forbids for variations never reaches eBay', async () => {
    m.platformAttributes = own(FIT, 'Marca')
    m.variants.forEach(v => { v.axisValues[FIT] = 'Xavia' })
    await expect(buildEbayListingInput(facts(), { currency: 'EUR' })).rejects.toThrow(/error 219451/)
  })
})
