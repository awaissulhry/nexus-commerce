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
 * Item ID control (2026-10-05, the sheet's rule too): an item eBay reports as ended links as ENDED (Relist is offered).
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

// Etsy's account reader, Shopify's read-only admin reader and Amazon's catalog read (Item ID control, I2–I4): stood in.
const doors = vi.hoisted(() => ({
  etsy: new Map<string, { shop: string; state: string; skus: string[] }>(),
  shopify: new Map<string, { status: string; variants: Array<{ id: string; sku: string; item: string }> }>(),
  catalog: new Set<string>(),
}))
vi.mock('../../etsy/read-client.js', () => ({
  EtsyReadError: class extends Error {},
  etsyReader: async () => ({ shopId: '555', get: async (path: string) => {
    const listing = doors.etsy.get(/\/listings\/(\d+)/.exec(path)?.[1] ?? '')
    if (!listing) throw Object.assign(new Error('Etsy could not read this resource (HTTP 404).'), { status: 404 })
    return path.endsWith('/inventory') ? { products: listing.skus.map((sku) => ({ sku })) } : { shop_id: Number(listing.shop), state: listing.state, title: 'Etsy jacket' }
  } }),
}))
vi.mock('../../shopify/admin-client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../shopify/admin-client.js')>(),
  shopifyAdminReader: async () => ({ domain: 'link-test.myshopify.com', grantedScopes: [], read: async (_query: string, variables: Record<string, unknown> = {}) => {
    const id = String(variables.id ?? '').split('/').at(-1)!
    const product = doors.shopify.get(id)
    return { errors: [], cost: null, data: { locations: { nodes: [{ id: 'gid://shopify/Location/1', isActive: true }] }, product: product ? { id: `gid://shopify/Product/${id}`, title: 'Shop jacket', status: product.status, identity: null,
      variants: { nodes: product.variants.map((v) => ({ id: `gid://shopify/ProductVariant/${v.id}`, sku: v.sku, inventoryItem: { id: `gid://shopify/InventoryItem/${v.item}` } })), pageInfo: { hasNextPage: false } } } : null } }
  } }),
}))
vi.mock('../../identity/channel-id-proofs/amazon-catalog.js', () => ({
  readAmazonCatalog: async (_accountId: string, asin: string, market: string) => (doors.catalog.has(`${market}:${asin}`) ? { found: true, title: 'Catalog jacket' } : { found: false }),
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
    // Etsy (I2): a family whose S sends its own Etsy SKU.
    ids.etsy = (await client.channelConnection.create({ data: { channelType: 'ETSY', isActive: true, externalAccountId: '555' } })).id
    await make('LNK-ETY', { isParent: true })
    await make('LNK-ETY-S', { parentId: ids['LNK-ETY'] })
    await list('etyRoot', 'LNK-ETY', 'ETSY', 'GLOBAL', ids.etsy, null, { listingStatus: 'DRAFT', isPublished: false })
    await list('etyS', 'LNK-ETY-S', 'ETSY', 'GLOBAL', ids.etsy, null, { listingStatus: 'DRAFT', isPublished: false, channelSku: 'OWN-LNK-ETY-S' })
    // Shopify (I3): one product per family.
    await make('LNK-SHF', { isParent: true })
    await make('LNK-SHF-S', { parentId: ids['LNK-SHF'] })
    await list('shfRoot', 'LNK-SHF', 'SHOPIFY', 'GLOBAL', ids.shopify, null, { listingStatus: 'DRAFT', isPublished: false })
    await list('shfS', 'LNK-SHF-S', 'SHOPIFY', 'GLOBAL', ids.shopify, null, { listingStatus: 'DRAFT', isPublished: false })
  })
  await inside(async () => { ids.bravo = (await client.product.create({ data: { sku: 'LNK-ROOT', name: 'Bravo', basePrice: '1.00' } })).id }, B)
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

beforeEach(() => {
  doors.etsy.clear(); doors.shopify.clear(); doors.catalog.clear()
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
  it('another seller’s item, an item another family holds, an item neither Active nor Ended', async () => {
    channel.getItem = () => getItem('Active', 'test-seller-b', ['LNK-S'])
    await askAndRun('unlink-channel-id', { listingId: ids.rootIt })
    expect(await preview('link-channel-id', { listingId: ids.rootIt, externalId: ITEM })).toMatchObject({ ok: false, error: expect.stringContaining('listed by eBay seller "test-seller-b"') })
    channel.getItem = () => getItem('Active', 'test-seller-a', ['LNK-S'])
    expect(await preview('link-channel-id', { listingId: ids.rootIt, externalId: '510000000098' })).toMatchObject({ ok: false, error: expect.stringContaining('already linked to another product') })
    channel.getItem = () => getItem('Custom', 'test-seller-a', ['LNK-S'])
    expect(await preview('link-channel-id', { listingId: ids.rootIt, externalId: ITEM })).toMatchObject({ ok: false, error: expect.stringContaining('not Active') })
  }, TIMEOUT)

  it('an ended item (the sheet\'s rule too): previewed as Ended with Relist offered, on the rows the item carries', async () => {
    channel.getItem = () => getItem('Completed', 'test-seller-a', ['LNK-S'])
    const out = await preview('link-channel-id', { listingId: ids.rootIt, externalId: ITEM })
    expect(out.preview).toMatchObject({ verdict: 'verified', listings: ['LNK-ROOT', 'LNK-S'], effect: expect.stringContaining('they read Ended (Relist is offered) in Nexus and stay paused') })
  }, TIMEOUT)

  it('Owner option A, one rule with the sheet: a variation holding another item moves only when eBay shows its SKU on the item — the preview lists it', async () => {
    const NEW = '510000000088'
    const mv = await inside(async () => {
      const client = db()
      const root = await client.product.create({ data: { sku: 'LNK-MV', name: 'LNK-MV', basePrice: '10.00', isParent: true } })
      const s = await client.product.create({ data: { sku: 'LNK-MV-S', name: 'LNK-MV-S', basePrice: '10.00', parentId: root.id } })
      const m = await client.product.create({ data: { sku: 'LNK-MV-M', name: 'LNK-MV-M', basePrice: '10.00', parentId: root.id } })
      const list = async (productId: string, external: string | null, status: string) => (await client.channelListing.create({ data: {
        productId, channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT', listingStatus: status, isPublished: status !== 'DRAFT',
        externalListingId: external, channelConnectionId: ids.ebay, quantity: 1 } })).id
      return { root: await list(root.id, null, 'DRAFT'), s: await list(s.id, null, 'DRAFT'), m: await list(m.id, '510000000077', 'ACTIVE') }
    })
    const moves = 'LNK-MV-M holds item 510000000077; eBay shows its SKU LNK-MV-M on item 510000000088; Link moves it to 510000000088.'
    channel.getItem = () => getItem('Active', 'test-seller-a', ['LNK-MV-S'])
    const kept = await preview('link-channel-id', { listingId: mv.root, externalId: NEW })
    expect(kept.preview).toMatchObject({ keptOtherItem: ['LNK-MV-M holds item 510000000077; eBay does not show its SKU on item 510000000088, so Link leaves it as it is.'] })
    expect(kept.preview.movesFromOtherItem).toBeUndefined()
    expect([...kept.preview.listings].sort()).toEqual(['LNK-MV', 'LNK-MV-S'])
    channel.getItem = () => getItem('Active', 'test-seller-a', ['LNK-MV-S', 'LNK-MV-M'])
    const moved = await preview('link-channel-id', { listingId: mv.root, externalId: NEW })
    expect(moved.preview).toMatchObject({ movesFromOtherItem: [moves], effect: expect.stringContaining('moving 1 of them from another item') })
    expect([...moved.preview.listings].sort()).toEqual(['LNK-MV', 'LNK-MV-M', 'LNK-MV-S'])
    await askAndRun('link-channel-id', { listingId: mv.root, externalId: NEW })
    const m = await inside(() => db().channelListing.findUniqueOrThrow({ where: { id: mv.m } }))
    expect([m.externalListingId, m.listingStatus, m.syncPaused]).toEqual([NEW, 'ACTIVE', true])
    expect(await inside(() => db().channelListingSnapshot.count({ where: { channelListingId: mv.m, label: `before link-channel-id (${NEW})` } }))).toBe(1)
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

  it('Amazon, one rule with the sheet\'s ASIN cell: a typed ASIN on a draft is the ASIN it lists on at Publish; the live ASIN is read; a live offer refuses a typed one', async () => {
    expect(await preview('link-channel-id', { listingId: ids.amz, externalId: 'B0TYPED001' })).toMatchObject({ ok: false, error: expect.stringContaining('Amazon has no ASIN B0TYPED001 on Amazon · DE') })
    doors.catalog.add('DE:B0TYPED001')
    expect((await preview('link-channel-id', { listingId: ids.amz, externalId: 'B0TYPED001' })).preview).toMatchObject({ externalId: 'B0TYPED001',
      changes: { 'channel id': { from: null, to: 'B0TYPED001' } }, effect: 'Sets ASIN B0TYPED001 as the ASIN seller SKU LNK-AMZ lists on at Publish (Amazon DE); nothing is sent to Amazon now.' })
    await askAndRun('link-channel-id', { listingId: ids.amz, externalId: 'B0TYPED001' })
    expect((await rowsOf('LNK-AMZ'))[0]).toMatchObject({ externalListingId: null, overrideData: { merchant_suggested_asin: 'B0TYPED001' } })
    expect(await preview('link-channel-id', { listingId: ids.amz })).toMatchObject({ ok: false, error: expect.stringContaining('Amazon gave no ASIN') })
    channel.asin = { asin: 'B0LNKAMZ01', sku: 'LNK-AMZ' }
    expect((await preview('link-channel-id', { listingId: ids.amz })).preview).toMatchObject({ externalId: 'B0LNKAMZ01', proof: 'Amazon holds seller SKU LNK-AMZ as B0LNKAMZ01.' })
    await askAndRun('link-channel-id', { listingId: ids.amz })
    expect((await rowsOf('LNK-AMZ'))[0].externalListingId).toBe('B0LNKAMZ01')
    expect(await preview('link-channel-id', { listingId: ids.amz, externalId: 'B0TYPED001' })).toMatchObject({ ok: false,
      error: expect.stringContaining('Amazon ties seller SKU LNK-AMZ to ASIN B0LNKAMZ01 on Amazon · DE. To use another ASIN: Delete (Status), set the ASIN here, Publish') })
  }, TIMEOUT)

  it('Amazon unlink, one rule with the sheet\'s Clear: a live ASIN is refused at preview with the sheet\'s sentence; a draft loses only its ASIN for Publish; undo sets it again', async () => {
    // The live offer (linked above): refused before any approval, in the sheet's words; nothing is queued or changed.
    const LIVE = 'Amazon ties seller SKU LNK-AMZ to ASIN B0LNKAMZ01 on Amazon · DE. To use another ASIN: Delete (Status), set the ASIN here, Publish — or give this listing a new SKU, which lists as a new offer.'
    const approvals = () => inside(() => db().agentApproval.count({ where: { toolName: 'unlink-channel-id' } }))
    const queuedBefore = await approvals()
    expect(await preview('unlink-channel-id', { listingId: ids.amz })).toEqual({ ok: false, error: `${LIVE} Nothing was queued.` })
    expect(await ask('unlink-channel-id', { listingId: ids.amz })).toMatchObject({ ok: false, error: expect.stringContaining(LIVE) })
    expect((await rowsOf('LNK-AMZ'))[0]).toMatchObject({ externalListingId: 'B0LNKAMZ01' })
    expect(await approvals()).toBe(queuedBefore)

    // A still-draft row with an ASIN set for Publish: the unlink removes only that ASIN (a plain preview, then approval).
    const draft = await inside(async () => {
      const product = await db().product.create({ data: { sku: 'LNK-AMZ-DRAFT', name: 'LNK-AMZ-DRAFT', basePrice: '10.00' } })
      return (await db().channelListing.create({ data: { productId: product.id, channel: 'AMAZON', marketplace: 'DE', region: 'DE', channelMarket: 'AMAZON_DE', channelConnectionId: ids.amazon,
        listingStatus: 'DRAFT', isPublished: false, externalListingId: null, syncPaused: true, overrideData: { merchant_suggested_asin: 'B0DRAFT001' } } })).id
    })
    const out = await preview('unlink-channel-id', { listingId: draft })
    expect(out.preview).toMatchObject({ suggested: true, externalId: 'B0DRAFT001', changes: { 'ASIN at Publish': { from: 'B0DRAFT001', to: null } },
      effect: 'Removes ASIN B0DRAFT001 as the ASIN seller SKU LNK-AMZ-DRAFT lists on at Publish (Amazon DE). The row stays a draft; nothing changes on Amazon.' })
    const approvalId = await askAndRun('unlink-channel-id', { listingId: draft })
    const row = (await rowsOf('LNK-AMZ-DRAFT'))[0]
    expect(row).toMatchObject({ externalListingId: null, listingStatus: 'DRAFT', isPublished: false })
    expect(row.overrideData ?? {}).not.toHaveProperty('merchant_suggested_asin')
    // Not an unlink of a channel item: no snapshot, no "Not listed" record.
    expect(await inside(() => db().channelListingSnapshot.count({ where: { channelListingId: draft } }))).toBe(0)
    doors.catalog.add('DE:B0DRAFT001')
    const change = await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))
    const asked = await ask('undo-change', { changeId: change.id })
    expect(asked, asked.error).toMatchObject({ ok: true, mode: 'queued', preview: { action: 'link-channel-id', externalId: 'B0DRAFT001' } })
    expect(await approveAndRun(asked.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect((await rowsOf('LNK-AMZ-DRAFT'))[0]).toMatchObject({ externalListingId: null, overrideData: { merchant_suggested_asin: 'B0DRAFT001' } })
  }, TIMEOUT)

  it('Shopify (I3): a product of this store is proven variant by variant; another store\'s product is refused', async () => {
    expect(await preview('link-channel-id', { listingId: ids.shop, externalId: '7002' })).toMatchObject({ ok: false, error: expect.stringContaining('(link-test.myshopify.com) has no product 7002') })
    doors.shopify.set('7100', { status: 'ACTIVE', variants: [{ id: '91', sku: 'LNK-SHF-S', item: '71' }] })
    expect((await preview('link-channel-id', { listingId: ids.shfRoot, externalId: '7100' })).preview).toMatchObject({ channel: 'SHOPIFY', listings: ['LNK-SHF', 'LNK-SHF-S'], effect: expect.stringContaining('they read Active in Nexus') })
    await askAndRun('link-channel-id', { listingId: ids.shfRoot, externalId: '7100' })
    const s = (await rowsOf('LNK-SHF-S'))[0]
    expect(s).toMatchObject({ externalListingId: '7100', liveChannelSku: 'LNK-SHF-S', syncPaused: true, platformAttributes: { variantId: '91', inventoryItemId: '71', shopifyProductId: '7100' } })
  }, TIMEOUT)
})

describe('Etsy (I2) through Claude\'s tools: the sheet\'s rule, and the proven SKU recorded and forgotten', () => {
  it('link → unlink → undo (link again, verified on Etsy)', async () => {
    doors.etsy.set('2100000001', { shop: '555', state: 'active', skus: ['OWN-LNK-ETY-S'] })
    doors.etsy.set('2100000009', { shop: '777', state: 'active', skus: ['OWN-LNK-ETY-S'] })
    expect(await preview('link-channel-id', { listingId: ids.etyRoot, externalId: '2100000009' })).toMatchObject({ ok: false, error: expect.stringContaining('not this account\'s shop 555') })
    expect((await preview('link-channel-id', { listingId: ids.etyRoot, externalId: '2100000001' })).preview).toMatchObject({ channel: 'ETSY', listings: ['LNK-ETY', 'LNK-ETY-S'] })
    await askAndRun('link-channel-id', { listingId: ids.etyRoot, externalId: '2100000001' })
    expect((await rowsOf('LNK-ETY-S'))[0]).toMatchObject({ externalListingId: '2100000001', listingStatus: 'ACTIVE', syncPaused: true, liveChannelSku: 'OWN-LNK-ETY-S', lastSyncStatus: 'SUCCESS' })
    const approvalId = await askAndRun('unlink-channel-id', { listingId: ids.etyS })
    expect((await rowsOf('LNK-ETY-S'))[0]).toMatchObject({ externalListingId: null, liveChannelSku: null, channelSku: 'OWN-LNK-ETY-S' })
    const change = await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))
    const asked = await ask('undo-change', { changeId: change.id })
    expect(asked, asked.error).toMatchObject({ ok: true, mode: 'queued', preview: { action: 'link-channel-id', externalId: '2100000001' } })
    expect(await approveAndRun(asked.approvalId)).toMatchObject({ ok: true, status: 'executed' })
    expect((await rowsOf('LNK-ETY-S'))[0]).toMatchObject({ externalListingId: '2100000001', liveChannelSku: 'OWN-LNK-ETY-S' })
  }, TIMEOUT)
})
