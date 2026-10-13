/**
 * Amazon Business step 5 (Part 2) — the business cell through the Matrix door, end to end: the real Matrix read, the
 * real door (`writeMatrixCells`) and the real business price door, over a real PostgreSQL in-process (PGlite).
 * Every id and SKU is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => undefined) }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: vi.fn(async () => undefined) } }))
vi.mock('../listing-values-events.js', () => ({ announceListingValues: vi.fn() }))

import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import type { BusinessPriceSetting } from '@nexus/shared/business-price'
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { announceListingValues } from '../listing-values-events.js'
import { OFFER_AUDIENCE_FIELD_KEY } from '../categories/seller-offer-audience.service.js'
import { BUSINESS_PRICE_SYNC_TYPE } from './business-price-write.service.js'
import { PARENT_PRICE_REASON } from './matrix-cells.js'
import { BUSINESS_VALUE_REASON, writeMatrixCells, type DoorContext } from './matrix-write.service.js'
import { getMatrixRead } from './matrix.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const KEY = 'AMAZON:IT'
const ctx: DoorContext = { productId: 'mwb-p', actor: 'test@example.test', can: () => true }
const tiers = { type: 'percent' as const, levels: [{ minQty: 2, value: 3 }, { minQty: 5, value: 5 }] }
const pct = (percent: number, t: BusinessPriceSetting['tiers'] = null): BusinessPriceSetting => ({ rule: 'PERCENT_OFF', percent, price: null, tiers: t })
const ids: Record<string, string> = {}

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  const account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'b2b', isActive: true, isPrimary: true } as never })).id
  await prisma.product.create({ data: { id: 'mwb-p', sku: 'TEST-MWB-P', name: 'p', basePrice: 105, isParent: true, productType: 'OUTERWEAR' } as never })
  await prisma.product.create({ data: { id: 'mwb-c', sku: 'TEST-MWB-C', name: 'c', basePrice: 105, parentId: 'mwb-p' } as never })
  for (const [key, productId] of [['p', 'mwb-p'], ['c', 'mwb-c']] as const) {
    ids[key] = (await prisma.channelListing.create({ data: {
      productId, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', channelConnectionId: account,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `EXT-mwb-${key}`, price: 105, priceOverride: 105, followMasterPrice: false, quantity: 3,
    } as never })).id
  }
  await prisma.sellerReferenceLabel.create({ data: {
    channel: 'AMAZON', connectionId: account, marketplace: 'IT', productType: 'OUTERWEAR', fieldKey: OFFER_AUDIENCE_FIELD_KEY,
    labels: { B2B: 'Amazon Business (B2B)', ALL: 'Vendita su Amazon' },
  } as never })
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

const cellsOf = async (rowId: string) => (await scoped(() => getMatrixRead({ productId: 'mwb-p', canEditPrice: true }))).rows.find((r) => r.id === rowId)!.cells[KEY]!
const write = async (rowId: string, value: unknown, expectedVersion?: number) => {
  const cells = await cellsOf(rowId)
  const r = await scoped(() => writeMatrixCells(ctx, [{ rowId, coordinateKey: KEY, cell: 'businessPrice', value, expectedVersion: expectedVersion ?? cells.version, expectedListingId: cells.listingId! }]))
  return r.results[0]!
}
const stored = () => scoped(() => prisma.channelListing.findUnique({ where: { id: ids.c }, select: { version: true, businessPriceRule: true, businessPricePercent: true, businessPrice: true, businessTiers: true } }))
const businessRows = () => scoped(() => prisma.outboundSyncQueue.findMany({ where: { channelListingId: ids.c, syncType: BUSINESS_PRICE_SYNC_TYPE }, orderBy: { createdAt: 'asc' }, select: { syncStatus: true } }))

describe('the Matrix door writes the business setting through the business price door', () => {
  it('a percent with two tiers: stored, version bumped, one business send queued, announced; the read shows it', async () => {
    const before = (await cellsOf('mwb-c')).version
    const out = await write('mwb-c', pct(5, tiers))
    expect(out).toMatchObject({ outcome: 'applied', version: before + 1, listings: [{ listingId: ids.c, productId: 'mwb-c', version: before + 1 }] })
    const row = (await stored())!
    expect({ ...row, businessPricePercent: Number(row.businessPricePercent) }).toEqual({ version: before + 1, businessPriceRule: 'PERCENT_OFF', businessPricePercent: 5, businessPrice: null, businessTiers: tiers })
    expect(await businessRows()).toEqual([{ syncStatus: 'PENDING' }])
    expect(vi.mocked(announceListingValues)).toHaveBeenCalledWith([ids.c], ['businessPrice'], 'business-price')
    expect((await cellsOf('mwb-c')).business).toMatchObject({ rule: 'PERCENT_OFF', percent: 5, price: 99.75, tiers: { type: 'percent', levels: [{ minQty: 2, value: 3, unitPrice: 96.76 }, { minQty: 5, value: 5, unitPrice: 94.76 }] }, send: { state: 'queued' } })
  })

  it('an exact price above the normal price: refused with Amazon\'s rule, nothing stored, nothing queued', async () => {
    const was = await stored()
    const out = await write('mwb-c', { rule: 'FIXED', percent: null, price: 120, tiers: null })
    expect(out).toMatchObject({ outcome: 'refused', reason: 'The business price EUR 120.00 is above the normal price EUR 105.00: Amazon would not show it to business buyers.' })
    expect(await stored()).toEqual(was)
    expect(await businessRows()).toHaveLength(1)
  })

  it('a stale version is a conflict carrying the current version; nothing written', async () => {
    const was = await stored()
    const out = await write('mwb-c', pct(7), was!.version - 1)
    expect(out).toMatchObject({ outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, version: was!.version })
    expect(await stored()).toEqual(was)
  })

  it('the same setting again is a no-op (no version spent); a value the door cannot read is refused whole', async () => {
    const was = await stored()
    expect(await write('mwb-c', pct(5, tiers))).toMatchObject({ outcome: 'noop', version: was!.version })
    expect(await write('mwb-c', { rule: 'PERCENT_OFF', percent: '5' })).toMatchObject({ outcome: 'refused', reason: BUSINESS_VALUE_REASON })
    expect(await stored()).toEqual(was)
  })

  it('none (null) removes the business offer: the rule is cleared and the removal is queued for Amazon (one waiting row)', async () => {
    const out = await write('mwb-c', null)
    expect(out.outcome).toBe('applied')
    expect(await stored()).toMatchObject({ businessPriceRule: null, businessPricePercent: null, businessPrice: null, businessTiers: null })
    expect((await businessRows()).map((r) => r.syncStatus)).toEqual(['CANCELLED', 'PENDING'])
    expect((await cellsOf('mwb-c')).business).toMatchObject({ rule: null, price: null })
  })

  it('the family parent: refused with the not-buyable sentence', async () => {
    expect(await write('mwb-p', pct(5))).toMatchObject({ outcome: 'refused', reason: PARENT_PRICE_REASON })
  })
})
