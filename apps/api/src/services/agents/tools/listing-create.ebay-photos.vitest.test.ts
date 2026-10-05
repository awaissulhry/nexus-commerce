/**
 * Owner 2026-10-05 — Product media is the one photo source of an eBay listing. Claude's set-listing-fields with the eBay
 * "Image URLs" field: the preview says what becomes of the list and writes nothing; the approved run (the product sheet's
 * row writer) settles it — a list of media-library photos becomes the listing's Product media in that order, a list with
 * any other address stays the Image URLs list, and no library grows. Review 6: the change's "before" is the list Publish
 * sent (the listing's own, or the Shared product's it followed), so an undo puts that back instead of resetting the
 * listing to Shared and losing its own Product media. Real PostgreSQL, production schema (PGlite).
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'

const state = vi.hoisted(() => ({ database: null as any }))
vi.mock('@nexus/database', async (original) => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.database = await formulaDatabase()
  return { ...(await original<object>()), default: state.database.client }
})
vi.mock('../../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(async () => []), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('../../pim/readiness-index.service.js', async () => (await import('../../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string): UserPrincipal => ({ kind: 'user', userId, label: userId, workspace: business, via: 'claude',
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) } })
type Json = Record<string, any>
const db = () => state.database.client
const OUTSIDE = 'https://example.invalid/outside/side.jpg'
const media = (...ids: string[]) => ({ und: { _productMedia: { version: 1, items: ids.map(assetId => ({ assetId })) } } })
const ids = { root: 'mcp-photo-root', own: 'mcp-photo-own', follows: 'mcp-photo-follows' }
const photos = { front: { id: '', url: 'https://example.invalid/library/front.jpg' }, back: { id: '', url: 'https://example.invalid/library/back.jpg' } }

beforeAll(async () => {
  await inside(async () => {
    await db().marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
    const account = (await db().channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'Test eBay', isActive: true, isPrimary: true } as never })).id
    await db().product.create({ data: { id: ids.root, sku: 'TEST-SKU-PHOTO', name: 'Photo family', basePrice: 10, isParent: true } })
    photos.front.id = (await db().productImage.create({ data: { productId: ids.root, url: photos.front.url, type: 'MAIN', sortOrder: 0 } })).id
    photos.back.id = (await db().productImage.create({ data: { productId: ids.root, url: photos.back.url, type: 'ALT', sortOrder: 1 } })).id
    // One variation's listing holds its own Product media; the other follows the Shared photos (the main product's library).
    for (const [id, own] of [[ids.own, true], [ids.follows, false]] as const) {
      await db().product.create({ data: { id, sku: `TEST-SKU-${id}`, name: id, basePrice: 10, parentId: ids.root } })
      await db().channelListing.create({ data: { id: `l-${id}`, productId: id, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'EU',
        channelConnectionId: account, platformAttributes: { subtitle: 'kept', ...(own ? { _productMediaLocales: media(photos.front.id) } : {}) } } })
    }
  })
}, 120_000)
afterAll(async () => { await state.database?.close() }, 30_000)

const dryRun = async (args: Json) => (await inside(() => callTool(person('u-photo-asker'), 'set-listing-fields', args))).raw as Json
async function approveAndRun(args: Json) {
  const preview = await dryRun(args)
  expect(preview.ok, preview.error).toBe(true)
  const ran = (await inside(() => executeTool(person('u-photo-approver'), 'set-listing-fields', args, { approvedPreview: JSON.parse(JSON.stringify(preview.preview)), via: 'claude' }))).raw as Json
  expect(ran.ok, ran.error).toBe(true)
  return { preview: preview.preview as Json, ran }
}
const attributes = async (productId: string) => (await inside(() => db().channelListing.findUniqueOrThrow({ where: { id: `l-${productId}` } }))).platformAttributes as Json
const libraryCount = () => inside(() => db().productImage.count({ where: { OR: [{ productId: ids.root }, { product: { parentId: ids.root } }] } }))
const tool = () => getTool('set-listing-fields')!

it('library photos: the preview says they become Product media and writes nothing; the run settles them; undo puts the listing\'s own list back', async () => {
  const args = { productId: ids.own, channel: 'EBAY', market: 'IT', values: { attr_imageUrls: [photos.back.url, photos.front.url] } }
  const preview = await dryRun(args)
  expect(preview.ok, preview.error).toBe(true)
  expect(preview.preview.note).toBe('Every address is a photo of the media library: the list becomes this listing\'s Product media, in this order, when the change runs.')
  // What it replaces is the list Publish sends: the listing's own Product media.
  expect(preview.preview.changes).toEqual([expect.objectContaining({ key: 'attr_imageUrls', from: JSON.stringify([photos.front.url]), fromOwn: true })])
  expect(await attributes(ids.own)).toEqual({ subtitle: 'kept', _productMediaLocales: media(photos.front.id) })

  const { ran } = await approveAndRun(args)
  expect(await attributes(ids.own)).toEqual({ subtitle: 'kept', _productMediaLocales: media(photos.back.id, photos.front.id) })
  expect(await libraryCount()).toBe(2)
  expect(ran.change).toMatchObject({ before: { values: { attr_imageUrls: { value: [photos.front.url], own: true } } }, after: { values: { attr_imageUrls: { value: [photos.back.url, photos.front.url], own: true } } } })
  // Review 6 — the undo sets the listing's own list again (before: it reset the listing to Shared and lost it).
  expect(await inside(() => tool().undo!.current(ran.change))).toEqual(ran.change.after)
  const undo = tool().undo!.request(ran.change) as { tool: string; args: Json }
  expect(undo).toMatchObject({ tool: 'set-listing-fields', args: { productId: ids.own, values: { attr_imageUrls: [photos.front.url] } } })
  expect(undo.args).not.toHaveProperty('reset')
  await approveAndRun(undo.args)
  expect(await attributes(ids.own)).toEqual({ subtitle: 'kept', _productMediaLocales: media(photos.front.id) })
}, 120_000)

it('an outside address: the list stays Image URLs and no library grows; undo makes the listing follow the Shared photos again', async () => {
  const args = { productId: ids.follows, channel: 'EBAY', market: 'IT', values: { attr_imageUrls: [OUTSIDE, photos.front.url] } }
  const { preview, ran } = await approveAndRun(args)
  expect(preview.note).toBe('An address is not a photo of the media library: the list stays this listing\'s Image URLs list (Publish sends it as written) until it is saved in Product media.')
  expect(preview.changes).toEqual([expect.objectContaining({ from: JSON.stringify([photos.front.url, photos.back.url]), fromOwn: false })])
  expect(await attributes(ids.follows)).toEqual({ subtitle: 'kept', imageUrls: [OUTSIDE, photos.front.url] })
  expect(await libraryCount()).toBe(2)
  const undo = tool().undo!.request(ran.change) as { tool: string; args: Json }
  expect(undo).toMatchObject({ tool: 'set-listing-fields', args: { productId: ids.follows, reset: ['attr_imageUrls'] } })
  await approveAndRun(undo.args)
  expect(await attributes(ids.follows)).toEqual({ subtitle: 'kept' })
}, 120_000)
