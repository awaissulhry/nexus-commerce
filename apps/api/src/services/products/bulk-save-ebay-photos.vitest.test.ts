/**
 * Owner 2026-10-05 — Product media is the one photo source of an eBay listing; one list at a time, the last save wins.
 * A sheet save (or Claude's set-listing-fields, the same row writer) of the eBay "Image URLs" field removes the listing's
 * Product media (the field's `replaces`) and, in the SAME transaction, settles the list (`settleAndAnnounce`): a list of
 * media-library photos becomes the listing's Product media in that order; a list with any other address stays the Image
 * URLs list, and nothing is added to any library. Proven on a real PostgreSQL with the production schema (PGlite), through
 * both writers of `POST /products/bulk-save`: the set-based batch and the row path.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, batches: 0 }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn(async () => ({ enqueued: true })) }))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../listing-events.service.js', async importOriginal => ({ ...(await importOriginal<object>()), publishListingEvent: vi.fn() }))
vi.mock('./bulk-edit-platform-batch.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./bulk-edit-platform-batch.js')>()
  return { ...actual, writePlatformBatch: async (...args: Parameters<typeof actual.writePlatformBatch>) => { state.batches++; return actual.writePlatformBatch(...args) } }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { publishListingEvent } from '../listing-events.service.js'
import { applyProductBulkSave, type BulkSaveUnit } from './bulk-save.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const logger = { warn: vi.fn(), error: vi.fn() }
const OUTSIDE = 'https://example.invalid/outside/side.jpg'
const OWN_MEDIA = { und: { _productMedia: { version: 1, items: [{ assetId: 'kept-elsewhere' }] } } }
let account: string
let sequence = 0

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
    account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'synthetic-photo-account', isActive: true } })).id
  })
}, 60_000)
afterAll(async () => { await state.db?.close() })
beforeEach(() => { vi.mocked(publishListingEvent).mockClear() })

/** A family (main product + variations), each on eBay IT with its own Product media; two photos in the main product's library. */
async function family(size: number) {
  const root = `photo-family-${++sequence}`
  const ids = Array.from({ length: size }, (_, i) => `${root}-${i}`)
  const [front, back] = await scoped(async () => {
    await prisma.product.create({ data: { id: root, sku: root, name: root, basePrice: 10, isParent: true } })
    await prisma.product.createMany({ data: ids.map(id => ({ id, sku: id, name: id, basePrice: 10, parentId: root })) })
    await prisma.channelListing.createMany({ data: [root, ...ids].map(productId => ({ id: `l-${productId}`, productId, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT',
      region: 'EU', channelConnectionId: account, platformAttributes: { subtitle: 'kept', _productMediaLocales: OWN_MEDIA } })) })
    return Promise.all(['front', 'back'].map((name, sortOrder) => prisma.productImage.create({ data: { productId: root, url: `https://example.invalid/library/${root}-${name}.jpg`, type: sortOrder ? 'ALT' : 'MAIN', sortOrder } })))
  })
  const unit = (id: string, value: unknown, extra: Partial<BulkSaveUnit> = {}, change: Partial<BulkSaveUnit['changes'][number]> = {}): BulkSaveUnit => ({ key: id, expectedVersion: 1,
    marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT', accountId: account, locale: 'it' }],
    changes: [{ id, field: 'attr_imageUrls', value, target: 'channel', intent: 'set', ...change }], ...extra })
  return { root, ids, front, back, unit }
}
const save = (units: BulkSaveUnit[]) => scoped(() => applyProductBulkSave({ units }, { formulaCascade: false, userId: null, logger: logger as never }))
const listing = (productId: string) => scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id: `l-${productId}` } }))
const libraryCount = (productIds: string[]) => scoped(() => prisma.productImage.count({ where: { productId: { in: productIds } } }))
const products = (productIds: string[]) => scoped(() => prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, version: true, localizedContent: true }, orderBy: { id: 'asc' } }))
const items = (attributes: unknown) => ((attributes as any)?._productMediaLocales?.und?._productMedia?.items ?? []).map((item: { assetId: string }) => item.assetId)

it('the batch writer: a list of library photos becomes Product media in its order; a list with an outside address stays Image URLs; tokens answer', async () => {
  const f = await family(2)
  const productsBefore = await products([f.root, ...f.ids])
  const before = state.batches
  const result = await save([f.unit(f.ids[0], [f.back.url, f.front.url]), f.unit(f.ids[1], [f.front.url, OUTSIDE])])
  expect(state.batches).toBe(before + 1)
  expect(result.failed, JSON.stringify(result.units)).toBe(0)
  const settled = await listing(f.ids[0]), kept = await listing(f.ids[1])
  expect(settled.platformAttributes).toEqual({ subtitle: 'kept', _productMediaLocales: { und: { _productMedia: { version: 1, items: [{ assetId: f.back.id }, { assetId: f.front.id }] } } } })
  // The other list replaced the listing's Product media and stays as written.
  expect(kept.platformAttributes).toEqual({ subtitle: 'kept', imageUrls: [f.front.url, OUTSIDE] })
  // Nothing was added to a library, and no product moved: only the listings were written.
  expect(await libraryCount([f.root, ...f.ids])).toBe(2)
  expect(await products([f.root, ...f.ids])).toEqual(productsBefore)
  for (const row of [settled, kept]) expect(result.units.find(u => u.key === row.productId)?.body).toMatchObject({ currentVersion: row.version, versionOf: 'channelListing' })
  // Open sheets hear the settled family once, after the commit.
  expect(vi.mocked(publishListingEvent).mock.calls.map(([event]) => event)).toEqual([expect.objectContaining({ type: 'product.media.changed', productId: f.root, layer: 'GALLERY' })])
  // The answered token is the stored one: the next save of the same rows is not a conflict.
  const next = await save(f.ids.map(id => f.unit(id, [f.front.url], { expectedVersion: Number(result.units.find(u => u.key === id)!.body.currentVersion) })))
  expect(next.failed, JSON.stringify(next.units)).toBe(0)
  for (const id of f.ids) expect(items((await listing(id)).platformAttributes)).toEqual([f.front.id])
}, 120_000)

it('the row writer (one row, as Claude\'s set-listing-fields writes): the same two outcomes, the answered token is the stored one', async () => {
  const f = await family(1)
  const before = state.batches
  const settled = await save([f.unit(f.ids[0], [f.back.url])])
  expect(state.batches).toBe(before)
  expect(settled.failed, JSON.stringify(settled.units)).toBe(0)
  let row = await listing(f.ids[0])
  expect(row.platformAttributes).toEqual({ subtitle: 'kept', _productMediaLocales: { und: { _productMedia: { version: 1, items: [{ assetId: f.back.id }] } } } })
  expect(settled.units[0].body).toMatchObject({ currentVersion: row.version, versionOf: 'channelListing' })
  expect(vi.mocked(publishListingEvent)).toHaveBeenCalledWith(expect.objectContaining({ type: 'product.media.changed', productId: f.root }))
  vi.mocked(publishListingEvent).mockClear()
  const kept = await save([f.unit(f.ids[0], [OUTSIDE, f.back.url], { expectedVersion: row.version })])
  expect(kept.failed, JSON.stringify(kept.units)).toBe(0)
  row = await listing(f.ids[0])
  expect(row.platformAttributes).toEqual({ subtitle: 'kept', imageUrls: [OUTSIDE, f.back.url] })
  expect(kept.units[0].body).toMatchObject({ currentVersion: row.version, versionOf: 'channelListing' })
  expect(await libraryCount([f.root, ...f.ids])).toBe(2)
  expect(vi.mocked(publishListingEvent)).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'product.media.changed' }))
}, 120_000)

it('a dry run writes nothing; a reset removes both lists (the listing shows the shared Product media)', async () => {
  const f = await family(1)
  const dry = await save([f.unit(f.ids[0], [f.front.url], { dryRun: true })])
  expect(dry.failed, JSON.stringify(dry.units)).toBe(0)
  expect((await listing(f.ids[0])).platformAttributes).toEqual({ subtitle: 'kept', _productMediaLocales: OWN_MEDIA })
  const reset = await save([f.unit(f.ids[0], null, {}, { intent: 'reset' })])
  expect(reset.failed, JSON.stringify(reset.units)).toBe(0)
  expect((await listing(f.ids[0])).platformAttributes).toEqual({ subtitle: 'kept' })
  expect(await libraryCount([f.root, ...f.ids])).toBe(2)
  expect(vi.mocked(publishListingEvent)).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'product.media.changed' }))
}, 120_000)
