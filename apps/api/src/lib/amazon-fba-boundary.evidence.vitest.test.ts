/**
 * D8 — `fbaSkusAmong` on real PostgreSQL (PGlite, production schema and policies): the seller-SKU lookups (offer,
 * mirror keys, flat-file snapshot), the account scope, other markets, FBA stock and the active FBA offer, each with an
 * FBM control on the same query.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from './workspace-context.js'
import { assertNoMerchantQuantityForFba, fbaSkusAmong } from './amazon-fba-boundary.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let account = ''
let otherAccount = ''
let fbaPool = ''

type Seed = { marketplace: string; account?: string | null; method?: 'FBA' | 'FBM'; code?: string; platformAttributes?: Record<string, unknown>; flatFileSnapshot?: Record<string, unknown>; offer?: { sku: string; method: 'FBA' | 'FBM'; active: boolean } }
async function seed(sku: string, listings: Seed[], product: { method?: 'FBA' | 'FBM'; fbaStock?: number } = {}) {
  const created = await prisma.product.create({ data: { sku, name: sku, basePrice: 10, status: 'ACTIVE', fulfillmentMethod: product.method ?? 'FBM' } })
  if (product.fbaStock !== undefined) await prisma.stockLevel.create({ data: { productId: created.id, locationId: fbaPool, quantity: product.fbaStock, available: product.fbaStock } })
  for (const l of listings) {
    const row = await prisma.channelListing.create({ data: {
      productId: created.id, channel: 'AMAZON', marketplace: l.marketplace, region: l.marketplace, channelMarket: `AMAZON_${l.marketplace}`,
      channelConnectionId: l.account === undefined ? account : l.account, aliasKey: '', fulfillmentMethod: l.method ?? 'FBM',
      platformAttributes: { ...(l.code ? { fulfillment_availability: [{ fulfillment_channel_code: l.code }] } : {}), ...l.platformAttributes },
      ...(l.flatFileSnapshot ? { flatFileSnapshot: l.flatFileSnapshot } : {}),
    } as never })
    if (l.offer) await prisma.offer.create({ data: { channelListingId: row.id, sku: l.offer.sku, fulfillmentMethod: l.offer.method, isActive: l.offer.active } })
  }
}

beforeAll(() => scoped(async () => {
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'fba-boundary-a', externalAccountId: 'MERCHANT-A', isActive: true, isPrimary: true } as never })).id
  otherAccount = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'fba-boundary-b', externalAccountId: 'MERCHANT-B', isActive: true, isPrimary: false } as never })).id
  fbaPool = (await prisma.stockLocation.create({ data: { code: 'AMAZON-EU-FBA', name: 'Amazon EU FBA', type: 'AMAZON_FBA' } })).id
  await seed('PLAIN-FBM', [{ marketplace: 'IT', code: 'DEFAULT' }])
  await seed('FLAG-FBA', [{ marketplace: 'IT' }], { method: 'FBA' })
  await seed('STOCK-FBA', [{ marketplace: 'IT' }], { fbaStock: 3 })
  await seed('STOCK-ZERO', [{ marketplace: 'IT' }], { fbaStock: 0 })
  await seed('DE-FBA', [{ marketplace: 'IT', code: 'DEFAULT' }, { marketplace: 'DE', code: 'AMAZON_EU' }])
  await seed('DE-FBA-OTHER-ACCOUNT', [{ marketplace: 'IT', code: 'DEFAULT' }, { marketplace: 'DE', code: 'AMAZON_EU', account: otherAccount }])
  await seed('DE-FBA-UNATTRIBUTED', [{ marketplace: 'IT', code: 'DEFAULT' }, { marketplace: 'DE', method: 'FBA', account: null }])
  await seed('OFFER-FBA', [{ marketplace: 'IT', offer: { sku: 'OFFER-FBA-SELLER', method: 'FBA', active: true } }])
  await seed('OFFER-OLD-FBA', [{ marketplace: 'IT', offer: { sku: 'OFFER-OLD-SELLER', method: 'FBA', active: false } }])
  await seed('MIRROR-FBA', [{ marketplace: 'IT', method: 'FBA', platformAttributes: { sellerSku: 'MIRROR-FBA-SELLER' } }])
  await seed('MIRROR-FBM', [{ marketplace: 'IT', platformAttributes: { seller_sku: 'MIRROR-FBM-SELLER' } }])
  await seed('FLAT-FBA', [{ marketplace: 'IT', code: 'AMAZON_EU_RAFN', flatFileSnapshot: { item_sku: 'FLAT-FBA-SELLER' } }])
}), 120_000)
afterAll(async () => { await state.db?.close() })

describe('fbaSkusAmong on PostgreSQL', () => {
  it('product flag, FBA stock, another market on this account, an unattributed row: FBA; zero stock and another account: not', () => scoped(async () => {
    expect(await fbaSkusAmong(['PLAIN-FBM', 'FLAG-FBA', 'STOCK-FBA', 'STOCK-ZERO', 'DE-FBA', 'DE-FBA-OTHER-ACCOUNT', 'DE-FBA-UNATTRIBUTED'], account))
      .toEqual(new Set(['FLAG-FBA', 'STOCK-FBA', 'DE-FBA', 'DE-FBA-UNATTRIBUTED']))
  }))

  it('a seller SKU resolves through the offer, the mirror keys and the flat-file snapshot', () => scoped(async () => {
    expect(await fbaSkusAmong(['OFFER-FBA-SELLER', 'OFFER-OLD-SELLER', 'MIRROR-FBA-SELLER', 'MIRROR-FBM-SELLER', 'FLAT-FBA-SELLER'], account))
      .toEqual(new Set(['OFFER-FBA-SELLER', 'MIRROR-FBA-SELLER', 'FLAT-FBA-SELLER']))
  }))

  it('a seller SKU only another account\'s listing carries is claimed by no product here: refused', () => scoped(async () => {
    expect(await fbaSkusAmong(['MIRROR-FBM-SELLER'], otherAccount)).toEqual(new Set(['MIRROR-FBM-SELLER']))
  }))

  it('the guard refuses the FBA SKUs of a feed by name and passes the FBM one', () => scoped(async () => {
    const feed = { messages: ['PLAIN-FBM', 'STOCK-FBA', 'MIRROR-FBA-SELLER'].map(sku => ({ sku, attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 4 }] } })) }
    await expect(assertNoMerchantQuantityForFba(feed, account)).rejects.toMatchObject({ notSent: true,
      message: 'STOCK-FBA, MIRROR-FBA-SELLER are fulfilled by Amazon (FBA) — a merchant quantity would switch them to FBM.' })
    await expect(assertNoMerchantQuantityForFba({ messages: [feed.messages[0]] }, account)).resolves.toBeUndefined()
  }))
})
