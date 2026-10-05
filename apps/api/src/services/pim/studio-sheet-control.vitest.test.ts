/**
 * P1 (fix/product-sheet-editing) — the full-control facts the studio sheet serves: where a value comes from, and
 * which rows may hold it. Constructed families, the harness of `studio-sheet-axis.vitest.test.ts`: these are
 * DERIVATIONS of this service (given these rows and columns, which layer and which lock), not claims about storage.
 *
 * Run: npx vitest run src/services/pim/studio-sheet-control.vitest.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.hoisted(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected outbound channel call') })) })

const productFindFirst = vi.fn()
const productFindMany = vi.fn()
const channelListingFindMany = vi.fn()
const aliasFindMany = vi.fn()
const getStudioColumns = vi.fn()
const marketplaceFindMany = vi.fn()

vi.mock('../../db.js', () => ({
  default: {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ $executeRaw: async () => 0 }),
    product: { findFirst: (...a: unknown[]) => productFindFirst(...a), findMany: (...a: unknown[]) => productFindMany(...a) },
    channelListing: { findMany: (...a: unknown[]) => channelListingFindMany(...a) },
    productMediaPlan: { findMany: async () => [] },
    productListingAlias: { findMany: (...a: unknown[]) => aliasFindMany(...a) },
    fieldLinkGroup: { findMany: async () => [] },
    cellFormula: { findMany: async () => [] },
    marketplace: { findUnique: async () => ({ schemaMapping: null }), findMany: (...a: unknown[]) => marketplaceFindMany(...a) },
  },
}))
// The stock cells are one Matrix read (proven on PostgreSQL in studio-stock / studio-sheet-stock-columns); this mocked database has no Matrix.
vi.mock('./studio-stock.js', async (importOriginal) => ({ ...await importOriginal<typeof import('./studio-stock.js')>(), attachStudioStock: async () => ({ ms: 0 }) }))
vi.mock('./studio-columns.js', () => ({ getStudioColumns: (...a: unknown[]) => getStudioColumns(...a) }))
vi.mock('./product-category-context.js', () => ({ productCategoryContext: async () => ({ connectionId: 'account', categories: ['177104'], defaults: {} }) }))
const resolveChannelValues = vi.fn()
vi.mock('./mapping/index.js', () => ({ resolveChannelValues: (...a: unknown[]) => resolveChannelValues(...a) }))

import { getStudioSheet } from './studio-sheet.service.js'

const PARENT = 'regal'
const EBAY_IT = { channel: 'EBAY', marketplace: 'IT', label: 'eBay · IT', inMarket: true, languages: ['it'] }
const title = { key: 'name', writeField: 'ebay_title', label: 'Title', group: 'Content', kind: 'longtext', storage: 'localizedContent',
  scope: 'global', requiredBy: [], editable: true, defaultVisible: true,
  channels: { 'eBay · IT': { key: 'title', attribute: 'title', path: [], store: { kind: 'listingColumn', column: 'title', followFlag: 'followMasterTitle' } } } }
const listing = (productId: string, over: Record<string, unknown> = {}) => ({
  id: `listing-${productId}`, productId, channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '', aliasId: null,
  listingStatus: 'ACTIVE', isPublished: true, offerActive: true, version: 4, translations: [], platformAttributes: {}, overrideData: {},
  followMasterTitle: true, title: null, ...over,
})

beforeEach(() => {
  for (const m of [productFindFirst, productFindMany, channelListingFindMany, aliasFindMany, getStudioColumns, marketplaceFindMany, resolveChannelValues]) m.mockReset()
  resolveChannelValues.mockResolvedValue({ byProduct: {}, categoryByProduct: {}, missingProductIds: [], meta: {} })
  productFindFirst.mockResolvedValue({ id: PARENT, parentId: null })
  productFindMany.mockResolvedValue([
    { id: PARENT, sku: 'REGAL', isParent: true, parentId: null, productType: 'OUTERWEAR', name: 'Master title',
      variationAxes: ['Colore'], variantAttributes: {}, categoryAttributes: {}, translations: [] },
    { id: 'child', sku: 'REGAL-L', isParent: false, parentId: PARENT, productType: 'OUTERWEAR', name: 'Master title',
      variationAxes: [], variantAttributes: { Color: 'Nero' }, categoryAttributes: {}, translations: [] },
  ])
  marketplaceFindMany.mockResolvedValue([{ channel: 'EBAY', code: 'IT', languages: ['it'], language: 'it' }])
  aliasFindMany.mockResolvedValue([])
  getStudioColumns.mockResolvedValue({ columns: [title], coordinates: [EBAY_IT] })
})

describe('an old listing text is the listing’s own value (report 2 I-3)', () => {
  it('serves it on the listing layer, not Master, with the resolver’s follow intent unchanged', async () => {
    channelListingFindMany.mockResolvedValue([listing('child', { title: 'Old eBay title' }), listing(PARENT)])
    const sheet = await getStudioSheet({ productId: PARENT, scope: 'channel', channel: 'EBAY', market: 'IT', locale: 'it' })
    const cell = sheet.rows.find(row => row.id === 'child')!.values.name
    expect(cell).toMatchObject({ value: 'Old eBay title', source: 'channelSnapshot', layer: 'channel', follows: true, pinned: false })
    // Master's own text on the other row is still Master's.
    expect(sheet.rows.find(row => row.id === PARENT)!.values.name).toMatchObject({ value: 'Master title', layer: 'master' })
  })

  it('names the alias layer on a named listing alias', async () => {
    aliasFindMany.mockResolvedValue([{ id: 'outlet', label: 'Outlet', position: 1, status: 'ACTIVE' }])
    channelListingFindMany.mockResolvedValue([listing('child', { title: 'Old outlet title', aliasKey: 'outlet', aliasId: 'outlet' })])
    const sheet = await getStudioSheet({ productId: PARENT, scope: 'channel', channel: 'EBAY', market: 'IT', locale: 'it' })
    expect(sheet.rows.find(row => row.id === 'child' && row.aliasId === 'outlet')!.values.name).toMatchObject({ source: 'channelSnapshot', layer: 'alias' })
  })
})

describe('the family row and per-variant columns (report 2 I-11)', () => {
  const perVariant = (key: string, storage: string) => ({ key, writeField: `attr_${key}`, label: key === 'color' ? 'Colour' : key[0].toUpperCase() + key.slice(1),
    group: 'Specifications', kind: 'text', storage, scope: 'per_variant', requiredBy: [], editable: true, defaultVisible: true })
  beforeEach(() => {
    getStudioColumns.mockResolvedValue({ columns: [perVariant('neckline', 'categoryAttributes'), perVariant('item_type_name', 'localizedContent'),
      perVariant('color', 'categoryAttributes'), { ...perVariant('ean', 'column'), writeField: 'ean' }, { ...perVariant('fit_code', 'column'), writeField: 'fit_code' }], coordinates: [EBAY_IT] })
    productFindMany.mockResolvedValue([
      { id: PARENT, sku: 'REGAL', isParent: true, parentId: null, productType: 'OUTERWEAR', name: 'Master title', variationAxes: ['Colore'], variantAttributes: {},
        categoryAttributes: { neckline: 'Collo alto' }, translations: [] },
      { id: 'child', sku: 'REGAL-L', isParent: false, parentId: PARENT, productType: 'OUTERWEAR', name: 'Master title', variationAxes: [], variantAttributes: { Color: 'Nero' },
        categoryAttributes: {}, translations: [] },
    ])
    channelListingFindMany.mockResolvedValue([])
  })

  it('lets the family row edit a per-variant value its variations inherit, and marks theirs inherited', async () => {
    const sheet = await getStudioSheet({ productId: PARENT, scope: 'master', market: 'IT', locale: 'it' } as never)
    const parent = sheet.rows.find(row => row.isParent)!, child = sheet.rows.find(row => !row.isParent)!
    for (const key of ['neckline', 'item_type_name']) expect(parent.values[key], key).toMatchObject({ editable: true, writable: true, writeBlockedReason: null })
    expect(child.values.neckline).toMatchObject({ value: 'Collo alto', inherited: true })
  })

  it('says "variation axis" only for a real axis, and the exact reason for the others', async () => {
    const parent = (await getStudioSheet({ productId: PARENT, scope: 'master', market: 'IT', locale: 'it' } as never)).rows.find(row => row.isParent)!
    expect(parent.values.color).toMatchObject({ editable: false, writeBlockedReason: 'Set on each variant — this is a variation axis, so the family row has no single value.' })
    expect(parent.values.ean.writeBlockedReason).toBe('Set on each variant — an identity code belongs to the individual product, not the family.')
    expect(parent.values.fit_code.writeBlockedReason).toBe('Set on each variant — Fit_code is stored on each variation, and the family row holds no value they inherit.')
  })

  it('keeps a channel’s family row locked, and sends the family value to the Shared sheet', async () => {
    const parent = (await getStudioSheet({ productId: PARENT, scope: 'channel', channel: 'EBAY', market: 'IT', locale: 'it' })).rows.find(row => row.isParent)!
    expect(parent.values.neckline).toMatchObject({ editable: false,
      writeBlockedReason: 'Set on each variant here. The family value every variation inherits is edited on the Shared product sheet.' })
    expect(parent.values.color.writeBlockedReason).toBe('Set on each variant — this is a variation axis, so the family row has no single value.')
  })
})

describe('build shape v2 — the Nexus product status leaves the Shared sheet (Owner 2026-10-04)', () => {
  const column = (key: string, storage: string) => ({ key, writeField: key, label: key, group: 'Identity', kind: 'select', storage,
    scope: 'global', requiredBy: [], editable: true, defaultVisible: true })

  it('drops the master Status column on Shared and keeps every other column, a dictionary "status" attribute included', async () => {
    getStudioColumns.mockResolvedValue({ columns: [column('sku', 'column'), column('status', 'column'), column('brand', 'column')], coordinates: [] })
    channelListingFindMany.mockResolvedValue([])
    const shared = await getStudioSheet({ productId: PARENT, scope: 'master', market: 'IT', locale: 'it' } as never)
    const keys = shared.columns.map(c => c.key)
    expect(keys).not.toContain('status')
    expect(keys).toEqual(expect.arrayContaining(['sku', 'brand']))
    getStudioColumns.mockResolvedValue({ columns: [column('sku', 'column'), column('status', 'categoryAttributes')], coordinates: [] })
    expect((await getStudioSheet({ productId: PARENT, scope: 'master', market: 'IT', locale: 'it' } as never)).columns.map(c => c.key)).toContain('status')
  })

  it('leaves a channel scope’s columns as they are', async () => {
    getStudioColumns.mockResolvedValue({ columns: [title, column('status', 'column')], coordinates: [EBAY_IT] })
    channelListingFindMany.mockResolvedValue([listing('child'), listing(PARENT)])
    const ebay = await getStudioSheet({ productId: PARENT, scope: 'channel', channel: 'EBAY', market: 'IT', locale: 'it' })
    expect(ebay.columns.map(c => c.key)).toContain('status')
  })
})

// Wave 2 (C6) — eBay takes condition, policies, … once per listing, from the main row: the variation row shows that value,
// read-only, with the reason. Wiring through the sheet (the rule itself: `ebay-listing-level.vitest.test.ts`). Fake SKUs.
describe('eBay listing fields on variation rows show the main row\'s value', () => {
  const field = (key: string, label: string) => ({ key, writeField: key, label, group: 'Offer', kind: 'text', storage: 'listing', scope: 'global', requiredBy: [],
    editable: true, defaultVisible: true, channels: { 'eBay · IT': { key, attribute: key, path: [], store: { kind: 'platformAttributes', path: [key] } } } })
  const mapped = (value: unknown) => ({ value, status: 'mapped', warnings: [], errors: [], mappingErrors: [], provenance: 'override', sourceOwner: 'channel', required: true })
  beforeEach(() => {
    getStudioColumns.mockResolvedValue({ columns: [title, field('conditionId', 'Condition'), field('paymentPolicyId', 'Payment policy')], coordinates: [EBAY_IT] })
    channelListingFindMany.mockResolvedValue([
      listing(PARENT, { platformAttributes: { conditionId: 'NEW', paymentPolicyId: 'pay-main' } }),
      listing('child', { platformAttributes: { conditionId: 'USED_EXCELLENT', paymentPolicyId: 'pay-main' } }),
    ])
    resolveChannelValues.mockResolvedValue({ byProduct: {
      [PARENT]: { conditionId: mapped('NEW'), paymentPolicyId: mapped('pay-main') },
      child: { conditionId: mapped('USED_EXCELLENT'), paymentPolicyId: mapped('pay-main') },
    }, categoryByProduct: {}, missingProductIds: [], meta: {} })
  })
  const read = (extra: Record<string, unknown> = {}) => getStudioSheet({ productId: PARENT, scope: 'channel', channel: 'EBAY', market: 'IT', locale: 'it', ...extra })

  it('the variation row: the main row\'s value, read-only, the reason and its own different value; the main row marked', async () => {
    const sheet = await read()
    const main = sheet.rows.find(row => row.id === PARENT)!, child = sheet.rows.find(row => row.id === 'child')!
    expect(child.values.conditionId).toMatchObject({ value: 'NEW', editable: false, writable: false, resettable: false,
      writeBlockedReason: 'eBay takes this once per listing, from the main row REGAL. Change it there. This row also has "USED_EXCELLENT", which eBay does not get.' })
    expect(child.values.paymentPolicyId).toMatchObject({ value: 'pay-main', editable: false, writeBlockedReason: 'eBay takes this once per listing, from the main row REGAL. Change it there.' })
    expect(main.values.conditionId).toMatchObject({ value: 'NEW', editable: true, writable: true, mapped: { listingLevel: { productId: PARENT, sku: 'REGAL' } } })
    expect(child.values.conditionId.mapped).not.toHaveProperty('listingLevel')
    // Not a listing-level field: the title stays the row's own.
    expect(child.values.name.editable).toBe(true)
  })

  it('a reader that judges rows by their own values (rowOwnValues) still gets each row\'s own', async () => {
    const child = (await read({ rowOwnValues: true })).rows.find(row => row.id === 'child')!
    expect(child.values.conditionId).toMatchObject({ value: 'USED_EXCELLENT', editable: true })
  })

  it('an Inventory-model listing (offer ids) keeps condition per variation; the payment policy is still the main row\'s', async () => {
    channelListingFindMany.mockResolvedValue([
      listing(PARENT, { platformAttributes: { conditionId: 'NEW', paymentPolicyId: 'pay-main' } }),
      listing('child', { platformAttributes: { conditionId: 'USED_EXCELLENT', paymentPolicyId: 'pay-own', offerId: 'offer-fake-1' } }),
    ])
    const sheet = await read()
    const child = sheet.rows.find(row => row.id === 'child')!
    expect(child.values.conditionId).toMatchObject({ value: 'USED_EXCELLENT', editable: true })
    expect(child.values.paymentPolicyId).toMatchObject({ value: 'pay-main', editable: false })
    expect(sheet.rows.find(row => row.id === PARENT)!.values.conditionId.mapped).not.toHaveProperty('listingLevel')
  })
})
