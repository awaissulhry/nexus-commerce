/**
 * MCP full control I7 — the Amazon, Shopify and Etsy readers of the per-account identity sweep, with each channel stood
 * in by a fixture (real reads need the deployed API's KMS-sealed logins), then swept for real into ChannelHeldId on
 * PGlite with the production schema and policies.
 *
 * Proven per channel: a complete read gives the ids a listing carries (Amazon: ASIN with seller SKU per market of THIS
 * account; Shopify: product id with each variant SKU, gid or short; Etsy: listing id with each SKU) and links them; a
 * failed page, a page cap, an empty Amazon report while listings are live — each is incomplete and ends nothing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { amazonHeldReader, etsyHeldReader, shopifyHeldReader, type AmazonCatalogRow } from './channel-held-readers.js'
import { sweepAccount } from './channel-held.service.js'
import { identityCheck } from './identity-checks.js'
import { runCheck } from './identity-audit.service.js'

const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}
const held = (connectionId: string) => inside(() => database.client.channelHeldId.findMany({ where: { channelConnectionId: connectionId }, orderBy: [{ externalId: 'asc' }, { sellerSku: 'asc' }] }))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    for (const [key, channelType, marketplace] of [['amazon', 'AMAZON', 'IT'], ['shopify', 'SHOPIFY', null], ['etsy', 'ETSY', null]] as const) {
      ids[key] = (await db.channelConnection.create({ data: { channelType, marketplace, isActive: true, externalAccountId: `test-${key}` } })).id
    }
    const product = async (sku: string) => { ids[sku] = (await db.product.create({ data: { sku, name: sku, basePrice: '10.00' } })).id }
    const listing = async (sku: string, channel: string, market: string, external: string, account: string) => {
      ids[`L:${sku}:${channel}:${market}`] = (await db.channelListing.create({
        data: { productId: ids[sku], channel, marketplace: market, region: market, channelMarket: `${channel}_${market}`, listingStatus: 'ACTIVE', externalListingId: external, channelConnectionId: account },
      })).id
    }
    for (const sku of ['AMZ-1', 'AMZ-2', 'SHP-1', 'ETS-1']) await product(sku)
    await listing('AMZ-1', 'AMAZON', 'IT', 'B0HELD0001', ids.amazon)
    await listing('AMZ-1', 'AMAZON', 'DE', 'B0HELD0001', ids.amazon)
    await listing('AMZ-2', 'AMAZON', 'DE', 'B0HELD0002', ids.amazon)
    await listing('SHP-1', 'SHOPIFY', 'GLOBAL', 'gid://shopify/Product/4001', ids.shopify)
    await listing('ETS-1', 'ETSY', 'GLOBAL', '880000001', ids.etsy)
  })
}, 120_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

describe('I7 — Amazon: the merchant listings report of this account, per market it sells in', () => {
  const report: Record<string, AmazonCatalogRow[]> = {
    APJ6JRA9NG5V4: [{ sku: 'AMZ-1', asin: 'B0HELD0001', parentAsin: null, title: 'Jacket', status: 'Active' }],
    A1PA6795UKMFR9: [
      { sku: 'AMZ-1', asin: 'B0HELD0001', parentAsin: null, title: 'Jacket', status: 'Active' },
      { sku: 'AMZ-1-FBA', asin: 'B0HELD0001', parentAsin: null, title: 'Jacket FBA', status: 'Active' },
      { sku: 'ORPHAN-AMZ', asin: 'B0HELD0009', parentAsin: null, title: 'Orphan', status: 'Active' },
    ],
  }
  it('reads each market for this account, records ASIN with each seller SKU, and links them', async () => {
    const asked: string[] = []
    const reader = amazonHeldReader({ fetchCatalog: async (account, market) => { asked.push(`${account === ids.amazon} ${market}`); return report[market] ?? [] } })
    const out = await inside(() => sweepAccount(ids.amazon, reader))
    expect(asked.sort()).toEqual(['true A1PA6795UKMFR9', 'true APJ6JRA9NG5V4'])
    // DE holds B0HELD0002? No: AMZ-2's ASIN is not in the DE report, and the report is not empty, so the read is complete.
    expect(out).toMatchObject({ complete: true, seen: 4 })
    const rows = (await held(ids.amazon)).map((r) => [r.marketplace, r.externalId, r.sellerSku, r.matchState].join(' ')).sort()
    expect(rows).toEqual([
      'DE B0HELD0001 AMZ-1 LINKED', 'DE B0HELD0001 AMZ-1-FBA LINKED', 'IT B0HELD0001 AMZ-1 LINKED', 'DE B0HELD0009 ORPHAN-AMZ UNLINKED',
    ].sort())
    const notHeld = await inside(async () => (await runCheck(identityCheck('channel-id-not-held-by-account')!, { limit: 50 })).findings)
    expect(notHeld.map((f) => [f.sku, f.market])).toEqual([['AMZ-2', 'DE']])
  })

  it('a failed market report, and an empty one while listings are live, are incomplete; nothing ends', async () => {
    const failing = amazonHeldReader({ fetchCatalog: async (_a, market) => { if (market === 'APJ6JRA9NG5V4') throw new Error('throttled'); return [] } })
    const out = await inside(() => sweepAccount(ids.amazon, failing))
    expect(out).toMatchObject({ complete: false, ended: 0 })
    expect(out.reason).toMatch(/IT: the listings report failed \(throttled\)/)
    expect(out.reason).toMatch(/DE: the report was empty while 2 listing\(s\) are live/)
    expect((await held(ids.amazon)).every((r) => r.endedAt === null)).toBe(true)
  })
})

describe('I7 — Shopify: products and variants, paged, read-only', () => {
  const page = (nodes: unknown[], hasNextPage: boolean, endCursor = 'c1') => ({ data: { products: { pageInfo: { hasNextPage, endCursor }, nodes } }, errors: [] })
  const product = (id: string, skus: string[], extra: { more?: boolean } = {}) => ({
    id: `gid://shopify/Product/${id}`, title: `P${id}`, status: 'ACTIVE',
    variants: { pageInfo: { hasNextPage: !!extra.more }, nodes: skus.map((sku, i) => ({ id: `gid://shopify/ProductVariant/${id}${i}`, sku })) },
  })

  it('every page: the product id (short form) with each variant SKU, linked to the listing that carries it', async () => {
    const pages = [page([product('4001', ['SHP-1-S', 'SHP-1-M'])], true), page([product('4002', [''])], false)]
    let call = 0
    const reader = shopifyHeldReader({ read: async () => async () => pages[call++] })
    const out = await inside(() => sweepAccount(ids.shopify, reader))
    expect(out).toMatchObject({ complete: true, seen: 3, linked: 2, unlinked: 1 })
    expect((await held(ids.shopify)).map((r) => [r.externalId, r.sellerSku, r.matchState])).toEqual([
      ['4001', 'SHP-1-M', 'LINKED'], ['4001', 'SHP-1-S', 'LINKED'], ['4002', '', 'UNLINKED'],
    ])
  })

  it('a page cap, GraphQL errors and a product with more than 250 variants are incomplete', async () => {
    const one = (answer: unknown) => shopifyHeldReader({ pageCap: 1, read: async () => async () => answer as never })
    const conn = { id: ids.shopify, channelType: 'SHOPIFY', marketplace: null, externalAccountId: null }
    expect(await one(page([product('4001', ['A'])], true)).read(conn)).toMatchObject({ complete: false, reason: expect.stringContaining('1-page cap') })
    expect(await one({ data: null, errors: [{ message: 'Throttled' }] }).read(conn)).toMatchObject({ complete: false, reason: 'page 1: Throttled' })
    expect(await one(page([product('4001', ['A'], { more: true })], false)).read(conn)).toMatchObject({ complete: false, reason: expect.stringContaining('more than 250 variants') })
  })
})

describe('I7 — Etsy: the shop\'s active listings, paged', () => {
  it('every page: the listing id with each SKU; a failed page or a cap is incomplete', async () => {
    const pages: Record<number, unknown> = {
      0: { count: 150, results: [{ listing_id: 880000001, title: 'Patch', state: 'active', skus: ['ETS-1'] }] },
      100: { count: 150, results: [{ listing_id: 880000002, title: 'Other', state: 'active', skus: [] }] },
    }
    const get = async (path: string) => {
      const offset = Number(/offset=(\d+)/.exec(path)?.[1])
      if (!(offset in pages)) throw new Error('HTTP 500')
      return pages[offset] as never
    }
    const out = await inside(() => sweepAccount(ids.etsy, etsyHeldReader({ reader: async () => ({ get, shopId: 77 }) })))
    expect(out).toMatchObject({ complete: true, seen: 2, linked: 1, unlinked: 1 })
    const conn = { id: ids.etsy, channelType: 'ETSY', marketplace: null, externalAccountId: null }
    expect(await etsyHeldReader({ pageCap: 1, reader: async () => ({ get, shopId: 77 }) }).read(conn)).toMatchObject({ complete: false, reason: expect.stringContaining('1-page cap') })
    delete pages[100]
    expect(await etsyHeldReader({ reader: async () => ({ get, shopId: 77 }) }).read(conn)).toMatchObject({ complete: false, reason: 'page 2 could not be read: HTTP 500' })
  })
})
