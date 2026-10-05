/**
 * Owner 2026-10-05 — Product media is the one photo source of an eBay listing; one list at a time, the last save wins.
 * A sheet save (or Claude's set-listing-fields, the same row writer) of the eBay "Image URLs" field removes the listing's
 * Product media (the field's `replaces`) and, in the SAME transaction, moves the list into it (`settleListingsPhotos`):
 * a library photo by its address, any other address added to the family's library. Proven on a real PostgreSQL with the
 * production schema (PGlite), through both writers of `POST /products/bulk-save`: the set-based batch and the row path.
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
const LIBRARY = 'https://example.invalid/library/front.jpg'
const NEW = 'https://example.invalid/outside/side.jpg'
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

/** A family (main product + variations), each on eBay IT with its own Product media, and one photo in the library. */
async function family(size: number) {
  const root = `photo-family-${++sequence}`
  const ids = Array.from({ length: size }, (_, i) => `${root}-${i}`)
  const library = await scoped(async () => {
    await prisma.product.create({ data: { id: root, sku: root, name: root, basePrice: 10, isParent: true } })
    await prisma.product.createMany({ data: ids.map(id => ({ id, sku: id, name: id, basePrice: 10, parentId: root })) })
    await prisma.channelListing.createMany({ data: [root, ...ids].map(productId => ({ id: `l-${productId}`, productId, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT',
      region: 'EU', channelConnectionId: account, platformAttributes: { subtitle: 'kept', _productMediaLocales: OWN_MEDIA } })) })
    return prisma.productImage.create({ data: { productId: root, url: LIBRARY, type: 'MAIN', sortOrder: 0 } })
  })
  const unit = (id: string, change: Partial<BulkSaveUnit['changes'][number]> = {}, extra: Partial<BulkSaveUnit> = {}): BulkSaveUnit => ({ key: id, expectedVersion: 1,
    marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT', accountId: account, locale: 'it' }],
    changes: [{ id, field: 'attr_imageUrls', value: [LIBRARY, NEW], target: 'channel', intent: 'set', ...change }], ...extra })
  return { root, ids, library, unit }
}
const save = (units: BulkSaveUnit[]) => scoped(() => applyProductBulkSave({ units }, { formulaCascade: false, userId: null, logger: logger as never }))
const listing = (productId: string) => scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id: `l-${productId}` } }))
const libraryOf = (productIds: string[]) => scoped(() => prisma.productImage.findMany({ where: { productId: { in: productIds } }, orderBy: { sortOrder: 'asc' } }))
const items = (attributes: unknown) => ((attributes as any)?._productMediaLocales?.und?._productMedia?.items ?? []).map((item: { assetId: string }) => item.assetId)

it('the batch writer: each row\'s list becomes its Product media, the outside photo is added once, and the next token works', async () => {
  const f = await family(2)
  const before = state.batches
  const result = await save(f.ids.map(id => f.unit(id)))
  expect(state.batches).toBe(before + 1)
  expect(result.failed, JSON.stringify(result.units)).toBe(0)
  const library = await libraryOf([f.root, ...f.ids])
  // One new library row, on the family's main product; the library photo is used, not copied.
  expect(library.map(row => [row.productId, row.url])).toEqual([[f.root, LIBRARY], [f.root, NEW]])
  for (const id of f.ids) {
    const row = await listing(id)
    expect(row.platformAttributes).not.toHaveProperty('imageUrls')
    expect(row.platformAttributes).toMatchObject({ subtitle: 'kept' })
    expect(items(row.platformAttributes)).toEqual([f.library.id, library[1].id])
    expect(result.units.find(u => u.key === id)?.body).toMatchObject({ currentVersion: row.version, versionOf: 'channelListing' })
  }
  // Open sheets hear it once per family, after the commit.
  expect(vi.mocked(publishListingEvent).mock.calls.map(([event]) => event)).toEqual([expect.objectContaining({ type: 'product.media.changed', productId: f.root, layer: 'GALLERY' })])
  // The answered token is the stored one: the next save of the same rows is not a conflict.
  const next = await save(f.ids.map(id => f.unit(id, { value: [NEW] }, { expectedVersion: Number(result.units.find(u => u.key === id)!.body.currentVersion) })))
  expect(next.failed, JSON.stringify(next.units)).toBe(0)
  for (const id of f.ids) expect(items((await listing(id)).platformAttributes)).toEqual([library[1].id])
}, 120_000)

it('the row writer (one row, as Claude\'s set-listing-fields writes): same move, same transaction, answered token', async () => {
  const f = await family(1)
  const before = state.batches
  const result = await save([f.unit(f.ids[0])])
  expect(state.batches).toBe(before)
  expect(result.failed, JSON.stringify(result.units)).toBe(0)
  const row = await listing(f.ids[0])
  const library = await libraryOf([f.root, ...f.ids])
  expect(library.map(photo => photo.url)).toEqual([LIBRARY, NEW])
  expect(row.platformAttributes).not.toHaveProperty('imageUrls')
  expect(items(row.platformAttributes)).toEqual([f.library.id, library[1].id])
  expect(result.units[0].body).toMatchObject({ currentVersion: row.version, versionOf: 'channelListing' })
  expect(vi.mocked(publishListingEvent)).toHaveBeenCalledWith(expect.objectContaining({ type: 'product.media.changed', productId: f.root }))
}, 120_000)

it('a dry run writes nothing; a reset removes both lists and adds nothing (the listing shows the shared Product media)', async () => {
  const f = await family(1)
  const dry = await save([f.unit(f.ids[0], {}, { dryRun: true })])
  expect(dry.failed, JSON.stringify(dry.units)).toBe(0)
  expect((await listing(f.ids[0])).platformAttributes).toEqual({ subtitle: 'kept', _productMediaLocales: OWN_MEDIA })
  expect(await libraryOf([f.root, ...f.ids])).toHaveLength(1)
  const reset = await save([f.unit(f.ids[0], { value: null, intent: 'reset' })])
  expect(reset.failed, JSON.stringify(reset.units)).toBe(0)
  expect((await listing(f.ids[0])).platformAttributes).toEqual({ subtitle: 'kept' })
  expect(await libraryOf([f.root, ...f.ids])).toHaveLength(1)
  expect(vi.mocked(publishListingEvent)).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'product.media.changed' }))
}, 120_000)
