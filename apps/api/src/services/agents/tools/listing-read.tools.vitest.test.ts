/**
 * MCP full control L2 — the listing reads, run through the one door (call-tool.ts) against a real PostgreSQL with the
 * production schema and business-isolation policies (PGlite). No mocked query.
 *
 * Proven here: listing-coordinates names every listing's exact destination (listing id, channel, market, account id and
 * label, alias, version, status, draft, published) and groups them into the destinations publish-review takes; no
 * channel id (the eBay item number) and no credential appears in any answer; an account of another business is never
 * named; listing-matrix is the Matrix page's own read, trimmed and paged; media-plan is the Media page's own read; and a
 * deleted product or another business's product is not found.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { callTool, type UserPrincipal } from '../call-tool.js'
import { getMatrixRead } from '../../pim/matrix.service.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_l2_other_business'
const ITEM_ID = 'TEST-ITEM-L2-0001'
const ALIAS_ITEM_ID = 'TEST-ITEM-L2-0002'
const SECRET = 'l2-secret-token-value'

const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)
const everything: UserPrincipal = {
  kind: 'user',
  userId: 'u-l2',
  label: 'L2 test',
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: business(A),
  via: 'claude',
}

type Json = Record<string, any>
async function call(tool: string, args: Record<string, unknown>): Promise<Json> {
  return (await callTool(everything, tool, args)).visible as Json
}

const ids = { parent: '', childA: '', childB: '', single: '', deleted: '', account: '', foreignAccount: '', alias: '', otherProduct: '' }
const listingIds: Record<string, string> = {}

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  const owner = await db.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active' } })
  await db.workspace.create({ data: { id: OTHER, name: 'L2 other business', createdByUserId: owner.id, creationKey: randomUUID() } })
  // The other business: its own account and product, which business A must never see or name.
  await inside(OTHER, async () => {
    ids.foreignAccount = (await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, accountLabel: 'OTHER-BUSINESS-SHOP' } })).id
    ids.otherProduct = (await db.product.create({ data: { sku: 'TEST-SKU-OTHER', name: 'Other business jacket', basePrice: '9.00' } })).id
  })
  await inside(A, async () => {
    for (const [channel, code] of [['EBAY', 'IT'], ['EBAY', 'DE']] as const) {
      await db.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } as never })
    }
    ids.account = (await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, isPrimary: true, accountLabel: 'Test shop one', accessToken: SECRET, externalAccountId: 'TEST-SELLER-ID' } })).id
    ids.parent = (await db.product.create({ data: { sku: 'TEST-SKU-1', name: 'Test jacket', basePrice: '50.00', isParent: true, variationAxes: ['Size'] } })).id
    ids.childA = (await db.product.create({ data: { sku: 'TEST-SKU-1-M', name: 'Test jacket M', basePrice: '50.00', parentId: ids.parent, variantAttributes: { Size: 'M' } } })).id
    ids.childB = (await db.product.create({ data: { sku: 'TEST-SKU-1-L', name: 'Test jacket L', basePrice: '55.00', parentId: ids.parent, variantAttributes: { Size: 'L' } } })).id
    ids.single = (await db.product.create({ data: { sku: 'TEST-SKU-2', name: 'Test gloves', basePrice: '20.00' } })).id
    ids.deleted = (await db.product.create({ data: { sku: 'TEST-SKU-GONE', name: 'Deleted', basePrice: '20.00', deletedAt: new Date() } })).id
    ids.alias = (await db.productListingAlias.create({ data: { productId: ids.parent, channel: 'EBAY', marketplace: 'IT', channelConnectionId: ids.account, label: 'Second listing', position: 1 } })).id
    const listing = (productId: string, data: Json) => db.channelListing.create({
      data: { productId, channel: 'EBAY', region: 'IT', marketplace: 'IT', channelMarket: 'EBAY_IT', channelConnectionId: ids.account, ...data } as never,
    })
    // The primary eBay IT listing: live, linked to its channel item.
    listingIds.parent = (await listing(ids.parent, { listingStatus: 'ACTIVE', isPublished: true, externalListingId: ITEM_ID, version: 3 })).id
    listingIds.childA = (await listing(ids.childA, { listingStatus: 'ACTIVE', isPublished: true, externalListingId: ITEM_ID, price: '51.00', quantity: 4, version: 2 })).id
    listingIds.childB = (await listing(ids.childB, { listingStatus: 'ACTIVE', isPublished: true, externalListingId: ITEM_ID, price: '56.00', quantity: 2 })).id
    // A second listing (alias) of the family on the same account and market.
    listingIds.aliasParent = (await listing(ids.parent, { aliasKey: ids.alias, aliasId: ids.alias, listingStatus: 'ACTIVE', isPublished: true, externalListingId: ALIAS_ITEM_ID })).id
    // A Nexus draft on eBay DE: never published, paused until Publish sends it.
    listingIds.draft = (await listing(ids.childA, { marketplace: 'DE', region: 'DE', channelMarket: 'EBAY_DE', listingStatus: 'DRAFT', isPublished: false, syncPaused: true })).id
    // A listing with no account recorded (the database refuses an account of another business outright).
    listingIds.foreign = (await listing(ids.single, { channelConnectionId: null, listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'TEST-ITEM-L2-0009' })).id
    await db.productImage.create({ data: { productId: ids.parent, url: 'https://images.example.test/l2/front.jpg', alt: 'Front', type: 'MAIN', width: 1600, height: 1600, isPrimary: true } })
    await db.productImage.create({ data: { productId: ids.childA, url: 'https://images.example.test/l2/back.jpg', alt: 'Back', type: 'ALT', width: 1600, height: 1600 } })
  })
}, 120_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

const noChannelIdsOrSecrets = (answer: unknown) => {
  const text = JSON.stringify(answer)
  for (const value of [ITEM_ID, ALIAS_ITEM_ID, 'TEST-ITEM-L2-0009', SECRET, 'TEST-SELLER-ID', 'OTHER-BUSINESS-SHOP']) expect(text).not.toContain(value)
}

describe('listing-coordinates', () => {
  it('names each listing of the family exactly, and groups them into the destinations publish-review takes', async () => {
    const answer = await call('listing-coordinates', { productId: ids.childB })
    expect(answer.ok).toBe(true)
    const { product, listings, destinations, accounts } = answer.data
    expect(product).toMatchObject({ id: ids.parent, sku: 'TEST-SKU-1', variations: 2 })
    expect(listings.map((l: Json) => l.listingId).sort()).toEqual([listingIds.parent, listingIds.childA, listingIds.childB, listingIds.aliasParent, listingIds.draft].sort())
    expect(listings.find((l: Json) => l.listingId === listingIds.childA)).toEqual({
      listingId: listingIds.childA, productId: ids.childA, sku: 'TEST-SKU-1-M', role: 'variant', channel: 'EBAY', market: 'IT',
      accountId: ids.account, accountLabel: 'Test shop one', alias: null, version: 2, status: 'ACTIVE', draft: false, published: true,
      linked: true, syncPaused: false, offerClosed: false, lastSync: null,
    })
    expect(listings.find((l: Json) => l.listingId === listingIds.draft)).toMatchObject({ market: 'DE', status: 'DRAFT', draft: true, published: false, linked: false, syncPaused: true })
    expect(listings.find((l: Json) => l.listingId === listingIds.aliasParent)).toMatchObject({ role: 'parent', alias: { id: ids.alias, label: 'Second listing', position: 1, archived: false } })
    expect(destinations).toEqual([
      { channel: 'EBAY', market: 'DE', accountId: ids.account, accountLabel: 'Test shop one', alias: null, listings: 1, drafts: 1, published: 0,
        reviewWith: { productId: ids.parent, channel: 'EBAY', market: 'DE', accountId: ids.account } },
      { channel: 'EBAY', market: 'IT', accountId: ids.account, accountLabel: 'Test shop one', alias: null, listings: 3, drafts: 0, published: 3,
        reviewWith: { productId: ids.parent, channel: 'EBAY', market: 'IT', accountId: ids.account } },
      // The alias destination is named by its listing (the parent's), as the studio names it.
      { channel: 'EBAY', market: 'IT', accountId: ids.account, accountLabel: 'Test shop one', alias: { id: ids.alias, label: 'Second listing', position: 1, archived: false },
        listings: 1, drafts: 0, published: 1, reviewWith: { productId: ids.parent, channel: 'EBAY', market: 'IT', accountId: ids.account, listingId: listingIds.aliasParent } },
    ])
    expect(accounts).toEqual([{ accountId: ids.account, channel: 'EBAY', label: 'Test shop one', active: true, primary: true }])
    noChannelIdsOrSecrets(answer)
  })

  it('narrows by channel and market', async () => {
    const answer = await call('listing-coordinates', { productId: ids.parent, channel: 'ebay', market: 'de' })
    expect(answer.data.listings.map((l: Json) => l.listingId)).toEqual([listingIds.draft])
    expect((await call('listing-coordinates', { productId: ids.parent, channel: 'AMAZON' })).data).toMatchObject({ listings: [], destinations: [], accounts: [] })
  })

  it('a listing with no account says so, and has no destination to review', async () => {
    const answer = await call('listing-coordinates', { productId: ids.single })
    expect(answer.data.listings).toEqual([expect.objectContaining({
      listingId: listingIds.foreign, role: 'single', accountId: null, accountLabel: null, accountNote: 'No account is recorded for this listing.',
    })])
    // No account: no destination to review.
    expect(answer.data.destinations[0].reviewWith).toBeNull()
    noChannelIdsOrSecrets(answer)
  })

  it('the other business\'s account is never listed', async () => {
    const answer = await call('listing-coordinates', { productId: ids.parent })
    expect(answer.data.accounts.map((a: Json) => a.accountId)).toEqual([ids.account])
    expect(JSON.stringify(answer)).not.toContain(ids.foreignAccount)
  })

  it('a deleted product and another business\'s product are not found', async () => {
    expect(await call('listing-coordinates', { productId: ids.deleted })).toEqual({ ok: false, error: 'Product not found' })
    expect(await call('listing-coordinates', { productId: ids.otherProduct })).toEqual({ ok: false, error: 'Product not found' })
  })
})

describe('listing-matrix', () => {
  it('is the Matrix page\'s own read, trimmed: coordinates, rows and cells by coordinate key, no channel id', async () => {
    const page = await inside(A, () => getMatrixRead({ productId: ids.parent, canEditPrice: true }))
    const answer = await call('listing-matrix', { productId: ids.childA })
    expect(answer.ok).toBe(true)
    const listedKeys = page.coordinates.filter((c) => c.cells.length > 0).map((c) => c.key)
    expect(answer.data.coordinates.map((c: Json) => c.key)).toEqual(listedKeys)
    expect(listedKeys).toEqual(expect.arrayContaining(['EBAY:IT', 'EBAY:DE', `EBAY:IT#${ids.alias}`]))
    expect(answer.data.rows.map((r: Json) => r.sku)).toEqual(page.rows.map((r) => r.sku))
    const row = answer.data.rows.find((r: Json) => r.rowId === ids.childA)
    const cell = page.rows.find((r) => r.id === ids.childA)!.cells['EBAY:IT']
    expect(row.cells['EBAY:IT']).toMatchObject({ listingId: listingIds.childA, version: 2, listing: { state: cell.listing!.state, linked: true },
      price: { value: cell.price!.value, currency: 'EUR', source: cell.price!.source }, sync: { kind: cell.sync!.kind, mode: cell.sync!.mode, held: 4 } })
    expect(answer.data.totalRows).toBe(3)
    expect(answer.data).not.toHaveProperty('nextOffset')
    noChannelIdsOrSecrets(answer)
  })

  it('pages rows with limit and offset, and narrows by market and SKU', async () => {
    const first = await call('listing-matrix', { productId: ids.parent, limit: 2 })
    expect(first.data.rows).toHaveLength(2)
    expect(first.data.nextOffset).toBe(2)
    const second = await call('listing-matrix', { productId: ids.parent, limit: 2, offset: 2 })
    expect(second.data.rows).toHaveLength(1)
    expect([...first.data.rows, ...second.data.rows].map((r: Json) => r.rowId)).toEqual((await call('listing-matrix', { productId: ids.parent })).data.rows.map((r: Json) => r.rowId))
    const de = await call('listing-matrix', { productId: ids.parent, market: 'DE', sku: 'test-sku-1-m' })
    expect(de.data.coordinates.map((c: Json) => c.key)).toEqual(['EBAY:DE'])
    expect(de.data.rows.map((r: Json) => r.sku)).toEqual(['TEST-SKU-1-M'])
    expect(Object.keys(de.data.rows[0].cells)).toEqual(['EBAY:DE'])
  })

  it('a deleted product and another business\'s product are not found', async () => {
    expect(await call('listing-matrix', { productId: ids.deleted })).toEqual({ ok: false, error: 'Product not found' })
    expect(await call('listing-matrix', { productId: ids.otherProduct })).toEqual({ ok: false, error: 'Product not found' })
  })
})

describe('media-plan', () => {
  it('is the Media page\'s own read, trimmed: the photo library and every destination', async () => {
    const answer = await call('media-plan', { productId: ids.childA })
    expect(answer.ok).toBe(true)
    expect(answer.data).toMatchObject({ productId: ids.parent, sku: 'TEST-SKU-1', onMediaPlan: false, photoCount: 2 })
    expect(answer.data.library.map((p: Json) => p.label).sort()).toEqual(['Back', 'Front'])
    expect(answer.data.library.find((p: Json) => p.label === 'Back')).toMatchObject({ ofVariation: ids.childA, url: 'https://images.example.test/l2/back.jpg', width: 1600 })
    const keys = answer.data.destinations.map((d: Json) => d.key)
    expect(answer.data.destinations.every((d: Json) => d.channel === 'EBAY' && d.accountLabel === 'Test shop one')).toBe(true)
    expect(keys.length).toBeGreaterThanOrEqual(2)
    expect(answer.data).not.toHaveProperty('layout')
    noChannelIdsOrSecrets(answer)
  })

  it('reads one destination\'s full layout by its key, and refuses an unknown key', async () => {
    const list = await call('media-plan', { productId: ids.parent })
    const target = list.data.destinations.find((d: Json) => d.market === 'IT' && !d.alias)
    const answer = await call('media-plan', { productId: ids.parent, destination: target.key })
    expect(answer.data.layout).toMatchObject({ key: target.key, checks: { errors: expect.any(Number), warnings: expect.any(Number), list: expect.any(Array) } })
    expect(await call('media-plan', { productId: ids.parent, destination: 'EBAY|NOWHERE' })).toMatchObject({ ok: false, error: expect.stringContaining('No destination') })
  })

  it('a deleted product and another business\'s product are not found', async () => {
    expect(await call('media-plan', { productId: ids.deleted })).toEqual({ ok: false, error: 'Product not found' })
    expect(await call('media-plan', { productId: ids.otherProduct })).toEqual({ ok: false, error: 'Product not found' })
  })
})
