/**
 * Amazon Business step 5 (Part 1) — the Matrix read carries each Amazon listing's business cell: on an Amazon market where
 * Amazon lists B2B for THAT listing (the business price door's own rule: its Amazon type, then its product's, then the
 * family's), null on the family parent, absent elsewhere. Real Matrix read over a real PostgreSQL in-process (PGlite).
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

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { OFFER_AUDIENCE_FIELD_KEY } from '../categories/seller-offer-audience.service.js'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import { getMatrixRead } from './matrix.service.js'
import { PARENT_PRICE_REASON, PRICE_PERMISSION_REASON } from './matrix-cells.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const IT = 'APJ6JRA9NG5V4'
const ids: Record<string, string> = {}

beforeAll(() => scoped(async () => {
  for (const code of ['IT', 'DE']) await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  const account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'b2b', isActive: true, isPrimary: true } as never })).id
  await prisma.product.create({ data: { id: 'mb-p', sku: 'TEST-MB-P', name: 'p', basePrice: 105, isParent: true, productType: 'OUTERWEAR' } as never })
  for (const n of [1, 2, 3]) await prisma.product.create({ data: { id: `mb-${n}`, sku: `TEST-MB-${n}`, name: `c${n}`, basePrice: 105, parentId: 'mb-p' } as never })
  const listing = async (key: string, productId: string, marketplace: string, extra: Record<string, unknown> = {}) => {
    ids[key] = (await prisma.channelListing.create({ data: {
      productId, channel: 'AMAZON', marketplace, channelMarket: `AMAZON_${marketplace}`, region: 'EU', channelConnectionId: account,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `EXT-${key}`, price: 105, priceOverride: 105, followMasterPrice: false, quantity: 3, ...extra,
    } as never })).id
  }
  await listing('p-it', 'mb-p', 'IT')
  await listing('1-it', 'mb-1', 'IT', { businessPriceRule: 'PERCENT_OFF', businessPricePercent: 5, businessTiers: { type: 'percent', levels: [{ minQty: 2, value: 3 }] } })
  await listing('1-de', 'mb-1', 'DE', { businessPriceRule: 'PERCENT_OFF', businessPricePercent: 5 })
  await listing('2-it', 'mb-2', 'IT', { platformAttributes: { attributes: { purchasable_offer: [
    { audience: 'ALL', marketplace_id: IT, currency: 'EUR', our_price: [{ schedule: [{ value_with_tax: 105 }] }] },
    { audience: 'B2B', marketplace_id: IT, currency: 'EUR', our_price: [{ schedule: [{ value_with_tax: 90 }] }] },
  ] } } })
  // Amazon holds this one as COAT, where it lists no B2B for the account: the listing's own type decides.
  await listing('3-it', 'mb-3', 'IT', { platformAttributes: { productType: 'COAT' } })
  const kept = (marketplace: string, productType: string, labels: Record<string, string>) => prisma.sellerReferenceLabel.create({ data: {
    channel: 'AMAZON', connectionId: account, marketplace, productType, fieldKey: OFFER_AUDIENCE_FIELD_KEY, labels,
  } as never })
  await kept('IT', 'OUTERWEAR', { B2B: 'Amazon Business (B2B)', ALL: 'Vendita su Amazon' })
  await kept('IT', 'COAT', { ALL: 'Vendita su Amazon' })
  await kept('DE', 'OUTERWEAR', { ALL: 'Bei Amazon verkaufen' })
  // A business send waiting in its hold; and an older normal price push (the queue fold must never see the business row).
  // An eBay listing beside them: no channel but Amazon ever serves the business cells.
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'eBay IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  const ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'ebay', isActive: true, isPrimary: true } as never })).id
  ids['1-ebay'] = (await prisma.channelListing.create({ data: {
    productId: 'mb-1', channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'EU', channelConnectionId: ebay,
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'EXT-1-ebay', price: 105, quantity: 3,
  } as never })).id
  await prisma.outboundSyncQueue.create({ data: {
    productId: 'mb-1', channelListingId: ids['1-it'], targetChannel: 'AMAZON', targetRegion: 'EU', syncStatus: 'PENDING', syncType: 'BUSINESS_PRICE_UPDATE',
    holdUntil: new Date('2026-10-13T10:00:30Z'), maxRetries: 3, payload: { syncBusiness: true },
  } as never })
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

describe('the Matrix read carries the business cell', () => {
  const read = () => scoped(() => getMatrixRead({ productId: 'mb-p', canEditPrice: true }))
  const cellOf = async (rowId: string, key: string) => (await read()).rows.find((r) => r.id === rowId)!.cells[key]

  it('a percent rule on IT: the price it gives now, the tiers with unit prices, and the send waiting in its hold', async () => {
    const business = (await cellOf('mb-1', 'AMAZON:IT'))!.business!
    expect(business).toMatchObject({
      rule: 'PERCENT_OFF', percent: 5, exact: null, price: 99.75, normalPrice: 105, currency: 'EUR', held: null,
      tiers: { type: 'percent', levels: [{ minQty: 2, value: 3, unitPrice: 96.76 }] },
      send: { state: 'queued', at: '2026-10-13T10:00:30.000Z', final: false },
    })
  })

  it('a business offer Amazon shows that Nexus never kept: no rule, reported as set outside Nexus', async () => {
    expect((await cellOf('mb-2', 'AMAZON:IT'))!.business).toMatchObject({ rule: null, price: null, reported: { price: 90 } })
  })

  it('the listing\'s own Amazon type decides: COAT has no B2B for the account → no business cell, though the family\'s type has', async () => {
    expect((await cellOf('mb-3', 'AMAZON:IT'))!).not.toHaveProperty('business')
  })

  it('DE has no B2B for the account → no business cell; the family parent carries null (no offer of its own)', async () => {
    expect((await cellOf('mb-1', 'AMAZON:DE'))!).not.toHaveProperty('business')
    expect((await cellOf('mb-p', 'AMAZON:IT'))!.business).toBeNull()
  })

  it('the business row never reaches the stock and price lane (the queue fold)', async () => {
    const eu = (await read()).rows.find((r) => r.id === 'mb-1')!.cells['AMAZON:EU']
    expect(eu?.queue?.state ?? 'never').toBe('never')
  })

  it('Part 2 — the IT group serves B2B price and Tiers after Sale; DE (no B2B), the EU inventory group and eBay never do', async () => {
    const coords = (await read()).coordinates
    expect(coords.find((c) => c.key === 'AMAZON:IT')!.cells.slice(-3)).toEqual(['salePrice', 'businessPrice', 'businessTiers'])
    expect(coords.find((c) => c.key === 'AMAZON:IT')!.absent.map((a) => a.cell)).not.toContain('businessPrice')
    expect(coords.find((c) => c.key === 'AMAZON:DE')!.absent.filter((a) => a.cell === 'businessPrice').map((a) => a.reason)).toEqual([MATRIX_COPY.absentBusiness('OUTERWEAR')])
    for (const key of ['AMAZON:DE', 'AMAZON:EU', 'EBAY:IT']) {
      const coord = coords.find((c) => c.key === key)!
      expect(coord.cells, key).not.toContain('businessPrice'); expect(coord.cells, key).not.toContain('businessTiers')
    }
    expect((await cellOf('mb-1', 'EBAY:IT'))!).not.toHaveProperty('business')
  })

  it('Part 2 — writable: a variant with B2B (kept or not); held on the parent, on a listing whose own type has no B2B, and without products.price.edit', async () => {
    const it1 = (await cellOf('mb-1', 'AMAZON:IT'))!
    expect(it1.writable).toMatchObject({ businessPrice: true, businessTiers: true })
    expect((await cellOf('mb-2', 'AMAZON:IT'))!.writable.businessPrice).toBe(true)
    const parent = (await cellOf('mb-p', 'AMAZON:IT'))!
    expect(parent.writable.businessPrice).toBe(false); expect(parent.writeBlockedReason.businessPrice).toBe(PARENT_PRICE_REASON)
    const coat = (await cellOf('mb-3', 'AMAZON:IT'))!
    expect(coat.writable.businessTiers).toBe(false); expect(coat.writeBlockedReason.businessPrice).toBe(MATRIX_COPY.absentBusiness('COAT'))
    const noRight = (await scoped(() => getMatrixRead({ productId: 'mb-p', canEditPrice: false }))).rows.find((r) => r.id === 'mb-1')!.cells['AMAZON:IT']!
    expect(noRight.writable.businessPrice).toBe(false); expect(noRight.writeBlockedReason.businessPrice).toBe(PRICE_PERMISSION_REASON)
  })
})
