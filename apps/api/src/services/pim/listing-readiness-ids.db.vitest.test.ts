/**
 * The bulk bar's reach (`POST /api/catalog-transfer/readiness/listing-ids`, live layer step 6): which listings a price
 * action on the selected products reaches, on a real PostgreSQL (PGlite). Ids invented.
 *
 * The family: GALE (parent, own Amazon DE listing) with GALE-M (Amazon DE + a second listing there, Amazon UK as "GB", eBay IT)
 * and GALE-L (a readiness row on Amazon DE, no listing there). A single product SOLO is listed on Amazon DE.
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
import { listingIdsInput, parseDestinationKey, readinessListingIds } from './listing-readiness-ids.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const key = (c: (string | null)[]) => JSON.stringify(c)
const DE = key(['AMAZON', 'DE', 'ri-a1', null])
const UK = key(['AMAZON', 'UK', 'ri-a1', null])
const IT_EBAY = key(['EBAY', 'IT', 'ri-e1', null])
const SHARED = key([null, null, null, null])
const DE_ALIAS = key(['AMAZON', 'DE', 'ri-a1', 'ri-alias'])
const computedAt = new Date('2026-10-25T08:00:00Z')
const index = (productId: string, c: (string | null)[]) => ({
  productId, coordinateKey: key(c), channel: c[0], market: c[1], accountId: c[2], aliasId: c[3], language: 'de',
  label: 'Amazon · DE', pct: null, state: 'ready', requiredFilled: 0, requiredTotal: 0, missing: [], note: null, computedAt,
})
const listing = (id: string, productId: string, channel: string, marketplace: string, accountId: string | null, aliasId: string | null = null) => ({
  id, productId, channel, marketplace, channelConnectionId: accountId, aliasId, aliasKey: aliasId ?? '', channelMarket: `${channel}_${marketplace}`, region: marketplace,
  externalListingId: `ext-${id}`, listingStatus: 'ACTIVE' as const, isPublished: true,
})
const marketplace = (channel: string, code: string, currency: string) => ({ channel, code, name: `${channel} ${code}`, region: 'EU', currency, language: 'en' })

beforeAll(() => scoped(async () => {
  await prisma.channelConnection.create({ data: { id: 'ri-a1', channelType: 'AMAZON', isActive: true, accountLabel: 'Xavia', externalAccountId: 'seller-ri' } as never })
  await prisma.channelConnection.create({ data: { id: 'ri-e1', channelType: 'EBAY', isActive: true, accountLabel: 'Xavia eBay', externalAccountId: 'ebay-ri' } as never })
  await prisma.marketplace.createMany({ data: [marketplace('AMAZON', 'DE', 'EUR'), marketplace('AMAZON', 'UK', 'GBP'), marketplace('EBAY', 'IT', 'EUR')] as never })
  await prisma.product.create({ data: { id: 'ri-root', sku: 'GALE', name: 'Gale jacket', basePrice: 10, isParent: true, status: 'DRAFT' } })
  await prisma.product.create({ data: { id: 'ri-m', sku: 'GALE-M', name: 'Gale M', basePrice: 10, parentId: 'ri-root', status: 'DRAFT' } })
  await prisma.product.create({ data: { id: 'ri-l', sku: 'GALE-L', name: 'Gale L', basePrice: 10, parentId: 'ri-root', status: 'DRAFT' } })
  await prisma.product.create({ data: { id: 'ri-solo', sku: 'SOLO', name: 'Solo', basePrice: 10, status: 'DRAFT' } })
  await prisma.product.create({ data: { id: 'ri-gone', sku: 'GONE', name: 'Gone', basePrice: 10, status: 'DRAFT', deletedAt: new Date() } })
  await prisma.productListingAlias.create({ data: { id: 'ri-alias', productId: 'ri-m', channel: 'AMAZON', marketplace: 'DE', channelConnectionId: 'ri-a1', label: 'Second' } as never })
  await prisma.readinessIndex.createMany({ data: [
    index('ri-root', ['AMAZON', 'DE', 'ri-a1', null]),
    index('ri-m', ['AMAZON', 'DE', 'ri-a1', null]), index('ri-m', ['AMAZON', 'UK', 'ri-a1', null]), index('ri-m', ['EBAY', 'IT', 'ri-e1', null]),
    index('ri-l', ['AMAZON', 'DE', 'ri-a1', null]),
    index('ri-solo', ['AMAZON', 'DE', 'ri-a1', null]),
  ] as never })
  await prisma.channelListing.create({ data: listing('ri-root-de', 'ri-root', 'AMAZON', 'DE', 'ri-a1') as never })
  await prisma.channelListing.create({ data: listing('ri-m-de', 'ri-m', 'AMAZON', 'DE', 'ri-a1') as never })
  await prisma.channelListing.create({ data: listing('ri-m-gb', 'ri-m', 'AMAZON', 'GB', 'ri-a1') as never })
  await prisma.channelListing.create({ data: listing('ri-m-it', 'ri-m', 'EBAY', 'IT', 'ri-e1') as never })
  await prisma.channelListing.create({ data: listing('ri-m-de-2', 'ri-m', 'AMAZON', 'DE', 'ri-a1', 'ri-alias') as never })
  await prisma.channelListing.create({ data: listing('ri-solo-de', 'ri-solo', 'AMAZON', 'DE', 'ri-a1') as never })
  // No account recorded: the live layer shows it as a chip of its own, never on the store's.
  await prisma.channelListing.create({ data: listing('ri-solo-none', 'ri-solo', 'AMAZON', 'DE', null) as never })
  await prisma.channelListing.create({ data: listing('ri-gone-de', 'ri-gone', 'AMAZON', 'DE', 'ri-a1') as never })
}), 120_000)
afterAll(async () => { await state.db?.close() })

describe('which listings a price action reaches', () => {
  it('a family row reaches its variants’ listings there, never the parent’s own; a variant without one is not listed there', async () => {
    const answer = await scoped(() => readinessListingIds({ productIds: ['ri-root'], destinationKeys: [DE] }))
    expect(answer.listingIds).toEqual(['ri-m-de'])
    expect(answer.products).toBe(1)
    expect(answer.missing).toBe(1) // GALE-L belongs on Amazon DE and has no listing
    expect(answer.currencies).toEqual(['EUR'])
    expect(answer.productIds).toEqual(['ri-l', 'ri-m', 'ri-root'])
  })
  it('a GB listing is the UK destination; another market or channel is not reached', async () => {
    const answer = await scoped(() => readinessListingIds({ productIds: ['ri-m'], destinationKeys: [UK] }))
    expect(answer.listingIds).toEqual(['ri-m-gb'])
    expect(answer.currencies).toEqual(['GBP'])
    expect(answer.missing).toBe(0)
  })
  it('several destinations: every listing there, with each market’s currency once', async () => {
    const answer = await scoped(() => readinessListingIds({ productIds: ['ri-root', 'ri-solo'], destinationKeys: [DE, UK, IT_EBAY] }))
    expect(answer.listingIds.sort()).toEqual(['ri-m-de', 'ri-m-gb', 'ri-m-it', 'ri-solo-de'])
    expect(answer.products).toBe(2)
    expect(answer.currencies.sort()).toEqual(['EUR', 'GBP'])
  })
  it('the account must agree (the live layer’s rule): a listing with none is not on the store’s destination', async () => {
    const answer = await scoped(() => readinessListingIds({ productIds: ['ri-solo'], destinationKeys: [DE] }))
    expect(answer.listingIds).toEqual(['ri-solo-de'])
    const own = await scoped(() => readinessListingIds({ productIds: ['ri-solo'], destinationKeys: [key(['AMAZON', 'DE', null, null])] }))
    expect(own.listingIds).toEqual(['ri-solo-none'])
  })
  it('Shared and alias destinations reach nothing; a deleted product is not a product', async () => {
    const answer = await scoped(() => readinessListingIds({ productIds: ['ri-solo', 'ri-gone'], destinationKeys: [SHARED, DE_ALIAS] }))
    expect(answer).toEqual({ listingIds: [], products: 0, missing: 0, aliases: 0, currencies: [], productIds: ['ri-solo'] })
  })
  it('no destination: only the products the selection covers', async () => {
    const answer = await scoped(() => readinessListingIds({ productIds: ['ri-root'] }))
    expect(answer.listingIds).toEqual([])
    expect(answer.productIds).toEqual(['ri-l', 'ri-m', 'ri-root'])
  })
  it('a second (alias) listing on the destination is left out and counted', async () => {
    const answer = await scoped(() => readinessListingIds({ productIds: ['ri-m'], destinationKeys: [DE] }))
    expect(answer.listingIds).toEqual(['ri-m-de'])
    expect(answer.aliases).toBe(1)
  })
})

describe('the request is checked', () => {
  it('refuses no products, too many, and keys that are not destinations', () => {
    expect(() => listingIdsInput({ productIds: [] })).toThrow('Choose 1–1,000 products')
    expect(() => listingIdsInput({ productIds: Array.from({ length: 1001 }, (_, i) => `p${i}`) })).toThrow('Choose 1–1,000 products')
    expect(() => listingIdsInput({ productIds: ['p'], destinationKeys: Array.from({ length: 201 }, () => DE) })).toThrow('at most 200')
    expect(() => parseDestinationKey('AMAZON DE')).toThrow('Choose destinations from the Listings page')
    expect(() => parseDestinationKey(JSON.stringify(['amazon', 'DE', null, null]))).toThrow('Choose destinations from the Listings page')
    expect(() => parseDestinationKey(JSON.stringify(['AMAZON', 'DE', null]))).toThrow('Choose destinations from the Listings page')
  })
  it('the refusal is a 400', () => {
    let refusal: unknown = null
    try { listingIdsInput({}) } catch (error) { refusal = error }
    expect(refusal).toMatchObject({ statusCode: 400 })
  })
  it('one spelling per destination: GB is UK; Shared and aliases are dropped', () => {
    const { destinations, productIds } = listingIdsInput({ productIds: [' a ', 'a', 'b'], destinationKeys: [key(['AMAZON', 'GB', 'ri-a1', null]), UK, SHARED, DE_ALIAS] })
    expect([...destinations.keys()]).toEqual([UK])
    expect(productIds).toEqual(['a', 'b'])
  })
})
