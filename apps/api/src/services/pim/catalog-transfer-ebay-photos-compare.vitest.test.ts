/**
 * Owner 2026-10-05 — Product media is the one photo source of an eBay listing. After a save in Product media the old
 * `platformAttributes.imageUrls` is gone, so an import that compared a file's Image URLs with it planned "changed" on
 * every eBay row with photos: a re-imported export turned a listing that followed the Shared product's photos into one
 * with its own list. The import now compares with the list Publish sends — the same list the export writes
 * (`ebayPhotoReader` / `ebayListingPhotos`): a file that restates it plans nothing, a different list is set (and settled
 * into Product media), and the compared list is part of the write fingerprint. Real PostgreSQL with the production
 * schema (PGlite), the real field catalogue, export rows → plan → apply. Fake ids and addresses only.
 *
 * Run (from apps/api): npx vitest run src/services/pim/catalog-transfer-ebay-photos-compare.vitest.test.ts
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

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
import { applyTransferTarget, loadTransferContext } from './catalog-transfer.service.js'
import { buildTransferPlan, fingerprint, targetWriteFingerprint, transferContracts, type TransferContext, type TransferPlan } from './catalog-transfer-plan.js'
import { catalogRows, productInclude } from './catalog-transfer-export.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const contracts = () => transferContracts('IT', { allowIncompleteSchema: true })
const languages = new Map([[JSON.stringify(['EBAY', 'IT']), ['it']]])
const media = (...ids: string[]) => ({ und: { _productMedia: { version: 1, items: ids.map(assetId => ({ assetId })) } } })
const OUTSIDE = 'https://example.invalid/outside/legacy.jpg'
const BECOMES = /Image URLs lists? becomes? (its|their) listing/
let account: string
let sequence = 0

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
    account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'synthetic-compare-account', isActive: true } })).id
  })
}, 60_000)
afterAll(async () => { await state.db?.close() })

/**
 * One family: the root's library (p1, p2, a video) and its Shared Product media [p2, p1] (not the files' order). Three
 * variations with an eBay IT listing each: one follows the Shared photos, one holds its own Product media [p1], one still
 * holds an old Image URLs list.
 */
async function family() {
  const root = `compare-family-${++sequence}`
  return scoped(async () => {
    await prisma.product.create({ data: { id: root, sku: root, name: root, basePrice: 10, isParent: true } })
    const p1 = await prisma.productImage.create({ data: { productId: root, url: `https://example.invalid/library/${root}-1.jpg`, type: 'MAIN', sortOrder: 0 } })
    const p2 = await prisma.productImage.create({ data: { productId: root, url: `https://example.invalid/library/${root}-2.jpg`, type: 'ALT', sortOrder: 1 } })
    await prisma.productImage.create({ data: { productId: root, url: `https://example.invalid/library/${root}-clip.mp4`, type: 'ALT', sortOrder: 2, mediaType: 'VIDEO' } })
    await prisma.product.update({ where: { id: root }, data: { localizedContent: media(p2.id, p1.id) } })
    const child = async (suffix: string, platformAttributes: Record<string, unknown>) => {
      const id = `${root}-${suffix}`
      await prisma.product.create({ data: { id, sku: id, name: id, basePrice: 10, parentId: root } })
      await prisma.channelListing.create({ data: { id: `l-${id}`, productId: id, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'EU',
        channelConnectionId: account, platformAttributes: { categoryId: '1001', ...platformAttributes } } })
      return id
    }
    return { root, p1, p2,
      follows: await child('follows', {}),
      own: await child('own', { _productMediaLocales: media(p1.id) }),
      legacy: await child('legacy', { imageUrls: [OUTSIDE, p1.url] }) }
  })
}
/** The Nexus workbook's rows for these products' eBay listings, as the export writes them (Image URLs only). */
async function exportedPhotoRows(productIds: string[]) {
  return scoped(async () => {
    const products = await prisma.product.findMany({ where: { id: { in: productIds } }, include: productInclude, orderBy: { sku: 'asc' } })
    const rows = await catalogRows(products, { market: 'IT', marketplaces: ['IT'] }, contracts(), [], undefined, languages)
    return rows.filter(r => r.channel === 'EBAY' && r.field === 'imageUrls')
  })
}
const plan = (rows: TransferRow[], tweak?: (context: TransferContext) => TransferContext) =>
  scoped(async () => { const context = await loadTransferContext(rows); return buildTransferPlan(rows, 'update', tweak ? tweak(context) : context, contracts()) })
/** As the runner applies a reviewed plan: only targets that change something are written. */
async function apply(reviewed: TransferPlan) {
  for (const target of reviewed.targets) if (target.create || target.cells.some(c => c.verdict === 'changed'))
    await scoped(() => inDatabaseTransaction(prisma, () => applyTransferTarget(prisma, target, 'photo-compare', null)))
}
const attributes = async (productId: string) => (await scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id: `l-${productId}` } }))).platformAttributes as Record<string, unknown>
const cellOf = (reviewed: TransferPlan, sku: string) => reviewed.targets.flatMap(t => t.cells).find(c => c.sku === sku && c.field === 'imageUrls')
const photoRow = (sku: string, value: unknown, patch: Partial<TransferRow> = {}): TransferRow => ({ row: 2, entity: 'Overrides', sku, channel: 'EBAY', accountId: account, marketplace: 'IT', aliasKey: '',
  locale: '', field: 'imageUrls', action: 'SET', value, ...patch })

it('round trip: the exported Image URLs re-import with no change — a listing that follows the Shared photos keeps following them', async () => {
  const f = await family()
  const rows = await exportedPhotoRows([f.follows, f.own, f.legacy])
  // The export writes the list Publish sends: Shared Product media in its order, photos only; the own list; the old list.
  expect(rows.map(r => [r.sku, r.action, r.value]).sort(([a], [b]) => String(a).localeCompare(String(b)))).toEqual([
    [f.follows, 'SET', [f.p2.url, f.p1.url]],
    [f.legacy, 'SET', [OUTSIDE, f.p1.url]],
    [f.own, 'SET', [f.p1.url]],
  ].sort(([a], [b]) => String(a).localeCompare(String(b))))
  const reviewed = await plan(rows)
  expect(reviewed.issues).toEqual([])
  expect(cellOf(reviewed, f.follows)).toMatchObject({ verdict: 'unchanged', beforeState: 'inherited', afterState: 'inherited', before: [f.p2.url, f.p1.url] })
  expect(cellOf(reviewed, f.own)).toMatchObject({ verdict: 'unchanged', beforeState: 'stored', before: [f.p1.url] })
  expect(cellOf(reviewed, f.legacy)).toMatchObject({ verdict: 'unchanged', beforeState: 'stored', before: [OUTSIDE, f.p1.url] })
  expect(reviewed.targets.map(t => t.patch)).toEqual([{}, {}, {}])
  expect(reviewed.warnings.filter(w => BECOMES.test(w))).toEqual([])
  // The review's compared list is what the write fingerprint guards.
  expect(reviewed.targets.find(t => t.identity.sku === f.follows)?.ebayPhotos).toEqual([f.p2.url, f.p1.url])

  await apply(reviewed)
  expect(await attributes(f.follows)).toEqual({ categoryId: '1001' })
  expect(await attributes(f.own)).toEqual({ categoryId: '1001', _productMediaLocales: media(f.p1.id) })
  expect(await attributes(f.legacy)).toEqual({ categoryId: '1001', imageUrls: [OUTSIDE, f.p1.url] })
  // Still following: a later Shared Product media save is what the listing sends, and the next export says so.
  await scoped(() => prisma.product.update({ where: { id: f.root }, data: { localizedContent: media(f.p1.id) } }))
  expect((await exportedPhotoRows([f.follows]))[0]).toMatchObject({ action: 'SET', value: [f.p1.url] })

  // NEGATIVE CONTROL: compared with the old `imageUrls` store (no photo facts), the same file planned a change on the
  // listing that follows Shared and on the one with its own Product media.
  const old = await plan(rows, context => ({ ...context, ebayPhotos: undefined }))
  expect([f.follows, f.own, f.legacy].map(sku => cellOf(old, sku)?.verdict)).toEqual(['changed', 'changed', 'unchanged'])
}, 120_000)

it('the eBay workbook\'s restated Image columns (a channel file) plan nothing either, and are not read as "follows Shared"', async () => {
  const f = await family()
  const reviewed = await plan([photoRow(f.follows, [f.p2.url, f.p1.url], { origin: 'channel-file' }), photoRow(f.own, [` ${f.p1.url}`, f.p1.url], { origin: 'channel-file' })])
  expect(reviewed.issues).toEqual([])
  expect([f.follows, f.own].map(sku => cellOf(reviewed, sku)?.verdict)).toEqual(['unchanged', 'unchanged'])
  expect(reviewed.warnings.filter(w => BECOMES.test(w) || /already sends|could not be read/.test(w))).toEqual([])
}, 120_000)

it('a different list is set: it becomes the listing\'s own Product media (library photos by address); the review shows the list it replaces', async () => {
  const f = await family()
  const reviewed = await plan([photoRow(f.follows, [f.p1.url, f.p2.url])])
  expect(reviewed.issues).toEqual([])
  expect(cellOf(reviewed, f.follows)).toMatchObject({ verdict: 'changed', before: [f.p2.url, f.p1.url], beforeState: 'inherited', after: [f.p1.url, f.p2.url], afterState: 'stored' })
  expect(reviewed.warnings).toContainEqual('EBAY IT: the Image URLs list becomes its listing\'s Product media. A photo of the media library is used from the library; any other address is added to it.')
  await apply(reviewed)
  const stored = await attributes(f.follows)
  expect(stored).not.toHaveProperty('imageUrls')
  expect((stored._productMediaLocales as any)?.und?._productMedia?.items?.map((item: { assetId: string }) => item.assetId)).toEqual([f.p1.id, f.p2.id])
  expect(await scoped(() => prisma.productImage.count({ where: { productId: { in: [f.root, f.follows] } } }))).toBe(3)
  // The same file again restates the listing's own list now: nothing.
  expect(cellOf(await plan([photoRow(f.follows, [f.p1.url, f.p2.url])]), f.follows)).toMatchObject({ verdict: 'unchanged', beforeState: 'stored' })
  // Exact addresses: the same photos in another order, or a list that leaves one out, is a change.
  expect(cellOf(await plan([photoRow(f.own, [f.p1.url, f.p2.url])]), f.own)).toMatchObject({ verdict: 'changed', before: [f.p1.url] })
}, 120_000)

it('blank, CLEAR and INHERIT keep their rules: they are not compared with the photos Publish sends', async () => {
  const f = await family()
  const reviewed = await plan([photoRow(f.follows, undefined, { action: 'INHERIT' }), photoRow(f.own, undefined, { action: 'CLEAR' })])
  expect(reviewed.issues).toEqual([])
  // INHERIT on a listing with no old list: nothing to reset (as before). CLEAR: an explicit empty value (as before).
  expect(cellOf(reviewed, f.follows)).toMatchObject({ verdict: 'unchanged', before: null, beforeState: 'inherited' })
  expect(cellOf(reviewed, f.own)).toMatchObject({ verdict: 'changed', before: null, beforeState: 'inherited', afterState: 'stored' })
  expect(reviewed.targets.every(t => t.ebayPhotos === undefined)).toBe(true)
}, 120_000)

it('a Shared Product media save between review and apply refuses the record (write fingerprint), though the listing itself is untouched', async () => {
  const f = await family()
  const reviewed = await plan([photoRow(f.follows, [f.p1.url])])
  const target = reviewed.targets[0]
  expect(cellOf(reviewed, f.follows)).toMatchObject({ verdict: 'changed', before: [f.p2.url, f.p1.url] })
  // Control: re-planned as the apply does, nothing moved — the same print.
  const again = (await plan(target.rows)).targets[0]
  expect(targetWriteFingerprint(again)).toBe(targetWriteFingerprint(target))
  // Somebody saves the Shared photos. The file's list is still a change and its write is byte-identical (the listing did
  // not move) — only the compared list differs, and that refuses the apply.
  await scoped(() => prisma.product.update({ where: { id: f.root }, data: { localizedContent: media(f.p2.id) } }))
  const current = (await plan(target.rows)).targets[0]
  expect(current.patch).toEqual(target.patch)
  expect(current.ebayPhotos).toEqual([f.p2.url])
  expect(targetWriteFingerprint(current)).not.toBe(targetWriteFingerprint(target))
  // A target without eBay photos keeps the print it had before this rule (in-flight reviews of other fields still apply).
  const { ebayPhotos: _photos, ...withoutPhotos } = target
  expect(targetWriteFingerprint(withoutPhotos)).toBe(fingerprint([withoutPhotos.patch, withoutPhotos.contentWrites, withoutPhotos.priceWrite ?? null, withoutPhotos.presence ?? null]))
}, 120_000)
