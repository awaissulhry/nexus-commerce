/**
 * MCP full control 08 S13 — set-ebay-price-promotion and set-tier-prices.
 *
 *   set-ebay-price-promotion: a markdown is priced against each eBay listing's current price; a listing on another eBay
 *   account than the primary (the one the eBay publisher sends with) is refused; the preview says whether the publisher
 *   is live; in dry run nothing reaches the eBay dispatcher; live, the dispatcher (mocked: the gateway is never called)
 *   gets the listing's eBay id. Volume pricing: tiers validated, SKUs of one market.
 *   set-tier-prices: add, change and remove tiers; the undo puts them back.
 *
 * Real SQL (PGlite with the production schema); the eBay marketing dispatcher is mocked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'disabled' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
const dispatch = vi.hoisted(() => ({ posts: [] as Array<{ path: string; payload: any }> }))
vi.mock('../ebay-marketing-dispatch.service.js', () => ({
  readEbayPromotionPushControls: vi.fn(async () => []),
  postEbayMarketing: vi.fn(async (path: string, payload: unknown) => {
    dispatch.posts.push({ path, payload })
    return { ok: true, status: 201, promotionId: `TEST-PROMO-${dispatch.posts.length}` }
  }),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const ids = { jacket: '', gloves: '', jacketListing: '', glovesListing: '', otherListing: '', primary: '', other: '' }

type Tool = import('../agents/tool-types.js').AgentTool
const tools: Record<string, Tool> = {}
const person = { userId: 'u-approver', can: () => true, via: 'claude' as const }
const run = (name: string, raw: Record<string, unknown>, mode: 'handler' | 'execute' = 'handler') => {
  const args = tools[name].input.parse(raw) as Record<string, unknown>
  return inside(() => (mode === 'handler' ? tools[name].handler(args, person) : tools[name].execute!(args, person)))
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    await db.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'EBAY_IT' } as never })
    ids.primary = (await db.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'TEST eBay main', externalAccountId: 'test-seller-main', isActive: true, isPrimary: true } as never })).id
    ids.other = (await db.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'TEST eBay second', externalAccountId: 'test-seller-second', isActive: true, isPrimary: false } as never })).id
    ids.jacket = (await db.product.create({ data: { sku: 'TEST-SKU-S13-JACKET', name: 'Test jacket', basePrice: '100.00' } })).id
    ids.gloves = (await db.product.create({ data: { sku: 'TEST-SKU-S13-GLOVES', name: 'Test gloves', basePrice: '20.00' } })).id
    const listing = (productId: string, connection: string, price: string, external: string) => db.channelListing.create({
      data: { productId, channelMarket: 'EBAY_IT', channel: 'EBAY', region: 'IT', marketplace: 'IT', price, quantity: 3, listingStatus: 'ACTIVE', externalListingId: external, channelConnectionId: connection } as never,
    })
    ids.jacketListing = (await listing(ids.jacket, ids.primary, '100.00', 'TEST-ITEM-1')).id
    ids.glovesListing = (await listing(ids.gloves, ids.primary, '20.00', 'TEST-ITEM-2')).id
    ids.otherListing = (await db.channelListing.create({
      data: { productId: ids.gloves, channelMarket: 'EBAY_IT', channel: 'EBAY', region: 'IT', marketplace: 'IT', price: '21.00', quantity: 3, listingStatus: 'ACTIVE', externalListingId: 'TEST-ITEM-3', channelConnectionId: ids.other, aliasKey: 'second' } as never,
    })).id
    await db.customerGroup.create({ data: { code: 'trade', label: 'Trade' } })
  })
  const { getTool } = await import('../agents/tool-registry.js')
  for (const name of ['set-ebay-price-promotion', 'set-tier-prices']) tools[name] = getTool(name)!
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
})

describe('08 S13 — set-ebay-price-promotion', () => {
  it('a markdown: priced per listing; another eBay account is refused; dry run sends nothing and says so', async () => {
    vi.stubEnv('NEXUS_EBAY_MARKDOWN_LIVE', '0')
    expect((await run('set-ebay-price-promotion', { listingIds: [ids.otherListing], discountValue: 10 })).error)
      .toBe('Not queued: TEST-SKU-S13-GLOVES is listed on another eBay account: a promotion is sent with the primary eBay account only (set it in Nexus)')
    expect((await run('set-ebay-price-promotion', { listingIds: [ids.jacketListing], discountType: 'fixed_price', discountValue: 120 })).error).toMatch(/120 is not below its eBay price 100/)
    const dry = await run('set-ebay-price-promotion', { listingIds: [ids.jacketListing, ids.glovesListing], discountValue: 15 })
    expect(dry, dry.error).toMatchObject({
      ok: true,
      preview: { kind: 'markdown', live: false, discount: { type: 'PERCENTAGE', value: 15 }, listings: [{ sku: 'TEST-SKU-S13-JACKET', price: 100, markdownPrice: 85 }, { sku: 'TEST-SKU-S13-GLOVES', price: 20, markdownPrice: 17 }], note: expect.stringContaining('NOT sent to eBay') },
    })
    const ran = await run('set-ebay-price-promotion', { listingIds: [ids.jacketListing], discountValue: 15 }, 'execute')
    expect(ran, ran.error).toMatchObject({ ok: true, data: { live: false, markdowns: [{ sku: 'TEST-SKU-S13-JACKET', ok: true, live: false }] } })
    expect(dispatch.posts).toEqual([])
    expect(await inside(() => database.client.ebayMarkdown.findFirstOrThrow({ where: { channelListingId: ids.jacketListing }, select: { status: true, lastSyncStatus: true, markdownPrice: true, currency: true } })))
      .toMatchObject({ status: 'DRAFT', lastSyncStatus: 'PENDING', currency: 'EUR' })
  })

  it('a markdown, live: the eBay dispatcher gets the listing\'s eBay id; the row is scheduled with eBay\'s promotion id', async () => {
    vi.stubEnv('NEXUS_EBAY_MARKDOWN_LIVE', '1')
    const ran = await run('set-ebay-price-promotion', { listingIds: [ids.glovesListing], discountValue: 10, startDate: '2099-01-01' }, 'execute')
    expect(ran, ran.error).toMatchObject({ ok: true, data: { live: true } })
    expect(dispatch.posts).toEqual([expect.objectContaining({ path: '/sell/marketing/v1/item_price_markdown_promotion', payload: expect.objectContaining({ marketplaceId: 'EBAY_IT', selectedInventoryDiscounts: [expect.objectContaining({ discountSpecification: { listingIds: ['TEST-ITEM-2'] } })] }) })])
    expect(await inside(() => database.client.ebayMarkdown.findFirstOrThrow({ where: { channelListingId: ids.glovesListing }, select: { status: true, externalPromotionId: true } }))).toEqual({ status: 'SCHEDULED', externalPromotionId: 'TEST-PROMO-1' })
  })

  it('volume pricing: tiers are checked; the SKUs of one market; dry run records it', async () => {
    vi.stubEnv('NEXUS_EBAY_VOLUME_LIVE', '0')
    expect((await run('set-ebay-price-promotion', { kind: 'volume', marketplace: 'IT', productIds: [ids.jacket], tiers: [{ minQty: 2, percentOff: 10 }, { minQty: 3, percentOff: 5 }] })).error).toMatch(/^Not queued: the tiers/)
    expect((await run('set-ebay-price-promotion', { kind: 'volume', marketplace: 'IT', productIds: [ids.gloves], tiers: [{ minQty: 2, percentOff: 5 }] })).error).toMatch(/TEST-SKU-S13-GLOVES is listed on another eBay account/)
    const dry = await run('set-ebay-price-promotion', { kind: 'volume', marketplace: 'it', productIds: [ids.jacket], tiers: [{ minQty: 2, percentOff: 5 }, { minQty: 3, percentOff: 10 }] })
    expect(dry, dry.error).toMatchObject({ ok: true, preview: { kind: 'volume', live: false, products: ['TEST-SKU-S13-JACKET'], marketplace: 'IT' } })
    const ran = await run('set-ebay-price-promotion', { kind: 'volume', marketplace: 'IT', productIds: [ids.jacket], tiers: [{ minQty: 2, percentOff: 5 }, { minQty: 3, percentOff: 10 }] }, 'execute')
    expect(ran, ran.error).toMatchObject({ ok: true, data: { live: false } })
    expect(await inside(() => database.client.ebayVolumePromotion.findFirstOrThrow({ select: { marketplace: true, skus: true, status: true } }))).toEqual({ marketplace: 'IT', skus: ['TEST-SKU-S13-JACKET'], status: 'DRAFT' })
  })
})

describe('08 S13 — set-tier-prices', () => {
  it('adds, changes and removes tiers; a customer group by code; the undo puts them back', async () => {
    expect((await run('set-tier-prices', { productId: ids.jacket, tiers: [{ minQty: 5, price: 90, customerGroup: 'retail' }] })).error).toBe('TEST-SKU-S13-JACKET: no customer group retail in this business')
    const added = await run('set-tier-prices', { productId: ids.jacket, tiers: [{ minQty: 5, price: 90 }, { minQty: 10, price: 80, customerGroup: 'trade' }] }, 'execute')
    expect(added, added.error).toMatchObject({ ok: true, data: { changed: 2 } })
    const dry = await run('set-tier-prices', { productId: ids.jacket, tiers: [{ minQty: 5, price: 88 }, { minQty: 10, price: null, customerGroup: 'trade' }] })
    expect(dry, dry.error).toMatchObject({ ok: true, preview: { tiers: [{ minQty: 5, from: 90, to: 88, change: 'update' }, { minQty: 10, customerGroup: 'trade', from: 80, to: null, change: 'remove' }] } })
    const changed = await run('set-tier-prices', { productId: ids.jacket, tiers: [{ minQty: 5, price: 88 }, { minQty: 10, price: null, customerGroup: 'trade' }] }, 'execute')
    expect(changed.ok, changed.error).toBe(true)
    expect(await inside(() => tools['set-tier-prices'].undo!.current(changed.change!))).toEqual(changed.change!.after)
    const undo = tools['set-tier-prices'].undo!.request(changed.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toEqual({ tool: 'set-tier-prices', args: { productId: ids.jacket, tiers: [{ minQty: 5, price: 90 }, { minQty: 10, price: 80, customerGroup: 'trade' }] } })
    expect((await run('set-tier-prices', undo.args, 'execute')).ok).toBe(true)
    const rows = await inside(() => database.client.productTierPrice.findMany({ where: { productId: ids.jacket }, orderBy: { minQty: 'asc' }, select: { minQty: true, price: true, customerGroup: { select: { code: true } } } }))
    expect(rows.map((r) => [r.minQty, Number(r.price), r.customerGroup?.code ?? null])).toEqual([[5, 90, null], [10, 80, 'trade']])
  })
})
