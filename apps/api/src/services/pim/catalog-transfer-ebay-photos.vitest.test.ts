/**
 * Owner 2026-10-05 — "if I import an Excel file with the image links, the product media should be able to get those images
 * if they are from the media library, and it should then follow those image URLs". An eBay file's Image URLs replace the
 * listing's Product media (the field's `replaces`, read from the field catalogue the import plans with), and the import's
 * one writer (`applyTransferTarget`, shared by the file import, the product sheet's import and assortment copies) settles
 * the list in the SAME transaction: a list of media-library photos becomes the listing's Product media in that order; a
 * list with any other address stays the Image URLs list. Only the listing is written: no library, no product.
 * Proven on a real PostgreSQL with the production schema (PGlite): file rows → plan → apply, and the catalog job runner.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, oldCore: false }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn(async () => ({ enqueued: true })) }))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../listing-events.service.js', async importOriginal => ({ ...(await importOriginal<object>()), publishListingEvent: vi.fn() }))
// NEGATIVE CONTROL switch: `oldCore` replays the review's blocker — the settle added a list's outside addresses to the
// family's library, which pinned the main product's photo list (a product write in the middle of an import).
vi.mock('../images/listing-photos.service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../images/listing-photos.service.js')>()
  return { ...actual, settleAndAnnounce: async (...args: Parameters<typeof actual.settleAndAnnounce>) => {
    const [tx, ids] = args
    if (state.oldCore) for (const id of ids) {
      const listing = await tx.channelListing.findFirstOrThrow({ where: { id }, select: { productId: true, platformAttributes: true, product: { select: { parentId: true } } } })
      const outside = (actual.legacyImageUrls(listing.platformAttributes) ?? []).filter(url => url.includes('/outside/'))
      await actual.addLibraryPhotos(tx, { productId: listing.product.parentId ?? listing.productId, urls: outside })
    }
    return actual.settleAndAnnounce(...args)
  } }
})

import type { TransferRow } from '@nexus/shared/catalog-transfer'
import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { publishListingEvent } from '../listing-events.service.js'
import { applyTransferTarget, loadTransferContext } from './catalog-transfer.service.js'
import { buildTransferPlan, transferContracts } from './catalog-transfer-plan.js'
import { applyTransferJob, readTransferJob, stageTransferJob, transferJobStatus } from './catalog-transfer-jobs.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const OUTSIDE = 'https://example.invalid/outside/side.jpg'
const OWN_MEDIA = { und: { _productMedia: { version: 1, items: [{ assetId: 'kept-elsewhere' }] } } }
const media = (...ids: string[]) => ({ und: { _productMedia: { version: 1, items: ids.map(assetId => ({ assetId })) } } })
const REVIEW = 'EBAY IT: an Image URLs list is set. A list whose every address is a photo of the media library becomes the listing\'s Product media, in that order; a list with any other address stays the listing\'s Image URLs list until it is saved in Product media.'
let account: string
let sequence = 0

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
    account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'synthetic-import-account', isActive: true } })).id
    // The category's cached requirements: the catalog job runner refuses a category without them.
    await prisma.categorySchema.create({ data: { channel: 'EBAY', marketplace: 'IT', productType: '1001', schemaVersion: 'fixture', schemaDefinition: { aspects: [] }, expiresAt: new Date('2099-01-01') } })
  })
}, 60_000)
afterAll(async () => { await state.db?.close() })
beforeEach(() => { vi.mocked(publishListingEvent).mockClear(); state.oldCore = false })

/** A family: the main product's library (front, back) in library mode (no saved list), variations with an eBay IT listing each. */
async function family(variants: string[], options: { parentListing?: boolean; childAttributes?: Record<string, unknown> } = {}) {
  const root = `import-family-${++sequence}`
  return scoped(async () => {
    await prisma.product.create({ data: { id: root, sku: root, name: root, basePrice: 10, isParent: true } })
    const front = await prisma.productImage.create({ data: { productId: root, url: `https://example.invalid/library/${root}-front.jpg`, type: 'MAIN', sortOrder: 0 } })
    const back = await prisma.productImage.create({ data: { productId: root, url: `https://example.invalid/library/${root}-back.jpg`, type: 'ALT', sortOrder: 1 } })
    const listed = [...(options.parentListing ? [root] : []), ...variants.map(v => `${root}-${v}`)]
    for (const v of variants) await prisma.product.create({ data: { id: `${root}-${v}`, sku: `${root}-${v}`, name: v, basePrice: 10, parentId: root } })
    for (const productId of listed) await prisma.channelListing.create({ data: { id: `l-${productId}`, productId, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'EU',
      channelConnectionId: account, platformAttributes: { categoryId: '1001', ...(productId === root ? {} : options.childAttributes ?? {}) } } })
    return { root, front, back, sku: (v: string) => `${root}-${v}` }
  })
}
const row = (sku: string, patch: Partial<TransferRow> = {}): TransferRow => ({ row: 2, entity: 'Overrides', sku, channel: 'EBAY', accountId: account, marketplace: 'IT', aliasKey: '', locale: '',
  field: 'imageUrls', action: 'SET', value: [], ...patch })
/** The import as it runs: the file's rows planned against the real field catalogue, each target applied in one transaction. */
async function importRows(rows: TransferRow[]) {
  const plan = await scoped(async () => buildTransferPlan(rows, 'update', await loadTransferContext(rows), transferContracts('IT', { allowIncompleteSchema: true })))
  expect(plan.issues).toEqual([])
  for (const target of plan.targets) if (target.cells.some(c => c.verdict === 'changed'))
    await scoped(() => inDatabaseTransaction(prisma, () => applyTransferTarget(prisma, target, 'photo-import', null)))
  return plan
}
const attributes = async (productId: string) => (await scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id: `l-${productId}` } }))).platformAttributes
const libraryCount = (root: string) => scoped(() => prisma.productImage.count({ where: { OR: [{ productId: root }, { product: { parentId: root } }] } }))
const productsOf = (root: string) => scoped(() => prisma.product.findMany({ where: { OR: [{ id: root }, { parentId: root }] }, select: { id: true, version: true, localizedContent: true }, orderBy: { id: 'asc' } }))

it('a list of library photos becomes the listing\'s Product media in its order; one with an outside address stays Image URLs; the review says both', async () => {
  const f = await family(['a', 'b'], { childAttributes: { subtitle: 'kept', _productMediaLocales: OWN_MEDIA } })
  const before = await productsOf(f.root)
  const plan = await importRows([row(f.sku('a'), { value: [f.back.url, f.front.url] }), row(f.sku('b'), { value: [OUTSIDE, f.front.url] })])
  expect(plan.warnings).toContainEqual(REVIEW.replace('an Image URLs list is', '2 Image URLs lists are'))
  expect(await attributes(f.sku('a'))).toEqual({ categoryId: '1001', subtitle: 'kept', _productMediaLocales: media(f.back.id, f.front.id) })
  expect(await attributes(f.sku('b'))).toEqual({ categoryId: '1001', subtitle: 'kept', imageUrls: [OUTSIDE, f.front.url] })
  // Only the listings were written: no library photo was added, no product moved.
  expect(await libraryCount(f.root)).toBe(2)
  expect(await productsOf(f.root)).toEqual(before)
  expect(vi.mocked(publishListingEvent).mock.calls.map(([event]) => event)).toEqual([expect.objectContaining({ type: 'product.media.changed', productId: f.root, layer: 'GALLERY' })])
  // The same file again restates what each listing sends now: nothing changes.
  const again = await importRows([row(f.sku('a'), { value: [f.back.url, f.front.url] }), row(f.sku('b'), { value: [OUTSIDE, f.front.url] })])
  expect(again.targets.flatMap(t => t.cells).map(c => c.verdict)).toEqual(['unchanged', 'unchanged'])
}, 120_000)

it('a cleared or reset Image URLs cell settles nothing: the listing\'s own lists are gone, so it shows the shared Product media', async () => {
  const f = await family(['a'], { childAttributes: { subtitle: 'kept', _productMediaLocales: OWN_MEDIA } })
  await importRows([row(f.sku('a'), { action: 'CLEAR', value: undefined })])
  expect(await attributes(f.sku('a'))).toEqual({ categoryId: '1001', subtitle: 'kept', imageUrls: null })
  await importRows([row(f.sku('a'), { action: 'INHERIT', value: undefined })])
  expect(await attributes(f.sku('a'))).toEqual({ categoryId: '1001', subtitle: 'kept' })
  expect(await libraryCount(f.root)).toBe(2)
  expect(vi.mocked(publishListingEvent)).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'product.media.changed' }))
}, 120_000)

/** An eBay channel file through the catalog job runner: review, then apply, each record in its own transaction. */
async function runJob(rows: TransferRow[]) {
  const settle = async (id: string, states: string[]) => {
    let result: NonNullable<Awaited<ReturnType<typeof readTransferJob>>>
    await vi.waitFor(async () => { result = (await scoped(() => readTransferJob(id, 'owner')))!; expect(states).toContain(result.job.status) }, { timeout: 60_000, interval: 20 })
    return transferJobStatus(result!)
  }
  const staged = await scoped(() => stageTransferJob({ rows, issues: [], mode: 'update', market: 'IT', filename: 'ebay-photos.xlsx', userId: 'owner' }))
  const review = await settle(staged.jobId, ['QUEUED', 'INVALID', 'FAILED'])
  expect(review.state, JSON.stringify(review.issues)).toBe('QUEUED')
  await scoped(() => applyTransferJob(staged.jobId, 'owner', review.reviewToken!))
  const done = await settle(staged.jobId, ['COMPLETED', 'PARTIAL', 'FAILED'])
  const records = await scoped(() => prisma.importJobRow.findMany({ where: { jobId: staged.jobId }, orderBy: { rowIndex: 'asc' }, select: { targetId: true, status: true, errorMessage: true } }))
  return { state: done.state, records: records.map(r => ({ sku: JSON.parse(r.targetId ?? '[]')[1], status: r.status, error: r.errorMessage })) }
}

it('the review\'s blocker: a family\'s channel file (parent + 2 variant listings, main product in library mode) applies every record', async () => {
  const run = async () => {
    const f = await family(['a', 'b'], { parentListing: true })
    const before = await productsOf(f.root)
    // The variant with an outside address first: under the old core its settle wrote the main product mid-import.
    const job = await runJob([
      row(f.sku('b'), { value: [OUTSIDE, f.front.url], origin: 'channel-file' }),
      row(f.root, { value: [f.back.url, f.front.url], origin: 'channel-file' }),
      row(f.sku('a'), { value: [f.back.url], origin: 'channel-file' }),
    ])
    return { f, before, job }
  }
  const { f, before, job } = await run()
  expect(job.records).toEqual([
    { sku: f.sku('b'), status: 'SUCCESS', error: null },
    { sku: f.root, status: 'SUCCESS', error: null },
    { sku: f.sku('a'), status: 'SUCCESS', error: null },
  ])
  expect(job.state).toBe('COMPLETED')
  expect(await attributes(f.root)).toEqual({ categoryId: '1001', _productMediaLocales: media(f.back.id, f.front.id) })
  expect(await attributes(f.sku('a'))).toEqual({ categoryId: '1001', _productMediaLocales: media(f.back.id) })
  expect(await attributes(f.sku('b'))).toEqual({ categoryId: '1001', imageUrls: [OUTSIDE, f.front.url] })
  // The main product is still in library mode (no saved list), and its library is as it was.
  expect(await productsOf(f.root)).toEqual(before)
  expect(await libraryCount(f.root)).toBe(2)

  // NEGATIVE CONTROL: the old core (a library write that pins the main product) fails the family's later records.
  state.oldCore = true
  const old = await run()
  expect(old.job.state).toBe('PARTIAL')
  expect(old.job.records.slice(1)).toEqual([
    { sku: old.f.root, status: 'FAILED', error: expect.stringContaining('changed since preview') },
    { sku: old.f.sku('a'), status: 'FAILED', error: expect.stringContaining('changed since preview') },
  ])
}, 180_000)
