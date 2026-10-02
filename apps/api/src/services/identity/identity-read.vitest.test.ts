/**
 * MCP full control I3 — product-identity and find-by-id, run through the one door (call-tool.ts) against a real
 * PostgreSQL with the production schema and the business-isolation policies (PGlite). No mocked query.
 *
 * Business A holds one family with an id in every place Nexus keeps one (listings on four channels, an extra listing,
 * offers, a claim, shared eBay variation rows, a Shopify colour product, the eBay listing index, a SKU alias, an old
 * product column) and a deleted variation that carries the family's Item ID. Business B holds a product with the same
 * SKU, Item ID and GTIN — legal across businesses — which A never finds. The extra-listing SKU is read once its column
 * exists, and said to be missing before.
 *
 * Run with business profiles OFF and again with NEXUS_WORKSPACES_ENABLED=1.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { callTool, ToolAccessError, type UserPrincipal } from '../agents/call-tool.js'

const A = LEGACY_WORKSPACE_ID
const B = 'ws_identity_read_bravo'

const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)
function principal(workspaceId: string, permissions: string[]): UserPrincipal {
  return {
    kind: 'user',
    userId: 'u-identity-read',
    label: 'Identity read test',
    permissions: { isOwner: false, permissions: new Set(permissions) },
    workspace: business(workspaceId),
    via: 'claude',
  }
}
const everything = (workspaceId = A) => principal(workspaceId, [...Object.values(FEATURES), ...Object.values(FIELDS)])

type Json = Record<string, any>
async function call(tool: string, args: Record<string, unknown>, who: UserPrincipal = everything()): Promise<Json> {
  return (await callTool(who, tool, args)).visible as Json
}

function withCheckDigit(base: string): string {
  let sum = 0
  for (let i = base.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(base[i]) * w
  return base + ((10 - (sum % 10)) % 10)
}
const UPC = withCheckDigit('03600029145')
const EAN = withCheckDigit('400638133393')
const ITEM = '110000000001'

const ids: Record<string, string> = {}
const listings: Record<string, string> = {}
const accounts: Record<string, string> = {}

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, 'Bravo business', 'active', 'identity', $1, CURRENT_TIMESTAMP)`, [B])
  await inside(A, async () => {
    const db = database.client
    for (const [key, channelType] of [['ebay', 'EBAY'], ['amazon', 'AMAZON'], ['shopify', 'SHOPIFY']] as const) {
      accounts[key] = (await db.channelConnection.create({ data: { channelType, accountLabel: `${channelType} main`, isActive: true, externalAccountId: `TEST-${channelType}-A` } })).id
    }
    const product = async (sku: string, extra: Json = {}) => {
      ids[sku] = (await db.product.create({ data: { sku, name: `${sku} jacket`, basePrice: '10.00', ...extra } })).id
    }
    await product('FAM-ROOT', { isParent: true, brand: 'Acme', ebayItemId: ITEM })
    await product('FAM-S', { parentId: ids['FAM-ROOT'], upc: UPC })
    await product('FAM-M', { parentId: ids['FAM-ROOT'], ean: EAN })
    await product('FAM-GONE', { parentId: ids['FAM-ROOT'] })
    const listing = async (name: string, sku: string, channel: string, market: string, external: string | null, extra: Json = {}) => {
      const account = { EBAY: accounts.ebay, AMAZON: accounts.amazon, SHOPIFY: accounts.shopify }[channel] ?? null
      listings[name] = (await db.channelListing.create({
        data: {
          productId: ids[sku], channel, marketplace: market, region: market, channelMarket: `${channel}_${market}`,
          listingStatus: 'ACTIVE', externalListingId: external, channelConnectionId: account, ...extra,
        },
      })).id
    }
    await listing('rootEbay', 'FAM-ROOT', 'EBAY', 'IT', ITEM)
    await listing('sEbay', 'FAM-S', 'EBAY', 'IT', ITEM)
    await listing('mEbay', 'FAM-M', 'EBAY', 'IT', ITEM)
    await listing('goneEbay', 'FAM-GONE', 'EBAY', 'IT', ITEM)
    const second = await db.productListingAlias.create({
      data: { productId: ids['FAM-ROOT'], channel: 'EBAY', marketplace: 'IT', channelConnectionId: accounts.ebay, label: 'second listing', position: 2 },
    })
    ids.alias = second.id
    await listing('rootEbay2', 'FAM-ROOT', 'EBAY', 'IT', '110000000002', { aliasId: second.id, aliasKey: second.id })
    await listing('rootAmazon', 'FAM-ROOT', 'AMAZON', 'DE', 'B0FAMPAR01')
    await listing('sAmazon', 'FAM-S', 'AMAZON', 'DE', 'B0FAMS0001', { externalParentId: 'B0FAMPAR01' })
    await db.offer.create({ data: { channelListingId: listings.sAmazon, fulfillmentMethod: 'FBA', sku: 'FAM-S-FBA' } })
    await listing('rootShopify', 'FAM-ROOT', 'SHOPIFY', 'GLOBAL', 'gid://shopify/Product/500')
    await listing('sShopify', 'FAM-S', 'SHOPIFY', 'GLOBAL', '500', {
      platformAttributes: { shopifyProductId: '500', variantId: 'gid://shopify/ProductVariant/5001', inventoryItemId: '9001' },
    })
    await listing('mEtsy', 'FAM-M', 'ETSY', 'GLOBAL', '7700001')
    await db.product.update({ where: { id: ids['FAM-GONE'] }, data: { deletedAt: new Date() } })
    await db.skuAlias.create({ data: { productId: ids['FAM-M'], alias: 'fam-medium', raw: 'FAM-Medium' } })
    for (const sku of ['FAM-S', 'FAM-M']) {
      await db.sharedListingMembership.create({
        data: { marketplace: 'IT', sku, itemId: ITEM, parentSku: 'FAM-ROOT', productId: ids[sku], variationSpecifics: { Size: sku.slice(-1) }, channelConnectionId: accounts.ebay },
      })
    }
    await db.shopifyColourProduct.create({
      data: { familyId: ids['FAM-ROOT'], channelConnectionId: accounts.shopify, splitAxis: 'Color', valueKey: 'red', colourName: 'Red', shopifyProductId: 'gid://shopify/Product/600', state: 'LINKED' },
    })
    await db.ebayListingIndex.create({ data: { marketplace: 'IT', itemId: ITEM, productIds: [ids['FAM-ROOT']], matchStatus: 'CONFIRMED' } })
    // A variation whose parent was deleted.
    await product('LONE-PARENT', { isParent: true })
    await product('LONE-CHILD', { parentId: ids['LONE-PARENT'] })
    await db.product.update({ where: { id: ids['LONE-PARENT'] }, data: { deletedAt: new Date() } })
  })
  // A claim on the family's eBay coordinate (claims are written by the publish path; here as the database owner).
  await database.db.query(
    `INSERT INTO "ChannelListingClaim" ("connectionId", marketplace, "sellerSku", "workspaceId", "channelListingId") VALUES ($1, 'IT', 'FAM-ROOT', $2, $3)`,
    [accounts.ebay, A, listings.rootEbay],
  )
  // Business B: the same SKU, Item ID and barcode — legal across businesses, and never A's.
  await inside(B, async () => {
    const db = database.client
    const account = await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, externalAccountId: 'TEST-EBAY-B' } })
    const product = await db.product.create({ data: { sku: 'FAM-ROOT', name: 'BRAVO jacket', basePrice: '10.00', upc: UPC } })
    ids.bravo = product.id
    listings.bravo = (await db.channelListing.create({
      data: { productId: product.id, channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT', listingStatus: 'ACTIVE', externalListingId: ITEM, channelConnectionId: account.id },
    })).id
  })
  // Integration (ids × eBay import by SKU): this schema already has ProductListingAlias.sku (20261001c). The tests below
  // start from the state before that migration and add the column themselves, so drop it once the seed is in.
  await database.db.query(`ALTER TABLE "ProductListingAlias" DROP COLUMN IF EXISTS "sku"`)
}, 180_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

// ── product-identity ──────────────────────────────────────────────────────────────────────────────────

describe('I3 — product-identity', () => {
  it('shows every id of the family, from every place, and nothing of the deleted variation', async () => {
    const out = await call('product-identity', { productId: ids['FAM-ROOT'] })
    expect(out.ok, out.error).toBe(true)
    const data = out.data
    expect(data.family).toMatchObject({ rootProductId: ids['FAM-ROOT'], rootSku: 'FAM-ROOT', isParent: true, variations: 2 })
    expect(data.products.map((p: Json) => [p.sku, p.role])).toEqual([['FAM-ROOT', 'parent'], ['FAM-M', 'variation'], ['FAM-S', 'variation']])
    expect(data.products[0].oldColumns).toEqual({ ebayItemId: ITEM })
    expect(data.products[1]).toMatchObject({ ean: EAN, skuAliases: ['FAM-Medium'] })
    expect(data.products[2]).toMatchObject({ upc: UPC })

    const byId = Object.fromEntries((data.listings as Json[]).map((l) => [l.listingId, l]))
    expect(Object.keys(byId).sort()).toEqual(['rootEbay', 'sEbay', 'mEbay', 'rootEbay2', 'rootAmazon', 'sAmazon', 'rootShopify', 'sShopify', 'mEtsy'].map((n) => listings[n]).sort())
    expect(byId[listings.rootEbay]).toMatchObject({
      sku: 'FAM-ROOT', channel: 'EBAY', market: 'IT', ids: { itemId: ITEM }, sellerSku: 'FAM-ROOT', draft: false,
      account: { accountId: accounts.ebay, label: 'EBAY main', ownedHere: true },
      claim: { accountId: accounts.ebay, market: 'IT', sellerSku: 'FAM-ROOT' },
    })
    expect(byId[listings.rootEbay2]).toMatchObject({ ids: { itemId: '110000000002' }, extraListing: { id: ids.alias, label: 'second listing' } })
    expect(byId[listings.sAmazon]).toMatchObject({
      ids: { asin: 'B0FAMS0001', parentAsin: 'B0FAMPAR01' }, sellerSku: 'FAM-S-FBA', offers: [{ fulfillment: 'FBA', sku: 'FAM-S-FBA', active: true }],
    })
    // Shopify ids in their short form, however they are stored.
    expect(byId[listings.rootShopify].ids).toEqual({ shopifyProductId: '500' })
    expect(byId[listings.sShopify].ids).toEqual({ shopifyProductId: '500', shopifyVariantId: '5001', shopifyInventoryItemId: '9001' })
    expect(byId[listings.mEtsy]).toMatchObject({ ids: { etsyListingId: '7700001' } })
    expect(byId[listings.mEtsy]).not.toHaveProperty('account')

    expect(data.extraListings).toEqual([{ id: ids.alias, onProductSku: 'FAM-ROOT', channel: 'EBAY', market: 'IT', account: expect.objectContaining({ accountId: accounts.ebay }), label: 'second listing', position: 2, status: 'ACTIVE' }])
    expect(data.sharedEbayListings).toEqual([{ market: 'IT', itemId: ITEM, parentSku: 'FAM-ROOT', status: ['ACTIVE'], variations: [
      { sku: 'FAM-M', productId: ids['FAM-M'], status: 'ACTIVE' }, { sku: 'FAM-S', productId: ids['FAM-S'], status: 'ACTIVE' },
    ] }])
    expect(data.shopifyColourProducts).toEqual([expect.objectContaining({ colour: 'Red', shopifyProductId: '600', state: 'LINKED' })])
    expect(data.extraListingSku).toBe('not available until the listing-SKU column exists')
    expect(data.more).toEqual({})

    const text = JSON.stringify(out)
    expect(text).not.toContain(ids['FAM-GONE'])
    expect(text).not.toContain(listings.goneEbay)
    expect(text).not.toContain(ids.bravo)
  })

  it('named by a variation, shows the same family and says which product was asked for', async () => {
    const out = await call('product-identity', { productId: ids['FAM-S'] })
    expect(out.data.family).toMatchObject({ rootProductId: ids['FAM-ROOT'], askedFor: ids['FAM-S'] })
    expect(out.data.listings).toHaveLength(9)
  })

  it('filters listings by channel and by market', async () => {
    const amazon = await call('product-identity', { productId: ids['FAM-ROOT'], channel: 'amazon' })
    expect(amazon.data.listings.map((l: Json) => l.listingId).sort()).toEqual([listings.rootAmazon, listings.sAmazon].sort())
    expect(amazon.data).toMatchObject({ extraListings: [], sharedEbayListings: [], shopifyColourProducts: [] })
    const italy = await call('product-identity', { productId: ids['FAM-ROOT'], market: 'it' })
    expect(new Set(italy.data.listings.map((l: Json) => `${l.channel} ${l.market}`))).toEqual(new Set(['EBAY IT']))
    expect(italy.data.sharedEbayListings).toHaveLength(1)
  })

  it('a deleted product, another business’s product and an unknown id are not found', async () => {
    for (const productId of [ids['FAM-GONE'], ids.bravo, 'no-such-product']) {
      expect(await call('product-identity', { productId })).toEqual({ ok: false, error: 'Product not found' })
    }
    // Control: B's product is found inside B.
    const own = await call('product-identity', { productId: ids.bravo }, everything(B))
    expect(own.data.listings.map((l: Json) => l.listingId)).toEqual([listings.bravo])
  })

  it('a variation whose parent was deleted is shown alone, and says why', async () => {
    const out = await call('product-identity', { productId: ids['LONE-CHILD'] })
    expect(out.data.family).toMatchObject({ rootProductId: ids['LONE-CHILD'], notes: [expect.stringContaining('parent product was deleted')] })
    expect(JSON.stringify(out)).not.toContain(ids['LONE-PARENT'])
  })

  it('needs both products.view and listings.view', async () => {
    const listingsOnly = principal(A, [FEATURES.aiRun, FEATURES.listingsView])
    await expect(callTool(listingsOnly, 'product-identity', { productId: ids['FAM-ROOT'] })).rejects.toBeInstanceOf(ToolAccessError)
    await expect(callTool(listingsOnly, 'find-by-id', { query: 'FAM-ROOT' })).rejects.toBeInstanceOf(ToolAccessError)
  })
})

// ── find-by-id ────────────────────────────────────────────────────────────────────────────────────────

describe('I3 — find-by-id', () => {
  const found = async (query: string, kind?: string, who?: UserPrincipal) => {
    const out = await call('find-by-id', { query, ...(kind ? { kind } : {}) }, who)
    expect(out.ok, out.error).toBe(true)
    return out.data as { matches: Json[]; families: Json[]; note?: string; more?: string }
  }
  const places = (matches: Json[]) => matches.map((m) => `${m.matchedAs} ${m.sku ?? '-'}${m.listingId ? ` ${Object.entries(listings).find(([, id]) => id === m.listingId)?.[0]}` : ''}`).sort()

  it('an eBay Item ID: every listing, the shared eBay listing, the index and the old column — one family, not the deleted variation, not B', async () => {
    const out = await found(ITEM)
    expect(places(out.matches)).toEqual([
      'eBay Item ID FAM-M mEbay', 'eBay Item ID FAM-ROOT rootEbay', 'eBay Item ID FAM-S sEbay',
      'eBay listing index FAM-ROOT', 'old product column ebayItemId FAM-ROOT', 'shared eBay listing (its variation rows) FAM-ROOT',
    ].sort())
    expect(out.families).toEqual([{ rootProductId: ids['FAM-ROOT'], rootSku: 'FAM-ROOT', matches: 6 }])
    // I5 — B holds the same Item ID: said, unnamed (no person who is a member of B asks), with nothing of B.
    expect((out as Json).elsewhere).toEqual([{ channel: 'EBAY', heldBy: 'another business', listings: 1 }])
    expect(JSON.stringify(out)).not.toContain(ids.bravo)
    for (const match of out.matches) expect(match.family).toEqual({ rootProductId: ids['FAM-ROOT'], rootSku: 'FAM-ROOT' })
    // Control: inside B the same Item ID is B's listing.
    const inB = await found(ITEM, undefined, everything(B))
    expect(inB.matches.map((m) => [m.matchedAs, m.productId, m.listingId])).toEqual([['eBay Item ID', ids.bravo, listings.bravo]])
  })

  it('SKUs, without case: a product SKU, a claimed seller SKU, an offer SKU, a shared variation SKU and a SKU alias', async () => {
    expect(places((await found('fam-root')).matches)).toEqual(['product SKU FAM-ROOT', 'seller SKU claimed on a shared account FAM-ROOT rootEbay'])
    expect(places((await found('FAM-S-FBA', 'sku')).matches)).toEqual(['offer SKU FAM-S sAmazon'])
    expect(places((await found('FAM-S')).matches)).toEqual(['product SKU FAM-S', 'shared eBay variation SKU FAM-S'])
    expect(places((await found('fam-medium')).matches)).toEqual(['SKU alias FAM-M'])
  })

  it('ASINs, Shopify ids in either form, an Etsy listing id, a barcode with its leading zero, a product id', async () => {
    expect(places((await found('b0fampar01')).matches)).toEqual(['ASIN FAM-ROOT rootAmazon', 'parent ASIN FAM-S sAmazon'])
    for (const variant of ['5001', 'gid://shopify/ProductVariant/5001']) {
      expect(places((await found(variant, 'shopify-id')).matches)).toEqual(['Shopify variant FAM-S sShopify'])
    }
    expect(places((await found('gid://shopify/Product/500')).matches)).toEqual(['Shopify product FAM-ROOT rootShopify', 'Shopify product FAM-S sShopify'])
    expect(places((await found('600')).matches)).toEqual(['Shopify colour product FAM-ROOT'])
    expect(places((await found('9001')).matches)).toEqual(['Shopify inventory item FAM-S sShopify'])
    const etsy = await found('7700001', 'etsy-listing-id')
    expect(places(etsy.matches)).toEqual(['Etsy listing id FAM-M mEtsy'])
    expect(etsy).not.toHaveProperty('elsewhere')
    // The UPC as a GTIN-13 (a leading zero): this business's variation, not B's product with the same code.
    const code = await found(`0${UPC}`)
    expect(places(code.matches)).toEqual(['GTIN / EAN / UPC FAM-S'])
    expect(code.matches[0].value).toBe(`upc ${UPC}`)
    expect(places((await found(ids['FAM-M'])).matches)).toEqual(['Nexus product id FAM-M'])
  })

  it('a kind narrows the search; a deleted product, another business’s id and an unknown id find nothing', async () => {
    expect((await found(ITEM, 'sku')).matches).toEqual([])
    for (const query of ['FAM-GONE', ids['FAM-GONE'], ids.bravo, 'NO-SUCH-ID']) {
      const out = await found(query)
      expect(out.matches).toEqual([])
      expect(out.note).toBe('Nothing in this business uses this id.')
    }
  })
})

// ── The extra listing's own SKU (ProductListingAlias.sku), once its column exists ─────────────────────

describe('I3 — the extra-listing SKU, once its column exists', () => {
  it('product-identity shows it and find-by-id finds it', async () => {
    await database.db.query(`ALTER TABLE "ProductListingAlias" ADD COLUMN "sku" TEXT`)
    await database.db.query(`UPDATE "ProductListingAlias" SET sku = 'FAM-ROOT-2ND' WHERE id = $1`, [ids.alias])
    const out = await call('product-identity', { productId: ids['FAM-ROOT'] })
    expect(out.data).not.toHaveProperty('extraListingSku')
    expect(out.data.extraListings[0]).toMatchObject({ id: ids.alias, sku: 'FAM-ROOT-2ND' })
    expect(out.data.listings.find((l: Json) => l.listingId === listings.rootEbay2).extraListing).toEqual({ id: ids.alias, label: 'second listing', sku: 'FAM-ROOT-2ND' })
    const search = await call('find-by-id', { query: 'fam-root-2nd' })
    expect(search.data.matches).toEqual([expect.objectContaining({ matchedAs: 'extra listing SKU', productId: ids['FAM-ROOT'], channel: 'EBAY', market: 'IT', value: 'FAM-ROOT-2ND' })])
  })
})
