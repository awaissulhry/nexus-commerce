import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * PLAN Step 3.5 (A-36, R-36) — the eBay slice: the Trading quantity read-back records its differences per LISTING in
 * ChannelDrift, through the one writer.
 *
 * A membership (ItemID, SKU) is not a listing. It lands on the eBay listing of THAT product on THAT ItemID, else on the
 * ItemID's one parentless owner listing (a shell or the family parent) with the SKU in the field; an ItemID with two
 * owners is counted as unmapped, never guessed. The end-to-end arm runs the real job on an in-process PostgreSQL
 * (PGlite), with its real queries and the real writer; only the outside calls (eBay, the pool ledger, the heal) are faked.
 */
const state = vi.hoisted(() => ({ db: null as any, getItem: null as any, logConflict: null as any, heal: null as any, record: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('./marketplaces/ebay.service.js', () => ({ EbayService: class {} }))
vi.mock('./channel-stock-event.service.js', () => ({ recordChannelStockEvent: vi.fn() }))
vi.mock('./available-to-publish.service.js', () => ({ computeAvailableToPublish: vi.fn() }))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: vi.fn(async () => 'token') } }))
vi.mock('./connection-resolver.service.js', () => ({ tryResolveConnection: vi.fn(async () => ({ id: 'conn-1' })) }))
vi.mock('./ebay-trading-api.service.js', () => {
  state.getItem = vi.fn()
  return { getItemQuantities: state.getItem }
})
vi.mock('./sync-control-policy.service.js', () => ({ policyFor: () => null, loadChannelPolicies: async () => ({}) }))
vi.mock('./sync-control-core.js', () => ({ resolveMembershipIntended: ({ ledger }: any) => ({ kind: 'FOLLOW', quantity: ledger.available }) }))
vi.mock('./stock-pool/sync-ledgers.js', () => ({
  loadSyncLedgers: async (_db: unknown, pids: string[]) => new Map(pids.map((p) => [p, { ledger: { available: LEDGER[p] ?? 0 }, uncountedIsZero: false }])),
  ledgerInputs: (p: any) => ({ ledger: p?.ledger, uncountedIsZero: false }),
}))
vi.mock('./ebay-shared-fanout.service.js', () => {
  state.heal = vi.fn(async () => undefined)
  return { enqueueSharedTradingFanout: state.heal }
})
vi.mock('./sync-health.service.js', () => {
  state.logConflict = vi.fn(async () => undefined)
  return { syncHealthService: { logConflict: state.logConflict } }
})
// The REAL writer, wrapped so one arm can make it fail.
vi.mock('./channel-drift.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./channel-drift.service.js')>()
  state.record = vi.fn((...a: Parameters<typeof real.recordChannelReadback>) => real.recordChannelReadback(...a))
  return { ...real, recordChannelReadback: state.record }
})

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { obsKey, readBackEbayTradingQuantities, tradingDriftRecords, type TradingListingRow, type TradingReadbackEntry } from './ebay-inventory-readback.service.js'
import { recordChannelReadback } from './channel-drift.service.js'

const LEDGER: Record<string, number> = {}
const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

// ── pure: where one (ItemID, SKU) reading lands ─────────────────────────────────────────────────────────────────────
describe('tradingDriftRecords — the mapping', () => {
  const entry = (itemId: string, sku: string, productId: string, extra: Partial<TradingReadbackEntry> = {}): TradingReadbackEntry =>
    ({ itemId, sku, productId, marketplace: 'IT', lastPushedAt: null, ...extra })
  const listing = (id: string, itemId: string, productId: string, parentId: string | null, marketplace = 'IT'): TradingListingRow =>
    ({ id, productId, marketplace, externalListingId: itemId, product: { parentId } })
  const rows = [
    listing('fam-owner', '111', 'fam', null), listing('a-child', '111', 'a', 'fam'), listing('b-child', '111', 'b', 'fam'),
    listing('shell-owner', '222', 'shell', null),
    listing('amb-1', '333', 'shell-x', null), listing('amb-2', '333', 'shell-y', null),
    listing('de-child', '555', 'a', 'fam', 'DE'),
  ]
  const intended = new Map([['a', 5], ['b', 3], ['c', 2]])

  it('🔴 a difference lands on the exact child listing of THAT product on THAT ItemID, field "quantity"', () => {
    const r = tradingDriftRecords([entry('111', 'A', 'a')], new Map([[obsKey('111', 'A'), 4]]), intended, rows)
    expect(r).toEqual({ unmapped: 0, records: [{ channelListingId: 'a-child', marketplace: 'IT', compared: ['quantity'], differing: [{ field: 'quantity', ours: 5, theirs: 4 }] }] })
  })

  it('🔴 control: a matching reading is recorded as compared with NO difference (the row stays at 0)', () => {
    const r = tradingDriftRecords([entry('111', 'B', 'b')], new Map([[obsKey('111', 'B'), 3]]), intended, rows)
    expect(r.records).toEqual([{ channelListingId: 'b-child', marketplace: 'IT', compared: ['quantity'], differing: [] }])
  })

  it('🔴 one SKU on two ItemIDs lands on BOTH listings; with no child listing it lands on the ItemID owner, the SKU in the field', () => {
    const r = tradingDriftRecords([entry('111', 'A', 'a'), entry('222', 'A', 'a')],
      new Map([[obsKey('111', 'A'), 4], [obsKey('222', 'A'), 7]]), intended, rows)
    expect(r.records.map((x) => [x.channelListingId, x.differing])).toEqual([
      ['a-child', [{ field: 'quantity', ours: 5, theirs: 4 }]],
      ['shell-owner', [{ field: 'quantity:A', ours: 5, theirs: 7 }]],
    ])
  })

  it('🔴 an ItemID with two owner listings is AMBIGUOUS — counted, never guessed', () => {
    const r = tradingDriftRecords([entry('333', 'C', 'c')], new Map([[obsKey('333', 'C'), 0]]), intended, rows)
    expect(r).toEqual({ records: [], unmapped: 1 })
  })

  it('the market must match: a DE listing does not receive an IT reading', () => {
    const r = tradingDriftRecords([entry('555', 'A', 'a')], new Map([[obsKey('555', 'A'), 1]]), intended, rows)
    expect(r).toEqual({ records: [], unmapped: 1 })
  })

  it('not compared → not recorded: no observation, intent unknown, inside the settle window', () => {
    const now = Date.now()
    const r = tradingDriftRecords([
      entry('111', 'A', 'a'), // no observation
      entry('111', 'B', 'zzz'), // intent unknown (uncounted)
      entry('222', 'A', 'a', { lastPushedAt: new Date(now - 10_000) }), // pushed 10 s ago
    ], new Map([[obsKey('111', 'B'), 1], [obsKey('222', 'A'), 9]]), intended, rows, { now })
    expect(r).toEqual({ records: [], unmapped: 0 })
  })
})

// ── end to end: the real job, the real queries, the real writer ─────────────────────────────────────────────────────
describe('readBackEbayTradingQuantities → ChannelDrift (PGlite)', () => {
  const ids: Record<string, string> = {}
  const drift = (listingId: string) => scoped(() => prisma.channelDrift.findFirst({ where: { channelListingId: listingId } }))
  const ebayListing = (key: string, productId: string, itemId: string) => scoped(async () => {
    ids[key] = (await prisma.channelListing.create({ data: { productId, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'IT',
      externalListingId: itemId, listingStatus: 'ACTIVE' } })).id
  })

  beforeAll(async () => {
    await scoped(async () => {
      const product = async (key: string, data: Record<string, unknown>) => { ids[key] = (await prisma.product.create({ data: { name: key, basePrice: 10, ...data } as never })).id }
      await product('fam', { sku: 'EBD-FAM', isParent: true })
      await product('a', { sku: 'EBD-A', parentId: undefined })
      await product('b', { sku: 'EBD-B' })
      await product('c', { sku: 'EBD-C' })
      await product('d', { sku: 'EBD-D' })
      await product('shell', { sku: 'EBD-SHELL', productType: 'EBAY_LISTING_SHELL' })
      await product('shellX', { sku: 'EBD-SHELL-X', productType: 'EBAY_LISTING_SHELL' })
      await product('shellY', { sku: 'EBD-SHELL-Y', productType: 'EBAY_LISTING_SHELL' })
      await product('dOwner', { sku: 'EBD-D-OWNER', productType: 'EBAY_LISTING_SHELL' })
      await prisma.product.updateMany({ where: { id: { in: [ids.a, ids.b] } }, data: { parentId: ids.fam } })
    })
    await ebayListing('famOwner', ids.fam, '111')
    await ebayListing('aChild', ids.a, '111')
    await ebayListing('bChild', ids.b, '111')
    await ebayListing('shellOwner', ids.shell, '222')
    await ebayListing('amb1', ids.shellX, '333')
    await ebayListing('amb2', ids.shellY, '333')
    await ebayListing('dOwnerL', ids.dOwner, '444')
    await scoped(async () => {
      const member = (itemId: string, sku: string, productId: string) => prisma.sharedListingMembership.create({ data: {
        marketplace: 'IT', itemId, sku, parentSku: 'EBD-PARENT', productId, variationSpecifics: {} } })
      await member('111', 'EBD-A', ids.a)
      await member('111', 'EBD-B', ids.b)
      await member('222', 'EBD-A', ids.a)
      await member('333', 'EBD-C', ids.c)
      await member('444', 'EBD-D', ids.d)
    })
    Object.assign(LEDGER, { [ids.a]: 5, [ids.b]: 3, [ids.c]: 2, [ids.d]: 1 })
    // Another source's entry on A's listing — the eBay read-back must leave it.
    await scoped(() => recordChannelReadback({ channelListingId: ids.aChild, channel: 'EBAY', marketplace: 'IT', source: 'content-read',
      compared: ['title'], differing: [{ field: 'title', ours: 'Ours', theirs: 'Theirs' }] }))
  }, 120_000)
  afterAll(async () => { await state.db?.close() })

  beforeEach(() => {
    state.record.mockClear()
    state.getItem.mockReset()
    state.getItem.mockImplementation(async (itemId: string) => {
      if (itemId === '444') throw new Error('GetItem timed out')
      const v: Record<string, Array<{ sku: string; available: number }>> = {
        '111': [{ sku: 'EBD-A', available: 4 }, { sku: 'EBD-B', available: 3 }],
        '222': [{ sku: 'EBD-A', available: 7 }],
        '333': [{ sku: 'EBD-C', available: 0 }],
      }
      return { listingStatus: 'Active', itemAvailable: null, variations: v[itemId] ?? [] }
    })
  })

  it('🔴 each difference is stored on the RIGHT listing; a clean listing keeps a row at 0; another source stays; unreadable and ambiguous are not recorded', async () => {
    const result = await scoped(() => readBackEbayTradingQuantities())
    expect(result).toMatchObject({ items: 4, errors: 1, mismatches: 3, driftRecorded: 3, driftUnmapped: 1 })

    const a = (await drift(ids.aChild))!
    expect((a.driftedFields as any[]).map((e) => `${e.source}:${e.field}:${e.ours}:${e.theirs}`).sort())
      .toEqual(['content-read:title:Ours:Theirs', 'ebay-trading-getitem:quantity:5:4'])
    expect(a).toMatchObject({ channel: 'EBAY', marketplace: 'IT', driftCount: 2 })
    expect(await drift(ids.bChild)).toMatchObject({ driftCount: 0, driftedFields: [] })
    expect((await drift(ids.shellOwner))!.driftedFields).toEqual([expect.objectContaining({ field: 'quantity:EBD-A', ours: 5, theirs: 7, source: 'ebay-trading-getitem' })])
    // The family owner holds no entry of its own: both its variants have a child listing.
    expect(await drift(ids.famOwner)).toBeNull()
    expect(await drift(ids.amb1)).toBeNull()
    expect(await drift(ids.amb2)).toBeNull()
    expect(await drift(ids.dOwnerL)).toBeNull()
  })

  it('🔴 a failed drift write never changes the read-back\'s own verdict (mismatches, logs, heals)', async () => {
    const baseline = await scoped(() => readBackEbayTradingQuantities())
    const realWriter = state.record.getMockImplementation()
    state.record.mockImplementation(async () => { throw new Error('drift table unavailable') })
    try {
      const failing = await scoped(() => readBackEbayTradingQuantities())
      const { driftRecorded, driftUnmapped, ...verdict } = failing
      const { driftRecorded: _r, driftUnmapped: _u, ...baseVerdict } = baseline
      expect(verdict).toEqual(baseVerdict)
      expect(driftRecorded).toBe(0)
      expect(baseline.driftRecorded).toBe(3)
      expect(state.record).toHaveBeenCalled()
    } finally {
      state.record.mockImplementation(realWriter)
    }
  })
})
