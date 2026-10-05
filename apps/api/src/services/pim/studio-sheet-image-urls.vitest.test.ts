/**
 * Owner 2026-10-05 — Product media is the one photo source of an eBay listing: the sheet's "Image URLs" column shows the
 * photo addresses of the list the Product media cell shows (what Publish sends), never the raw `platformAttributes`
 * store — a save in Product media removes the old list, and the column read blank. Fake ids and addresses only.
 *
 * Run (from apps/api): npx vitest run src/services/pim/studio-sheet-image-urls.vitest.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const productFindMany = vi.fn()
const channelListingFindMany = vi.fn()
const getStudioColumns = vi.fn()
const plan = vi.hoisted(() => ({ row: null as null | ((...a: unknown[]) => unknown) }))

vi.mock('../../db.js', () => ({
  default: {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ $executeRaw: async () => 0 }),
    product: { findFirst: async () => ({ id: 'p_solo', parentId: null }), findMany: (...a: unknown[]) => productFindMany(...a) },
    channelListing: { findMany: (...a: unknown[]) => channelListingFindMany(...a) },
    $queryRaw: async () => [],
    productMediaPlan: { findMany: async () => [] },
    productListingAlias: { findMany: async () => [] },
    fieldLinkGroup: { findMany: async () => [] },
    cellFormula: { findMany: async () => [] },
    categorySchema: { findFirst: async () => null, findMany: async () => [] },
    channelSchema: { findMany: async () => [] },
    marketplace: { findUnique: async () => ({ schemaMapping: null }), findMany: async () => [
      { channel: 'AMAZON', code: 'IT', languages: ['it'], language: 'it' }, { channel: 'EBAY', code: 'IT', languages: ['it'], language: 'it' },
    ] },
  },
}))
vi.mock('./studio-stock.js', async (importOriginal) => ({ ...await importOriginal<typeof import('./studio-stock.js')>(), attachStudioStock: async () => ({ ms: 0 }) }))
vi.mock('./studio-columns.js', () => ({ getStudioColumns: (...a: unknown[]) => getStudioColumns(...a) }))
vi.mock('./product-category-context.js', () => ({ productCategoryContext: async () => ({ connectionId: 'account', categories: ['CAT-1'], defaults: {} }) }))
vi.mock('./mapping/index.js', () => ({ resolveChannelValues: async () => ({ byProduct: { p_solo: { imageUrls: { value: ['https://cdn.test/rule.jpg'], status: 'mapped', provenance: 'rule', rule: { source: 'images' }, warnings: [], errors: [], mappingErrors: [] } } }, categoryByProduct: {}, missingProductIds: [], meta: {} }) }))
vi.mock('../images/media-plan.service.js', async (importOriginal) => ({ ...await importOriginal<object>(),
  sheetMediaPlan: async () => plan.row ? { row: plan.row } : null }))

import { getStudioSheet } from './studio-sheet.service.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { legacyPhotoItems } from '../images/listing-photos.pure.js'

const read = (channel = 'EBAY') => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] },
  () => getStudioSheet({ productId: 'p_solo', scope: 'channel', channel, market: 'IT', locale: 'it' }))

const url = (name: string) => `https://cdn.test/${name}.jpg`
const file = (id: string, sortOrder: number, extra: Record<string, unknown> = {}) => ({ id, url: url(id), type: 'ALT', sortOrder, createdAt: new Date(`2026-01-0${sortOrder + 1}T00:00:00Z`),
  isPrimary: false, mediaType: 'IMAGE', posterUrl: null, alt: '', ...extra })
const collection = (...ids: string[]) => ({ _productMedia: { version: 1, items: ids.map(assetId => ({ assetId })) } })
const imageUrlsColumn = { key: 'imageUrls', writeField: 'imageUrls', label: 'Image URLs', group: 'Images', kind: 'text', shape: 'list', storage: 'listing',
  scope: 'global', requiredBy: [], editable: true, defaultVisible: true,
  channels: { 'eBay · IT': { key: 'imageUrls', store: { kind: 'platformAttributes', path: ['imageUrls'], replaces: [['_productMediaLocales']] } },
    'Amazon · IT': { key: 'imageUrls', store: { kind: 'platformAttributes', path: ['imageUrls'] } } } }

function setUp(input: { images: unknown[]; localizedContent?: unknown; platformAttributes?: unknown; channel?: string }) {
  const channel = input.channel ?? 'EBAY'
  productFindMany.mockResolvedValue([{ id: 'p_solo', sku: 'SOLO', isParent: false, parentId: null, productType: null, name: 'Giacca', description: null,
    variationAxes: [], variantAttributes: {}, categoryAttributes: {}, translations: [], localizedContent: input.localizedContent ?? {}, images: input.images }])
  channelListingFindMany.mockResolvedValue([{ id: 'l1', productId: 'p_solo', channel, marketplace: 'IT', channelConnectionId: 'account',
    platformAttributes: input.platformAttributes ?? {}, translations: [], aliasKey: null }])
  getStudioColumns.mockResolvedValue({ coordinates: [{ channel, marketplace: 'IT', label: channel === 'EBAY' ? 'eBay · IT' : 'Amazon · IT', inMarket: true, languages: ['it'] }],
    columns: [imageUrlsColumn] })
}

beforeEach(() => {
  plan.row = null
  for (const m of [productFindMany, channelListingFindMany, getStudioColumns]) m.mockReset()
})

describe('the eBay Image URLs column shows the Product media cell\'s photos (Owner 2026-10-05)', () => {
  it('Product media saved on the listing: its photos, in its order, as the listing\'s own value (the old list is gone)', async () => {
    setUp({ images: [file('img-a', 0), file('img-b', 1), file('vid-c', 2, { mediaType: 'VIDEO', url: 'https://cdn.test/c.mp4', posterUrl: url('poster-c') })],
      platformAttributes: { _productMediaLocales: { it: collection('img-b', 'vid-c', 'img-a') } } })
    const row = (await read()).rows[0]
    expect(row.productMedia!.map(item => item.id)).toEqual(['img-b', 'vid-c', 'img-a'])
    // Photos only: eBay takes no videos (the cell shows the video; Publish refuses it by name).
    expect(row.values.imageUrls).toMatchObject({ value: [url('img-b'), url('img-a')], source: 'channelExplicit', inherited: false, layer: 'channel', pinned: true, follows: false, mapped: null })
    // Still a column the operator edits: an edit writes Image URLs, which then moves into Product media.
    expect(row.values.imageUrls).toMatchObject({ editable: true, writable: true, writeBlockedReason: null, writeTarget: 'channelListing' })
    expect(row.productMediaSource).toBeUndefined()
  })

  it('no list saved: the Shared product\'s photos the listing follows, inherited from the family', async () => {
    setUp({ images: [file('img-a', 0), file('img-b', 1)], localizedContent: { und: collection('img-b') } })
    const row = (await read()).rows[0]
    expect(row.values.imageUrls).toMatchObject({ value: [url('img-b')], source: 'master', inheritedFrom: 'p_solo', inherited: true, layer: 'master', pinned: false, mapped: null })
  })

  it('an old Image URLs list (no Product media yet): exactly the addresses Publish sends, marked on the row', async () => {
    const outside = 'https://elsewhere.test/photo-1.jpg'
    setUp({ images: [file('img-a', 0)], platformAttributes: { imageUrls: [outside, ` ${url('img-a')}`, outside, ''] } })
    const row = (await read()).rows[0]
    expect(row.values.imageUrls).toMatchObject({ value: [outside, url('img-a')], source: 'channelExplicit', layer: 'channel', pinned: true })
    expect(row.productMediaSource).toBe('image-urls')
    expect(row.productMedia!.map(item => item.preview)).toEqual([outside, url('img-a')])
    // The photo outside the media library keeps its `url:` id (the web counts these in the cell's note); a library photo its own.
    expect(row.productMedia!.map(item => item.id.startsWith('url:') ? 'url:' : item.id)).toEqual(['url:', 'img-a'])
  })

  it('the old list picks the editor\'s file for an address held twice (own files by sortOrder then id, not createdAt)', async () => {
    // The sheet reads files by sortOrder then createdAt: `img-z` (older) first. The editor reads by sortOrder then id: `img-y`.
    const older = file('img-z', 0, { url: url('same'), createdAt: new Date('2025-01-01T00:00:00Z') })
    const newer = file('img-y', 0, { url: url('same'), createdAt: new Date('2026-06-01T00:00:00Z') })
    setUp({ images: [older, newer], platformAttributes: { imageUrls: [url('same')] } })
    const row = (await read()).rows[0]
    const editor = legacyPhotoItems([url('same')], [newer, older].map(image => ({ ...image, productId: 'p_solo' })), 'p_solo')
    expect(editor.items).toEqual([{ assetId: 'img-y' }])
    expect(row.productMedia!.map(item => item.id)).toEqual(['img-y'])
  })

  it('a photo plan family: the plan row\'s photos (videos left out), read-only — Publish ignores Image URLs there (review finding 9)', async () => {
    plan.row = () => ({ set: { ref: 'common', label: 'Common', sharedBy: 1 }, items: [
      { id: 'img-a', type: 'IMAGE', preview: url('img-a'), alt: '' }, { id: 'vid-c', type: 'VIDEO', preview: url('poster-c'), alt: '' },
      { id: 'img-b', type: 'IMAGE', preview: url('img-b'), alt: '', muted: true }] })
    setUp({ images: [file('img-a', 0), file('img-b', 1)], platformAttributes: { imageUrls: ['https://elsewhere.test/ignored.jpg'] } })
    const row = (await read()).rows[0]
    expect(row.values.imageUrls).toMatchObject({ value: [url('img-a'), url('img-b')], source: 'master', inherited: true })
    // An edit was saved and then snapped back to the plan's list: the cell now says where the photos change instead.
    expect(row.values.imageUrls).toMatchObject({ editable: false, writable: false, writeBlockedReason: 'This family uses the photo plan. Change its photos on the Media page.' })
    expect(row.productMediaSource).toBeUndefined()
  })

  it('NEGATIVE CONTROL: another channel\'s Image URLs cell keeps its stored value', async () => {
    setUp({ channel: 'AMAZON', images: [file('img-a', 0)], platformAttributes: { imageUrls: ['https://elsewhere.test/amazon.jpg'] } })
    const row = (await read('AMAZON')).rows[0]
    expect(row.values.imageUrls?.value).not.toEqual([url('img-a')])
    expect(row.productMediaSource).toBeUndefined()
  })
})
