/**
 * MCP full control I8 — channel-identity-check through the one door (call-tool.ts) on PGlite with the production schema;
 * the channel's live read (services/live-read, the publish review's read through the gateway) stood in, as real reads
 * need the deployed API's KMS-sealed logins.
 *
 * Proven: per listing coordinate of a family — held (eBay: Active, and the account's own seller), foreign (another
 * seller), unverifiable (no seller recorded for the account), ended, and not-readable with its reason (no account, no
 * channel id, a channel whose live read is not built); missing and extra SKUs; nothing is read for a listing that cannot
 * be; at most five coordinates a call; the hourly limit per business.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
const live = vi.hoisted(() => ({ reads: [] as Array<Record<string, unknown>>, answer: (_scope: any): any => null }))
vi.mock('../live-read/index.js', () => ({
  readLiveListing: vi.fn(async (productId: string, scope: any) => {
    live.reads.push({ productId, ...scope })
    return live.answer(scope)
  }),
}))

import { callTool, type UserPrincipal } from '../agents/call-tool.js'
import { __toolRateTest } from '../agents/tool-rate.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const who: UserPrincipal = { kind: 'user', userId: 'u-i8', label: 'I8', permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) }, workspace: business, via: 'claude' }
const ids: Record<string, string> = {}
type Json = Record<string, any>
const check = async (args: Json) => (await callTool(who, 'channel-identity-check', args)).visible as Json

const ebayXml = (status: string, seller: string | null) =>
  `<GetItemResponse><Item><ItemID>x</ItemID><SellingStatus><ListingStatus>${status}</ListingStatus></SellingStatus>${seller ? `<Seller><UserID>${seller}</UserID></Seller>` : ''}</Item></GetItemResponse>`
const read = (extra: Json = {}) => ({ readAt: '2026-10-02T03:00:00.000Z', source: 'ebay-trading-item', destination: {}, revision: 'r', content: {}, variations: null, errors: [], raw: null, cached: false, ...extra })

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    ids.ebayIt = (await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, externalAccountId: 'test-seller-a' } })).id
    ids.ebayDe = (await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, externalAccountId: null } })).id
    ids.amazon = (await db.channelConnection.create({ data: { channelType: 'AMAZON', isActive: true, externalAccountId: 'test-amazon' } })).id
    ids.shopify = (await db.channelConnection.create({ data: { channelType: 'SHOPIFY', isActive: true, externalAccountId: 'test-shop' } })).id
    const product = async (sku: string, extra: Json = {}) => { ids[sku] = (await db.product.create({ data: { sku, name: sku, basePrice: '10.00', ...extra } })).id }
    await product('CIC-ROOT', { isParent: true })
    await product('CIC-S', { parentId: ids['CIC-ROOT'] })
    const listing = (sku: string, channel: string, market: string, account: string | null, external: string | null) => db.channelListing.create({
      data: { productId: ids[sku], channel, marketplace: market, region: market, channelMarket: `${channel}_${market}`, listingStatus: 'ACTIVE', externalListingId: external, channelConnectionId: account },
    })
    await listing('CIC-ROOT', 'EBAY', 'IT', ids.ebayIt, '410000000001')
    await listing('CIC-S', 'EBAY', 'IT', ids.ebayIt, '410000000001')
    await listing('CIC-ROOT', 'EBAY', 'DE', ids.ebayDe, '410000000002')
    await listing('CIC-ROOT', 'AMAZON', 'DE', ids.amazon, 'B0CIC00001')
    await listing('CIC-ROOT', 'SHOPIFY', 'GLOBAL', ids.shopify, '5001')
    await listing('CIC-ROOT', 'EBAY', 'FR', null, '410000000003')
    await listing('CIC-ROOT', 'EBAY', 'ES', ids.ebayIt, null)
    await product('CIC-SOLO')
    await listing('CIC-SOLO', 'EBAY', 'IT', ids.ebayIt, '410000000009')
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

beforeEach(() => {
  live.reads.length = 0
  __toolRateTest.reset()
})

describe('I8 — channel-identity-check', () => {
  it('per listing: held, unverifiable, missing SKUs, and not-readable with its reason — reading only what can be read', async () => {
    live.answer = (scope) => scope.channel === 'EBAY' && scope.marketplace === 'IT' ? read({ raw: { xml: ebayXml('Active', 'TEST-SELLER-A') } })
      : scope.channel === 'EBAY' ? read({ raw: { xml: ebayXml('Active', 'test-seller-a') } })
      : scope.channel === 'AMAZON' ? read({ source: 'amazon-listings-item', variations: { axes: ['Size'], order: {}, variants: [
        { sku: 'CIC-S', values: {}, price: { state: 'absent' }, stock: { state: 'absent' }, state: 'missing' },
        { sku: 'STRANGER', values: {}, price: { state: 'absent' }, stock: { state: 'absent' }, state: 'extra' }] } })
      : read({ errors: [{ scope: 'item', reason: 'Reading live from Shopify comes with the Shopify publish step (P4.2).' }] })
    const out = await check({ productId: ids['CIC-S'], channel: 'ebay' })
    expect(out.ok, out.error).toBe(true)
    expect(out.data.family).toEqual({ rootProductId: ids['CIC-ROOT'], rootSku: 'CIC-ROOT' })
    const byMarket = Object.fromEntries((out.data.checks as Json[]).map((c) => [c.market, c]))
    expect(byMarket.IT).toMatchObject({ verdict: 'held', externalId: '410000000001', status: 'Active', seller: { onChannel: 'TEST-SELLER-A', account: 'test-seller-a' } })
    expect(byMarket.DE).toMatchObject({ verdict: 'unverifiable', reason: expect.stringMatching(/no recorded eBay seller/) })
    expect(byMarket.FR).toMatchObject({ verdict: 'not-readable', reason: expect.stringContaining('names no account') })
    expect(byMarket.ES).toMatchObject({ verdict: 'not-readable', reason: expect.stringContaining('no channel id') })
    expect(live.reads.map((r) => `${r.channel} ${r.marketplace}`).sort()).toEqual(['EBAY DE', 'EBAY IT'])
    expect(live.reads.every((r) => r.productId === ids['CIC-ROOT'])).toBe(true)

    const others = await check({ productId: ids['CIC-ROOT'], channel: 'AMAZON' })
    expect(others.data.checks).toEqual([expect.objectContaining({ verdict: 'held', skus: { live: 0, missing: ['CIC-S'], extra: ['STRANGER'] } })])
    const shop = await check({ productId: ids['CIC-ROOT'], channel: 'SHOPIFY' })
    expect(shop.data.checks).toEqual([expect.objectContaining({ verdict: 'not-readable', reason: expect.stringContaining('Shopify publish step') })])
  })

  it('another seller’s item is foreign; an ended item is ended', async () => {
    live.answer = () => read({ raw: { xml: ebayXml('Active', 'test-seller-b') } })
    expect((await check({ productId: ids['CIC-SOLO'] })).data.checks).toEqual([expect.objectContaining({ verdict: 'foreign', reason: expect.stringContaining('test-seller-b') })])
    live.answer = () => read({ raw: { xml: ebayXml('Completed', 'test-seller-a') } })
    expect((await check({ productId: ids['CIC-SOLO'] })).data.checks).toEqual([expect.objectContaining({ verdict: 'ended', reason: expect.stringContaining('"Completed"') })])
  })

  it('reads at most five listings a call and says how many it left; a deleted or unknown product is not found', async () => {
    live.answer = () => read({ raw: { xml: ebayXml('Active', 'test-seller-a') } })
    const out = await check({ productId: ids['CIC-ROOT'] })
    expect(out.data.checks).toHaveLength(5)
    expect(out.data.more).toMatch(/^1 more listing coordinates were not read/)
    expect(await check({ productId: 'no-such-product' })).toEqual({ ok: false, error: 'Product not found' })
  })

  it('is limited per business per hour', async () => {
    vi.stubEnv('NEXUS_IDENTITY_CHECK_PER_HOUR', '1')
    live.answer = () => read({ raw: { xml: ebayXml('Active', 'test-seller-a') } })
    expect((await check({ productId: ids['CIC-SOLO'] })).ok).toBe(true)
    expect(await check({ productId: ids['CIC-SOLO'] })).toMatchObject({ ok: false, error: expect.stringContaining('limited to 1 live checks per hour') })
    vi.unstubAllEnvs()
  })
})
