/**
 * Owner 2026-10-05 — Product media is the one photo source of an eBay listing: a file's Image URLs (the Nexus workbook's
 * `imageUrls` row and our eBay workbook's Image 1…N columns) are the photos Publish sends, the same list as the sheet's
 * Product media cell — never only the raw `platformAttributes.imageUrls`, which a save in Product media removes.
 * Fake ids and addresses only.
 *
 * Run (from apps/api): npx vitest run src/services/pim/catalog-transfer-export.ebay-photos.vitest.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'

const db = vi.hoisted(() => ({ files: [] as unknown[], plans: [] as unknown[], listings: [] as unknown[] }))
const planRow = vi.hoisted(() => vi.fn())
vi.mock('../../db.js', () => ({ default: {
  channelListing: { findMany: async () => db.listings },
  productImage: { findMany: vi.fn(async () => db.files) },
  productMediaPlan: { findMany: async () => db.plans },
} }))
vi.mock('./mapping/category-mapping.service.js', () => ({ resolveCategoriesForProducts: async () => ({}) }))
vi.mock('../images/media-plan.service.js', () => ({ sheetMediaPlan: async () => ({ row: planRow }) }))

import prisma from '../../db.js'
import { catalogRows } from './catalog-transfer-export.js'
import { ebayListingPhotoUrls } from '../images/listing-photos.pure.js'
import type { transferContracts } from './catalog-transfer-plan.js'
import { buildEbayWorkbookRows, type EbayExportRecord } from '../channel-mapping/ebay-export.js'
import { buildEbayDraftFields } from '../channel-mapping/ebay-draft.js'
import { readerMapping } from '../channel-mapping/decisions.js'
import { mapEbayWorkbook, readEbayWorkbook, type EbayWorkbookTarget } from './catalog-ebay-workbook.js'
import { ebaySpecFromCache } from './channel-specs/ebay.js'

const url = (name: string) => `https://cdn.test/${name}.jpg`
const file = (id: string, productId: string, mediaType = 'IMAGE') => ({ id, productId, url: mediaType === 'IMAGE' ? url(id) : `https://cdn.test/${id}.mp4`, mediaType })
const media = (...ids: string[]) => ({ _productMedia: { version: 1, items: ids.map(assetId => ({ assetId })) } })

describe('ebayListingPhotoUrls — the photos Publish sends for one eBay row', () => {
  const root = { id: 'root', localizedContent: { und: media('r2', 'r1') } }
  const files = [file('r1', 'root'), file('r2', 'root'), file('rv', 'root', 'VIDEO'), file('c1', 'child')]

  it('the old Image URLs list first, while no Product media is saved (clean addresses, each once)', () => {
    expect(ebayListingPhotoUrls({ listingAttributes: { imageUrls: [' https://elsewhere.test/1.jpg', 'https://elsewhere.test/1.jpg', '', url('r1')] }, locale: 'it',
      product: root, files })).toEqual(['https://elsewhere.test/1.jpg', url('r1')])
  })
  it('Product media saved on the listing wins over a stale old list, in its order, photos only', () => {
    expect(ebayListingPhotoUrls({ listingAttributes: { imageUrls: [url('stale')], _productMediaLocales: { it: media('rv', 'r2', 'r1') } }, locale: 'it',
      product: root, files })).toEqual([url('r2'), url('r1')])
  })
  it('no list on the listing: the Shared product\'s list, then the parent\'s for a row with no files of its own', () => {
    expect(ebayListingPhotoUrls({ listingAttributes: {}, locale: 'it', product: root, files })).toEqual([url('r2'), url('r1')])
    expect(ebayListingPhotoUrls({ listingAttributes: {}, locale: 'it', product: { id: 'bare', localizedContent: {} }, parent: root, files })).toEqual([url('r2'), url('r1')])
    // A row with files of its own and no list: its library, by the files' order.
    expect(ebayListingPhotoUrls({ listingAttributes: {}, locale: 'it', product: { id: 'child', localizedContent: {} }, parent: root, files })).toEqual([url('c1')])
  })
  it('an unreadable saved list exports the stored value instead (undefined), never a guess', () => {
    expect(ebayListingPhotoUrls({ listingAttributes: { _productMediaLocales: { it: { _productMedia: { version: 9 } } } }, locale: 'it', product: root, files })).toBeUndefined()
  })
})

// ── catalogRows: the eBay listing's `imageUrls` row ─────────────────────────────────────────────────────────────────
const imageField = { fieldKey: 'imageUrls', sheetKey: 'imageUrls', label: 'Image URLs', kind: 'text', shape: 'list', editable: true,
  channelStore: { kind: 'platformAttributes', path: ['imageUrls'], replaces: [['_productMediaLocales']] } }
const titleField = { fieldKey: 'videoId', sheetKey: 'videoId', label: 'Video', kind: 'text', shape: 'scalar', editable: true, channelStore: { kind: 'platformAttributes', path: ['videoId'] } }
const contracts = { master: async () => [], channel: async () => ({ fields: [imageField, titleField] }) } as unknown as ReturnType<typeof transferContracts>
const product = (id: string, sku: string, parent: Record<string, unknown> | null = null, localizedContent: unknown = {}) =>
  ({ id, sku, parentId: parent ? parent.id : null, parent, version: 1, familyId: null, localizedContent, translations: [], categories: [] })
const listing = (id: string, productId: string, platformAttributes: unknown, extra: Record<string, unknown> = {}) =>
  ({ id, productId, channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'seller-a', aliasKey: '', version: 3, overrideData: {}, platformAttributes, translations: [], ...extra })
const languages = new Map([[JSON.stringify(['EBAY', 'IT']), ['it']]])
type Row = { sku: string; field: string; action: string; value?: unknown; aliasKey: string; channel: string; marketplace: string; locale: string }
const photosOf = (rows: Row[], sku: string) => rows.find(r => r.sku === sku && r.field === 'imageUrls')

const ROOT = product('root', 'FAKE-JACKET', null, { und: media('r1', 'r2') })
const OWN = product('own', 'FAKE-JACKET-RED-M', ROOT)
const OLD = product('old', 'FAKE-JACKET-RED-L', ROOT)
const FOLLOWS = product('follows', 'FAKE-JACKET-BLUE-M', ROOT)

beforeEach(() => {
  planRow.mockReset()
  db.plans = []
  db.files = [file('r1', 'root'), file('r2', 'root'), file('rv', 'root', 'VIDEO'), file('o1', 'own')]
  db.listings = [
    // Product media saved on the main row's listing: the old list is gone (a save in Product media removes it).
    listing('l-root', 'root', { _productMediaLocales: { it: media('r2', 'rv', 'r1') } }),
    listing('l-own', 'own', { _productMediaLocales: { und: media('o1', 'r1') } }),
    listing('l-old', 'old', { imageUrls: ['https://elsewhere.test/old-1.jpg', url('r1')] }),
    listing('l-follows', 'follows', {}),
  ]
})

describe('the export writes the photos Publish sends (Owner 2026-10-05)', () => {
  it('each eBay row: SET with its Product media photos, or its old list — never INHERIT because the old store is gone', async () => {
    const rows = await catalogRows([ROOT, OWN, OLD, FOLLOWS] as never, { market: 'IT', marketplaces: ['IT'] }, contracts, [], undefined, languages) as Row[]
    expect(photosOf(rows, 'FAKE-JACKET')).toMatchObject({ action: 'SET', value: [url('r2'), url('r1')] })
    expect(photosOf(rows, 'FAKE-JACKET-RED-M')).toMatchObject({ action: 'SET', value: [url('o1'), url('r1')] })
    expect(photosOf(rows, 'FAKE-JACKET-RED-L')).toMatchObject({ action: 'SET', value: ['https://elsewhere.test/old-1.jpg', url('r1')] })
    // No list of its own and no files: the family's Shared list, as Publish sends it.
    expect(photosOf(rows, 'FAKE-JACKET-BLUE-M')).toMatchObject({ action: 'SET', value: [url('r1'), url('r2')] })
    // One read of the files for the page, in Publish's order.
    expect(vi.mocked(prisma.productImage.findMany)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(prisma.productImage.findMany).mock.calls[0][0]).toMatchObject({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] })
    // NEGATIVE CONTROL: other fields still read their own store.
    expect(rows.find(r => r.sku === 'FAKE-JACKET' && r.field === 'videoId')).toMatchObject({ action: 'INHERIT' })
  })

  it('a row with no photo anywhere keeps the stored state (nothing is invented)', async () => {
    db.files = []
    db.listings = [listing('l-bare', 'bare', {})]
    const rows = await catalogRows([product('bare', 'FAKE-BARE')] as never, { market: 'IT', marketplaces: ['IT'] }, contracts, [], undefined, languages) as Row[]
    expect(photosOf(rows, 'FAKE-BARE')).toMatchObject({ action: 'INHERIT', value: null })
  })

  it('a photo plan family: the plan row\'s photos for this listing (videos left out)', async () => {
    db.plans = [{ productId: 'root' }]
    db.listings = db.listings.filter(l => ['l-root', 'l-old'].includes((l as { id: string }).id))
    planRow.mockReturnValue({ set: { ref: 'common', label: 'Common', sharedBy: 2 }, items: [
      { id: 'r2', type: 'IMAGE', preview: url('r2'), alt: '' }, { id: 'rv', type: 'VIDEO', preview: url('poster'), alt: '' }] })
    const rows = await catalogRows([ROOT, OLD] as never, { market: 'IT', marketplaces: ['IT'] }, contracts, [], undefined, languages) as Row[]
    expect(photosOf(rows, 'FAKE-JACKET-RED-L')).toMatchObject({ action: 'SET', value: [url('r2')] })
    expect(planRow).toHaveBeenCalledWith('old', { channel: 'EBAY', marketplace: 'IT', accountId: 'seller-a', aliasKey: '' }, 'it')
  })
})

// ── Our eBay workbook: Image 1…N, and back in through the reader ────────────────────────────────────────────────────
describe('our eBay workbook round trip', () => {
  const spec = ebaySpecFromCache({ marketplace: 'IT', categoryId: '177104', aspects: [] })
  const specs = new Map([['177104', spec]])
  const headers = ['SKU', 'Parent/Child', 'Parent SKU', 'Item ID', 'Title', 'Category ID', 'Image 1', 'Image 2', 'Image 3']
  const fields = buildEbayDraftFields(headers, specs, 'IT').map((r, i) => ({ ...r, id: `f${i}` }))

  it('the Image columns are the Product media photos, and the file reads back as exactly that list', async () => {
    db.listings = [listing('l-root', 'root', { _productMediaLocales: { it: media('r2', 'rv', 'r1') } })]
    const rows = await catalogRows([ROOT] as never, { market: 'IT', marketplaces: ['IT'] }, contracts, [], undefined, languages) as Row[]
    // As `ebay-export-host.ts` builds a record: the listing's SET rows.
    const values = new Map(rows.filter(r => r.channel === 'EBAY' && r.action === 'SET').map(r => [r.field, r.value]))
    const record: EbayExportRecord = { sku: 'FAKE-JACKET', isParent: true, parentSku: 'FAKE-JACKET', itemId: '900000000009', values, price: null }
    const out = buildEbayWorkbookRows(headers, fields, specs, [record])
    expect(out.rows[0]).toMatchObject({ 'Image 1': url('r2'), 'Image 2': url('r1') })
    expect(out.rows[0]['Image 3']).toBeUndefined()

    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('ebay_it')
    sheet.addRow(headers)
    for (const row of out.rows) sheet.addRow(headers.map(h => h === 'Title' ? 'Giacca' : h === 'Category ID' ? '177104' : row[h] ?? ''))
    const table = readEbayWorkbook(book)!
    const targets: EbayWorkbookTarget[] = [{ id: 'l-root', sku: 'FAKE-JACKET', parentSku: 'FAKE-JACKET', sourceParentSku: 'FAKE-JACKET', isParent: true, itemId: '900000000009', accountId: 'seller-a', marketplace: 'IT', aliasKey: '', version: 3 }]
    const read = mapEbayWorkbook(table, targets, specs, { mapping: readerMapping({ id: 'm', version: 1, status: 'DRAFT' }, 'm', fields), mappingSpecs: specs })
    // The file restates the list Publish sends: an import comparing with `ebayListingPhotoUrls` plans nothing.
    const back = (read.rows as Row[]).find(r => r.field === 'imageUrls')
    expect(back?.value).toEqual(ebayListingPhotoUrls({ listingAttributes: (db.listings[0] as { platformAttributes: unknown }).platformAttributes, locale: 'it', product: ROOT, files: db.files as never }))
  })
})
