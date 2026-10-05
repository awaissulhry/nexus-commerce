/**
 * Owner 2026-10-05 — "if I import an Excel file with the image links, the product media should be able to get those images
 * if they are from the media library, and it should then follow those image URLs". An eBay file's Image URLs replace the
 * listing's Product media (the field's `replaces`, read from the field catalogue the import plans with), and the import's
 * one writer (`applyTransferTarget`, shared by the file import, the product sheet's import and assortment copies) moves the
 * list into Product media in the SAME transaction: a library photo by its address, any other address added to the
 * family's library. Proven on a real PostgreSQL with the production schema (PGlite): file rows → plan → apply.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn(async () => ({ enqueued: true })) }))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../listing-events.service.js', async importOriginal => ({ ...(await importOriginal<object>()), publishListingEvent: vi.fn() }))

import type { TransferRow } from '@nexus/shared/catalog-transfer'
import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { publishListingEvent } from '../listing-events.service.js'
import { applyTransferTarget, loadTransferContext } from './catalog-transfer.service.js'
import { buildTransferPlan, transferContracts } from './catalog-transfer-plan.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const LIBRARY = 'https://example.invalid/library/front.jpg'
const NEW = 'https://example.invalid/outside/side.jpg'
const OWN_MEDIA = { und: { _productMedia: { version: 1, items: [{ assetId: 'kept-elsewhere' }] } } }
let account: string
let sequence = 0

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
    account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'synthetic-import-account', isActive: true } })).id
  })
}, 60_000)
afterAll(async () => { await state.db?.close() })
beforeEach(() => { vi.mocked(publishListingEvent).mockClear() })

async function family() {
  const root = `import-family-${++sequence}`, child = `${root}-a`
  const library = await scoped(async () => {
    await prisma.product.create({ data: { id: root, sku: root, name: root, basePrice: 10, isParent: true } })
    await prisma.product.create({ data: { id: child, sku: child, name: child, basePrice: 10, parentId: root } })
    await prisma.channelListing.create({ data: { id: `l-${child}`, productId: child, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'EU',
      channelConnectionId: account, platformAttributes: { categoryId: '1001', subtitle: 'kept', _productMediaLocales: OWN_MEDIA } } })
    return prisma.productImage.create({ data: { productId: root, url: LIBRARY, type: 'MAIN', sortOrder: 0 } })
  })
  return { root, child, library }
}
const row = (sku: string, patch: Partial<TransferRow> = {}): TransferRow => ({ row: 2, entity: 'Overrides', sku, channel: 'EBAY', accountId: account, marketplace: 'IT', aliasKey: '', locale: '',
  field: 'imageUrls', action: 'SET', value: [LIBRARY, NEW], ...patch })
/** The import as it runs: the file's rows planned against the real field catalogue, each target applied in one transaction. */
async function importRows(rows: TransferRow[]) {
  const plan = await scoped(async () => buildTransferPlan(rows, 'update', await loadTransferContext(rows), transferContracts('IT', { allowIncompleteSchema: true })))
  expect(plan.issues).toEqual([])
  for (const target of plan.targets) await scoped(() => inDatabaseTransaction(prisma, () => applyTransferTarget(prisma, target, 'photo-import', null)))
  return plan
}
const listing = (productId: string) => scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id: `l-${productId}` } }))
const libraryOf = (productIds: string[]) => scoped(() => prisma.productImage.findMany({ where: { productId: { in: productIds } }, orderBy: { sortOrder: 'asc' } }))
const items = (attributes: unknown) => ((attributes as any)?._productMediaLocales?.und?._productMedia?.items ?? []).map((item: { assetId: string }) => item.assetId)

it('an Image URLs list becomes the listing\'s Product media: the library photo is used, the other address added; the review says so', async () => {
  const f = await family()
  const plan = await importRows([row(f.child)])
  expect(plan.warnings).toContainEqual('EBAY IT: the Image URLs list becomes its listing\'s Product media. A photo of the media library is used from the library; any other address is added to it.')
  const library = await libraryOf([f.root, f.child])
  expect(library.map(photo => [photo.productId, photo.url])).toEqual([[f.root, LIBRARY], [f.root, NEW]])
  const stored = await listing(f.child)
  expect(stored.platformAttributes).not.toHaveProperty('imageUrls')
  expect(stored.platformAttributes).toMatchObject({ categoryId: '1001', subtitle: 'kept' })
  expect(items(stored.platformAttributes)).toEqual([f.library.id, library[1].id])
  expect(vi.mocked(publishListingEvent)).toHaveBeenCalledWith(expect.objectContaining({ type: 'product.media.changed', productId: f.root, layer: 'GALLERY' }))
  // The same file again changes nothing: every address is now a library photo of the listing's Product media.
  const again = await importRows([row(f.child, { value: [LIBRARY] })])
  expect(again.targets.flatMap(t => t.cells).map(c => c.verdict)).toEqual(['changed'])
  expect(items((await listing(f.child)).platformAttributes)).toEqual([f.library.id])
  expect(await libraryOf([f.root, f.child])).toHaveLength(2)
}, 120_000)

it('a cleared or reset Image URLs cell moves nothing: the listing\'s own lists are gone, so it shows the shared Product media', async () => {
  const f = await family()
  await importRows([row(f.child, { action: 'CLEAR', value: undefined })])
  expect((await listing(f.child)).platformAttributes).toEqual({ categoryId: '1001', subtitle: 'kept', imageUrls: null })
  await importRows([row(f.child, { action: 'INHERIT', value: undefined })])
  expect((await listing(f.child)).platformAttributes).toEqual({ categoryId: '1001', subtitle: 'kept' })
  expect(await libraryOf([f.root, f.child])).toHaveLength(1)
  expect(vi.mocked(publishListingEvent)).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'product.media.changed' }))
}, 120_000)
