/**
 * Amazon sheet gaps (D4 = B) — a product sheet price or sale saved on a live Amazon listing waits for Publish
 * (`platformAttributes.amazonOfferDraft`). The Matrix's Price and Sale cells keep the LIVE value (what the price push
 * reads) and carry the saved one as `waiting`, for the tooltip line only (`MATRIX_COPY.waitingForPublish`).
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

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { getMatrixRead } from './matrix.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const leaf = (value: unknown, base: unknown) => ({ value, base, savedAt: '2026-10-02T08:00:00.000Z', savedBy: 'sheet@example.test' })
const draft = (leaves: Record<string, unknown>) => ({ amazonOfferDraft: { v: 1, leaves } })

beforeAll(() => scoped(async () => {
  for (const [channel, code] of [['AMAZON', 'IT'], ['AMAZON', 'DE'], ['EBAY', 'IT']] as const) {
    await prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  }
  const acc: Record<string, string> = {}
  for (const channel of ['AMAZON', 'EBAY']) acc[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `waiting-${channel}`, isActive: true, isPrimary: true } as never })).id
  await prisma.product.create({ data: { id: 'w-p', sku: 'TEST-W-P', name: 'w', basePrice: 49.9, isParent: true } as never })
  await prisma.product.create({ data: { id: 'w-c', sku: 'TEST-W-C', name: 'w', basePrice: 49.9, parentId: 'w-p' } as never })
  const listing = (productId: string, channel: string, marketplace: string, platformAttributes: unknown) => prisma.channelListing.create({ data: {
    productId, channel, marketplace, channelMarket: `${channel}_${marketplace}`, region: 'EU', channelConnectionId: acc[channel],
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: `EXT-${productId}-${channel}-${marketplace}`,
    price: 49.9, priceOverride: 49.9, followMasterPrice: false, quantity: 5, platformAttributes,
  } as never })
  await listing('w-p', 'AMAZON', 'IT', draft({ our_price: leaf({ pin: 1 }, { pin: 2 }) }))
  await listing('w-c', 'AMAZON', 'IT', draft({
    our_price: leaf({ pin: 44.9 }, { pin: 49.9 }),
    sale: leaf({ price: 39.9, start: '2026-10-10', end: '2026-10-20' }, null),
  }))
  await listing('w-c', 'AMAZON', 'DE', draft({ our_price: leaf({ follow: true }, { pin: 49.9 }), sale: leaf(null, { price: 30, start: '2026-10-01', end: '2026-10-31' }) }))
  await listing('w-c', 'EBAY', 'IT', { itemSpecifics: {} })
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

describe('the Matrix shows a saved-but-unpublished price beside the live one', () => {
  it('Price and Sale keep the live value; `waiting` carries the saved pin and sale', async () => {
    const read = await scoped(() => getMatrixRead({ productId: 'w-p', canEditPrice: true }))
    const it = read.rows.find((r) => r.id === 'w-c')!.cells['AMAZON:IT']!
    expect(it.price).toMatchObject({ value: 49.9, source: 'override', waiting: { value: 44.9 } })
    expect(it.sale).toEqual({ value: null, start: null, end: null, waiting: { value: 39.9, start: '2026-10-10', end: '2026-10-20' } })
  })

  it('a saved "follow the rule again" waits as value null; a saved sale removal waits as an empty sale', async () => {
    const read = await scoped(() => getMatrixRead({ productId: 'w-p', canEditPrice: true }))
    const de = read.rows.find((r) => r.id === 'w-c')!.cells['AMAZON:DE']!
    expect(de.price).toMatchObject({ value: 49.9, waiting: { value: null } })
    expect(de.sale!.waiting).toEqual({ value: null, start: null, end: null })
  })

  it('no draft → no `waiting` at all (eBay, and the parent, which has no offer)', async () => {
    const read = await scoped(() => getMatrixRead({ productId: 'w-p', canEditPrice: true }))
    const ebay = read.rows.find((r) => r.id === 'w-c')!.cells['EBAY:IT']!
    expect('waiting' in ebay.price!).toBe(false)
    const parent = read.rows.find((r) => r.id === 'w-p')!.cells['AMAZON:IT']!
    expect(parent.price!.waiting).toBeUndefined()
    expect(parent.sale!.waiting).toBeUndefined()
  })
})
