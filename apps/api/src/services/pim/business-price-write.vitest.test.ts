/**
 * Amazon Business step 3 — the business price door over a real PostgreSQL in-process (PGlite). Every id and SKU is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => undefined) }))

import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import type { BusinessPriceSetting } from '@nexus/shared/business-price'
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { OFFER_AUDIENCE_FIELD_KEY } from '../categories/seller-offer-audience.service.js'
import { PARENT_PRICE_REASON } from './matrix-cells.js'
import { writeBusinessPrices } from './business-price-write.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const pct = (percent: number, tiers: BusinessPriceSetting['tiers'] = null): BusinessPriceSetting => ({ rule: 'PERCENT_OFF', percent, price: null, tiers })
const fixed = (price: number, tiers: BusinessPriceSetting['tiers'] = null): BusinessPriceSetting => ({ rule: 'FIXED', percent: null, price, tiers })
const tiers3 = { type: 'percent' as const, levels: [{ minQty: 2, value: 3 }, { minQty: 5, value: 5 }, { minQty: 10, value: 8 }] }
const ids: Record<string, string> = {}
const versionOf = async (key: string) => (await scoped(() => prisma.channelListing.findUnique({ where: { id: ids[key] }, select: { version: true } })))!.version

beforeAll(() => scoped(async () => {
  for (const [channel, code] of [['AMAZON', 'IT'], ['AMAZON', 'DE'], ['AMAZON', 'FR'], ['EBAY', 'IT']] as const) {
    await prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  }
  const account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'b2b', isActive: true, isPrimary: true } as never })).id
  await prisma.product.create({ data: { id: 'bp-p', sku: 'TEST-BP-P', name: 'p', basePrice: 105, isParent: true, productType: 'OUTERWEAR' } as never })
  await prisma.product.create({ data: { id: 'bp-c', sku: 'TEST-BP-C', name: 'c', basePrice: 105, parentId: 'bp-p' } as never })
  const listing = async (key: string, productId: string, channel: string, marketplace: string, extra: Record<string, unknown> = {}) => {
    ids[key] = (await prisma.channelListing.create({ data: {
      productId, channel, marketplace, channelMarket: `${channel}_${marketplace}`, region: 'EU', channelConnectionId: channel === 'AMAZON' ? account : null,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `EXT-${key}`, price: 105, priceOverride: 105, followMasterPrice: false, quantity: 3, ...extra,
    } as never })).id
  }
  await listing('it', 'bp-c', 'AMAZON', 'IT')
  await listing('itMin', 'bp-c', 'AMAZON', 'IT', { aliasKey: 'min', platformAttributes: { amazonOffer: { minimum_seller_allowed_price: 100 } } })
  await listing('itSale', 'bp-c', 'AMAZON', 'IT', { aliasKey: 'sale', salePrice: 89 })
  await listing('de', 'bp-c', 'AMAZON', 'DE')
  await listing('fr', 'bp-c', 'AMAZON', 'FR')
  await listing('parent', 'bp-p', 'AMAZON', 'IT')
  await listing('ebay', 'bp-c', 'EBAY', 'IT')
  const kept = (marketplace: string, labels: Record<string, string>) => prisma.sellerReferenceLabel.create({ data: {
    channel: 'AMAZON', connectionId: account, marketplace, productType: 'OUTERWEAR', fieldKey: OFFER_AUDIENCE_FIELD_KEY, labels,
  } as never })
  await kept('IT', { B2B: 'Amazon Business (B2B)', ALL: 'Vendita su Amazon' })
  await kept('DE', { ALL: 'Bei Amazon verkaufen' })
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

const write = (targets: Parameters<typeof writeBusinessPrices>[0]['targets']) => scoped(() => writeBusinessPrices({ targets, actor: 'test@example.test' }))

describe('the business price door', () => {
  it('a percent setting with three tiers is kept, audited and versioned; the price it gives follows the normal price', async () => {
    const v = await versionOf('it')
    const r = await write([{ listingId: ids.it!, expectedVersion: v, setting: pct(5, tiers3) }])
    expect(r.results[0]).toMatchObject({ outcome: 'applied', businessPrice: 99.75, before: null, after: pct(5, tiers3), version: v + 1, warnings: [] })
    const row = await scoped(() => prisma.channelListing.findUnique({ where: { id: ids.it }, select: { businessPriceRule: true, businessPricePercent: true, businessPrice: true, businessTiers: true } }))
    expect({ ...row, businessPricePercent: Number(row!.businessPricePercent) }).toEqual({ businessPriceRule: 'PERCENT_OFF', businessPricePercent: 5, businessPrice: null, businessTiers: tiers3 })
    const audit = await scoped(() => prisma.channelListingOverride.findFirst({ where: { channelListingId: ids.it, fieldName: 'businessPrice' } }))
    expect(audit).toMatchObject({ previousValue: null, newValue: '−5 % · 3 tiers (percent: 2+ 3, 5+ 5, 10+ 8)', changedBy: 'test@example.test' })
  })

  it('the same setting again is a no-op; a stale version is a conflict; a clear hands it back and the old value can be put back', async () => {
    const v = await versionOf('it')
    expect((await write([{ listingId: ids.it!, expectedVersion: v, setting: pct(5, tiers3) }])).results[0]!.outcome).toBe('noop')
    expect((await write([{ listingId: ids.it!, expectedVersion: v - 1, setting: pct(4) }])).results[0]).toMatchObject({ outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere })
    const cleared = (await write([{ listingId: ids.it!, expectedVersion: v, setting: null }])).results[0]!
    expect(cleared).toMatchObject({ outcome: 'applied', after: null, before: pct(5, tiers3) })
    const back = (await write([{ listingId: ids.it!, expectedVersion: cleared.version, setting: cleared.before }])).results[0]!
    expect(back).toMatchObject({ outcome: 'applied', after: pct(5, tiers3) })
  })

  it('refuses what Amazon would refuse or hide, and writes nothing', async () => {
    const v = await versionOf('it')
    const above = (await write([{ listingId: ids.it!, expectedVersion: v, setting: fixed(110) }])).results[0]!
    expect(above).toMatchObject({ outcome: 'refused' })
    expect(above.reason).toContain('above the normal price EUR 105.00')
    const badTiers = (await write([{ listingId: ids.it!, expectedVersion: v, setting: fixed(99, { type: 'fixed', levels: [{ minQty: 2, value: 100 }] }) }])).results[0]!
    expect(badTiers.reason).toContain('lower than the business price')
    const belowMin = (await write([{ listingId: ids.itMin!, expectedVersion: await versionOf('itMin'), setting: pct(5) }])).results[0]!
    expect(belowMin.reason).toContain('below this listing\'s minimum price EUR 100.00')
    expect(await versionOf('it')).toBe(v)
  })

  it('needs B2B for the account, market and product type: not enabled, never measured', async () => {
    expect((await write([{ listingId: ids.de!, expectedVersion: await versionOf('de'), setting: pct(5) }])).results[0]!.reason).toBe(MATRIX_COPY.absentBusiness('OUTERWEAR'))
    expect((await write([{ listingId: ids.fr!, expectedVersion: await versionOf('fr'), setting: pct(5) }])).results[0]!.reason).toBe(MATRIX_COPY.absentBusinessUnchecked())
  })

  it('never on a family parent or another channel', async () => {
    expect((await write([{ listingId: ids.parent!, expectedVersion: await versionOf('parent'), setting: pct(5) }])).results[0]!.reason).toBe(PARENT_PRICE_REASON)
    expect((await write([{ listingId: ids.ebay!, expectedVersion: await versionOf('ebay'), setting: pct(5) }])).results[0]!.reason).toBe('Only an Amazon listing has a business price.')
  })

  it('a sale below the business price saves with a warning', async () => {
    const r = (await write([{ listingId: ids.itSale!, expectedVersion: await versionOf('itSale'), setting: pct(5) }])).results[0]!
    expect(r.outcome).toBe('applied')
    expect(r.warnings[0]).toContain('sale price EUR 89.00 is lower than the business price EUR 99.75')
  })

  it('copying in what Amazon holds records it as it is — even a price Amazon hides — with the warning', async () => {
    const r = (await write([{ listingId: ids.itMin!, unguardedReason: 'amazon-business-offer-adopt', setting: fixed(110) }])).results[0]!
    expect(r).toMatchObject({ outcome: 'applied', guarded: false, businessPrice: 110 })
    expect(r.warnings[0]).toMatch(/^Hidden by Amazon/)
  })
})
