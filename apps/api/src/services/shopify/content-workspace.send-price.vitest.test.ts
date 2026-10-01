/**
 * Round 6 (2026-10-01) — the Shopify publisher's variant prices (`readContent`'s `variants[].price`, what content sync
 * creates and updates on Shopify) are THE send price (`listingSendPrice`, the price door's rule).
 *
 * 🔴 WHAT THIS GUARDS. `readContent` priced every following variant at the master price (`p.basePrice`), whatever its
 * rule or its market's currency: a variant at "master +10%" went out at the master, and a market in another currency was
 * sent the EUR number. Now a pin sends its own price, a follower its rule's price from the current master in the master
 * currency, a follower in another currency the price it holds; one that holds none is a publish error by name.
 *
 * On an in-process PostgreSQL (PGlite), the harness of `pim/family-projection-shopify-options.vitest.test.ts`. No Shopify
 * call is made. Every id is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('./admin-client.js', () => ({ shopifyAdmin: async () => { throw new Error('no Shopify call in this test') } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { activeDatabaseTransaction, inDatabaseTransaction } from '../../lib/database-context.js'
import { contentDestination, readContent } from './content-workspace.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ACCOUNT = 'shopify-sendp'

/** A family at master 50 with two variants, and its listings on one Shopify market (`listing` per variant). */
async function seedFamily(prefix: string, market: string, listings: Record<'a' | 'b', Record<string, unknown>>) {
  await prisma.product.create({ data: { id: `${prefix}-family`, sku: `${prefix.toUpperCase()}-FAMILY`, name: prefix, isParent: true, basePrice: 50, variationAxes: ['Colore'] } as never })
  for (const [key, colore] of [['a', 'Nero'], ['b', 'Rosso']] as const) {
    await prisma.product.create({ data: { id: `${prefix}-${key}`, sku: `${prefix.toUpperCase()}-${key.toUpperCase()}`, name: `${prefix}-${key}`, parentId: `${prefix}-family`, basePrice: 50,
      categoryAttributes: { variations: { Colore: colore } } } as never })
  }
  for (const id of [`${prefix}-family`, `${prefix}-a`, `${prefix}-b`]) {
    const own = id.endsWith('-a') ? listings.a : id.endsWith('-b') ? listings.b : {}
    await prisma.channelListing.create({ data: { id: `l-${id}`, productId: id, channel: 'SHOPIFY', marketplace: market, region: 'GLOBAL', channelMarket: `SHOPIFY_${market}`,
      channelConnectionId: ACCOUNT, aliasKey: '', listingStatus: 'DRAFT', ...own } as never })
  }
}
const read = (prefix: string, market: string) => scoped(async () => {
  const destination = await contentDestination(`${prefix}-family`, { accountId: ACCOUNT, market })
  return inDatabaseTransaction(prisma, () => readContent(activeDatabaseTransaction()!, destination))
})

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'SHOPIFY', code: 'GLOBAL', name: 'Shopify GLOBAL', region: 'GLOBAL', currency: 'EUR', language: 'en' } as never })
  await prisma.marketplace.create({ data: { channel: 'SHOPIFY', code: 'UK', name: 'Shopify UK', region: 'GLOBAL', currency: 'GBP', language: 'en' } as never })
  await prisma.channelConnection.create({ data: { id: ACCOUNT, externalAccountId: ACCOUNT, channelType: 'SHOPIFY', isPrimary: true, isActive: true } })
  await seedFamily('sendp-eur', 'GLOBAL', {
    a: { followMasterPrice: true, pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10, price: 55 },
    b: { followMasterPrice: false, priceOverride: 48, price: 48 },
  })
  await seedFamily('sendp-gbp', 'UK', {
    a: { followMasterPrice: true, pricingRule: 'FIXED', price: 42 },
    b: { followMasterPrice: true, pricingRule: 'FIXED', price: null },
  })
}), 60_000)
afterAll(async () => { await state.db?.close?.() })

describe('🔴 the Shopify publisher prices each variant at its send price', () => {
  it('a variant at "master +10%" is 55.00 (it was the master 50); a pinned one its own 48.00; no publish error', async () => {
    const data = await read('sendp-eur', 'GLOBAL')
    expect(Object.fromEntries(data.variants.map((v) => [v.id, v.price]))).toEqual({ 'sendp-eur-a': '55.00', 'sendp-eur-b': '48.00' })
    expect(data.errors.filter((e) => /price/i.test(e))).toEqual([])
  })

  it('🔴 Shopify UK (GBP): a follower holding its own 42.00 is 42.00; one holding none is refused by name — never the EUR master as pounds', async () => {
    const data = await read('sendp-gbp', 'UK')
    expect(data.variants.find((v) => v.id === 'sendp-gbp-a')?.price).toBe('42.00')
    expect(data.variants.find((v) => v.id === 'sendp-gbp-b')?.price).toBe('')
    expect(data.errors).toContain('SENDP-GBP-B: Shopify UK sells in GBP, and this listing follows the master price in EUR. Nexus does not convert it. Set this listing\'s own GBP price.')
  })
})
