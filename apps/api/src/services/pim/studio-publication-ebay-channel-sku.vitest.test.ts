import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * S4 (per-channel SKU, docs/sheet-ids-sku-rows/PLAN.md) — the SKU each row of an eBay studio publication sends
 * (`ebayPublishSku`): a row eBay does not hold yet sends its WANTED SKU (its own `channelSku`, an extra listing's own SKU on
 * its main row, else the product SKU); a row eBay holds sends the SKU eBay holds (its confirmed `liveChannelSku`, else the
 * product SKU). Parity: with no own SKU anywhere, every row sends its product SKU, exactly as before.
 *
 * TODO(S10): a live row whose wanted SKU differs from eBay's keeps eBay's SKU here — moving a live eBay SKU (Trading revise
 * in place, renamed variations matched by their values) is step S10; the "S10" cases below pin today's behaviour.
 *
 * The real builder and variation rules; only the loaders, the description renderer and eBay are stood in. Nothing reaches
 * eBay. SKUs are fake.
 */
const m = vi.hoisted(() => ({
  itemId: null as string | null,
  variants: [] as Array<{ id: string; sku: string; included: boolean; axisValues: Record<string, string> }>,
  aliases: [] as Array<{ id: string; sku: string | null; productId: string }>,
  inventoryDestination: null as any,
}))

vi.mock('../../lib/queue.js', () => ({ addJobSafely: vi.fn(), outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('../images/media-plan-switch.js', () => ({ isOnMediaPlan: async () => false }))
vi.mock('../../db.js', () => ({ default: {
  marketplace: { findFirst: async () => ({ languages: ['it'] }) }, customAttribute: { findMany: async () => [] }, channelListing: { findFirst: async () => null },
  channelMappingSet: { findMany: async () => [] }, channelMappingField: { findMany: async () => [] },
  productListingAlias: { findMany: async ({ where }: any) => m.aliases.filter(a => where.id.in.includes(a.id)) },
} }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => 'live' }))
vi.mock('../ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'token' } }))
vi.mock('../ebay-description-theme.service.js', () => ({ renderListingDescriptionSafe: async (_db: unknown, input: { body: string }) => ({ html: `<p>${input.body}</p>`, warnings: [] }) }))
vi.mock('./studio-publication-media.js', () => ({ publicationImages: () => ['https://img.example/fam-1.jpg'] }))
vi.mock('../stock-pool/sync-ledgers.js', () => ({ loadSyncLedgers: async () => new Map() }))
vi.mock('../live-read/ebay-inventory.js', () => ({ readEbayInventoryListing: async (destination: unknown) => { m.inventoryDestination = destination; return { ok: true } } }))
vi.mock('./studio-publication-ebay-inventory.js', async original => ({ ...(await original<object>()), ebayInventoryReads: () => ({}) }))
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
      family: { familyAxes: ['Taglia'], axisLabels: { size: 'Size' }, productVersion: 1, productTheme: null, childIds: m.variants.map(v => v.id),
        variants: m.variants.map(v => ({ ...v, axisValues: { ...v.axisValues } })) },
      listing: { version: 3, variationTheme: null, variationMapping: null, platformAttributes: {}, externalListingId: m.itemId, listingStatus: m.itemId ? 'ACTIVE' : 'DRAFT' },
      rule: null,
      schema: { ebay: { categoryId: '57988', aspects: [{ name: 'Taglia', englishName: 'Size', variantEligible: true, required: false, columnKey: 'size' }], nonVariationAspects: ['Marca'] } },
      limits: limitsFor('EBAY'), vocabulary: vocabularyFor('EBAY'),
    }
    return { input, cell: resolveVariationProjection(input as any) }
  } }
})

import { buildEbayListingInput, ebayFullRevision, ebayLiveStock, prepareEbayInventoryPublication } from './studio-publication-ebay.js'
import { parseEbayItemDocument, parseEbayPublicationItem } from '../channel-drift/ebay-content-compare.js'

const updatedAt = new Date('2026-09-01T00:00:00Z')
const LIVE = { listingStatus: 'ACTIVE', isPublished: true }
const DRAFT = { listingStatus: 'DRAFT', isPublished: false, externalListingId: null }
const product = (id: string, sku: string, extra: Record<string, unknown> = {}) => ({ id, sku, name: `Nome ${sku}`, ean: null, parentId: null, isParent: false,
  variationTheme: null, categoryAttributes: {}, variantAttributes: {}, brand: 'Xavia', images: [], basePrice: 99, totalStock: 5, updatedAt, ...extra })
const listing = (productId: string, extra: Record<string, unknown> = {}) => ({ id: `l-${productId}`, productId,
  channel: 'EBAY', marketplace: 'IT', region: 'IT', channelConnectionId: 'acc', aliasKey: '', aliasId: null, externalListingId: m.itemId,
  platformAttributes: productId === 'p' ? { categoryId: '57988', conditionId: '1000' } : {}, fulfillmentMethod: null,
  title: 'Titolo', description: 'Descrizione', price: null, quantity: 5, priceOverride: null, quantityOverride: null, stockBuffer: 0,
  ...(m.itemId ? LIVE : DRAFT), channelSku: null, liveChannelSku: null,
  syncStatus: 'IN_SYNC', followMasterPrice: true, followMasterQuantity: true, followMasterTitle: true, followMasterDescription: true, followMasterBulletPoints: true,
  masterPrice: null, masterTitle: null, masterDescription: null, masterQuantity: null, updatedAt, ...extra })

/** A parent FAM and its variants; `rows` adds facts to each product's listing row. */
function facts(rows: Record<string, Record<string, unknown>> = {}, destination: Record<string, unknown> = {}): any {
  const parent = product('p', 'FAM', { isParent: true })
  const kids = m.variants.map(v => product(v.id, v.sku, { parentId: 'p' }))
  return {
    scope: { channel: 'EBAY', marketplace: 'IT', accountId: 'acc' },
    destination: { aliasKey: null, currency: 'EUR', familyId: 'p', ...destination },
    account: { connectionMetadata: {} },
    parent, products: [parent, ...kids],
    listings: [listing('p', rows.p), ...kids.map(k => listing(k.id, rows[k.id]))],
    resolved: [{ catalogue: { fields: [{ fieldKey: 'size', sheetKey: 'size', channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Taglia'] } }] },
      products: [parent, ...kids].map(p => ({ productId: p.id, category: { channelCategoryId: '57988' }, cells: { title: { value: 'Giacca FAM', errors: [] } } })) }],
  }
}
const sent = (built: Awaited<ReturnType<typeof buildEbayListingInput>>) => ({
  item: built.shared.sku, variations: built.shared.variations.map(v => v.sku), identities: built.identities.map(i => [i.productId, i.sku]) })

beforeEach(() => {
  process.env.NEXUS_EBAY_REAL_API = 'true'; delete process.env.EBAY_SANDBOX
  m.itemId = null
  m.aliases = []
  m.inventoryDestination = null
  m.variants = [
    { id: 'c1', sku: 'FAM-M', included: true, axisValues: { Taglia: 'M' } },
    { id: 'c2', sku: 'FAM-L', included: true, axisValues: { Taglia: 'L' } },
  ]
})

describe('a new eBay listing (rows eBay does not hold) sends each row\'s WANTED SKU', () => {
  it('parity: no own SKU anywhere → every row sends its product SKU, as before', async () => {
    expect(sent(await buildEbayListingInput(facts(), { currency: 'EUR' }))).toEqual({
      item: 'FAM', variations: ['FAM-M', 'FAM-L'], identities: [['p', 'FAM'], ['c1', 'FAM-M'], ['c2', 'FAM-L']] })
  })

  it('a row with its own SKU sends it (the item label too, from the main row)', async () => {
    const built = await buildEbayListingInput(facts({ p: { channelSku: 'FAM-EB' }, c1: { channelSku: 'FAM-M-EB' } }), { currency: 'EUR' })
    expect(sent(built)).toEqual({ item: 'FAM-EB', variations: ['FAM-M-EB', 'FAM-L'], identities: [['p', 'FAM-EB'], ['c1', 'FAM-M-EB'], ['c2', 'FAM-L']] })
  })

  it('an extra listing (alias): its own SKU is the main row\'s wanted SKU; the variations keep theirs', async () => {
    m.aliases = [{ id: 'alias-1', sku: 'FAM-ALT', productId: 'p' }]
    const rows = { p: { aliasKey: 'alias-1', aliasId: 'alias-1' }, c1: { aliasKey: 'alias-1' }, c2: { aliasKey: 'alias-1' } }
    expect(sent(await buildEbayListingInput(facts(rows, { aliasKey: 'alias-1' }), { currency: 'EUR' }))).toMatchObject({ item: 'FAM-ALT', variations: ['FAM-M', 'FAM-L'] })
  })

  it('a confirmed SKU on a still-draft row is not what eBay holds: the wanted SKU is sent', async () => {
    expect(sent(await buildEbayListingInput(facts({ c1: { channelSku: 'WANT-M', liveChannelSku: 'STALE-M' } }), { currency: 'EUR' })).variations).toEqual(['WANT-M', 'FAM-L'])
  })
})

describe('a live eBay listing (rows eBay holds) sends the SKU eBay holds', () => {
  beforeEach(() => { m.itemId = '111' })

  it('parity: no own SKU → the product SKUs', async () => {
    expect(sent(await buildEbayListingInput(facts(), { currency: 'EUR' }))).toEqual({
      item: 'FAM', variations: ['FAM-M', 'FAM-L'], identities: [['p', 'FAM'], ['c1', 'FAM-M'], ['c2', 'FAM-L']] })
  })

  it('a variation eBay holds under its own confirmed SKU is addressed by it', async () => {
    expect(sent(await buildEbayListingInput(facts({ c1: { channelSku: 'OWN-M', liveChannelSku: 'OWN-M' } }), { currency: 'EUR' })).variations).toEqual(['OWN-M', 'FAM-L'])
  })

  it('a new variation added to the live listing (a still-draft row) sends its wanted SKU', async () => {
    expect(sent(await buildEbayListingInput(facts({ c2: { ...DRAFT, channelSku: 'NEW-L' } }), { currency: 'EUR' })).variations).toEqual(['FAM-M', 'NEW-L'])
  })

  it('TODO(S10): a live row whose wanted SKU differs from eBay\'s keeps eBay\'s SKU (moving it is step S10)', async () => {
    const built = await buildEbayListingInput(facts({ c1: { channelSku: 'WANT-M' }, c2: { channelSku: 'WANT-L', liveChannelSku: 'HELD-L' } }), { currency: 'EUR' })
    expect(sent(built).variations).toEqual(['FAM-M', 'HELD-L'])
    // An extra listing's alias SKU (never sent to eBay) is not moved onto a live item either.
    m.aliases = [{ id: 'alias-1', sku: 'FAM-ALT', productId: 'p' }]
    const alias = await buildEbayListingInput(facts({ p: { aliasKey: 'alias-1', aliasId: 'alias-1' } }, { aliasKey: 'alias-1' }), { currency: 'EUR' })
    expect(sent(alias).item).toBe('FAM')
  })

  it('Full update still matches eBay\'s variations by the SKU eBay holds: an own SKU is neither added nor deleted', async () => {
    const built = await buildEbayListingInput(facts({ c1: { channelSku: 'OWN-M', liveChannelSku: 'OWN-M' } }), { currency: 'EUR' })
    const variation = (sku: string, size: string) => `<Variation><SKU>${sku}</SKU><StartPrice currencyID="EUR">99</StartPrice><Quantity>4</Quantity><VariationSpecifics><NameValueList><Name>Taglia</Name><Value>${size}</Value></NameValueList></VariationSpecifics><SellingStatus><QuantitySold>1</QuantitySold></SellingStatus></Variation>`
    const raw = `<GetItemResponse><Ack>Success</Ack><Item><ItemID>111</ItemID><SKU>FAM</SKU><Variations>${variation('OWN-M', 'M')}${variation('FAM-L', 'L')}</Variations></Item></GetItemResponse>`
    const full = ebayFullRevision({ shared: built.shared as any, settings: built.settings, itemId: '111', single: false,
      live: parseEbayPublicationItem(raw), stock: ebayLiveStock(parseEbayItemDocument(raw)) })
    expect(full).toMatchObject({ blockers: [], added: [], extras: [] })
    expect(full.xml).toContain('<SKU>OWN-M</SKU>')
    expect(full.xml).not.toContain('<SKU>FAM-M</SKU>')
  })
})

describe('an eBay Inventory listing is read under the SKUs eBay holds', () => {
  beforeEach(() => { m.itemId = '222' })

  it('parity: the group key and the variant SKUs are the product SKUs', async () => {
    await prepareEbayInventoryPublication(facts())
    expect(m.inventoryDestination).toMatchObject({ parentSku: 'FAM', expectedSkus: ['FAM-M', 'FAM-L'], itemId: '222' })
  })

  it('the main row\'s own confirmed SKU is the group key; a variation\'s own confirmed SKU is expected', async () => {
    await prepareEbayInventoryPublication(facts({ p: { liveChannelSku: 'GRP-EB' }, c2: { liveChannelSku: 'OWN-L' } }))
    expect(m.inventoryDestination).toMatchObject({ parentSku: 'GRP-EB', expectedSkus: ['FAM-M', 'OWN-L'] })
  })
})
