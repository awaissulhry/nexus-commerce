/**
 * Item ID control (docs/sheet-ids-sku-rows/A2-item-id-control.md, step I1) — identity-fix's eBay proof, its verify mode
 * (the sheet's Check), the row-precise link and the unlink record, on PGlite with the production schema and policies.
 * eBay is stood in at its one door (GetItem in callTradingApi, which goes through the gateway) and the account token.
 *
 * Proven: the item's SKUs are compared with THIS listing's channel SKUs on its market and account (channel-sku.ts), not
 * Product.sku; a link writes only the rows the item carries, with eBay's status (an Ended item reads ENDED), stays paused
 * and keeps a snapshot first; an accepted unlink is read like an accepted Delete (the row is Not listed, never NEW); and
 * another business's item is refused — its listing is not found here, and its seller is not this account's.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})
vi.mock('../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
const channel = vi.hoisted(() => ({ getItem: (_itemId: string): string => '', calls: [] as string[], token: async (_connectionId: string): Promise<string> => 'test-token', events: [] as any[] }))
vi.mock('../ebay-trading-api.service.js', () => ({
  callTradingApi: async (_call: string, xml: string) => {
    const id = /<ItemID>([^<]+)<\/ItemID>/.exec(xml)?.[1] ?? ''
    channel.calls.push(id)
    return { ack: 'Success', raw: channel.getItem(id) }
  },
  siteIdForMarket: () => 101,
  escapeXml: (s: string) => s,
}))
vi.mock('../ebay-auth.service.js', () => ({ EbayAuthService: class { async getValidToken(connectionId: string) { return channel.token(connectionId) } } }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: (event: unknown) => { channel.events.push(event) } }))

import { checkChannelId, runLink, runUnlink, planLink, IdentityFixRefusal, PUSHES_STAY_PAUSED } from './identity-fix.service.js'
import { readListingDeletions } from '../listings/listing-deletions.js'
import { EBAY_ONLY, MAIN_ROW_ONLY, checkSheetChannelId, linkSheetChannelId, unlinkSheetChannelId, unlinkSentence } from './channel-id.service.js'
import { newListingChoice } from '@nexus/shared/listing-actions'

const A = LEGACY_WORKSPACE_ID
const B = 'i1_item_id_bravo'
const TIMEOUT = 30_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const db = () => database.client
const ids: Record<string, string> = {}
type Data = Record<string, any>

const item = (itemId: string, o: { status?: string; seller?: string | null; skus?: string[]; top?: string; title?: string } = {}) =>
  `<GetItemResponse><Ack>Success</Ack><Item><ItemID>${itemId}</ItemID><Title>${o.title ?? 'Test jacket'}</Title>`
  + `<SellingStatus><ListingStatus>${o.status ?? 'Active'}</ListingStatus></SellingStatus>`
  + (o.seller === null ? '' : `<Seller><UserID>${o.seller ?? 'seller-a'}</UserID></Seller>`)
  + (o.top ? `<SKU>${o.top}</SKU>` : '')
  + (o.skus ? `<Variations>${o.skus.map((s) => `<Variation><SKU>${s}</SKU><Quantity>1</Quantity></Variation>`).join('')}</Variations>` : '')
  + '</Item></GetItemResponse>'
const items = new Map<string, string>()
const rows = (...keys: string[]) => inside(() => db().channelListing.findMany({ where: { id: { in: keys.map((k) => ids[k]) } }, orderBy: { id: 'asc' } }))
const one = async (key: string) => (await rows(key))[0] as Data
const shape = (r: Data) => [r.externalListingId, r.listingStatus, r.isPublished, r.syncPaused]

beforeAll(async () => {
  database = await formulaDatabase()
  const client = database.client
  const approver = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Ida Item' } })
  await client.workspace.create({ data: { id: B, name: 'Bravo item id business', createdByUserId: approver.id, creationKey: randomUUID() } })
  ids.user = approver.id
  await inside(async () => {
    for (const code of ['IT', 'DE']) await client.marketplace.create({ data: { channel: 'EBAY', code, name: `EBAY ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: `I1_EBAY_${code}` } as never })
    ids.ebay = (await client.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, externalAccountId: 'seller-a' } })).id
    ids.ebayOld = (await client.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, externalAccountId: null } })).id
    const make = async (sku: string, extra: Data = {}) => { ids[sku] = (await client.product.create({ data: { sku, name: sku, basePrice: '10.00', ...extra } })).id }
    const list = async (key: string, sku: string, market: string, account: string, extra: Data = {}) => {
      ids[key] = (await client.channelListing.create({ data: {
        productId: ids[sku], channel: 'EBAY', marketplace: market, region: market, channelMarket: `EBAY_${market}`, channelConnectionId: account,
        listingStatus: 'DRAFT', isPublished: false, externalListingId: null, syncPaused: true, quantity: 2, ...extra,
      } })).id
    }
    // A family whose S variation sends its OWN eBay IT SKU (S1/S2), and whose M variation has no IT listing yet.
    await make('IDC-JKT', { isParent: true })
    await make('IDC-JKT-S', { parentId: ids['IDC-JKT'] })
    await make('IDC-JKT-M', { parentId: ids['IDC-JKT'] })
    await make('IDC-JKT-L', { parentId: ids['IDC-JKT'] })
    await list('root', 'IDC-JKT', 'IT', ids.ebay)
    await list('s', 'IDC-JKT-S', 'IT', ids.ebay, { channelSku: 'OWN-JKT-S-IT' })
    await list('l', 'IDC-JKT-L', 'IT', ids.ebay)
    // The same S variation on eBay DE sends another SKU: never this IT listing's.
    await list('sDe', 'IDC-JKT-S', 'DE', ids.ebay, { channelSku: 'DE-ONLY-S' })
    // A single product, live, holding an item.
    await make('IDC-SOLO')
    await list('solo', 'IDC-SOLO', 'IT', ids.ebay, { listingStatus: 'ACTIVE', isPublished: true, syncPaused: false, externalListingId: '520000000010' })
    // A product on an account Nexus never recorded a seller for.
    await make('IDC-OLD')
    await list('old', 'IDC-OLD', 'IT', ids.ebayOld)
    // Another family that already holds an item.
    await make('IDC-OTHER')
    await list('other', 'IDC-OTHER', 'IT', ids.ebay, { listingStatus: 'ACTIVE', isPublished: true, externalListingId: '520000000099' })
  })
  // Business B: its own eBay account (another seller), the same SKU, a listing holding B's item.
  await inside(async () => {
    ids.ebayB = (await client.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, externalAccountId: 'seller-b' } })).id
    ids.bravo = (await client.product.create({ data: { sku: 'IDC-SOLO', name: 'Bravo solo', basePrice: '10.00' } })).id
    ids.bravoListing = (await client.channelListing.create({ data: {
      productId: ids.bravo, channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT', channelConnectionId: ids.ebayB,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: '520000000777',
    } })).id
  }, B)
}, 120_000)

afterAll(async () => { await database?.close() }, 30_000)

beforeEach(() => {
  items.clear()
  channel.calls = []
  channel.events = []
  channel.token = async () => 'test-token'
  channel.getItem = (id) => items.get(id) ?? ''
})

describe('verify mode (the sheet\'s Check): the proof compares THIS listing\'s channel SKUs, never Product.sku', () => {
  it('an item carrying the IT listing\'s own channel SKU proves; it carries the main row and that variation only', async () => {
    items.set('520000000001', item('520000000001', { skus: ['OWN-JKT-S-IT'] }))
    const out = await inside(() => checkChannelId(ids.root, { externalId: '520000000001' }))
    expect(out).toMatchObject({ ok: true, refusal: null, verdict: 'verified', status: 'ACTIVE', currentId: null, itemId: '520000000001', unchanged: false, pushes: PUSHES_STAY_PAUSED })
    expect(out.rows.map((r) => r.sku).sort()).toEqual(['IDC-JKT', 'IDC-JKT-S'])
    expect(out.found).toEqual(expect.arrayContaining(['eBay reports it as Active.', 'Listed by eBay seller "seller-a", the seller of this account.']))
    expect(channel.calls).toEqual(['520000000001'])
  }, TIMEOUT)

  it('the S product\'s own SKU is not this listing\'s SKU any more (it sends OWN-JKT-S-IT): refused as another product', async () => {
    items.set('520000000002', item('520000000002', { skus: ['IDC-JKT-S'] }))
    const out = await inside(() => checkChannelId(ids.root, { externalId: '520000000002' }))
    expect(out).toMatchObject({ ok: false, verdict: 'rejected', refusal: expect.stringContaining('None of the 1 SKU(s) on that listing belong to this family') })
  }, TIMEOUT)

  it('another market\'s channel SKU (eBay DE) is not this IT listing\'s', async () => {
    items.set('520000000003', item('520000000003', { skus: ['DE-ONLY-S'] }))
    const out = await inside(() => checkChannelId(ids.root, { externalId: '520000000003' }))
    expect(out).toMatchObject({ ok: false, verdict: 'rejected' })
  }, TIMEOUT)

  it('refuses only what cannot work, each in a plain sentence: not a number, another family\'s item, another seller, a dead read', async () => {
    expect(await inside(() => checkChannelId(ids.root, { externalId: '12ab' }))).toMatchObject({ ok: false, verdict: 'invalid', refusal: expect.stringContaining('9–15 digits') })
    expect(await inside(() => checkChannelId(ids.root, { externalId: '520000000099' }))).toMatchObject({ ok: false, refusal: expect.stringContaining('already linked to another product') })
    items.set('520000000004', item('520000000004', { seller: 'seller-b', skus: ['OWN-JKT-S-IT'] }))
    expect(await inside(() => checkChannelId(ids.root, { externalId: '520000000004' }))).toMatchObject({ ok: false, refusal: expect.stringContaining('listed by eBay seller "seller-b"') })
    expect(await inside(() => checkChannelId(ids.root, { externalId: '520000000005' }))).toMatchObject({ ok: false, refusal: expect.stringContaining('eBay returned no body') })
  }, TIMEOUT)

  it('an account with no recorded seller: refused in the sheet (no "link it anyway"); Claude\'s tool still asks for an explicit yes', async () => {
    items.set('520000000006', item('520000000006', { top: 'IDC-OLD' }))
    const out = await inside(() => checkChannelId(ids.old, { externalId: '520000000006' }))
    expect(out).toMatchObject({ ok: false, verdict: 'unverifiable', refusal: expect.stringContaining('Reconnect the account in Nexus (Settings, Channels), then check again.') })
    expect(out.refusal).not.toContain('acknowledgeUnverifiable')
    await expect(inside(() => planLink(ids.old, { externalId: '520000000006' }))).rejects.toThrow('acknowledgeUnverifiable')
    expect((await inside(() => planLink(ids.old, { externalId: '520000000006', acknowledgeUnverifiable: true }))).verdict).toBe('unverifiable')
  }, TIMEOUT)

  it('no working sign-in: refused before eBay is asked', async () => {
    channel.token = async () => { throw new Error('no credentials') }
    const out = await inside(() => checkChannelId(ids.root, { externalId: '520000000001' }))
    expect(out).toMatchObject({ ok: false, refusal: expect.stringContaining('has no working sign-in in Nexus') })
    expect(channel.calls).toEqual([])
  }, TIMEOUT)

  it('with no id typed it checks the one Nexus holds; a live item Nexus already reads is "nothing to change"', async () => {
    items.set('520000000010', item('520000000010', { top: 'IDC-SOLO' }))
    const out = await inside(() => checkChannelId(ids.solo))
    expect(out).toMatchObject({ ok: true, unchanged: true, itemId: '520000000010', currentId: '520000000010' })
    expect(out.found).toContain('Nexus already holds it on 1 row: nothing to change.')
  }, TIMEOUT)
})

describe('link: only the rows the item carries, with eBay\'s status; paused; a snapshot first', () => {
  it('Active: the main row and the S variation take the item; L (not on the item) is left alone; pushes stay paused', async () => {
    items.set('520000000001', item('520000000001', { skus: ['OWN-JKT-S-IT'] }))
    const before = await one('root')
    const record = await inside(() => runLink(ids.root, { externalId: '520000000001', expectedExternalId: '520000000001', expectedVersion: before.version, actor: ids.user }))
    expect(record).toMatchObject({ status: 'ACTIVE', externalId: '520000000001' })
    expect(record.rows.map((r) => r.id).sort()).toEqual([ids.root, ids.s].sort())
    expect(shape(await one('root'))).toEqual(['520000000001', 'ACTIVE', true, true])
    expect(shape(await one('s'))).toEqual(['520000000001', 'ACTIVE', true, true])
    expect(shape(await one('l'))).toEqual([null, 'DRAFT', false, true])
    expect(shape(await one('sDe'))).toEqual([null, 'DRAFT', false, true])
    const snaps = await inside(() => db().channelListingSnapshot.findMany({ where: { channelListingId: { in: [ids.root, ids.s] }, reason: 'manual' } }))
    expect(snaps.map((s) => [s.label, s.capturedBy])).toEqual([
      ['before link-channel-id (520000000001)', ids.user], ['before link-channel-id (520000000001)', ids.user],
    ])
    // The sheet re-reads: one listing.values_changed for the family root, naming the written rows.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(channel.events).toEqual([expect.objectContaining({ type: 'listing.values_changed', productId: ids['IDC-JKT'], fields: ['externalListingId', 'syncState'], reason: 'channel-id-link' })])
  }, TIMEOUT)

  it('the fence: a listing version the sheet did not read is refused before eBay is asked; nothing changes', async () => {
    const before = await one('l')
    await expect(inside(() => runLink(ids.l, { externalId: '520000000001', expectedExternalId: '520000000001', expectedVersion: before.version - 1 })))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(channel.calls).toEqual([])
  }, TIMEOUT)

  it('Ended: the rows read ENDED (Relist is offered), never ACTIVE; the shared variations stay ended', async () => {
    await inside(() => db().sharedListingMembership.create({ data: { marketplace: 'IT', sku: 'IDC-SOLO', itemId: '520000000020', parentSku: 'IDC-SOLO', productId: ids['IDC-SOLO'], variationSpecifics: {}, channelConnectionId: ids.ebay, status: 'ENDED' } }))
    items.set('520000000020', item('520000000020', { status: 'Completed', top: 'IDC-SOLO' }))
    const check = await inside(() => checkChannelId(ids.solo, { externalId: '520000000020' }))
    expect(check).toMatchObject({ ok: true, status: 'ENDED', ebayStatus: 'Completed' })
    expect(check.found).toContain('eBay reports it as Completed: Nexus records it as Ended, and Relist is offered.')
    const before = await one('solo')
    await inside(() => runLink(ids.solo, { externalId: '520000000020', expectedExternalId: '520000000020', expectedVersion: before.version }))
    expect(shape(await one('solo'))).toEqual(['520000000020', 'ENDED', true, true])
    expect((await inside(() => db().sharedListingMembership.findFirstOrThrow({ where: { itemId: '520000000020' } }))).status).toBe('ENDED')
  }, TIMEOUT)

  /** Put the family back as the Active link left it: root and S on item 001, L with no item. */
  const restoreFamily = () => inside(async () => {
    await db().channelListing.updateMany({ where: { id: { in: [ids.root, ids.s] } }, data: { externalListingId: '520000000001', listingStatus: 'ACTIVE', isPublished: true } })
    await db().channelListing.update({ where: { id: ids.l }, data: { externalListingId: null, listingStatus: 'DRAFT', isPublished: false } })
  })

  it('Owner option A: a variation holding ANOTHER item moves to this one when eBay shows its own SKU on it — listed before, snapshot first', async () => {
    await inside(() => db().channelListing.update({ where: { id: ids.l }, data: { externalListingId: '520000000030', listingStatus: 'ACTIVE', isPublished: true } }))
    items.set('520000000031', item('520000000031', { skus: ['OWN-JKT-S-IT', 'IDC-JKT-L'] }))
    const out = await inside(() => checkChannelId(ids.root, { externalId: '520000000031' }))
    expect(out.ok).toBe(true)
    expect(out.moved).toEqual([{ listingId: ids.l, sku: 'IDC-JKT-L', channelSku: 'IDC-JKT-L', from: '520000000030',
      sentence: 'IDC-JKT-L holds item 520000000030; eBay shows its SKU IDC-JKT-L on item 520000000031; Link moves it to 520000000031.' }])
    expect(out.kept).toEqual([])
    expect(out.rows.map((r) => r.sku).sort()).toEqual(['IDC-JKT', 'IDC-JKT-L', 'IDC-JKT-S'])
    const before = await one('root')
    const record = await inside(() => runLink(ids.root, { externalId: '520000000031', expectedExternalId: '520000000031', expectedVersion: before.version, actor: ids.user, sheet: true }))
    expect(record.moved?.map((m) => [m.id, m.fromItemId])).toEqual([[ids.l, '520000000030']])
    expect(shape(await one('l'))).toEqual(['520000000031', 'ACTIVE', true, true])
    const snap = await inside(() => db().channelListingSnapshot.findFirst({ where: { channelListingId: ids.l, reason: 'manual', label: 'before link-channel-id (520000000031)' } }))
    expect(snap).toMatchObject({ capturedBy: ids.user })
    expect(snap!.payload).toMatchObject({ state: { id: ids.l } })
    await restoreFamily()
  }, TIMEOUT)

  it('a variation whose SKU is NOT on the new item is left alone and listed as kept; Link does not touch it', async () => {
    await inside(() => db().channelListing.update({ where: { id: ids.l }, data: { externalListingId: '520000000030', listingStatus: 'ACTIVE', isPublished: true } }))
    items.set('520000000032', item('520000000032', { skus: ['OWN-JKT-S-IT'] }))
    const out = await inside(() => checkChannelId(ids.root, { externalId: '520000000032' }))
    expect(out).toMatchObject({ ok: true, moved: [] })
    const sentence = 'IDC-JKT-L holds item 520000000030; eBay does not show its SKU on item 520000000032, so Link leaves it as it is.'
    expect(out.kept).toEqual([{ id: ids.l, sku: 'IDC-JKT-L', externalListingId: '520000000030', sentence }])
    expect(out.found).toContain(sentence)
    const before = await one('root')
    await inside(() => runLink(ids.root, { externalId: '520000000032', expectedExternalId: '520000000032', expectedVersion: before.version, sheet: true }))
    expect(shape(await one('l'))).toEqual(['520000000030', 'ACTIVE', true, true]) // exactly as it was
    expect((await one('s')).externalListingId).toBe('520000000032')
    expect(await inside(() => db().channelListingSnapshot.count({ where: { channelListingId: ids.l, label: 'before link-channel-id (520000000032)' } }))).toBe(0)
    await restoreFamily()
  }, TIMEOUT)
})

describe('unlink: recorded as accepted, read like an accepted Delete — never offered as a NEW listing', () => {
  it('the rows become paused drafts, each with an accepted \'unlink\' record naming the old item; they read Not listed', async () => {
    const before = await one('root')
    expect(before.externalListingId).toBe('520000000001')
    const record = await inside(() => runUnlink(ids.root, '520000000001', ids.user, { expectedVersion: before.version }))
    expect(record.rows.map((r) => r.id).sort()).toEqual([ids.root, ids.s].sort())
    for (const key of ['root', 's']) expect(shape(await one(key))).toEqual([null, 'DRAFT', false, true])
    const snaps = await inside(() => db().channelListingSnapshot.findMany({ where: { channelListingId: { in: [ids.root, ids.s] }, reason: 'unlink' } }))
    expect(snaps).toHaveLength(2)
    for (const snap of snaps) {
      expect(snap).toMatchObject({ outcome: 'ACCEPTED', capturedBy: ids.user, label: 'before unlink-channel-id (520000000001)' })
      expect(snap.acceptedAt).toBeInstanceOf(Date)
      expect(snap.payload).toMatchObject({ kind: 'channel-id-unlink', evidence: { oldExternalListingId: '520000000001' } })
    }
    const candidates = (await rows('root', 's', 'l')).map((r) => ({ id: r.id, channel: 'EBAY', marketplace: 'IT', externalListingId: r.externalListingId, listingStatus: r.listingStatus, isPublished: r.isPublished }))
    const removed = await inside(() => readListingDeletions(candidates))
    expect([...removed.keys()].sort()).toEqual([ids.root, ids.s].sort())
    expect(removed.get(ids.root)).toMatchObject({ where: 'eBay · IT', oldReference: '520000000001', unlinked: true })
    // The trap this closes: a removed row is Not listed by default, so a Publish never creates a second item.
    expect(newListingChoice({ channel: 'EBAY', includedByDefault: true, deleted: removed.has(ids.root) } as never)).toEqual({ target: 'not_listed', source: 'default' })
    expect(newListingChoice({ channel: 'EBAY', includedByDefault: true, deleted: removed.has(ids.l) } as never).target).not.toBe('not_listed')
  }, TIMEOUT)

  it('a link afterwards (the item again) makes the rows listed again: no longer read as removed', async () => {
    items.set('520000000001', item('520000000001', { skus: ['OWN-JKT-S-IT'] }))
    const before = await one('root')
    await inside(() => runLink(ids.root, { externalId: '520000000001', expectedExternalId: '520000000001', expectedVersion: before.version }))
    const candidates = (await rows('root', 's')).map((r) => ({ id: r.id, channel: 'EBAY', marketplace: 'IT', externalListingId: r.externalListingId, listingStatus: r.listingStatus, isPublished: r.isPublished }))
    expect((await inside(() => readListingDeletions(candidates))).size).toBe(0)
  }, TIMEOUT)

  it('a stale fence (another id, or another version) is refused and nothing changes', async () => {
    const before = await one('root')
    await expect(inside(() => runUnlink(ids.root, '520000000999', null))).rejects.toMatchObject({ code: 'conflict' })
    await expect(inside(() => runUnlink(ids.root, '520000000001', null, { expectedVersion: before.version + 1 }))).rejects.toBeInstanceOf(IdentityFixRefusal)
    expect((await one('root')).externalListingId).toBe('520000000001')
  }, TIMEOUT)
})

describe('channel ids never cross businesses', () => {
  it('another business\'s listing is not found here, and its item (another seller) is refused', async () => {
    await expect(inside(() => checkChannelId(ids.bravoListing))).rejects.toMatchObject({ code: 'not_found' })
    // B's item carries the same SKU as A's solo product: the SKUs alone would pass; the seller proof refuses it.
    items.set('520000000777', item('520000000777', { seller: 'seller-b', top: 'IDC-SOLO' }))
    const out = await inside(() => checkChannelId(ids.solo, { externalId: '520000000777' }))
    expect(out).toMatchObject({ ok: false, verdict: 'rejected', refusal: expect.stringContaining('not by this account\'s seller "seller-a"') })
    // B's rows are untouched, and B's item never lands on A's rows.
    expect((await inside(() => db().channelListing.findUniqueOrThrow({ where: { id: ids.bravoListing } }), B)).externalListingId).toBe('520000000777')
    expect((await one('solo')).externalListingId).not.toBe('520000000777')
  }, TIMEOUT)
})

describe('the sheet\'s door (channel-id.service): main row only, fenced, as the signed-in person', () => {
  it('a variation row is refused ("Set on the main row"); eBay only', async () => {
    await expect(inside(() => checkSheetChannelId(ids.s, { externalId: '520000000001' }))).rejects.toThrow(MAIN_ROW_ONLY)
    await expect(inside(() => unlinkSheetChannelId(ids.s, { expectedExternalId: '520000000001', expectedVersion: 1 }, ids.user))).rejects.toThrow(MAIN_ROW_ONLY)
    const amazon = await inside(async () => {
      const connection = await db().channelConnection.create({ data: { channelType: 'AMAZON', isActive: true, externalAccountId: 'amz' } })
      return (await db().channelListing.create({ data: { productId: ids['IDC-SOLO'], channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', channelConnectionId: connection.id, listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0SOLO' } })).id
    })
    await expect(inside(() => checkSheetChannelId(amazon, {}))).rejects.toThrow(EBAY_ONLY)
  }, TIMEOUT)

  it('an item Nexus cannot prove is this account\'s: the sheet\'s Link refuses in its own words (no "link it anyway")', async () => {
    items.set('520000000006', item('520000000006', { top: 'IDC-OLD' }))
    const old = await one('old')
    const refused = await inside(() => linkSheetChannelId(ids.old, { externalId: '520000000006', expectedExternalId: null, expectedVersion: old.version }, ids.user)).catch((e) => e)
    expect(refused).toBeInstanceOf(IdentityFixRefusal)
    expect(refused.message).toContain('Reconnect the account in Nexus (Settings, Channels), then check again.')
    expect(refused.message).not.toContain('acknowledgeUnverifiable')
    expect((await one('old')).externalListingId).toBeNull()
  }, TIMEOUT)

  it('the fence: another id or another version than the sheet read is a conflict, and eBay is not asked', async () => {
    const root = await one('root')
    await expect(inside(() => linkSheetChannelId(ids.root, { externalId: '520000000001', expectedExternalId: null, expectedVersion: root.version }, ids.user))).rejects.toMatchObject({ code: 'conflict' })
    await expect(inside(() => linkSheetChannelId(ids.root, { externalId: '520000000001', expectedExternalId: root.externalListingId, expectedVersion: root.version - 1 }, ids.user))).rejects.toMatchObject({ code: 'conflict' })
    expect(channel.calls).toEqual([])
  }, TIMEOUT)

  it('Clear, then Link again: each answers with the rows\' new versions and its sentence, and leaves an audit row', async () => {
    const root = await one('root')
    const cleared = await inside(() => unlinkSheetChannelId(ids.root, { expectedExternalId: '520000000001', expectedVersion: root.version }, ids.user))
    expect(cleared).toMatchObject({ ok: true, externalId: '520000000001', sentence: unlinkSentence('520000000001') })
    expect(cleared.sentence).toBe('Nexus forgets item 520000000001. Nothing changes on eBay; it stays live and Nexus stops updating it.')
    expect(cleared.rows).toEqual(expect.arrayContaining([{ listingId: ids.root, version: (await one('root')).version }, { listingId: ids.s, version: (await one('s')).version }]))
    items.set('520000000001', item('520000000001', { skus: ['OWN-JKT-S-IT'] }))
    const after = await one('root')
    const linked = await inside(() => linkSheetChannelId(ids.root, { externalId: '520000000001', expectedExternalId: null, expectedVersion: after.version }, ids.user))
    expect(linked).toMatchObject({ ok: true, status: 'ACTIVE', sentence: 'Linked item 520000000001 on 2 rows.', pushes: PUSHES_STAY_PAUSED })
    const audit = await inside(() => db().auditLog.findMany({ where: { entityId: ids.root, action: { startsWith: 'listing.channel-id.' } }, orderBy: { createdAt: 'asc' } }))
    expect(audit.map((a) => [a.action, a.userId])).toEqual([['listing.channel-id.unlink', ids.user], ['listing.channel-id.link', ids.user]])
    // Keep on what Nexus already holds and eBay confirms: nothing written, said so.
    const kept = await inside(async () => linkSheetChannelId(ids.root, { externalId: '520000000001', expectedExternalId: '520000000001', expectedVersion: (await one('root')).version }, ids.user))
    expect(kept).toMatchObject({ rows: [], sentence: 'eBay confirms item 520000000001; Nexus already holds it. Nothing changed.' })
  }, TIMEOUT)
})
