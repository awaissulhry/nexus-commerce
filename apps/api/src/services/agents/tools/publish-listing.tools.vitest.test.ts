/**
 * MCP full control L5 — publish-listing on the studio path, run through the one door (call-tool.ts) and the approval gate
 * against a real PostgreSQL with the production schema and business-isolation policies (PGlite), on the studio's own
 * publication service. The channel transports and the studio's fact reader are the studio suites' fakes; Amazon's change
 * compiler is the real one, so what Amazon would receive is what is asserted.
 *
 * Proven here: only the field groups named are sent (d4), never stock, price or fulfilment; a draft's first publish is
 * sent complete; the publish runs AS the approver; a review that changed since the approval sends nothing; FBA quantity
 * is never sent and an FBA listing's quantity fields are unchanged; the one Amazon EU quantity is guarded; Etsy, an
 * existing Shopify product and a blocked review are refused; approval-status says what the publish did.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'

const fixture = vi.hoisted(() => ({
  database: null as any,
  facts: vi.fn(),
  sendAmazon: vi.fn(),
  readAmazon: vi.fn(),
  sendEbay: vi.fn(),
  readEbay: vi.fn(),
  amazonChanges: vi.fn(),
  ebayChanges: vi.fn(),
  shopPreview: vi.fn(),
  amazonMessages: vi.fn(),
  trading: vi.fn(),
}))

vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(fixture.database.client)), property) }) }
})
vi.mock('../../pim/studio-publication-plan.js', async () => {
  const { createHash } = await import('node:crypto')
  return { readPublicationFacts: fixture.facts,
    publicationDigest: (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, entry) =>
      entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)).digest('hex'),
    object: (value: unknown) => value && typeof value === 'object' ? value : {} }
})
vi.mock('../../amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: () => 'live' }))
vi.mock('../../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => 'live' }))
vi.mock('../../shopify-publish-gate.service.js', () => ({ getShopifyPublishMode: () => 'live' }))
vi.mock('../../shopify/content-workspace.service.js', () => ({ getContentWorkspace: async () => ({ initialized: true }), saveContentWorkspace: vi.fn() }))
vi.mock('../../shopify/content-sync.service.js', () => ({ previewContentSync: fixture.shopPreview, synchronizeContent: vi.fn() }))
vi.mock('../../pim/studio-publication-amazon.js', () => ({
  prepareAmazonPublication: async (facts: any) => ({ kind: 'amazon', sellerId: 'seller-test', marketplaceId: 'market-test',
    products: facts.products.map((p: any) => ({ productId: p.id, sku: p.sku })),
    feed: { header: { sellerId: 'seller-test', version: '2.0' }, messages: fixture.amazonMessages(facts) } }),
  sendAmazonPublication: fixture.sendAmazon, readAmazonPublication: fixture.readAmazon,
}))
vi.mock('../../pim/studio-publication-ebay.js', () => ({
  prepareEbayPublication: async (facts: any) => ({ kind: 'ebay', marketplace: 'IT', itemId: facts.listings.length ? 'TEST-ITEM-L5' : null, liveRevision: 'live-1',
    products: facts.products.map((p: any) => ({ productId: p.id, sku: p.sku })), xml: '<Item/>' }),
  sendEbayPublication: fixture.sendEbay, readEbayPublication: fixture.readEbay,
  ebayPublicationRequest: (_plan: any, reviewId: string) => ({ operation: 'ReviseFixedPriceItem', xml: `<Item><UUID>${reviewId}</UUID></Item>` }),
  usesEbayInventory: () => false, prepareEbayInventoryPublication: vi.fn(),
}))
vi.mock('../../pim/studio-publication-baseline.js', () => ({ readPublicationBaseline: async () => ({ values: new Map(), revision: 'baseline-1' }) }))
// Amazon: the change PLAN is the fake (it reads Amazon live); the compiler that turns a selection into the feed is real.
vi.mock('../../pim/studio-publication-amazon-changes.js', async (original) => ({ ...(await original<object>()), prepareAmazonChanges: fixture.amazonChanges }))
vi.mock('../../pim/studio-publication-ebay-changes.js', () => ({
  prepareEbayChanges: fixture.ebayChanges,
  compileEbayChanges: (plan: any, ids: string[]) => ({ ...plan.publication, products: plan.publication.products,
    fieldWrites: Object.fromEntries([[plan.publication.products[0].productId, plan.changes.filter((c: any) => ids.includes(c.id)).map((c: any) => ({ field: c.field, value: c.current }))]]) }),
}))
vi.mock('../../amazon/listing-asin-fill.service.js', () => ({ fillAmazonListingAsins: async () => ({ dryRun: false, rows: [], counts: {} }) }))
// eBay's own check (VerifyAddFixedPriceItem) is the studio's real one; only its transport and the account token are stood in.
vi.mock('../../ebay-trading-api.service.js', async (original) => ({ ...(await original<object>()), callTradingApi: fixture.trading }))
vi.mock('../../ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'test-token' }, EbayAuthService: class { async getValidToken() { return 'test-token' } } }))

import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { planPublicationChanges, type PublicationChangeInput } from '../../pim/studio-publication-changes.js'
import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { groupOf, planPublish, publishStory } from './publish.tools.js'
import { getTool } from '../tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string, label: string): UserPrincipal => ({
  kind: 'user', userId, label,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: business, via: 'claude',
})
const claude = person('u-l5-asker', 'Asker')
const approver = person('u-l5-approver', 'Approver')

type Json = Record<string, any>
const db = () => fixture.database.client
const ids = { ebayProduct: '', amazonParent: '', amazonChild: '', fbaProduct: '', euProduct: '', ebay: '', amazon: '', shopify: '' }

const known = (value: unknown) => ({ state: 'value' as const, value })
const unknown = (reason: string) => ({ state: 'unknown' as const, reason })
/** A studio change row, through the studio's own planner. */
const change = (productId: string, sku: string, field: string, current: unknown, channel: unknown, lastAccepted?: unknown, extra: Partial<PublicationChangeInput> = {}): PublicationChangeInput =>
  ({ productId, sku, field, label: field, current: known(current), channel: known(channel), lastAccepted: lastAccepted === undefined ? unknown('No accepted publish record') : known(lastAccepted), ...extra })

/** What the eBay review shows: title differs from the channel, Nexus changed the description and the pictures. */
let ebayChannelTitle = 'Channel title'
function ebayPlan(facts: any, publication: any) {
  const p = facts.products[0]
  return { kind: 'ebay-changes', publication, remoteRevision: `remote-${ebayChannelTitle}`, products: publication.products, ownerProductId: p.id, liveSpecifics: {}, aspectNames: {}, createWrites: {},
    changes: planPublicationChanges([
      change(p.id, p.sku, 'title', 'Nexus title', ebayChannelTitle),
      change(p.id, p.sku, 'description', 'New description', 'Old description', 'Old description'),
      change(p.id, p.sku, 'pictures', ['https://images.example.test/1.jpg'], ['https://images.example.test/0.jpg'], ['https://images.example.test/0.jpg']),
      change(p.id, p.sku, 'aspect:Brand', ['Test brand'], ['Test brand']),
    ]) }
}

/** The Amazon review: a new listing is one complete create row per product; a live one is reviewed per attribute. */
function amazonPlan(facts: any, publication: any) {
  const products = publication.products.map((p: any) => {
    const live = facts.listings.some((l: any) => l.productId === p.productId && l.externalListingId)
    return { ...p, newListing: !live, content: {}, contentRoots: {},
      patches: live ? { brand: { op: 'replace', path: '/attributes/brand', value: [{ value: 'Test brand' }] } } : {} }
  })
  const inputs = products.flatMap((p: any) => {
    const message = publication.feed.messages.find((m: any) => m.sku === p.sku)
    return p.newListing
      ? [{ productId: p.productId, sku: p.sku, field: '$create', label: 'Create complete listing', current: known(message), lastAccepted: unknown('No accepted publish record'), channel: { state: 'absent' as const }, newListing: true }]
      : [change(p.productId, p.sku, 'brand', [{ value: 'Test brand' }], [{ value: 'Old brand' }], [{ value: 'Old brand' }]),
        // The real planner never offers stock; the tool would refuse it anyway.
        change(p.productId, p.sku, 'fulfillment_availability', [{ fulfillment_channel_code: 'DEFAULT', quantity: 9 }], [{ quantity: 1 }], [{ quantity: 1 }])]
  })
  return { kind: 'amazon-changes', publication, remoteRevision: 'remote-1', products, changes: planPublicationChanges(inputs) }
}

let fulfilment: Record<string, unknown> = { fulfillment_channel_code: 'DEFAULT', quantity: 5 }
const amazonMessage = (sku: string) => ({ messageId: 1, sku, operationType: 'UPDATE', productType: 'COAT',
  attributes: { item_name: [{ value: `Title ${sku}`, language_tag: 'it_IT' }], fulfillment_availability: [{ ...fulfilment }] } })

const factsFor = (productId: string) => async (_id: string, scope: Json) => {
  const rows = await inside(() => db().product.findMany({ where: { OR: [{ id: productId }, { parentId: productId }] }, orderBy: { sku: 'asc' } }))
  const listings = await inside(() => db().channelListing.findMany({ where: { productId: { in: rows.map((r: Json) => r.id) }, channel: scope.channel, marketplace: scope.marketplace, channelConnectionId: scope.accountId } }))
  return { scope, destination: { familyId: productId, aliasKey: null }, account: { displayName: 'Test account' }, parent: { id: productId },
    products: rows.map((r: Json) => ({ id: r.id, sku: r.sku, name: r.name })), listings, resolved: [], issues: [], excluded: 0, aliasLabel: 'Primary listing', revision: `revision-${productId}` }
}

beforeAll(async () => {
  fixture.database = await formulaDatabase()
  await inside(async () => {
    ids.ebay = (await db().channelConnection.create({ data: { channelType: 'EBAY', isActive: true, accountLabel: 'Test eBay', externalAccountId: 'TEST-L5-EBAY' } })).id
    ids.amazon = (await db().channelConnection.create({ data: { channelType: 'AMAZON', isActive: true, accountLabel: 'Test Amazon', externalAccountId: 'TEST-L5-AMAZON' } })).id
    ids.shopify = (await db().channelConnection.create({ data: { channelType: 'SHOPIFY', isActive: true, accountLabel: 'Test store', externalAccountId: 'TEST-L5-SHOP' } })).id
    for (const [channel, code] of [['EBAY', 'IT'], ['AMAZON', 'IT'], ['AMAZON', 'DE'], ['AMAZON', 'UK'], ['SHOPIFY', 'GLOBAL']]) {
      await db().marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } as never })
    }
    const product = (sku: string, data: Json = {}) => db().product.create({ data: { sku, name: sku, basePrice: 10, ...data } })
    ids.ebayProduct = (await product('TEST-SKU-L5-EBAY')).id
    await db().channelListing.create({ data: { productId: ids.ebayProduct, channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT', channelConnectionId: ids.ebay,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'TEST-ITEM-L5', quantity: 4 } as never })
    ids.amazonParent = (await product('TEST-SKU-L5-AMZ', { isParent: true })).id
    ids.amazonChild = (await product('TEST-SKU-L5-AMZ-M', { parentId: ids.amazonParent })).id
    for (const id of [ids.amazonParent, ids.amazonChild]) {
      await db().channelListing.create({ data: { productId: id, channel: 'AMAZON', marketplace: 'UK', region: 'UK', channelMarket: 'AMAZON_UK', channelConnectionId: ids.amazon,
        listingStatus: 'DRAFT', isPublished: false, syncPaused: true } as never })
    }
    ids.fbaProduct = (await product('TEST-SKU-L5-FBA', { fulfillmentMethod: 'FBA' } as Json)).id
    await db().channelListing.create({ data: { productId: ids.fbaProduct, channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', channelConnectionId: ids.amazon,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'TEST-ASIN-FBA', fulfillmentMethod: 'FBA', quantity: 7, quantityOverride: 7, followMasterQuantity: false } as never })
    ids.euProduct = (await product('TEST-SKU-L5-EU')).id
    await db().channelListing.create({ data: { productId: ids.euProduct, channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', channelConnectionId: ids.amazon,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'TEST-ASIN-EU', quantity: 3 } as never })
  })
}, 120_000)

beforeEach(() => {
  vi.clearAllMocks()
  ebayChannelTitle = 'Channel title'
  fulfilment = { fulfillment_channel_code: 'DEFAULT', quantity: 5 }
  fixture.facts.mockImplementation(async (productId: string, scope: Json) => {
    const root = (await inside(() => db().product.findUniqueOrThrow({ where: { id: productId } }))).parentId ?? productId
    return factsFor(root)(productId, scope)
  })
  fixture.amazonMessages.mockImplementation((facts: any) => facts.products.map((p: any) => amazonMessage(p.sku)))
  fixture.amazonChanges.mockImplementation(async (facts: any, publication: any) => amazonPlan(facts, publication))
  fixture.ebayChanges.mockImplementation(async (facts: any, publication: any) => ebayPlan(facts, publication))
  fixture.readAmazon.mockResolvedValue(null)
  fixture.readEbay.mockResolvedValue({ reference: 'TEST-ITEM-L5', warnings: [], verified: true })
  fixture.sendAmazon.mockImplementation(async (plan: any, _account: string, beforeSend: any) => {
    await beforeSend?.({ feedType: 'JSON_LISTINGS_FEED', marketplaceIds: ['market-test'], feed: plan.feed })
    return 'feed-l5'
  })
  fixture.sendEbay.mockImplementation(async (plan: any, _account: string, reviewId: string, beforeSend: any) => {
    await beforeSend?.({ operation: 'ReviseFixedPriceItem', xml: `<Item><UUID>${reviewId}</UUID></Item>` })
    return { reference: 'TEST-ITEM-L5', warnings: [] }
  })
})

afterAll(async () => { await fixture.database?.close() }, 30_000)

const dryRun = async (args: Json) => (await inside(() => callTool(claude, 'publish-listing', args))).raw
/** The person approves exactly the preview Claude was shown, and the publish runs as them. */
async function approveAndRun(args: Json) {
  const preview = await dryRun(args)
  expect(preview.ok, preview.error).toBe(true)
  const ran = (await inside(() => executeTool(approver, 'publish-listing', args, { approvedPreview: JSON.parse(JSON.stringify(preview.preview)), via: 'claude' }))).raw
  return { preview: preview.preview as Json, ran }
}

describe('what a publish sends', () => {
  it('only the field groups named: title, photos, or all content — never stock, price or fulfilment', () => {
    expect(['$create', '__create__'].map(groupOf)).toEqual(['create', 'create'])
    expect(['fulfillment_availability', 'purchasable_offer', 'list_price', 'quantity'].map(groupOf)).toEqual(['never', 'never', 'never', 'never'])
    expect(['pictures', 'Pictures', 'main_product_image_locator', 'title', 'item_name:["A1","it_IT"]', 'bullet_point:["A1","it_IT"]', 'aspect:Brand'].map(groupOf))
      .toEqual(['photos', 'photos', 'photos', 'title', 'title', 'bullets', 'attributes'])
    // Etsy's tags are its search keywords (E1); its other listing fields are attributes.
    expect(['tags', 'materials', 'classification'].map(groupOf)).toEqual(['keywords', 'attributes', 'attributes'])
    const review = { action: 'update', issues: [], rows: [], mode: 'live', changes: planPublicationChanges([
      change('p', 'TEST-SKU', 'title', 'New', 'Old', 'Old'),
      change('p', 'TEST-SKU', 'fulfillment_availability', [{ quantity: 2 }], [{ quantity: 1 }], [{ quantity: 1 }]),
    ]) } as any
    const plan = planPublish(review, 'AMAZON', 'all')
    expect(plan.selected.map((c) => c.field)).toEqual(['title'])
    expect(plan.notSent).toEqual([expect.objectContaining({ field: 'fulfillment_availability', reason: expect.stringContaining('A re-publish never sends stock, price or fulfilment') })])
  })

  it('N3 — a first publish says price and quantity go inside the new listing, never "never sent"', () => {
    const review = { action: 'create', issues: [], rows: [], mode: 'live', changes: planPublicationChanges([
      change('p', 'TEST-SKU', '$create', 'New listing', null),
      change('p', 'TEST-SKU', 'purchasable_offer', [{ our_price: 49.9 }], null),
    ]) } as any
    const plan = planPublish(review, 'AMAZON', 'all')
    expect(plan.publish).toBe('first publish')
    expect(plan.notSent).toEqual([expect.objectContaining({ field: 'purchasable_offer', reason: expect.stringContaining('Sent inside the new listing') })])
  })

  it('eBay re-publish: the preview is the studio review of the groups named', async () => {
    const base = { productId: ids.ebayProduct, channel: 'EBAY', marketplace: 'IT' }
    const title = await dryRun({ ...base, fields: ['title'] })
    expect(title.preview).toMatchObject({ publish: 're-publish', publishMode: 'live', sendCount: 1,
      destination: { channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, accountLabel: 'Test eBay' },
      send: [{ field: 'title', status: 'DIFFERS', nexus: 'Nexus title', channel: 'Channel title' }] })
    expect((await dryRun({ ...base, fields: 'photos' })).preview.send.map((s: Json) => s.field)).toEqual(['pictures'])
    const all = await dryRun(base)
    expect(all.preview.send.map((s: Json) => s.field)).toEqual(['title', 'description', 'pictures'])
    expect(all.preview.unchanged).toBe(1)
    // A dry run writes nothing: no review row.
    expect(await inside(() => db().bulkOperation.count())).toBe(0)
  })

  it('runs the studio publish AS the approver, sending exactly the fields approved', async () => {
    const { ran } = await approveAndRun({ productId: ids.ebayProduct, channel: 'EBAY', marketplace: 'IT', fields: ['description', 'photos'] })
    expect(ran.ok, ran.error).toBe(true)
    expect(ran.data).toMatchObject({ status: 'ACCEPTED', publish: 're-publish' })
    const sent = fixture.sendEbay.mock.calls[0][0]
    expect(sent.fieldWrites[ids.ebayProduct].map((w: Json) => w.field)).toEqual(['description', 'pictures'])
    const operation = await inside(() => db().bulkOperation.findUniqueOrThrow({ where: { id: (ran.data as Json).publicationId } }))
    expect(operation).toMatchObject({ userId: 'u-l5-approver', status: 'ACCEPTED' })
    const live = await inside(() => db().channelListing.findFirstOrThrow({ where: { productId: ids.ebayProduct, channel: 'EBAY' }, select: { id: true } }))
    expect(ran.change).toMatchObject({ after: { publicationId: (ran.data as Json).publicationId, publish: 're-publish', listingIds: [live.id], closed: false },
      before: { status: 'ACCEPTED', fields: [{ field: 'description', channel: 'Old description', nexus: 'New description' }, { field: 'pictures' }] } })
    // A re-publish is put back by publishing the old values, not by closing the listing.
    expect(getTool('publish-listing')!.undo!.request(ran.change)).toMatchObject({ refusal: expect.stringContaining('re-publish') })
  })

  it('a review that changed since the approval sends nothing', async () => {
    const args = { productId: ids.ebayProduct, channel: 'EBAY', marketplace: 'IT', fields: ['title'] }
    const preview = await dryRun(args)
    ebayChannelTitle = 'Someone edited it on eBay'
    const ran = (await inside(() => executeTool(approver, 'publish-listing', args, { approvedPreview: preview.preview }))).raw
    expect(ran).toMatchObject({ ok: false, error: expect.stringContaining('changed since it was approved') })
    expect(fixture.sendEbay).not.toHaveBeenCalled()
    // And without an approved preview it never runs.
    expect((await inside(() => executeTool(approver, 'publish-listing', args))).raw).toMatchObject({ ok: false, error: expect.stringContaining('only after a person approved') })
  })
})

describe('first publish of a draft', () => {
  it('Amazon (outside the EU): the complete listing, as the approver; its drafts go live once Amazon accepts', async () => {
    expect((await dryRun({ productId: ids.amazonChild, channel: 'AMAZON', marketplace: 'UK', fields: 'photos' })).error).toContain('A first publish sends the complete listing')
    const { preview, ran } = await approveAndRun({ productId: ids.amazonChild, channel: 'AMAZON' })
    expect(preview).toMatchObject({ publish: 'first publish', destination: { marketplace: 'UK', accountId: ids.amazon }, sendCount: 2 })
    expect(preview.summary).toMatch(/^TEST-SKU-L5-AMZ.*: first publish — /)
    expect(preview).not.toHaveProperty('warning')
    expect(ran).toMatchObject({ ok: true, data: { status: 'SUBMITTED', publish: 'first publish' } })
    // Its undo closes the listings it published.
    expect(getTool('publish-listing')!.undo!.request(ran.change)).toEqual({ tool: 'close-listing', args: { listingIds: ran.change.after.listingIds, reason: 'undo of a publish' } })
    expect(ran.change.after.listingIds).toHaveLength(2)
    expect(fixture.sendAmazon.mock.calls[0][0].feed.messages.map((m: Json) => [m.sku, m.operationType])).toEqual([['TEST-SKU-L5-AMZ', 'UPDATE'], ['TEST-SKU-L5-AMZ-M', 'UPDATE']])
  })

  it('Amazon EU: refused when the one EU quantity would differ from the SKU\'s live EU markets; sent when it is the same', async () => {
    const args = { productId: ids.euProduct, channel: 'AMAZON', marketplace: 'DE' }
    const refused = await dryRun(args)
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("would set Amazon's one EU quantity to 5, but its live EU listings hold 3 (IT)") })
    fulfilment = { fulfillment_channel_code: 'DEFAULT', quantity: 3 }
    const { preview, ran } = await approveAndRun(args)
    expect(preview.euQuantity).toEqual([{ sku: 'TEST-SKU-L5-EU', sends: 3, otherMarkets: [{ market: 'IT', holds: 3 }] }])
    // Live EU markets exist: euQuantity names them, so no second, general warning.
    expect(preview).not.toHaveProperty('warning')
    expect(ran.ok, ran.error).toBe(true)
  })

  it('FBA: a first publish that would send an Amazon-fulfilled quantity is refused, and nothing is sent', async () => {
    fulfilment = { fulfillment_channel_code: 'AMAZON_EU', quantity: 5 }
    const out = await dryRun({ productId: ids.amazonParent, channel: 'AMAZON', marketplace: 'DE' })
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("fulfilled by Amazon (FBA): its quantity is Amazon's") })
    expect(fixture.sendAmazon).not.toHaveBeenCalled()
  })
})

describe('FBA quantity is untouchable', () => {
  it('a re-publish of an FBA listing sends no stock or fulfilment, and its quantity fields are unchanged', async () => {
    const fields = { quantity: true, quantityOverride: true, followMasterQuantity: true, fulfillmentMethod: true, stockBuffer: true }
    const before = await inside(() => db().channelListing.findFirstOrThrow({ where: { productId: ids.fbaProduct, channel: 'AMAZON' }, select: fields }))
    const { preview, ran } = await approveAndRun({ productId: ids.fbaProduct, channel: 'AMAZON', marketplace: 'IT' })
    expect(preview.send.map((s: Json) => s.field)).toEqual(['brand'])
    expect(preview.notSent).toEqual([expect.objectContaining({ field: 'fulfillment_availability' })])
    expect(ran.ok, ran.error).toBe(true)
    const feed = fixture.sendAmazon.mock.calls[0][0].feed
    expect(feed.messages).toEqual([expect.objectContaining({ sku: 'TEST-SKU-L5-FBA', operationType: 'PATCH', patches: [{ op: 'replace', path: '/attributes/brand', value: [{ value: 'Test brand' }] }] })])
    expect(JSON.stringify(feed)).not.toMatch(/fulfillment_availability|quantity/)
    expect(await inside(() => db().channelListing.findFirstOrThrow({ where: { productId: ids.fbaProduct, channel: 'AMAZON' }, select: fields }))).toEqual(before)
  })
})

describe('refusals', () => {
  it('Etsy has no publisher; an existing Shopify product is change-only, which Shopify does not have; a blocked review', async () => {
    expect(await dryRun({ productId: ids.ebayProduct, channel: 'ETSY', marketplace: 'GLOBAL' })).toMatchObject({ ok: false, error: expect.stringContaining('Etsy from Nexus is not available yet') })
    fixture.shopPreview.mockResolvedValue({ errors: [], remote: { id: 'gid://shopify/Product/1' }, revision: 'r', remoteRevision: 'rr', initialized: true, draft: {},
      variants: [{ id: ids.ebayProduct, sku: 'TEST-SKU-L5-EBAY' }], changes: { newProductStatus: 'ACTIVE' }, locations: [{ id: 'gid://shopify/Location/1', name: 'Warehouse', isActive: true }] })
    expect(await dryRun({ productId: ids.ebayProduct, channel: 'SHOPIFY', marketplace: 'GLOBAL' })).toMatchObject({ ok: false, error: expect.stringContaining('Publish cannot update a product already on Shopify yet.') })
    fixture.facts.mockImplementation(async (productId: string, scope: Json) => ({ ...(await factsFor(productId)(productId, scope)), issues: [{ severity: 'error', message: 'Reconnect this account before publishing.' }] }))
    expect(await dryRun({ productId: ids.ebayProduct, channel: 'EBAY', marketplace: 'IT' })).toMatchObject({ ok: false, error: expect.stringContaining('Reconnect this account before publishing.') })
  })

  it('without a market, it does not guess between the markets the product sells in', async () => {
    expect(await dryRun({ productId: ids.euProduct, channel: 'EBAY' })).toMatchObject({ ok: false, error: 'TEST-SKU-L5-EU has no eBay listing yet: name the market (marketplace).' })
    // IT is live; the EU test's publish started its DE draft.
    expect(await dryRun({ productId: ids.euProduct, channel: 'AMAZON' })).toMatchObject({ ok: false, error: 'TEST-SKU-L5-EU has Amazon listings in DE, IT: name the market (marketplace).' })
  })
})

describe('through the approval gate', () => {
  it('queued by Claude, approved by a person, run as them; approval-status names the publication', async () => {
    const run = await inside(() => db().agentRun.create({ data: { agentKey: 'manual-action', trigger: 'manual', status: 'done', via: 'claude' } as never }))
    const queued = await inside(() => runOrQueueTool('publish-listing', { productId: ids.ebayProduct, channel: 'EBAY', marketplace: 'IT', fields: ['title'] }, claude, run.id))
    expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
    expect(fixture.sendEbay).not.toHaveBeenCalled()
    const decided = await inside(() => decideApproval(queued.approvalId!, 'approve', approver))
    expect(decided, decided.error).toMatchObject({ ok: true, status: 'executed' })
    expect(fixture.sendEbay).toHaveBeenCalledOnce()
    const status = (await inside(() => callTool(claude, 'approval-status', { approvalId: queued.approvalId }))).raw as Json
    expect(status.data).toMatchObject({ status: 'executed', publication: { status: 'ACCEPTED', settled: true },
      meaning: 'Approved: it was published through the Nexus studio, as the person who approved it. The channel accepted it.' })
    expect(status.data).not.toHaveProperty('channels')
  })
})

describe("eBay's own check of a new listing (VerifyAddFixedPriceItem)", () => {
  const refusal = '<VerifyAddFixedPriceItemResponse><Ack>Failure</Ack><Errors><ShortMessage>The category is not valid.</ShortMessage>'
    + '<LongMessage>The category selected is not a leaf category.</LongMessage><ErrorCode>87</ErrorCode><SeverityCode>Error</SeverityCode></Errors></VerifyAddFixedPriceItemResponse>'

  it('the read never asks eBay; the approved run asks eBay first, as the studio does, and refuses with eBay\'s words', async () => {
    vi.stubEnv('NEXUS_EBAY_REAL_API', 'true')
    vi.stubEnv('EBAY_SANDBOX', 'false')
    try {
      const productId = (await inside(() => db().product.create({ data: { sku: 'TEST-SKU-L5-NEW', name: 'TEST-SKU-L5-NEW', basePrice: 10 } }))).id
      const args = { productId, channel: 'EBAY', marketplace: 'IT' }
      fixture.trading.mockResolvedValue({ ack: 'Failure', raw: refusal })
      const preview = await dryRun(args)
      expect(preview.ok, preview.error).toBe(true)
      expect(preview.preview.note).toContain('eBay checks a new listing itself first')
      expect(fixture.trading).not.toHaveBeenCalled()

      const refused = (await inside(() => executeTool(approver, 'publish-listing', args, { approvedPreview: JSON.parse(JSON.stringify(preview.preview)), via: 'claude' }))).raw
      expect(fixture.trading).toHaveBeenCalledOnce()
      expect(fixture.trading.mock.calls[0][0]).toBe('VerifyAddFixedPriceItem')
      expect(refused).toEqual({ ok: false, error: expect.stringContaining('eBay says: The category is not valid.') })
      expect(refused.error).toMatch(/^TEST-SKU-L5-NEW on eBay IT: .*Nothing was sent\.$/)
      expect(fixture.sendEbay).not.toHaveBeenCalled()
      expect(await inside(() => db().bulkOperation.count({ where: { changes: { path: ['productId'], equals: productId } } }))).toBe(0)

      // eBay's check passes: the same approval is sent.
      fixture.trading.mockResolvedValue({ ack: 'Success', raw: '<VerifyAddFixedPriceItemResponse><Ack>Success</Ack></VerifyAddFixedPriceItemResponse>' })
      const sent = (await inside(() => executeTool(approver, 'publish-listing', args, { approvedPreview: JSON.parse(JSON.stringify(preview.preview)), via: 'claude' }))).raw
      expect(sent.ok, sent.error).toBe(true)
      expect(fixture.trading).toHaveBeenCalledTimes(2)
      expect(fixture.sendEbay).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('N4 — a publish in words', () => {
  const row = (sku: string, extra: Json = {}) => ({ productId: sku, sku, title: sku, existing: false, ...extra })
  const create = (sku: string) => ({ id: `c-${sku}`, sku, field: '$create' }) as any
  const plan = (selected: any[]) => ({ publish: 'first publish', selected, notSent: [], unchanged: 0, refusal: null }) as any

  it('a first publish: how many listings it creates, how they start, what it holds back, and Amazon\'s one EU quantity', () => {
    const review = { rows: [row('A-S', { startsAs: 'active' }), row('A-M', { startsAs: 'inactive' }), row('A-L', { notListed: true }), row('A-XL', { blocked: 'no price in EUR' })] } as any
    const story = publishStory({ product: { sku: 'A' }, channel: 'AMAZON', market: 'DE' }, review, plan([create('A-S'), create('A-M')]), false)
    expect(story.summary).toBe('A: first publish — creates 2 listings on Amazon DE (1 active, 1 inactive) with the price, quantity and fulfilment Nexus holds for them (listing-matrix shows them); leaves 2 rows out (held).')
    expect(story.creates).toEqual([{ sku: 'A-S', startsAs: 'active' }, { sku: 'A-M', startsAs: 'inactive' }])
    expect(story.held).toEqual([{ sku: 'A-L', why: 'its Status is Not listed' }, { sku: 'A-XL', why: 'no price in EUR' }])
    expect(story.warning).toContain('this first publish in DE sets it for all of them')
  })

  it('no general EU warning outside the EU, or when live EU markets are already named', () => {
    const review = { rows: [row('A-S', { startsAs: 'active' })] } as any
    expect(publishStory({ product: { sku: 'A' }, channel: 'AMAZON', market: 'UK' }, review, plan([create('A-S')]), false).warning).toBeNull()
    expect(publishStory({ product: { sku: 'A' }, channel: 'AMAZON', market: 'IT' }, review, plan([create('A-S')]), true).warning).toBeNull()
  })

  it('a re-publish counts the fields it sends', () => {
    const review = { rows: [row('B', { existing: true })] } as any
    const story = publishStory({ product: { sku: 'B' }, channel: 'EBAY', market: 'IT' }, review, { ...plan([{ sku: 'B', field: 'Title' }, { sku: 'B', field: 'Description' }]), publish: 're-publish' }, false)
    expect(story.summary).toBe('B: re-publish — sends 2 changed fields to eBay IT.')
  })
})

/** Aliases (Owner 2026-10-05): a second listing on a market is named by its alias id and is published as its own listing. */
describe('aliases: publish-listing acts on the alias, never on the main listing', () => {
  const alias = (productId: string, channel: string, marketplace: string, accountId: string, label: string, sku?: string) =>
    inside(async () => (await db().productListingAlias.create({ data: { productId, channel, marketplace, channelConnectionId: accountId, label, position: 1, ...(sku ? { sku } : {}) } as never })).id)
  const row = (productId: string, channel: string, marketplace: string, accountId: string, data: Json = {}) => inside(async () => (await db().channelListing.create({ data: {
    productId, channel, marketplace, region: marketplace, channelMarket: `${channel}_${marketplace}`, channelConnectionId: accountId, ...data } as never })).id)

  it('the undo record names the alias\'s own listing rows when the alias is named by its alias id (no account needed)', async () => {
    const productId = await inside(async () => (await db().product.create({ data: { sku: 'TEST-SKU-L5-ALIAS', name: 'Alias product', basePrice: 10 } })).id)
    const main = await row(productId, 'EBAY', 'IT', ids.ebay, { listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'TEST-ITEM-L5-MAIN', quantity: 2 })
    const altId = await alias(productId, 'EBAY', 'IT', ids.ebay, 'ALT1')
    const alt = await row(productId, 'EBAY', 'IT', ids.ebay, { aliasKey: altId, aliasId: altId, listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'TEST-ITEM-L5-ALT', quantity: 2 })
    const { preview, ran } = await approveAndRun({ productId, channel: 'EBAY', marketplace: 'IT', listingId: altId, fields: ['title'] })
    expect(preview.destination).toMatchObject({ accountId: ids.ebay, listingId: altId })
    expect(ran.ok, ran.error).toBe(true)
    expect(ran.change.after.listingIds).toEqual([alt])
    expect(ran.change.after.listingIds).not.toContain(main)
    // An alias of another market is not this destination's: refused before anything is reviewed.
    const elsewhere = await alias(productId, 'EBAY', 'DE', ids.ebay, 'DE1')
    expect(await dryRun({ productId, channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, listingId: elsewhere })).toMatchObject({ ok: false, error: expect.stringContaining('TEST-SKU-L5-ALIAS on eBay IT:') })
  })

  it('Amazon EU: the one EU quantity is compared by the seller SKU this create sends, so an alias with its own SKU is not mixed with the main listing', async () => {
    const productId = await inside(async () => (await db().product.create({ data: { sku: 'TEST-SKU-L5-EUA', name: 'EU alias product', basePrice: 10 } })).id)
    await row(productId, 'AMAZON', 'IT', ids.amazon, { listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'TEST-ASIN-EUA', quantity: 3 })
    const altId = await alias(productId, 'AMAZON', 'DE', ids.amazon, 'Second', 'TEST-SKU-L5-EUA-ALT')
    await row(productId, 'AMAZON', 'DE', ids.amazon, { aliasKey: altId, aliasId: altId, listingStatus: 'DRAFT', isPublished: false })
    // The studio sends the alias's own seller SKU for its listing.
    fixture.facts.mockImplementation(async (id: string, scope: Json) => {
      const facts = await factsFor(productId)(id, scope)
      return { ...facts, products: facts.products.map((p: Json) => ({ ...p, sku: 'TEST-SKU-L5-EUA-ALT' })) }
    })
    const args = { productId, channel: 'AMAZON', marketplace: 'DE', listingId: altId }
    // The main listing holds 3 in IT under the product SKU: another SKU, so this create of 5 is not refused.
    const sent = await dryRun(args)
    expect(sent.ok, sent.error).toBe(true)
    expect(sent.preview).toMatchObject({ publish: 'first publish', destination: { listingId: altId } })
    expect(sent.preview).not.toHaveProperty('euQuantity')
    // A live IT listing that holds the alias's seller SKU (whatever its product) is the same Amazon quantity: refused.
    const other = await inside(async () => (await db().product.create({ data: { sku: 'TEST-SKU-L5-EUB', name: 'Other', basePrice: 10 } })).id)
    await row(other, 'AMAZON', 'IT', ids.amazon, { listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'TEST-ASIN-EUB', quantity: 2, liveChannelSku: 'TEST-SKU-L5-EUA-ALT' })
    expect(await dryRun(args)).toMatchObject({ ok: false,
      error: expect.stringContaining("TEST-SKU-L5-EUA-ALT: this first publish in DE would set Amazon's one EU quantity to 5, but its live EU listings hold 2 (IT)") })
  })
})
