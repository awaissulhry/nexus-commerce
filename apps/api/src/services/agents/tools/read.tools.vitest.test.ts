/**
 * MCP.12 — two read tools Claude uses, through the one door (call-tool.ts), on a real PostgreSQL with the production
 * schema and business-isolation policies (PGlite).
 *
 *   product-search / order-search  the caller's text is matched as typed: `_` and `%` are characters. Prisma's
 *                                  `contains` does not escape them, so `A_B` also found `AXB` and `100%` found `1000`.
 *   product-snapshot               hasAmazon / hasEbay come from the listings Nexus holds (a draft counts, and a
 *                                  parent's variations count), not from the older Product columns, which said
 *                                  "no eBay" while an eBay draft existed; and each listing says whether it is a draft.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { callTool, type UserPrincipal } from '../call-tool.js'
import { likeEscaped } from '../../../lib/like-pattern.js'

const A = LEGACY_WORKSPACE_ID
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const everyone: UserPrincipal = {
  kind: 'user',
  userId: 'u-mcp12',
  label: 'MCP.12 test',
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: business,
  via: 'claude',
}

type Data = Record<string, any>
async function call(tool: string, args: Record<string, unknown>): Promise<Data> {
  const out = (await callTool(everyone, tool, args)).visible as { ok: boolean; error?: string; data?: Data }
  expect(out.ok, out.error).toBe(true)
  return out.data!
}
const skus = async (query: string) => (await call('product-search', { query, limit: 50 })).products.map((p: Data) => p.sku).sort()

const ids = { parent: '', child: '', deleted: '' }

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    for (const [sku, name] of [
      ['MCP12-A_B', 'Jacket A_B'], ['MCP12-AXB', 'Jacket AXB'],
      ['MCP12-100%', 'Glove 100% leather'], ['MCP12-1000', 'Glove 1000'],
    ]) {
      await db.product.create({ data: { sku, name, basePrice: '10.00' } })
    }
    // A parent listed on Amazon itself, and a variation with an eBay DRAFT; the old columns (amazonAsin,
    // ebayItemId) are left empty, as they are for a listing made in Nexus.
    ids.parent = (await db.product.create({ data: { sku: 'MCP12-PARENT', name: 'Parent jacket', basePrice: '10.00', isParent: true } })).id
    ids.child = (await db.product.create({ data: { sku: 'MCP12-PARENT-S', name: 'Parent jacket S', basePrice: '10.00', parentId: ids.parent } })).id
    const listing = (productId: string, channel: string, marketplace: string, data: Record<string, unknown>) =>
      db.channelListing.create({ data: { productId, channel, marketplace, region: marketplace, channelMarket: `${channel}_${marketplace}`, ...data } as never })
    await listing(ids.parent, 'AMAZON', 'IT', { listingStatus: 'ACTIVE', externalListingId: 'EXT-MCP12-1' })
    await listing(ids.child, 'EBAY', 'DE', { listingStatus: 'DRAFT', externalListingId: null })
    // A draft LINKED to an item the channel already has (it carries the channel's item number): not yet sent from
    // Nexus, yet not "unpublished" either — the shape 46 of 102 drafts in the development data have.
    await listing(ids.parent, 'EBAY', 'IT', { listingStatus: 'DRAFT', externalListingId: 'EXT-MCP12-2' })
    // A deleted product (soft delete) whose SKU and name match searches above, with a listing of its own.
    ids.deleted = (await db.product.create({ data: { sku: 'MCP12-A_B-OLD', name: 'Jacket A_B (deleted)', basePrice: '10.00', deletedAt: new Date() } })).id
    await listing(ids.deleted, 'AMAZON', 'DE', { listingStatus: 'ACTIVE', externalListingId: 'EXT-MCP12-3' })

    for (const [n, email] of [[1, 'j_smith@example.test'], [2, 'jxsmith@example.test']] as const) {
      await db.order.create({
        data: {
          channel: 'EBAY', channelOrderId: `MCP12-ORDER-${n}`, marketplace: 'IT', currencyCode: 'EUR', totalPrice: '10.00',
          customerName: `Buyer ${n}`, customerEmail: email, shippingAddress: { city: 'Milano' }, purchaseDate: new Date(),
        } as never,
      })
    }
  })
}, 120_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

describe('MCP.12 — the caller’s text is matched as typed', () => {
  it('likeEscaped makes `_`, `%` and `\\` literal', () => {
    expect(likeEscaped('a_b%c\\d')).toBe('a\\_b\\%c\\\\d')
    expect(likeEscaped('plain')).toBe('plain')
  })

  it('product-search: `_` and `%` in a SKU or a name are characters, not wildcards', async () => {
    expect(await skus('A_B')).toEqual(['MCP12-A_B'])
    expect(await skus('100%')).toEqual(['MCP12-100%'])
    expect(await skus('%')).toEqual(['MCP12-100%'])
    // Control: a plain fragment still finds both.
    expect(await skus('MCP12-A')).toEqual(['MCP12-AXB', 'MCP12-A_B'])
  })

  it('order-search: a buyer’s `_` is a character too', async () => {
    const orders = (await call('order-search', { buyer: 'j_smith', limit: 50 })).orders as Data[]
    expect(orders.map((o) => o.channelOrderId)).toEqual(['MCP12-ORDER-1'])
  })
})

describe('MCP.12 — product-snapshot reads the listings Nexus holds', () => {
  it('a parent with an Amazon listing and a variation’s eBay draft: both channels, and the draft named', async () => {
    const snap = await call('product-snapshot', { productId: ids.parent })
    expect(snap).toMatchObject({ sku: 'MCP12-PARENT', hasAmazon: true, hasEbay: true })
    expect(snap.listings).toEqual([
      { sku: 'MCP12-PARENT', channel: 'AMAZON', market: 'IT', status: 'ACTIVE', draft: false, linked: true },
      { sku: 'MCP12-PARENT-S', channel: 'EBAY', market: 'DE', status: 'DRAFT', draft: true, linked: false },
      { sku: 'MCP12-PARENT', channel: 'EBAY', market: 'IT', status: 'DRAFT', draft: true, linked: true },
    ])
    expect(snap.listingCounts).toEqual({ total: 3, drafts: 2, linked: 2 })
    expect(snap).not.toHaveProperty('moreListings')
  })

  it('a product with no listing says so', async () => {
    const [id] = (await call('product-search', { query: 'MCP12-AXB' })).products.map((p: Data) => p.id)
    const snap = await call('product-snapshot', { productId: id })
    expect(snap).toMatchObject({ hasAmazon: false, hasEbay: false, listings: [], listingCounts: { total: 0, drafts: 0, linked: 0 } })
  })
})

describe('MCP.12 — listing-health says draft and linked, never "published" for a linked draft', () => {
  it('each listing of the product, with the honest pair', async () => {
    const health = await call('listing-health', { productId: ids.parent })
    const byMarket = Object.fromEntries((health.channels as Data[]).map((c) => [`${c.channel} ${c.marketplace}`, c]))
    expect(byMarket['AMAZON IT']).toMatchObject({ draft: false, linked: true })
    expect(byMarket['EBAY IT']).toMatchObject({ draft: true, linked: true })
    for (const c of health.channels as Data[]) expect(c).not.toHaveProperty('published')
  })
})

describe('MCP.12 — a deleted product is never a result', () => {
  it('product-search leaves it out, by SKU and by name', async () => {
    expect(await skus('A_B')).toEqual(['MCP12-A_B'])
    expect(await skus('deleted')).toEqual([])
    expect((await call('product-search', { limit: 50 })).products.map((p: Data) => p.sku)).not.toContain('MCP12-A_B-OLD')
  })

  it('product-snapshot answers "not found" for it', async () => {
    const out = (await callTool(everyone, 'product-snapshot', { productId: ids.deleted })).visible as { ok: boolean; error?: string }
    expect(out).toEqual({ ok: false, error: 'Product not found' })
  })
})
