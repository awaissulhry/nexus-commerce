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
import { businessTypeCandidates, queueHeldBusinessSends, writeBusinessPrices } from './business-price-write.service.js'

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

describe('copying in never overwrites what Nexus manages', () => {
  it('an adopt over a managed listing is a no-op, and the setting stays', async () => {
    const before = await scoped(() => prisma.channelListing.findUnique({ where: { id: ids.it }, select: { businessPriceRule: true, version: true } }))
    expect(before!.businessPriceRule).not.toBeNull()
    const r = (await write([{ listingId: ids.it!, unguardedReason: 'amazon-business-offer-adopt', setting: fixed(50) }])).results[0]!
    expect(r).toMatchObject({ outcome: 'noop', reason: 'Nexus already manages this business price.' })
    const after = await scoped(() => prisma.channelListing.findUnique({ where: { id: ids.it }, select: { businessPriceRule: true, version: true } }))
    expect(after).toEqual(before)
  })
})

describe('step 4 — a person\'s change queues ONE business push for Amazon', () => {
  const pending = (key: string) => scoped(() => prisma.outboundSyncQueue.findMany({ where: { channelListingId: ids[key], syncType: 'BUSINESS_PRICE_UPDATE' }, orderBy: { createdAt: 'asc' } }))

  it('an applied change queues a held row; a newer change replaces the one still waiting', async () => {
    const first = (await write([{ listingId: ids.it!, expectedVersion: await versionOf('it'), setting: pct(6) }])).results[0]!
    expect(first.outcome).toBe('applied')
    expect(first.queueId).toBeTruthy()
    const second = (await write([{ listingId: ids.it!, expectedVersion: first.version, setting: pct(7) }])).results[0]!
    const rows = await pending('it')
    expect(rows.find((r) => r.id === first.queueId)!.syncStatus).toBe('CANCELLED')
    expect(rows.filter((r) => r.syncStatus === 'PENDING').map((r) => r.id)).toEqual([second.queueId])
    const live = rows.find((r) => r.id === second.queueId)!
    expect(live).toMatchObject({ targetChannel: 'AMAZON', payload: { syncBusiness: true, source: 'BUSINESS_PRICE_WRITE', actor: 'test@example.test' } })
    expect(live.holdUntil!.getTime()).toBeGreaterThan(Date.now() + 20_000)
  })

  it('a no-op, a refusal and a copy of what Amazon holds queue nothing', async () => {
    const before = (await pending('it')).length
    await write([{ listingId: ids.it!, expectedVersion: await versionOf('it'), setting: pct(7) }]) // the same again
    await write([{ listingId: ids.it!, expectedVersion: await versionOf('it'), setting: fixed(500) }]) // refused
    expect((await pending('it')).length).toBe(before)
    const fresh = await scoped(async () => (await prisma.channelListing.create({ data: {
      productId: 'bp-c', channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', aliasKey: 'adopt',
      channelConnectionId: (await prisma.channelListing.findUnique({ where: { id: ids.it }, select: { channelConnectionId: true } }))!.channelConnectionId,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'EXT-adopt', price: 105, priceOverride: 105, followMasterPrice: false, quantity: 1,
    } as never })).id)
    ids.adopt = fresh
    expect((await write([{ listingId: fresh, unguardedReason: 'amazon-business-offer-adopt', setting: fixed(90) }])).results[0]).toMatchObject({ outcome: 'applied', queueId: null })
    expect(await pending('adopt')).toEqual([])
  })

  it('a paused listing keeps the change in Nexus and says so', async () => {
    await scoped(() => prisma.channelListing.update({ where: { id: ids.itSale }, data: { syncPaused: true } }))
    const before = (await pending('itSale')).length
    const r = (await write([{ listingId: ids.itSale!, expectedVersion: await versionOf('itSale'), setting: pct(8) }])).results[0]!
    expect(r).toMatchObject({ outcome: 'applied', queueId: null })
    expect(r.notSent).toContain('sync is paused')
    expect((await pending('itSale')).length).toBe(before)
  })
})

describe('review fixes (2026-10-12)', () => {
  const pendingRows = (id: string) => scoped(() => prisma.outboundSyncQueue.findMany({ where: { channelListingId: id, syncType: 'BUSINESS_PRICE_UPDATE', syncStatus: 'PENDING' } }))
  const extraListing = async (key: string, extra: Record<string, unknown>, productId = 'bp-c') => {
    const account = (await scoped(() => prisma.channelListing.findUnique({ where: { id: ids.it }, select: { channelConnectionId: true } })))!.channelConnectionId
    ids[key] = (await scoped(() => prisma.channelListing.create({ data: {
      productId, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', aliasKey: key, channelConnectionId: account,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `EXT-${key}`, price: 105, priceOverride: 105, followMasterPrice: false, quantity: 1, ...extra,
    } as never }))).id
    return ids[key]!
  }

  it('a draft, or an Inactive listing, keeps the change in Nexus and says when it goes; resuming sends it', async () => {
    const draft = await extraListing('draft', { listingStatus: 'DRAFT', isPublished: false, externalListingId: null })
    const inactive = await extraListing('inactive', { offerClosedAt: new Date() })
    const d = (await write([{ listingId: draft, expectedVersion: 1, setting: pct(5) }])).results[0]!
    const c = (await write([{ listingId: inactive, expectedVersion: 1, setting: pct(5) }])).results[0]!
    expect(d).toMatchObject({ outcome: 'applied', queueId: null })
    expect(d.notSent).toContain('sent when the listing is published')
    expect(c.notSent).toContain('sent when the listing is set Active again')
    expect(await pendingRows(inactive)).toEqual([])
    // Set Active again → the held business price goes.
    await scoped(() => prisma.channelListing.update({ where: { id: inactive }, data: { offerClosedAt: null } }))
    const queued = await scoped(() => queueHeldBusinessSends({ listingIds: [inactive, draft], actor: 'test', cause: 'reopen' }))
    expect(queued).toHaveLength(1) // the draft still waits
    expect((await pendingRows(inactive)).map((r) => (r.payload as any).source)).toEqual(['BUSINESS_PRICE_REOPEN'])
  })

  it('removing a business price queues the send that removes it on Amazon', async () => {
    const id = await extraListing('remove', {})
    const set = (await write([{ listingId: id, expectedVersion: 1, setting: fixed(99) }])).results[0]!
    const removed = (await write([{ listingId: id, expectedVersion: set.version, setting: null }])).results[0]!
    expect(removed).toMatchObject({ outcome: 'applied', after: null })
    expect(removed.queueId).toBeTruthy()
    expect((await pendingRows(id)).map((r) => r.id)).toEqual([removed.queueId])
  })

  it('product types are read as the nightly refresh names them; a family with none says so', async () => {
    await scoped(async () => {
      await prisma.product.create({ data: { id: 'bp-lower', sku: 'TEST-BP-LOWER', name: 'l', basePrice: 105, productType: 'outerwear' } as never })
      await prisma.product.create({ data: { id: 'bp-none', sku: 'TEST-BP-NONE', name: 'n', basePrice: 105 } as never })
    })
    const lower = await extraListing('lower', {}, 'bp-lower')
    const none = await extraListing('none', {}, 'bp-none')
    expect((await write([{ listingId: lower, expectedVersion: 1, setting: pct(5) }])).results[0]!.outcome).toBe('applied')
    expect((await write([{ listingId: none, expectedVersion: 1, setting: pct(5) }])).results[0]!.reason).toBe(MATRIX_COPY.absentBusinessNoType())
    // The listing's own Amazon type wins when Amazon answered for it.
    expect(businessTypeCandidates({ platformAttributes: { productType: 'coat' }, product: { productType: 'OUTERWEAR', parent: { productType: null } } })).toEqual(['COAT', 'OUTERWEAR'])
  })

  it('the maximum seller price bounds the business price too', async () => {
    const id = await extraListing('max', { platformAttributes: { amazonOffer: { maximum_seller_allowed_price: 90 } } })
    expect((await write([{ listingId: id, expectedVersion: 1, setting: fixed(95) }])).results[0]!.reason).toContain('above this listing\'s maximum price EUR 90.00')
  })

  it('tiers are stored with their own keys only', async () => {
    const id = await extraListing('keys', {})
    await write([{ listingId: id, expectedVersion: 1, setting: fixed(99, { type: 'percent', levels: [{ minQty: 2, value: 3, junk: 'x' } as never] }) }])
    const row = await scoped(() => prisma.channelListing.findUnique({ where: { id }, select: { businessTiers: true } }))
    expect(row!.businessTiers).toEqual({ type: 'percent', levels: [{ minQty: 2, value: 3 }] })
  })
})

it('copying in loses to a person who set a price between the read and the write: the write is conditional, nothing is overwritten', async () => {
  const account = (await scoped(() => prisma.channelListing.findUnique({ where: { id: ids.it }, select: { channelConnectionId: true } })))!.channelConnectionId
  const id = (await scoped(() => prisma.channelListing.create({ data: {
    productId: 'bp-c', channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', aliasKey: 'race', channelConnectionId: account,
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'EXT-race', price: 105, priceOverride: 105, followMasterPrice: false, quantity: 1,
  } as never }))).id
  // The door reads through `tx`; a person's change lands right after the door's own listing read (no setting yet then).
  let landed = false
  const listings = prisma.channelListing as any
  const racing = new Proxy(listings, { get: (t, p) => p === 'findMany'
    ? async (args: any) => {
      const rows = await t.findMany(args)
      if (!landed && args?.select?.businessPriceRule) { landed = true; await prisma.channelListing.update({ where: { id }, data: { businessPriceRule: 'FIXED', businessPrice: 77 } }) }
      return rows
    }
    : (typeof t[p] === 'function' ? t[p].bind(t) : t[p]) })
  const tx = new Proxy(prisma as any, { get: (t, p) => (p === 'channelListing' ? racing : typeof t[p] === 'function' ? t[p].bind(t) : t[p]) })
  const r = (await scoped(() => writeBusinessPrices({ targets: [{ listingId: id, unguardedReason: 'amazon-business-offer-adopt', setting: fixed(50) }], actor: 'test', tx }))).results[0]!
  expect(landed).toBe(true)
  expect(r.outcome).toBe('conflict')
  const row = await scoped(() => prisma.channelListing.findUnique({ where: { id }, select: { businessPrice: true } }))
  expect(Number(row!.businessPrice)).toBe(77)
})
