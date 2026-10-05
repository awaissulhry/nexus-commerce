/**
 * Owner 2026-10-05 — Product media is the one photo source of an eBay listing. Claude's set-listing-fields with the eBay
 * "Image URLs" field: the preview says the list becomes the listing's Product media and writes nothing; the approved run
 * (the product sheet's row writer) moves the list into Product media. Real PostgreSQL, production schema (PGlite).
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

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string): UserPrincipal => ({ kind: 'user', userId, label: userId, workspace: business, via: 'claude',
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) } })
type Json = Record<string, any>
const db = () => state.database.client
const LIBRARY = 'https://example.invalid/library/front.jpg'
const NEW = 'https://example.invalid/outside/side.jpg'
const OWN_MEDIA = { und: { _productMedia: { version: 1, items: [{ assetId: 'kept-elsewhere' }] } } }
const ids = { root: 'mcp-photo-root', child: 'mcp-photo-child' }
let libraryId = ''

beforeAll(async () => {
  await inside(async () => {
    await db().marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
    const account = (await db().channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'Test eBay', isActive: true, isPrimary: true } as never })).id
    await db().product.create({ data: { id: ids.root, sku: 'TEST-SKU-PHOTO', name: 'Photo family', basePrice: 10, isParent: true } })
    await db().product.create({ data: { id: ids.child, sku: 'TEST-SKU-PHOTO-M', name: 'Photo M', basePrice: 10, parentId: ids.root } })
    await db().channelListing.create({ data: { id: 'l-photo-child', productId: ids.child, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'EU',
      channelConnectionId: account, platformAttributes: { subtitle: 'kept', _productMediaLocales: OWN_MEDIA } } })
    libraryId = (await db().productImage.create({ data: { productId: ids.root, url: LIBRARY, type: 'MAIN', sortOrder: 0 } })).id
  })
}, 120_000)
afterAll(async () => { await state.database?.close() }, 30_000)

it('previews without writing, says the list becomes Product media, and the approved run moves it there', async () => {
  const args = { productId: ids.child, channel: 'EBAY', market: 'IT', values: { attr_imageUrls: [LIBRARY, NEW] } }
  const preview = (await inside(() => callTool(person('u-photo-asker'), 'set-listing-fields', args))).raw as Json
  expect(preview.ok, preview.error).toBe(true)
  expect(preview.preview.note).toContain('Product media')
  const listing = () => inside(() => db().channelListing.findUniqueOrThrow({ where: { id: 'l-photo-child' } }))
  expect((await listing()).platformAttributes).toEqual({ subtitle: 'kept', _productMediaLocales: OWN_MEDIA })
  const ran = (await inside(() => executeTool(person('u-photo-approver'), 'set-listing-fields', args, { approvedPreview: JSON.parse(JSON.stringify(preview.preview)), via: 'claude' }))).raw as Json
  expect(ran.ok, ran.error).toBe(true)
  const library = await inside(() => db().productImage.findMany({ where: { productId: { in: [ids.root, ids.child] } }, orderBy: { sortOrder: 'asc' } }))
  expect(library.map((photo: { productId: string; url: string }) => [photo.productId, photo.url])).toEqual([[ids.root, LIBRARY], [ids.root, NEW]])
  const stored = (await listing()).platformAttributes as Json
  expect(stored).not.toHaveProperty('imageUrls')
  expect(stored._productMediaLocales.und._productMedia.items.map((item: { assetId: string }) => item.assetId)).toEqual([libraryId, library[1].id])
}, 120_000)
