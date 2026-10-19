import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Round 6 (2026-10-01) — Publish sends a listing THE send price (`listingSendPrice`, the price door's rule), never the
 * master price for a follower and never the master number into another currency.
 *
 * 🔴 WHAT THIS GUARDS. The Amazon studio publication built its offer from `followMasterPrice ? product.basePrice : own`:
 * a listing following at "master +10%" went live at the master price, and Amazon UK (GBP) was sent the EUR master number
 * as pounds. Now a pin sends its own price, a follower its rule's price from the current master in the master currency,
 * a follower in another currency the price it holds — and one that holds none is refused for that SKU, by name, as the
 * price door refuses it.
 *
 * The real builder on PGlite, the pattern of `sheet-payload-parity.vitest.test.ts`: `readPublicationFacts` →
 * `prepareAmazonPublication`, built and never sent. Every id is invented.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
// The cached category schemas below are fresh, so no provider call is made — any fetch is a failure of the fixture.
vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { throw new Error(`network refused in a gate: ${String(url)}`) }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { readPublicationFacts } from './studio-publication-plan.js'
import { prepareAmazonPublication } from './studio-publication-amazon.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const MARKETS = { IT: { currency: 'EUR', id: 'TEST_MARKET_IT', language: 'it' }, UK: { currency: 'GBP', id: 'TEST_MARKET_UK', language: 'en' } } as const
let account = ''

beforeAll(() => scoped(async () => {
  for (const [code, m] of Object.entries(MARKETS)) {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, currency: m.currency, region: 'EU', language: m.language, languages: [m.language], marketplaceId: m.id } as never })
    await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: code, productType: 'COAT', schemaVersion: 'v1', expiresAt: new Date(Date.now() + 86_400_000),
      schemaDefinition: { properties: {} } } })
  }
  // A product type with a size theme, for the family below.
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'UK', productType: 'SHIRT', schemaVersion: 'v1', expiresAt: new Date(Date.now() + 86_400_000),
    schemaDefinition: { properties: { size: { title: 'Size' }, variation_theme: { items: { properties: { name: { enum: ['SIZE'] } } } } } } } })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'send-price', isActive: true, externalAccountId: 'TEST-SELLER',
    authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })

/** A product at master 10 and one LIVE Amazon listing (an invented ASIN), so the studio builds a partial update. */
async function seed(sku: string, market: keyof typeof MARKETS, listing: Record<string, unknown>) {
  const product = await prisma.product.create({ data: { sku, name: sku, basePrice: 10, productType: 'COAT', fulfillmentMethod: 'FBM' } as never })
  await prisma.channelListing.create({ data: { productId: product.id, channel: 'AMAZON', marketplace: market, channelMarket: `AMAZON_${market}`, region: 'EU',
    channelConnectionId: account, externalListingId: `TEST-ASIN-${sku}`, listingStatus: 'ACTIVE', isPublished: true, ...listing } as never })
  return product.id
}
/** The offer price the publication's feed message carries for the product. */
async function publishedPrice(productId: string, market: keyof typeof MARKETS) {
  return scoped(async () => {
    const facts = await readPublicationFacts(productId, { channel: 'AMAZON', marketplace: market, accountId: account })
    const message = (await prepareAmazonPublication(facts)).feed.messages[0]
    const attributes = (message.attributes ?? Object.fromEntries((message.patches ?? []).filter((p: any) => p.op === 'replace').map((p: any) => [p.path.replace('/attributes/', ''), p.value]))) as Record<string, any>
    const offer = attributes.purchasable_offer?.[0]
    return { price: offer?.our_price?.[0]?.schedule?.[0]?.value_with_tax as number | undefined, currency: offer?.currency as string | undefined }
  })
}

describe('🔴 the Amazon publication sends the listing\'s send price', () => {
  it('a follower at "master +10%" goes out at 11.00 — the rule\'s price, not the master 10.00', async () => {
    const id = await scoped(() => seed('send-percent', 'IT', { followMasterPrice: true, pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10, price: 11 }))
    expect(await publishedPrice(id, 'IT')).toEqual({ price: 11, currency: 'EUR' })
  })

  it('the rule\'s price is from the CURRENT master, not a stale stored one', async () => {
    const id = await scoped(() => seed('send-stale', 'IT', { followMasterPrice: true, pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 20, price: 9 }))
    expect((await publishedPrice(id, 'IT')).price).toBe(12)
  })

  it('a pinned listing goes out at its own price', async () => {
    const id = await scoped(() => seed('send-pinned', 'IT', { followMasterPrice: false, priceOverride: 12.5, price: 12.5 }))
    expect((await publishedPrice(id, 'IT')).price).toBe(12.5)
  })

  it('🔴 a follower on Amazon UK (GBP) that holds its own 9.00 goes out at 9.00 GBP — never the EUR master number as pounds', async () => {
    const id = await scoped(() => seed('send-gbp-own', 'UK', { followMasterPrice: true, pricingRule: 'FIXED', price: 9 }))
    expect(await publishedPrice(id, 'UK')).toEqual({ price: 9, currency: 'GBP' })
  })

  it('🔴 a follower on Amazon UK that holds no price is refused by name, as the price door refuses it — no price is built', async () => {
    const id = await scoped(() => seed('send-gbp-none', 'UK', { followMasterPrice: true, pricingRule: 'FIXED', price: null }))
    // Option A (Owner 2026-10-19): a live row's missing price is its offer's problem (it leaves the price lines out); the
    // EUR master number is never sent as pounds.
    const prepared = await scoped(async () => prepareAmazonPublication(await readPublicationFacts(id, { channel: 'AMAZON', marketplace: 'UK', accountId: account })))
    expect(prepared.issues).toContainEqual({ productId: id, sku: 'send-gbp-none', field: 'purchasable_offer', severity: 'error',
      message: 'send-gbp-none: Amazon UK sells in GBP, and this listing follows the master price in EUR. Nexus does not convert it. Set this listing\'s own GBP price.' })
    expect(await publishedPrice(id, 'UK')).toEqual({ price: undefined, currency: undefined })
  })
})

// Owner 2026-10-19 — "if I'm deleting a product on the market, it doesn't let me publish because a field is empty". A row this
// publication sends nothing for (`facts.unsent`: here a variation being deleted, held by the plan) is not built, so its own
// gaps refuse nothing; the same row, sent, is still refused by name. The family keeps its theme and relationships.
describe('🔴 a row this publication sends nothing for is not built', () => {
  const UK = { channel: 'AMAZON', marketplace: 'UK', accountId: '' }
  async function family(prefix: string) {
    const parent = await prisma.product.create({ data: { sku: prefix, name: prefix, basePrice: 10, productType: 'SHIRT', isParent: true, variationAxes: ['Size'], fulfillmentMethod: 'FBM' } as never })
    const child = async (size: string, price: number | null, value: string | null) => {
      const row = await prisma.product.create({ data: { sku: `${prefix}-${size}`, name: `${prefix} ${size}`, basePrice: 10, productType: 'SHIRT', parentId: parent.id, fulfillmentMethod: 'FBM' } as never })
      await prisma.channelListing.create({ data: { productId: row.id, channel: 'AMAZON', marketplace: 'UK', channelMarket: 'AMAZON_UK', region: 'EU', channelConnectionId: account,
        externalListingId: `TEST-ASIN-${prefix}-${size}`, listingStatus: 'ACTIVE', isPublished: true, followMasterPrice: true, pricingRule: 'FIXED', price,
        overrideData: value === null ? {} : { size: value } } as never })
      return row.id
    }
    await prisma.channelListing.create({ data: { productId: parent.id, channel: 'AMAZON', marketplace: 'UK', channelMarket: 'AMAZON_UK', region: 'EU', channelConnectionId: account,
      externalListingId: `TEST-ASIN-${prefix}`, listingStatus: 'ACTIVE', isPublished: true, variationTheme: 'SIZE' } as never })
    // M is sent (its own GBP price); L is being deleted: no GBP price and no size value.
    return { parent: parent.id, sent: await child('M', 9, 'M'), held: await child('L', null, null) }
  }

  it('a variation being deleted with no price and no size: it gets no message and refuses nothing; the parent and the sent child are built exactly as when it is sent', async () => {
    const ids = await scoped(() => family('unsent-fam'))
    const scope = { ...UK, accountId: account }
    const held = await scoped(async () => prepareAmazonPublication(await readPublicationFacts(ids.parent, scope, { heldProductIds: [ids.held] })))
    expect(held.products).toEqual([{ productId: ids.parent, sku: 'unsent-fam' }, { productId: ids.sent, sku: 'unsent-fam-M' }])
    const bySku = (publication: Awaited<ReturnType<typeof prepareAmazonPublication>>) =>
      Object.fromEntries(publication.feed.messages.map(({ messageId: _messageId, ...message }) => [message.sku, message]))
    const attributes = (message: { attributes?: Record<string, unknown>; patches?: any[] }) =>
      (message.attributes ?? Object.fromEntries((message.patches ?? []).map((p: any) => [p.path.replace('/attributes/', ''), p.value]))) as Record<string, any>
    // The family's lines stay: the parent keeps its theme and role, the sent child names its parent.
    expect(attributes(bySku(held)['unsent-fam']).variation_theme).toEqual([expect.objectContaining({ name: 'SIZE' })])
    expect(attributes(bySku(held)['unsent-fam']).parentage_level).toEqual([expect.objectContaining({ value: 'parent' })])
    expect(attributes(bySku(held)['unsent-fam-M']).child_parent_sku_relationship).toEqual([expect.objectContaining({ parent_sku: 'unsent-fam' })])
    // Control: once the row has its price and size and is sent, the parent and M are built exactly the same.
    await scoped(() => prisma.channelListing.updateMany({ where: { productId: ids.held }, data: { price: 9, overrideData: { size: 'L' } } as never }))
    const sent = await scoped(async () => prepareAmazonPublication(await readPublicationFacts(ids.parent, scope)))
    expect(Object.keys(bySku(sent)).sort()).toEqual(['unsent-fam', 'unsent-fam-L', 'unsent-fam-M'])
    expect(bySku(sent)['unsent-fam']).toEqual(bySku(held)['unsent-fam'])
    expect(bySku(sent)['unsent-fam-M']).toEqual(bySku(held)['unsent-fam-M'])
  })

  it('control: the same variation SENT is still refused by name', async () => {
    const ids = await scoped(async () => {
      const made = await family('sent-fam')
      // Its size is set, so only its missing price is left to refuse.
      await prisma.channelListing.updateMany({ where: { productId: made.held }, data: { overrideData: { size: 'L' } } as never })
      return made
    })
    const prepared = await scoped(async () => prepareAmazonPublication(await readPublicationFacts(ids.parent, { ...UK, accountId: account })))
    expect(prepared.issues).toContainEqual(expect.objectContaining({ productId: ids.held, severity: 'error',
      message: 'sent-fam-L: Amazon UK sells in GBP, and this listing follows the master price in EUR. Nexus does not convert it. Set this listing\'s own GBP price.' }))
  })
})
