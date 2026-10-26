/**
 * The Listing window's link (`/listings?listing=<id>`, live layer step 5): where one listing sits on the page — its
 * product, the family root and the chip's destination, by the live layer's join rule — on a real PostgreSQL (PGlite).
 * Ids invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { readinessListingTarget } from './listing-readiness-link.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const key = (c: (string | null)[]) => JSON.stringify(c)
const computedAt = new Date('2026-10-25T08:00:00Z')
const index = (productId: string, c: (string | null)[]) => ({
  productId, coordinateKey: key(c), channel: c[0], market: c[1], accountId: c[2], aliasId: c[3], language: 'it',
  label: 'Amazon · UK', pct: null, state: 'ready', requiredFilled: 0, requiredTotal: 0, missing: [], note: null, computedAt,
})
const listing = (id: string, productId: string, marketplace: string, accountId: string | null, aliasId: string | null = null) => ({
  id, productId, channel: 'AMAZON', marketplace, channelConnectionId: accountId, aliasId, aliasKey: aliasId ?? '', channelMarket: `AMAZON_${marketplace}`, region: marketplace,
  externalListingId: `ll-${id}`, listingStatus: 'ACTIVE' as const, isPublished: true,
})

beforeAll(() => scoped(async () => {
  await prisma.channelConnection.create({ data: { id: 'll-a1', channelType: 'AMAZON', isActive: true, accountLabel: 'Xavia', externalAccountId: 'seller-ll' } as never })
  await prisma.product.create({ data: { id: 'll-root', sku: 'GALE', name: 'Gale jacket', basePrice: 10, isParent: true, status: 'DRAFT' } })
  await prisma.product.create({ data: { id: 'll-v1', sku: 'GALE-M', name: 'Gale M', basePrice: 10, parentId: 'll-root', status: 'DRAFT' } })
  await prisma.productListingAlias.create({ data: { id: 'll-alias', productId: 'll-v1', channel: 'AMAZON', marketplace: 'UK', channelConnectionId: 'll-a1', label: 'Second' } as never })
  await prisma.readinessIndex.createMany({ data: [index('ll-v1', ['AMAZON', 'UK', 'll-a1', null]), index('ll-v1', ['AMAZON', 'DE', 'll-a1', null])] as never })
  await prisma.channelListing.create({ data: listing('ll-gb', 'll-v1', 'GB', 'll-a1') as never })
  await prisma.channelListing.create({ data: listing('ll-fr', 'll-v1', 'FR', 'll-a1') as never })
  await prisma.channelListing.create({ data: listing('ll-none', 'll-v1', 'DE', null) as never })
  await prisma.channelListing.create({ data: listing('ll-second', 'll-v1', 'UK', 'll-a1', 'll-alias') as never })
}), 120_000)
afterAll(async () => { await state.db?.close() })

describe('the listing link', () => {
  it('names the product, its family root and the index destination (a GB listing is the UK coordinate)', async () => {
    expect(await scoped(() => readinessListingTarget('ll-gb'))).toEqual({
      productId: 'll-v1', rootId: 'll-root', destinationKey: key(['AMAZON', 'UK', 'll-a1', null]), sku: 'GALE-M', name: 'Gale M',
    })
  })
  it('a listing on no readiness destination opens on its own key — the extra chip the page shows for it', async () => {
    expect((await scoped(() => readinessListingTarget('ll-fr'))).destinationKey).toBe(key(['AMAZON', 'FR', 'll-a1', null]))
  })
  it('the account must agree: a listing with none is never put on a store’s chip', async () => {
    expect((await scoped(() => readinessListingTarget('ll-none'))).destinationKey).toBe(key(['AMAZON', 'DE', null, null]))
  })
  it('a second listing (an alias) is its own destination', async () => {
    expect((await scoped(() => readinessListingTarget('ll-second'))).destinationKey).toBe(key(['AMAZON', 'UK', 'll-a1', 'll-alias']))
  })
  it('an unknown listing is a 404', async () => {
    await expect(scoped(() => readinessListingTarget('nope'))).rejects.toMatchObject({ statusCode: 404, message: 'Listing not found' })
    await expect(scoped(() => readinessListingTarget(''))).rejects.toMatchObject({ statusCode: 404 })
  })
})
