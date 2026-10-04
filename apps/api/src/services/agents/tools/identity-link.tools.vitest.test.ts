/**
 * MCP full control I9 — unlink-channel-id and link-channel-id through the gate (queued, approved, run, recorded, undone
 * through the same gate) on PGlite with the production schema and policies. The channel is stood in: eBay's GetItem (the
 * read goes through the gateway in callTradingApi) and the account token; Amazon's ASIN read (fillAmazonListingAsins).
 *
 * Proven: unlink snapshots every row first, clears the id on the family rows that share it, makes them paused drafts,
 * ends the item's shared eBay variations in Nexus and unlinks the held-id records — the preview names the quantity last
 * advertised; undo links it again only after eBay confirms the seller, the status and the SKUs, and the confirmed shared
 * variations live again while pushes stay paused; link refuses another seller's item, an item another family holds, an
 * unverifiable account without an explicit yes, a typed ASIN and a Shopify listing; Amazon's ASIN is read, never typed.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn(async () => []) } }))
const channel = vi.hoisted(() => ({ getItem: (_itemId: string): string => '', asin: null as null | { asin: string; sku: string }, token: async (_connectionId: string): Promise<string> => 'test-token' }))
vi.mock('../../ebay-trading-api.service.js', () => ({
  callTradingApi: async (_call: string, xml: string) => ({ ack: 'Success', raw: channel.getItem(/<ItemID>([^<]+)<\/ItemID>/.exec(xml)?.[1] ?? '') }),
  siteIdForMarket: () => 101,
  escapeXml: (s: string) => s,
  // outbound-sync.service binds these at load (bulk-edit → sheet-quantity-door → matrix-write → follow-master); this test
  // never revises eBay stock, so a call is a failure, not a silent no-op.
  reviseInventoryStatus: async () => { throw new Error('identity-link test: no eBay stock revise expected') },
  reviseInventoryStatusBatch: async () => { throw new Error('identity-link test: no eBay stock revise expected') },
  REVISE_INVENTORY_STATUS_MAX_ENTRIES: 4,
}))
vi.mock('../../ebay-auth.service.js', () => ({ EbayAuthService: class { async getValidToken(connectionId: string) { return channel.token(connectionId) } } }))
vi.mock('../../amazon/listing-asin-fill.service.js', () => ({
  fillAmazonListingAsins: async (ids: string[], options: { dryRun?: boolean } = {}) => {
    const row = channel.asin
      ? { id: ids[0], sku: channel.asin.sku, marketplace: 'DE', outcome: 'filled', asin: channel.asin.asin }
      : { id: ids[0], sku: null, marketplace: 'DE', outcome: 'not_visible_yet', reason: 'Amazon has not made this listing visible yet.' }
    if (!options.dryRun && channel.asin) {
      await database.client.channelListing.update({ where: { id: ids[0] }, data: { externalListingId: channel.asin.asin } })
    }
    return { dryRun: !!options.dryRun, rows: [row], counts: {} }
  },
}))

import { runOrQueueTool } from '../approval-gate.service.js'
import { callTool, type UserPrincipal } from '../call-tool.js'
import { commitScheduledApproval, scheduleApproval } from '../../agent-fleet/approval-inbox.service.js'

const A = LEGACY_WORKSPACE_ID
const B = 'i9_identity_link_bravo'
const TIMEOUT = 30_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids: Record<string, string> = {}
const ALL = (): UserPrincipal => ({ kind: 'user', userId: ids.approver, label: 'Lia Link', permissions: { isOwner: false, permissions: EVERYTHING }, workspace: business(A), via: 'app' })
const db = () => database.client
type Data = Record<string, any>

const ITEM = '510000000001'
const getItem = (status: string, seller: string | null, skus: string[]) => `<GetItemResponse><Ack>Success</Ack><Item><ItemID>${ITEM}</ItemID><Title>Test</Title>`
  + `<SellingStatus><ListingStatus>${status}</ListingStatus></SellingStatus>${seller ? `<Seller><UserID>${seller}</UserID></Seller>` : ''}`
  + `<Variations>${skus.map((s) => `<Variation><SKU>${s}</SKU><Quantity>1</Quantity></Variation>`).join('')}</Variations></Item></GetItemResponse>`

async function ask(tool: string, args: Record<string, unknown>) {
  const run = await inside(() => db().agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'running', userId: ids.approver, via: 'app' } }))
  return inside(() => runOrQueueTool(tool, args, ALL(), run.id, { forceAsk: true })) as Promise<Data>
}
async function approveAndRun(approvalId: string) {
  const parked = await inside(() => scheduleApproval({ id: approvalId, actor: ALL() }))
  expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId)) as Promise<Data>
}
async function askAndRun(tool: string, args: Record<string, unknown>) {
  const queued = await ask(tool, args)
  expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
  const ran = await approveAndRun(queued.approvalId)
  expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
  return queued.approvalId as string
}
const preview = async (tool: string, args: Record<string, unknown>) => (await callTool(ALL(), tool, args)).visible as Data
const rowsOf = (sku: string) => inside(() => db().channelListing.findMany({ where: { product: { sku } }, orderBy: { id: 'asc' } }))

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const client = database.client
  const role = await client.role.create({ data: { key: `I9_${randomUUID().slice(0, 8)}`, name: 'Link tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  const approver = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Lia Link' } })
  ids.approver = approver.id
  await client.userRole.create({ data: { userId: approver.id, roleId: role.id } })
  await client.workspace.create({ data: { id: B, name: 'Bravo link business', createdByUserId: approver.id, creationKey: randomUUID() } })
  for (const workspaceId of [A, B]) {
    const membership = await client.workspaceMembership.create({ data: { workspaceId, userId: approver.id, status: 'active' } })
    await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  }
  await inside(async () => {
    ids.ebay = (await client.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, externalAccountId: 'test-seller-a' } })).id
    ids.ebayOld = (await client.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, externalAccountId: null } })).id
    ids.amazon = (await client.channelConnection.create({ data: { channelType: 'AMAZON', isActive: true, externalAccountId: 'test-amazon' } })).id
    ids.shopify = (await client.channelConnection.create({ data: { channelType: 'SHOPIFY', isActive: true, externalAccountId: 'test-shop' } })).id
    const make = async (sku: string, extra: Data = {}) => { ids[sku] = (await client.product.create({ data: { sku, name: sku, basePrice: '10.00', ...extra } })).id }
    const list = async (key: string, sku: string, ch: string, market: string, account: string, external: string | null, extra: Data = {}) => {
      ids[key] = (await client.channelListing.create({ data: { productId: ids[sku], channel: ch, marketplace: market, region: market, channelMarket: `${ch}_${market}`, listingStatus: 'ACTIVE', isPublished: true, externalListingId: external, channelConnectionId: account, quantity: 3, ...extra } })).id
    }
    await make('LNK-ROOT', { isParent: true })
    await make('LNK-S', { parentId: ids['LNK-ROOT'] })
    await list('rootIt', 'LNK-ROOT', 'EBAY', 'IT', ids.ebay, ITEM)
    await list('childIt', 'LNK-S', 'EBAY', 'IT', ids.ebay, ITEM)
    await client.sharedListingMembership.create({ data: { marketplace: 'IT', sku: 'LNK-S', itemId: ITEM, parentSku: 'LNK-ROOT', productId: ids['LNK-S'], variationSpecifics: {}, channelConnectionId: ids.ebay } })
    await client.channelHeldId.create({ data: { channel: 'EBAY', channelConnectionId: ids.ebay, marketplace: 'IT', externalId: ITEM, sellerSku: 'LNK-S', listingId: ids.childIt, matchState: 'LINKED' } })
    await make('LNK-OTHER')
    await list('otherIt', 'LNK-OTHER', 'EBAY', 'IT', ids.ebay, '510000000099')
    await make('LNK-OLD')
    await list('oldDe', 'LNK-OLD', 'EBAY', 'DE', ids.ebayOld, null, { listingStatus: 'DRAFT' })
    await make('LNK-AMZ')
    await list('amz', 'LNK-AMZ', 'AMAZON', 'DE', ids.amazon, null, { listingStatus: 'DRAFT' })
    await make('LNK-SHOP')
    await list('shop', 'LNK-SHOP', 'SHOPIFY', 'GLOBAL', ids.shopify, '7001')
  })
  await inside(async () => { ids.bravo = (await client.product.create({ data: { sku: 'LNK-ROOT', name: 'Bravo', basePrice: '1.00' } })).id }, B)
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

beforeEach(() => {
  channel.getItem = () => getItem('Active', 'test-seller-a', ['LNK-S'])
  channel.asin = null
  channel.token = async () => 'test-token'
})

describe('I9 — unlink-channel-id, then undo (link again, verified on eBay)', () => {
  it('previews the family rows, the quantity last advertised and the risk; writes nothing', async () => {
    const out = await preview('unlink-channel-id', { listingId: ids.childIt })
    expect(out.preview).toMatchObject({
      externalId: ITEM, changes: { 'channel id': { from: ITEM, to: null } }, liveQuantity: 6, sharedVariations: 1,
      listings: ['LNK-ROOT (ACTIVE, 3 advertised)', 'LNK-S (ACTIVE, 3 advertised)'], risk: expect.stringContaining('can oversell'),
    })
    expect((await rowsOf('LNK-S'))[0].externalListingId).toBe(ITEM)
  }, TIMEOUT)

  it('runs: snapshots first, rows become paused drafts with no id, shared variation ended, held id unlinked; undo links it again', async () => {
    const approvalId = await askAndRun('unlink-channel-id', { listingId: ids.childIt })
    for (const sku of ['LNK-ROOT', 'LNK-S']) {
      expect((await rowsOf(sku)).map((r) => [r.externalListingId, r.listingStatus, r.isPublished, r.syncPaused])).toEqual([[null, 'DRAFT', false, true]])
    }
    expect(await inside(() => db().channelListingSnapshot.count({ where: { channelListingId: { in: [ids.rootIt, ids.childIt] } } }))).toBe(2)
    expect((await inside(() => db().sharedListingMembership.findFirstOrThrow({ where: { itemId: ITEM } }))).status).toBe('ENDED')
    expect(await inside(() => db().channelHeldId.findFirstOrThrow({ where: { externalId: ITEM } }))).toMatchObject({ listingId: null, matchState: 'UNLINKED' })

    const change = await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))
    const asked = await ask('undo-change', { changeId: change.id })
    expect(asked, asked.error).toMatchObject({ ok: true, mode: 'queued' })
    expect(asked.preview).toMatchObject({ action: 'link-channel-id', verdict: 'verified', seller: { item: 'test-seller-a', account: 'test-seller-a' }, changes: { 'channel id': { from: null, to: ITEM } } })
    expect(await approveAndRun(asked.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    for (const sku of ['LNK-ROOT', 'LNK-S']) {
      expect((await rowsOf(sku)).map((r) => [r.externalListingId, r.listingStatus, r.isPublished, r.syncPaused])).toEqual([[ITEM, 'ACTIVE', true, true]])
    }
    expect((await inside(() => db().sharedListingMembership.findFirstOrThrow({ where: { itemId: ITEM } }))).status).toBe('ACTIVE')
  }, TIMEOUT)

  it('an id changed after the approval was asked for makes it stale: nothing runs', async () => {
    const queued = await ask('unlink-channel-id', { listingId: ids.otherIt })
    await inside(() => db().channelListing.update({ where: { id: ids.otherIt }, data: { externalListingId: '510000000098' } }))
    const ran = await approveAndRun(queued.approvalId).catch((error) => ({ ok: false, error: String(error) }))
    expect(ran.ok).toBe(false)
    expect((await rowsOf('LNK-OTHER'))[0].externalListingId).toBe('510000000098')
  }, TIMEOUT)

  it('an unknown listing is not found; a listing with no id has nothing to unlink', async () => {
    expect(await preview('unlink-channel-id', { listingId: 'no-such-listing' })).toEqual({ ok: false, error: 'Listing not found' })
    expect(await preview('unlink-channel-id', { listingId: ids.amz })).toMatchObject({ ok: false, error: expect.stringContaining('carries no channel id') })
  }, TIMEOUT)
})

describe('I9 — link-channel-id refuses what the channel does not prove', () => {
  it('another seller’s item, an item another family holds, an ended item', async () => {
    channel.getItem = () => getItem('Active', 'test-seller-b', ['LNK-S'])
    await askAndRun('unlink-channel-id', { listingId: ids.rootIt })
    expect(await preview('link-channel-id', { listingId: ids.rootIt, externalId: ITEM })).toMatchObject({ ok: false, error: expect.stringContaining('listed by eBay seller "test-seller-b"') })
    channel.getItem = () => getItem('Active', 'test-seller-a', ['LNK-S'])
    expect(await preview('link-channel-id', { listingId: ids.rootIt, externalId: '510000000098' })).toMatchObject({ ok: false, error: expect.stringContaining('already linked to another product') })
    channel.getItem = () => getItem('Completed', 'test-seller-a', ['LNK-S'])
    expect(await preview('link-channel-id', { listingId: ids.rootIt, externalId: ITEM })).toMatchObject({ ok: false, error: expect.stringContaining('not Active') })
  }, TIMEOUT)

  it('an account with no recorded seller: refused unless the person says yes explicitly', async () => {
    channel.getItem = () => getItem('Active', 'test-seller-a', [])
    await inside(() => db().sharedListingMembership.create({ data: { marketplace: 'DE', sku: 'LNK-OLD', itemId: ITEM, parentSku: 'LNK-OLD', variationSpecifics: {} } }))
    channel.getItem = () => `<GetItemResponse><Ack>Success</Ack><Item><ItemID>${ITEM}</ItemID><SKU>LNK-OLD</SKU><SellingStatus><ListingStatus>Active</ListingStatus></SellingStatus><Seller><UserID>test-seller-a</UserID></Seller></Item></GetItemResponse>`
    expect(await preview('link-channel-id', { listingId: ids.oldDe, externalId: ITEM })).toMatchObject({ ok: false, error: expect.stringContaining('acknowledgeUnverifiable') })
    expect((await preview('link-channel-id', { listingId: ids.oldDe, externalId: ITEM, acknowledgeUnverifiable: true })).preview).toMatchObject({ verdict: 'unverifiable' })
  }, TIMEOUT)

  it('an account with no credentials: refused with a plain reason, never an error, and eBay is not asked', async () => {
    let asked = 0
    channel.getItem = () => { asked++; return getItem('Active', 'test-seller-a', ['LNK-OLD']) }
    channel.token = async (connectionId) => { throw new Error(`Connection ${connectionId} has no credentials — reconnect the account.`) }
    const out = await preview('link-channel-id', { listingId: ids.oldDe, externalId: ITEM })
    expect(out).toEqual({ ok: false, error: expect.stringContaining('has no working sign-in in Nexus') })
    expect(out.error).not.toContain(ids.ebayOld)
    expect(asked).toBe(0)
  }, TIMEOUT)

  it('Amazon: the ASIN is read from Amazon, never typed; Shopify links in its own flow', async () => {
    expect(await preview('link-channel-id', { listingId: ids.amz, externalId: 'B0TYPED001' })).toMatchObject({ ok: false, error: expect.stringContaining('an ASIN is never typed') })
    expect(await preview('link-channel-id', { listingId: ids.amz })).toMatchObject({ ok: false, error: expect.stringContaining('Amazon gave no ASIN') })
    channel.asin = { asin: 'B0LNKAMZ01', sku: 'LNK-AMZ' }
    expect((await preview('link-channel-id', { listingId: ids.amz })).preview).toMatchObject({ externalId: 'B0LNKAMZ01', proof: 'Amazon holds seller SKU LNK-AMZ as B0LNKAMZ01.' })
    await askAndRun('link-channel-id', { listingId: ids.amz })
    expect((await rowsOf('LNK-AMZ'))[0].externalListingId).toBe('B0LNKAMZ01')
    expect(await preview('link-channel-id', { listingId: ids.shop, externalId: '7002' })).toMatchObject({ ok: false, error: expect.stringContaining('colour products') })
  }, TIMEOUT)
})
