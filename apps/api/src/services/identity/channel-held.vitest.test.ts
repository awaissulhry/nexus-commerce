/**
 * MCP full control I6 — the per-account sweep of what a channel account holds (ChannelHeldId), and the audit checks that
 * read it: #3 a listing id its account does not hold, #4 an item the account holds that no listing carries, #12 a seller
 * SKU that differs. PGlite with the production schema and policies; the channel read is stood in (a stub reader, and
 * the eBay reader's Trading call), as real reads need the deployed API's KMS-sealed logins.
 *
 * Proven: a complete read records and links every id (variations by their SKU); a read that stops early (a page cap, a
 * failed page, an error) never marks an id missing and leaves the last complete read standing; only a later complete
 * read ends what it no longer saw; #3 trusts only a complete read and only listings that existed when it began; the job
 * does nothing unless NEXUS_IDENTITY_SWEEP=1; another business cannot sweep this business's account.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { ebayHeldReader, parseHeldEbayPage, sweepAccount, type HeldItem, type HeldReader } from './channel-held.service.js'
import { identityCheck } from './identity-checks.js'
import { runCheck } from './identity-audit.service.js'
import { runIdentityChannelSweepOnce } from '../../jobs/identity-channel-sweep.job.js'

const A = LEGACY_WORKSPACE_ID
const B = 'ws_identity_held_bravo'
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}

const stub = (items: HeldItem[], complete = true, reason?: string): HeldReader => ({ channel: 'EBAY', read: async () => ({ items, complete, reason }) })
const FULL: HeldItem[] = [
  { marketplace: null, externalId: '310000000001', sellerSku: 'HELD-1-S', parentExternalId: '310000000001', title: 'Jacket S' },
  { marketplace: null, externalId: '310000000001', sellerSku: 'HELD-1-M', parentExternalId: '310000000001', title: 'Jacket M' },
  { marketplace: null, externalId: '310000000003', sellerSku: 'OLD-SKU-3', title: 'Gloves' },
  { marketplace: 'IT', externalId: '310000000004', sellerSku: 'ORPHAN-4', title: 'Not in Nexus' },
]
const found = async (kind: string) => inside(async () => (await runCheck(identityCheck(kind)!, { limit: 100 })).findings)

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, 'Bravo', 'active', 'identity', $1, CURRENT_TIMESTAMP)`, [B])
  await inside(async () => {
    const db = database.client
    ids.conn = (await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, externalAccountId: 'test-seller-held' } })).id
    ids.conn2 = (await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, externalAccountId: 'test-seller-other' } })).id
    ids.off = (await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: false, externalAccountId: 'test-seller-off' } })).id
    const product = async (sku: string, extra: Record<string, unknown> = {}) => { ids[sku] = (await db.product.create({ data: { sku, name: sku, basePrice: '10.00', ...extra } })).id }
    const listing = async (sku: string, external: string, connection = ids.conn) => {
      ids[`L:${sku}`] = (await db.channelListing.create({
        data: { productId: ids[sku], channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT', listingStatus: 'ACTIVE', externalListingId: external, channelConnectionId: connection },
      })).id
    }
    await product('HELD-1', { isParent: true })
    await product('HELD-1-S', { parentId: ids['HELD-1'] })
    await product('HELD-1-M', { parentId: ids['HELD-1'] })
    await product('HELD-2')
    await product('HELD-3')
    await product('HELD-9')
    await listing('HELD-1', '310000000001')
    await listing('HELD-1-S', '310000000001')
    await listing('HELD-1-M', '310000000001')
    await listing('HELD-2', '310000000002')
    await listing('HELD-3', '310000000003')
    await listing('HELD-9', '310000000009', ids.conn2)
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('I6 — a complete read', () => {
  it('records and links every id: variations to their own listings by SKU, an unknown item unlinked', async () => {
    const report = await inside(() => sweepAccount(ids.conn, stub(FULL)))
    expect(report).toMatchObject({ complete: true, seen: 4, linked: 3, unlinked: 1, ended: 0 })
    const rows = await inside(() => database.client.channelHeldId.findMany({ orderBy: [{ externalId: 'asc' }, { sellerSku: 'asc' }] }))
    expect(rows.map((r) => [r.externalId, r.sellerSku, r.marketplace, r.matchState, r.listingId])).toEqual([
      ['310000000001', 'HELD-1-M', 'IT', 'LINKED', ids['L:HELD-1-M']],
      ['310000000001', 'HELD-1-S', 'IT', 'LINKED', ids['L:HELD-1-S']],
      ['310000000003', 'OLD-SKU-3', 'IT', 'LINKED', ids['L:HELD-3']],
      ['310000000004', 'ORPHAN-4', 'IT', 'UNLINKED', null],
    ])
    const sweep = await inside(() => database.client.channelHeldSweep.findFirstOrThrow({ where: { channelConnectionId: ids.conn } }))
    expect(sweep).toMatchObject({ complete: true, itemsSeen: 4, lastCompleteAt: expect.any(Date) })
  })

  it('#3 flags the listing id the account does not hold — not a listing made after the read, not an account never read', async () => {
    await inside(async () => {
      await database.client.product.create({ data: { sku: 'HELD-NEW', name: 'New', basePrice: '10.00' } }).then(async (p) => {
        ids['HELD-NEW'] = p.id
        await database.client.channelListing.create({ data: { productId: p.id, channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT', listingStatus: 'ACTIVE', externalListingId: '310000000077', channelConnectionId: ids.conn } })
      })
    })
    expect((await found('channel-id-not-held-by-account')).map((f) => [f.sku, f.details?.externalId])).toEqual([['HELD-2', '310000000002']])
  })

  it('#4 flags the held item no listing carries; #12 the item whose channel SKU is not the one Nexus sends (variations match theirs)', async () => {
    expect((await found('channel-id-not-in-nexus')).map((f) => [f.details?.externalId, f.sku])).toEqual([['310000000004', 'ORPHAN-4']])
    expect((await found('channel-sku-differs')).map((f) => [f.sku, f.details?.channelSku, f.details?.nexusSku])).toEqual([['HELD-3', 'OLD-SKU-3', 'HELD-3']])
  })
})

describe('I6 — a read that stops early never marks an id missing', () => {
  it('a truncated read records what it saw, ends nothing, and leaves the last complete read standing', async () => {
    const before = await inside(() => database.client.channelHeldSweep.findFirstOrThrow({ where: { channelConnectionId: ids.conn } }))
    const report = await inside(() => sweepAccount(ids.conn, stub([FULL[0]], false, 'stopped at the 1-page cap')))
    expect(report).toMatchObject({ complete: false, ended: 0, reason: 'stopped at the 1-page cap' })
    const open = await inside(() => database.client.channelHeldId.count({ where: { channelConnectionId: ids.conn, endedAt: null } }))
    expect(open).toBe(4)
    const after = await inside(() => database.client.channelHeldSweep.findFirstOrThrow({ where: { channelConnectionId: ids.conn } }))
    expect(after).toMatchObject({ complete: false, reason: 'stopped at the 1-page cap', lastCompleteAt: before.lastCompleteAt })
  })

  it('a read that throws is incomplete too; nothing ends', async () => {
    const failing: HeldReader = { channel: 'EBAY', read: async () => { throw new Error('eBay is down') } }
    expect(await inside(() => sweepAccount(ids.conn, failing))).toMatchObject({ complete: false, ended: 0, reason: expect.stringContaining('eBay is down') })
    expect(await inside(() => database.client.channelHeldId.count({ where: { channelConnectionId: ids.conn, endedAt: null } }))).toBe(4)
  })

  it('a later complete read ends what it no longer saw, and #4 lets it go', async () => {
    const report = await inside(() => sweepAccount(ids.conn, stub(FULL.slice(0, 3))))
    expect(report).toMatchObject({ complete: true, ended: 1 })
    expect(await found('channel-id-not-in-nexus')).toEqual([])
  })
})

describe('I6 — the eBay reader (GetMyeBaySelling through the gateway, stood in)', () => {
  const page = (n: number, total: number, items: string) =>
    `<GetMyeBaySellingResponse><Ack>Success</Ack><ActiveList><ItemArray>${items}</ItemArray><PaginationResult><TotalNumberOfPages>${total}</TotalNumberOfPages></PaginationResult></ActiveList></GetMyeBaySellingResponse>`
  const item = (id: string, extra = '') => `<Item><ItemID>${id}</ItemID><Title>T ${id}</Title>${extra}</Item>`

  it('parses an item\'s own SKU, each variation\'s SKU and the site', () => {
    expect(parseHeldEbayPage(page(1, 1, item('1', '<SKU>A</SKU><Site>Germany</Site>') + item('2', '<Variations><Variation><SKU>V1</SKU></Variation><Variation><SKU>V2</SKU></Variation></Variations>')))).toEqual([
      { marketplace: 'DE', externalId: '1', title: 'T 1', remoteStatus: 'Active', sellerSku: 'A' },
      { marketplace: null, externalId: '2', title: 'T 2', remoteStatus: 'Active', sellerSku: 'V1', parentExternalId: '2' },
      { marketplace: null, externalId: '2', title: 'T 2', remoteStatus: 'Active', sellerSku: 'V2', parentExternalId: '2' },
    ])
  })

  it('reads every page; stops early at the page cap or a failed page, and says so', async () => {
    const pages = [page(1, 2, item('1')), page(2, 2, item('2'))]
    const reader = (cap: number, failOn?: number) => ebayHeldReader({ pageCap: cap, send: async (_c, _b, n) => {
      if (n === failOn) return '<GetMyeBaySellingResponse><Ack>Failure</Ack></GetMyeBaySellingResponse>'
      return pages[n - 1]
    } })
    const conn = { id: 'c1', channelType: 'EBAY', marketplace: null, externalAccountId: null }
    expect(await reader(5).read(conn)).toMatchObject({ complete: true, items: [{ externalId: '1' }, { externalId: '2' }] })
    expect(await reader(1).read(conn)).toMatchObject({ complete: false, reason: expect.stringContaining('1-page cap'), items: [{ externalId: '1' }] })
    expect(await reader(5, 2).read(conn)).toMatchObject({ complete: false, reason: 'page 2: eBay answered Failure' })
  })
})

describe('I6 — the job and the business boundary', () => {
  it('does nothing unless NEXUS_IDENTITY_SWEEP=1; then sweeps each active account of its channel', async () => {
    const reads: string[] = []
    const reader: HeldReader = { channel: 'EBAY', read: async (c) => { reads.push(c.id); return { items: [], complete: false, reason: 'test' } } }
    vi.stubEnv('NEXUS_IDENTITY_SWEEP', '')
    expect((await inside(() => runIdentityChannelSweepOnce({ EBAY: reader }))).summary).toMatch(/^off/)
    expect(reads).toEqual([])
    vi.stubEnv('NEXUS_IDENTITY_SWEEP', '1')
    const out = await inside(() => runIdentityChannelSweepOnce({ EBAY: reader }))
    expect(out.summary).toMatch(/accounts 2 · complete 0 · incomplete 2/)
    expect(reads.sort()).toEqual([ids.conn, ids.conn2].sort())
    vi.unstubAllEnvs()
  })

  it('another business cannot sweep this business\'s account', async () => {
    await expect(inside(() => sweepAccount(ids.conn, stub(FULL)), B)).rejects.toThrow(/not one of this business/)
  })
})
