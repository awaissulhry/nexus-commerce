import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Amazon sheet gaps (D4=B) — Publish's offer lane on a LIVE Amazon listing: the review lines of its saved offer draft,
 * the whole roots they compile to, and the quantity a fulfilment root goes out with.
 *
 * 🔴 WHAT THIS GUARDS. An Amazon PATCH `replace` of `/attributes/<root>` sets the WHOLE root. The selected draft leaves
 * go on top of Amazon's current root (the review read): the business (B2B) instance and another market's instance stay,
 * every leaf not selected keeps Amazon's value, and the fulfilment root carries the stock job's quantity at send time
 * (pin 10, buffer 3, routed 50 → 10) — never a number frozen into the review.
 *
 * The real review on PGlite (the pattern of `studio-publication-send-price.vitest.test.ts`): `readPublicationFacts` →
 * `prepareAmazonPublication` → `prepareAmazonChanges` → `compileAmazonChanges` → `withSendQuantities`. Amazon's read is a
 * fixture; nothing is sent. Every id is invented.
 */
const state = vi.hoisted(() => ({ db: null as any, remote: {} as Record<string, unknown>, warehouse: '' }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'TEST-SELLER', getAmazonRegion: async () => 'eu', getAmazonSpClient: vi.fn() }))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({ AmazonSpApiClient: class {
  getListingsItem = async ({ sku }: { sku: string }) => ({ success: true, sku, rawResponse: { sku, attributes: state.remote, summaries: [{ marketplaceId: IT_ID, productType: 'COAT' }] } })
} }))
vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { throw new Error(`network refused in a gate: ${String(url)}`) }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { loadAmazonSendQuantity } from '../amazon/send-quantity.js'
import { readPublicationFacts } from './studio-publication-plan.js'
import { prepareAmazonPublication } from './studio-publication-amazon.js'
import { readPublicationBaseline } from './studio-publication-baseline.js'
import { compileAmazonChanges, prepareAmazonChanges } from './studio-publication-amazon-changes.js'
import { publicationChangeId } from './studio-publication-changes.js'
import { AUTOMATE_PRICING_WARNING, ALWAYS_AVAILABLE_WARNING, planAmazonOfferLines, withSendQuantities, type OfferLaneInput } from './studio-publication-amazon-offer.js'
import { readAmazonOfferFacts } from '../amazon/offer-facts.js'
import { resetSaleWindowColumnCache } from './sale-window.js'

const IT_ID = 'APJ6JRA9NG5V4', DE_ID = 'A1PA6795UKMFR9'
const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const scheduled = (n: number) => [{ schedule: [{ value_with_tax: n }] }]
const leaf = (value: unknown, base: unknown) => ({ value, base, savedAt: '2026-10-01T09:00:00.000Z', savedBy: 'person-1' })
let account = ''

beforeAll(() => scoped(async () => {
  await state.db.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE; ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE;')
  resetSaleWindowColumnCache()
  for (const [code, id, language] of [['IT', IT_ID, 'it'], ['DE', DE_ID, 'de']]) {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, currency: 'EUR', region: 'EU', language, languages: [language], marketplaceId: id } as never })
    await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: code, productType: 'COAT', schemaVersion: 'v1', expiresAt: new Date(Date.now() + 86_400_000),
      schemaDefinition: { properties: {} } } })
  }
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'offer-lane', isActive: true, externalAccountId: 'TEST-SELLER',
    authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
  // Stock in a warehouse routed everywhere: 50 available.
  state.warehouse = (await prisma.stockLocation.create({ data: { code: 'OFFER-LANE-WH', name: 'Offer lane warehouse', type: 'WAREHOUSE' } })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })

/** Amazon's live roots: our IT offer, a business (B2B) offer and the DE offer; one merchant fulfilment entry. */
function amazonNow(over: { price?: number } = {}) {
  return {
    purchasable_offer: [
      { marketplace_id: IT_ID, currency: 'EUR', audience: 'ALL', our_price: scheduled(over.price ?? 49.9), minimum_seller_allowed_price: scheduled(30),
        maximum_seller_allowed_price: scheduled(60), map_price: scheduled(40), automated_pricing_merchandising_rule_plan: [{ merchandising_rule: { rule_id: 'R1' } }] },
      { marketplace_id: IT_ID, currency: 'EUR', audience: 'B2B', our_price: scheduled(47), quantity_discount_plan: [{ schedule: [{ discount_type: 'percent', levels: [{ lower_bound: 5, value: 3 }] }] }] },
      { marketplace_id: DE_ID, currency: 'EUR', audience: 'ALL', our_price: scheduled(55) },
    ],
    fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 7, lead_time_to_ship_max_days: 2, restock_date: '2027-01-15' }],
  }
}

/** A product at master 49.90 (floor 30, ceiling 70) live on Amazon IT and DE, pinned at quantity 10 with a buffer of 3. */
async function seed(sku: string, drafts: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const product = await prisma.product.create({ data: { sku, name: sku, basePrice: 49.9, minPrice: 30, maxPrice: 70, productType: 'COAT', fulfillmentMethod: 'FBM' } as never })
  await prisma.stockLevel.create({ data: { productId: product.id, locationId: state.warehouse, quantity: 50, available: 50 } })
  const live = { amazonOffer: { minimum_seller_allowed_price: 30, maximum_seller_allowed_price: 60, map_price: 40, automated_pricing_rule_id: 'R1' },
    amazonFulfillment: { lead_time_to_ship_max_days: 2 }, attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT' }] } }
  const fulfilmentDrafts = Object.fromEntries(Object.entries(drafts).filter(([k]) => ['lead_time_to_ship_max_days', 'restock_date', 'is_inventory_available'].includes(k)))
  for (const [market, id] of [['IT', IT_ID], ['DE', DE_ID]]) {
    const leaves = market === 'IT' ? drafts : fulfilmentDrafts
    await prisma.channelListing.create({ data: { productId: product.id, channel: 'AMAZON', marketplace: market, channelMarket: `AMAZON_${market}`, region: 'EU',
      channelConnectionId: account, externalListingId: `TEST-ASIN-${sku}-${id}`, listingStatus: 'ACTIVE', isPublished: true,
      followMasterPrice: true, price: 49.9, pricingRule: 'FIXED', followMasterQuantity: false, quantity: 10, quantityOverride: 10, stockBuffer: 3, fulfillmentMethod: 'FBM',
      platformAttributes: { ...live, ...(Object.keys(leaves).length ? { amazonOfferDraft: { v: 1, leaves } } : {}) }, ...over } as never })
  }
  return product.id
}

async function review(productId: string) {
  return scoped(async () => {
    const facts = await readPublicationFacts(productId, { channel: 'AMAZON', marketplace: 'IT', accountId: account })
    const publication = await prepareAmazonPublication(facts)
    const baseline = await readPublicationBaseline(facts, publication.products)
    return prepareAmazonChanges(facts, publication, baseline.values)
  })
}
const offerLines = (plan: Awaited<ReturnType<typeof review>>) => plan.changes.filter(c => c.field.startsWith('purchasable_offer__') || c.field.startsWith('fulfillment_availability__'))
const patchOf = (sent: ReturnType<typeof compileAmazonChanges>, root: string) => sent.feed.messages[0].patches?.find((p: any) => p.path === `/attributes/${root}`)?.value

describe('🔴 the offer lane of a live Amazon listing', () => {
  it('lines from the draft, ticked; the replace carries 44.90 + minimum 35 over Amazon\'s whole root (B2B and DE kept, MAP and rule kept)', async () => {
    state.remote = amazonNow()
    const id = await scoped(() => seed('lane-whole', {
      our_price: leaf({ pin: 44.9 }, { follow: true }), minimum_seller_allowed_price: leaf(35, 30), lead_time_to_ship_max_days: leaf(3, 2) }))
    const plan = await review(id)
    const lines = offerLines(plan)
    expect(lines.map(c => [c.field, c.status, c.selectedByDefault])).toEqual([
      ['purchasable_offer__our_price', 'SEND', true],
      ['purchasable_offer__minimum_seller_allowed_price', 'SEND', true],
      ['fulfillment_availability__lead_time_to_ship_max_days', 'SEND', true],
    ])
    expect(lines.map(c => c.label)).toEqual([
      'Price · 49.90 → 44.90 — pins this price (now follows the master price)',
      'Minimum price · 30.00 → 35.00',
      'Handling time · 2 → 3 days — all EU markets (IT DE); sent with the current quantity',
    ])
    expect(lines[0].display).toEqual({ current: '44.90', lastAccepted: '49.90 (follows the master price)', channel: '49.90' })
    expect(lines[2].display).toEqual({ current: '3 days', lastAccepted: '2 days', channel: '2 days' })

    // Expected payload first: the IT all-buyers instance with the two selected leaves on top; everything else as Amazon has it.
    const expectedOffer = [
      { marketplace_id: IT_ID, currency: 'EUR', audience: 'ALL', our_price: scheduled(44.9), minimum_seller_allowed_price: scheduled(35),
        maximum_seller_allowed_price: scheduled(60), map_price: scheduled(40), automated_pricing_merchandising_rule_plan: [{ merchandising_rule: { rule_id: 'R1' } }] },
      amazonNow().purchasable_offer[1],
      amazonNow().purchasable_offer[2],
    ]
    const expectedFulfilment = [{ fulfillment_channel_code: 'DEFAULT', lead_time_to_ship_max_days: 3, restock_date: '2027-01-15' }]
    const sent = compileAmazonChanges(JSON.parse(JSON.stringify(plan)), lines.map(c => c.id))
    expect(sent.feed.messages[0].operationType).toBe('PATCH')
    expect(patchOf(sent, 'purchasable_offer')).toEqual(expectedOffer)
    // The stored base has no quantity: it is the stock job's, at send time.
    expect(patchOf(sent, 'fulfillment_availability')).toEqual(expectedFulfilment)
    expect(sent.offers?.[id]).toEqual({
      leaves: { our_price: { pin: 44.9 }, minimum_seller_allowed_price: 35, lead_time_to_ship_max_days: 3 },
      base: { our_price: { follow: true }, minimum_seller_allowed_price: 30, lead_time_to_ship_max_days: 2 },
    })

    // At send: the stock job's quantity for this listing (pin 10, buffer 3, routed 50 → 10) — the same number the job sends.
    const delivered = await scoped(() => withSendQuantities(sent, { marketplace: 'IT', accountId: account, aliasKey: '' }))
    const fulfilment = delivered.feed.messages[0].patches?.find((p: any) => p.path === '/attributes/fulfillment_availability')?.value
    expect(fulfilment).toEqual([{ ...expectedFulfilment[0], quantity: 10 }])
    const listing = await scoped(() => prisma.channelListing.findFirstOrThrow({ where: { productId: id, marketplace: 'IT' } }))
    const job = await scoped(() => loadAmazonSendQuantity(prisma as never, { listingId: listing.id, requested: 99 }))
    expect(job.quantity).toBe(10)
    // The purchasable offer is untouched by the injection.
    expect(delivered.feed.messages[0].patches?.find((p: any) => p.path === '/attributes/purchasable_offer')?.value).toEqual(expectedOffer)
  })

  it('an unselected leaf keeps Amazon\'s value: only the price is sent, the minimum stays 30 on Amazon', async () => {
    state.remote = amazonNow()
    const id = await scoped(() => seed('lane-unselected', { our_price: leaf({ pin: 44.9 }, { follow: true }), minimum_seller_allowed_price: leaf(35, 30) }))
    const plan = await review(id)
    const sent = compileAmazonChanges(plan, [publicationChangeId(id, 'purchasable_offer__our_price')])
    expect((patchOf(sent, 'purchasable_offer') as any[])[0]).toMatchObject({ our_price: scheduled(44.9), minimum_seller_allowed_price: scheduled(30) })
    expect(patchOf(sent, 'fulfillment_availability')).toBeUndefined()
    expect(sent.offers?.[id]).toEqual({ leaves: { our_price: { pin: 44.9 } }, base: { our_price: { follow: true } } })
  })

  it('Amazon not at Nexus\'s live value → DIFFERS, unticked, with the sentence', async () => {
    state.remote = amazonNow({ price: 51 })
    const id = await scoped(() => seed('lane-differs', { our_price: leaf({ pin: 44.9 }, { follow: true }) }))
    const [line] = offerLines(await review(id))
    expect(line).toMatchObject({ status: 'DIFFERS', selectable: true, selectedByDefault: false,
      reason: 'Amazon shows 51.00, not Nexus\'s live 49.90 — a price push may still be on its way, or it was changed in Seller Central.' })
  })

  it('refuses a price under the product\'s floor and a restock date that has passed, by name', async () => {
    state.remote = amazonNow()
    const id = await scoped(() => seed('lane-refused', { our_price: leaf({ pin: 25 }, { follow: true }), restock_date: leaf('2020-01-01', '2027-01-15') }))
    const lines = offerLines(await review(id))
    expect(lines.map(c => [c.field, c.selectable])).toEqual([['purchasable_offer__our_price', false], ['fulfillment_availability__restock_date', false]])
    expect(lines[0].reason).toBe('Nothing was sent to Amazon for lane-refused: 25 is below the pricing floor of 30 set on this product. Change the price, or change the floor.')
    expect(lines[1].reason).toBe('A restock date is today or later — Amazon ignores a date that has passed')
  })
})

describe('line words (pure)', () => {
  type Listing = { price?: number; priceOverride?: number; followMasterPrice?: boolean }
  const facts = (pa: Record<string, unknown>, listing: Listing, lane: 'job' | 'publish', followPrice?: number) =>
    readAmazonOfferFacts({ marketplace: 'IT', price: 49.9, followMasterPrice: true, ...listing, platformAttributes: pa }, lane, { followPrice })
  const input = (drafts: Record<string, unknown>, listing: Listing = {}, followPrice?: number): OfferLaneInput => {
    const pa = { amazonOfferDraft: { v: 1, leaves: drafts }, attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT' }] } }
    return { productId: 'p', sku: 'SKU', isParent: false, listingId: 'l', marketplaceId: IT_ID, currency: 'EUR', masterCurrency: 'EUR',
      live: facts(pa, listing, 'job'), publish: facts(pa, listing, 'publish', followPrice),
      remote: { purchasable_offer: [{ marketplace_id: IT_ID, audience: 'ALL', our_price: scheduled(49.9) }], fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 4 }] },
      rule: { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10 }, bounds: { minPrice: null, maxPrice: null }, quantity: { fba: false, refusal: null },
      euMarkets: ['IT', 'DE', 'FR', 'ES'], today: '2026-10-02' }
  }
  it('sale, rule, restock and always available: the design words, with their warnings', () => {
    const { inputs, plan } = planAmazonOfferLines(input({
      sale: leaf({ price: 39.9, start: '2026-10-10', end: '2026-10-20' }, null), automated_pricing_rule_id: leaf('R-123', null),
      is_inventory_available: leaf(true, null), restock_date: leaf('2026-11-01', null),
    }))
    expect(inputs.map(i => i.label)).toEqual([
      'Sale price · none → 39.90, 10 Oct – 20 Oct',
      'Automate Pricing rule · none → R-123',
      'Restock date · none → 1 Nov 2026 — all EU markets (IT DE FR ES); sent with the current quantity',
      'Always available · Off → On — all EU markets (IT DE FR ES); sent with the current quantity',
    ])
    expect(plan!.lines['purchasable_offer__automated_pricing_merchandising_rule_plan'].display.note).toBe(AUTOMATE_PRICING_WARNING)
    expect(plan!.lines['fulfillment_availability__is_inventory_available'].display.note).toBe(ALWAYS_AVAILABLE_WARNING)
    expect(plan!.lines['purchasable_offer__discounted_price__value_with_tax'].display).toEqual({ current: '39.90, 10 Oct – 20 Oct', lastAccepted: 'none', channel: 'none' })
  })
  it('a price set back to Follow names the rule; live that moved since the save says so', () => {
    const { inputs, plan } = planAmazonOfferLines(input({ our_price: leaf({ follow: true }, { pin: 50 }) }, { followMasterPrice: false, price: 52, priceOverride: 52 }, 54.89))
    expect(inputs[0].label).toBe('Price · 52.00 → 54.89 — follows the master price +10% again')
    expect(plan!.lines['purchasable_offer__our_price'].display).toEqual({ current: '54.89 (follows the master price +10%)', lastAccepted: '52.00', channel: '49.90',
      note: 'Live changed since you saved: 50.00 → 52.00. Publish sends your saved value.' })
  })
  it('an FBA listing: every fulfilment line refused by name', () => {
    const { inputs } = planAmazonOfferLines({ ...input({ lead_time_to_ship_max_days: leaf(3, 2) }), quantity: { fba: true, refusal: null } })
    expect(inputs[0]).toMatchObject({ refusal: expect.stringContaining('Amazon stores and ships this listing (FBA)') })
  })
})

describe('🔴 a new listing\'s offer roots (the one builder, after the mapping)', () => {
  /** A product at master 49.90 with a still-draft Amazon IT listing (no ASIN yet), pinned at quantity 10 with a buffer of 3. */
  async function seedNew(sku: string, opts: { fbaStock?: number; listing?: Record<string, unknown>; saleWindow?: [string, string] } = {}) {
    const product = await prisma.product.create({ data: { sku, name: sku, basePrice: 49.9, minPrice: 30, maxPrice: 70, productType: 'COAT', fulfillmentMethod: 'FBM' } as never })
    await prisma.stockLevel.create({ data: { productId: product.id, locationId: state.warehouse, quantity: 50, available: 50 } })
    await prisma.productImage.create({ data: { productId: product.id, url: `https://images.example.test/${sku}.jpg`, type: 'MAIN', sortOrder: 0 } })
    if (opts.fbaStock) {
      const fba = await prisma.stockLocation.upsert({ where: { code: 'AMAZON-EU-FBA' }, create: { code: 'AMAZON-EU-FBA', name: 'Amazon EU FBA', type: 'AMAZON_FBA' }, update: {} } as never) as { id: string }
      await prisma.stockLevel.create({ data: { productId: product.id, locationId: fba.id, quantity: opts.fbaStock, available: opts.fbaStock } })
    }
    const listing = await prisma.channelListing.create({ data: { productId: product.id, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU',
      channelConnectionId: account, listingStatus: 'DRAFT', isPublished: false, syncPaused: true,
      followMasterPrice: true, price: 49.9, pricingRule: 'FIXED', followMasterQuantity: false, quantity: 10, quantityOverride: 10, stockBuffer: 3, fulfillmentMethod: 'FBM',
      ...opts.listing } as never })
    if (opts.saleWindow) await prisma.$executeRawUnsafe('UPDATE "ChannelListing" SET "salePriceStart" = $1::date, "salePriceEnd" = $2::date WHERE id = $3', ...opts.saleWindow, listing.id)
    return product.id
  }
  const prepare = (productId: string) => scoped(async () => prepareAmazonPublication(await readPublicationFacts(productId, { channel: 'AMAZON', marketplace: 'IT', accountId: account })))

  it('FBA evidence (stock at Amazon) on a listing typed FBM is refused by name — never re-coded, never sent a merchant quantity', async () => {
    const id = await scoped(() => seedNew('lane-new-fba', { fbaStock: 12 }))
    await expect(prepare(id)).rejects.toThrow('lane-new-fba: Amazon fulfils this product (FBA), but this listing is set to FBM. Nexus never sends it a merchant quantity: choose FBA for it, or move its stock out of FBA, before publishing.')
  })

  it('control: an FBM listing is created with the stock job\'s quantity (pin 10, buffer 3, routed 50 → 10) and its sale with both dates', async () => {
    const id = await scoped(() => seedNew('lane-new-fbm', { listing: { salePrice: 39.9 }, saleWindow: ['2026-10-10', '2026-10-20'] }))
    const [message] = (await prepare(id)).feed.messages
    expect(message.operationType).toBe('UPDATE')
    expect(message.attributes?.fulfillment_availability).toEqual([{ fulfillment_channel_code: 'DEFAULT', quantity: 10 }])
    expect(message.attributes?.purchasable_offer).toEqual([{ currency: 'EUR', marketplace_id: IT_ID, our_price: scheduled(49.9),
      discounted_price: [{ schedule: [{ start_at: '2026-10-10', end_at: '2026-10-20', value_with_tax: 39.9 }] }] }])
  })
})
