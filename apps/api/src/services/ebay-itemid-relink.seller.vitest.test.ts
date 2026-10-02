/**
 * MCP full control I4 / G2 — an eBay Item ID re-link proves the item is listed by the seller behind the account,
 * not only that its SKUs are the family's. Two businesses that share stock by SKU carry the same SKUs, so before this
 * a re-link accepted another seller's live item (section 04 §1.5 G2).
 *
 * The relink service runs for real against PGlite (production schema and policies); only eBay's GetItem answer is
 * stood in (the read itself goes through the channel gateway in callTradingApi).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
const getItem = vi.fn()
vi.mock('./ebay-trading-api.service.js', () => ({
  callTradingApi: (...args: unknown[]) => getItem(...args),
  siteIdForMarket: () => 101,
  escapeXml: (s: string) => s,
}))

import { relinkEbayItemId } from './ebay-itemid-relink.service.js'

const A = LEGACY_WORKSPACE_ID
const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const NEW_ITEM = '120000000001'
const accounts = { known: '', unknown: '' }

const answer = (seller: string | null) => ({
  ack: 'Success',
  raw: `<GetItemResponse><Item><ItemID>${NEW_ITEM}</ItemID><Title>Test jacket</Title>`
    + '<SellingStatus><ListingStatus>Active</ListingStatus></SellingStatus>'
    + (seller ? `<Seller><UserID>${seller}</UserID></Seller>` : '')
    + '<Variations><Variation><SKU>REL-S</SKU><Quantity>2</Quantity></Variation><Variation><SKU>REL-M</SKU><Quantity>1</Quantity></Variation></Variations>'
    + '</Item></GetItemResponse>',
})

const relink = (connectionId: string, extra: { apply?: boolean; acknowledgeUnverifiable?: boolean } = {}) =>
  inside(() => relinkEbayItemId(database.client as never, { parentSku: 'REL-ROOT', marketplace: 'IT', itemId: NEW_ITEM, ...extra }, { oauthToken: 'test-token', connectionId }))
const storedItemId = () => inside(async () => (await database.client.channelListing.findFirstOrThrow({ where: { product: { sku: 'REL-ROOT' }, channel: 'EBAY' } })).externalListingId)
const reset = () => inside(() => database.client.channelListing.updateMany({ where: { channel: 'EBAY' }, data: { externalListingId: '110000000009', listingStatus: 'DRAFT' } }))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    accounts.known = (await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, externalAccountId: 'test-seller-a' } })).id
    accounts.unknown = (await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, externalAccountId: null } })).id
    const root = await db.product.create({ data: { sku: 'REL-ROOT', name: 'Relink jacket', basePrice: '10.00', isParent: true } })
    for (const sku of ['REL-S', 'REL-M']) await db.product.create({ data: { sku, name: sku, basePrice: '10.00', parentId: root.id } })
    await db.channelListing.create({
      data: { productId: root.id, channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT', listingStatus: 'DRAFT', externalListingId: '110000000009', channelConnectionId: accounts.known },
    })
  })
}, 120_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

beforeEach(async () => {
  getItem.mockReset()
  await reset()
})

describe('I4 / G2 — the re-link asks eBay who lists the item', () => {
  it('asks GetItem for Item.Seller.UserID', async () => {
    getItem.mockResolvedValue(answer('test-seller-a'))
    await relink(accounts.known)
    expect(getItem).toHaveBeenCalledTimes(1)
    expect(String(getItem.mock.calls[0][1])).toContain('<OutputSelector>Item.Seller.UserID</OutputSelector>')
  })

  it("the account's own seller and the family's SKUs: verified, and written", async () => {
    getItem.mockResolvedValue(answer('TEST-SELLER-A'))
    const result = await relink(accounts.known, { apply: true })
    expect(result).toMatchObject({ verdict: 'verified', applied: true, seller: { item: 'TEST-SELLER-A', account: 'test-seller-a' } })
    expect(await storedItemId()).toBe(NEW_ITEM)
  })

  it("another seller's item with the family's SKUs (the same SKUs in two businesses): rejected, nothing written", async () => {
    getItem.mockResolvedValue(answer('test-seller-b'))
    const result = await relink(accounts.known, { apply: true, acknowledgeUnverifiable: true })
    expect(result).toMatchObject({ verdict: 'rejected', applied: false, seller: { item: 'test-seller-b', account: 'test-seller-a' } })
    expect(result.reason).toContain('test-seller-b')
    expect(await storedItemId()).toBe('110000000009')
  })

  it('an account with no recorded seller: unverifiable, written only with an explicit yes', async () => {
    getItem.mockResolvedValue(answer('test-seller-a'))
    const refused = await relink(accounts.unknown, { apply: true })
    expect(refused).toMatchObject({ verdict: 'unverifiable', applied: false })
    expect(refused.reason).toMatch(/no recorded eBay seller/)
    expect(refused.reason).toContain('acknowledgeUnverifiable')
    expect(await storedItemId()).toBe('110000000009')
    const confirmed = await relink(accounts.unknown, { apply: true, acknowledgeUnverifiable: true })
    expect(confirmed).toMatchObject({ verdict: 'unverifiable', applied: true })
    expect(await storedItemId()).toBe(NEW_ITEM)
  })

  it('eBay names no seller: unverifiable, not verified', async () => {
    getItem.mockResolvedValue(answer(null))
    const result = await relink(accounts.known, { apply: true })
    expect(result).toMatchObject({ verdict: 'unverifiable', applied: false })
    expect(await storedItemId()).toBe('110000000009')
  })
})
