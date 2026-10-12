/**
 * Amazon Business step 1 — the Matrix's B2B sentence comes from what Amazon told THE COORDINATE'S ACCOUNT (a seller-scoped
 * definition kept as a `SellerReferenceLabel` row), never from the shared CategorySchema cache, which Amazon answers
 * without the B2B audience. Measured 2026-10-12: the cache said `["ALL"]` while the seller definition said `["B2B","ALL"]`.
 *
 * Real Matrix read over a real PostgreSQL in-process (PGlite). Every id and SKU is invented.
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
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { OFFER_AUDIENCE_FIELD_KEY } from '../categories/seller-offer-audience.service.js'
import { getMatrixRead } from './matrix.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

beforeAll(() => scoped(async () => {
  for (const code of ['IT', 'DE', 'FR']) {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  }
  const account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'b2b-amazon', isActive: true, isPrimary: true } as never })).id
  await prisma.product.create({ data: { id: 'b-p', sku: 'TEST-B-P', name: 'b', basePrice: 99, isParent: true, productType: 'OUTERWEAR' } as never })
  await prisma.product.create({ data: { id: 'b-c', sku: 'TEST-B-C', name: 'b', basePrice: 99, parentId: 'b-p', productType: 'OUTERWEAR' } as never })
  for (const marketplace of ['IT', 'DE', 'FR']) {
    await prisma.channelListing.create({ data: {
      productId: 'b-c', channel: 'AMAZON', marketplace, channelMarket: `AMAZON_${marketplace}`, region: 'EU', channelConnectionId: account,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `EXT-b-c-${marketplace}`, price: 99, quantity: 3,
    } as never })
  }
  // The shared cache says ALL only (what Amazon answers without sellerId) — it must not decide.
  await prisma.categorySchema.create({ data: {
    channel: 'AMAZON', marketplace: 'IT', productType: 'OUTERWEAR', schemaVersion: 'shared-1', expiresAt: new Date(Date.now() + 86_400_000),
    schemaDefinition: { properties: { purchasable_offer: { items: { properties: { audience: { enum: ['ALL'] } } } } } },
  } as never })
  const kept = (marketplace: string, labels: Record<string, string>) => prisma.sellerReferenceLabel.create({ data: {
    channel: 'AMAZON', connectionId: account, marketplace, productType: 'OUTERWEAR', fieldKey: OFFER_AUDIENCE_FIELD_KEY, labels,
  } as never })
  await kept('IT', { B2B: 'Amazon Business (B2B)', ALL: 'Vendita su Amazon' })
  await kept('DE', { ALL: 'Bei Amazon verkaufen' })
  // FR: never measured.
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

describe('business pricing absence follows the account\'s seller-scoped definition', () => {
  const reasonOf = async (key: string) => {
    const read = await scoped(() => getMatrixRead({ productId: 'b-p', canEditPrice: true }))
    const coord = read.coordinates.find((c) => c.key === key)!
    return coord.absent.filter((a) => a.cell === 'businessPrice' || a.cell === 'businessTiers').map((a) => a.reason)
  }

  it('IT: the account may sell to business buyers → "allowed, not built yet", although the shared cache says ALL only', async () => {
    expect(await reasonOf('AMAZON:IT')).toEqual([MATRIX_COPY.absentBusinessNotBuilt('OUTERWEAR'), MATRIX_COPY.absentBusinessNotBuilt('OUTERWEAR')])
  })

  it('DE: measured without B2B → "Amazon has not enabled business pricing"', async () => {
    expect(await reasonOf('AMAZON:DE')).toEqual([MATRIX_COPY.absentBusiness('OUTERWEAR'), MATRIX_COPY.absentBusiness('OUTERWEAR')])
  })

  it('FR: never measured → the unchecked sentence, never a false "checked against"', async () => {
    const reasons = await reasonOf('AMAZON:FR')
    expect(reasons).toEqual([MATRIX_COPY.absentBusinessUnchecked(), MATRIX_COPY.absentBusinessUnchecked()])
    expect(reasons[0]).not.toContain('checked against')
  })
})
