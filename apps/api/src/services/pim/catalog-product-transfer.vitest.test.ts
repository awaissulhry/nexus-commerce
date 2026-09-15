import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { writeFile } from 'node:fs/promises'
import type { ProductTransferSelection, TransferRow } from '@nexus/shared/catalog-transfer'
import { importTestStore, fixtureColumns, fixtureFields } from './catalog-transfer-test/store.js'
const state = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof importTestStore> }))
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_, key) => state.store.db[key as string] }) }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: vi.fn() } }))
// LX.F R-LX-13 — LX.5's readiness producer asks this module for the coordinate
// set (`readiness-index.service.ts` → `coordinatesFor`), so the mock must export it.
vi.mock('./sheet-columns.service.js', () => ({ getSheetColumns: async () => ({ columns: fixtureColumns }), clearSheetColumnCache: vi.fn(),
  coordinatesFor: (market: string, markets: { channel: string; code: string; languages?: string[] }[] = []) =>
    markets.filter(m => m.code === market).map(m => ({ channel: m.channel, marketplace: m.code, label: `${m.channel} · ${m.code}`, inMarket: true, languages: m.languages ?? ['it'] })) }))
vi.mock('./mapping/field-catalogue.service.js', () => ({ getFieldCatalogue: vi.fn(async () => ({ fields: fixtureFields, schema: { present: true, fetchedAt: '2026-01-01' } })), clearFieldCatalogueCache: vi.fn() }))
vi.mock('./mapping/category-mapping.service.js', async importOriginal => ({ ...await importOriginal<object>(), resolveCategoriesForProducts: vi.fn(async ({ productIds }: { productIds: string[] }) => Object.fromEntries(productIds.map(id => [id, { channelCategoryId: 'COAT' }]))) }))
import routes from '../../routes/catalog-transfer.routes.js'
import { writeTransferWorkbook } from './catalog-transfer-file.js'
import { readEditorTransfer, writeEditorWorkbook } from './catalog-editor-workbook.js'
import { checkProductTransferBoundary, resolveProductTransferBoundary } from './catalog-product-transfer.js'
import { runTransferJob, stageTransferJob } from './catalog-transfer-jobs.js'
import { inspectCatalogSource } from './catalog-source.service.js'
import { getFieldCatalogue } from './mapping/field-catalogue.service.js'
import { resolveCategoriesForProducts } from './mapping/category-mapping.service.js'
import { transferContracts } from './catalog-transfer-plan.js'
import * as channelSpecs from './channel-specs/index.js'
import { ebaySpecFromCache } from './channel-specs/ebay.js'
const app = Fastify()
beforeAll(async () => {
  state.store = importTestStore()
  await app.register(multipart)
  app.addHook('onRequest', async request => { (request as any).authUser = { id: request.headers['x-fixture-actor'] ?? 'owner' } })
  await app.register(routes, { prefix: '/api' })
  app.get('/api/fixture/evidence', async () => ({ products: [...state.store.data.product.values()].slice(0, 3), listings: [...state.store.data.channelListing.values()].filter(l => l.productId === 'p1'), audits: [...state.store.data.auditLog.values()] }))
  if (process.env.NEXUS_PRODUCT_TRANSFER_BROWSER === '1') app.post('/api/fixture/source', async () => inspectCatalogSource(Buffer.from('SKU,Summer title,Outlet title\n000001,Summer coat,Outlet coat'), 'synthetic-supplier.csv', 'owner'))
  await app.ready()
})
beforeEach(() => state.store.seed(45))
afterAll(() => app.close())
const shared = (productIds = ['p1']): ProductTransferSelection => ({ productIds, includeShared: true, listingIds: [], locales: ['it'] })
const channel = (): ProductTransferSelection => ({ productIds: ['p1'], includeShared: false, listingIds: ['p1-account-a'], locales: [] })
const row = (overrides: Partial<TransferRow> = {}): TransferRow => ({ row: 2, entity: 'Products', sku: '000001', channel: '', accountId: '', marketplace: '', aliasKey: '', locale: '', field: 'name', action: 'SET', value: 'Changed title', version: 3, ...overrides })
/**
 * LX.F2 R-LX-21 — the editor workbook has had TWO header rows since LX.19: row 1 the human
 * LABELS (`Title`, `Material`), row 2 the machine keys in the `key@channel:market:locale`
 * grammar (`item_name@amazon:IT:it`), and the data from row 3. Locale-bearing content also
 * moved onto its own sheet per language (`AMAZON IT 1` for the language-independent
 * attributes, `AMAZON IT it 2` for the text). Every arm below used to read row 1 as the key
 * row and write row 2, so it either found no sheet at all or edited the key row — measured:
 * `sheet` undefined, `col('item_name')` = -1, and exceljs throwing
 * "-1 is out of bounds". These three helpers DERIVE the position from the workbook instead of
 * repeating a coordinate (`reference_a_list_of_members_is_a_set_claim`), so the next grammar
 * change is a one-line fix here rather than in nine places.
 */
const KEY_ROW = 2, FIRST_DATA_ROW = 3
const keyRow = (sheet: ExcelJS.Worksheet) => sheet.getRow(KEY_ROW).values as any[]
const hasKey = (value: unknown, key: string) => String(value ?? '') === key || String(value ?? '').startsWith(`${key}@`)
const sheetWithKey = (book: ExcelJS.Workbook, key: string) => book.worksheets.find(s => keyRow(s).some(v => hasKey(v, key)))!
const colOf = (sheet: ExcelJS.Worksheet, key: string) => keyRow(sheet).findIndex(v => hasKey(v, key))

const url = '/api/catalog-transfer/products/p1'
const getJob = async (id: string) => (await app.inject(`/api/catalog-transfer/jobs/${id}`)).json()
const review = async (id: string) => { let job: any; await vi.waitFor(async () => { job = await getJob(id); expect(['QUEUED', 'INVALID', 'FAILED']).toContain(job.state) }); return job }
async function upload(selection: ProductTransferSelection, bytes: Buffer) {
  const boundary = 'product-test-boundary'
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="selection"\r\n\r\n${JSON.stringify(selection)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="market"\r\n\r\nIT\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="product.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)])
  return app.inject({ method: 'POST', url: `${url}/preview`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload })
}
const uploadRows = async (selection: ProductTransferSelection, rows: TransferRow[]) => upload(selection, await writeTransferWorkbook(rows, []))

function ebayInput() {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('ebay_it')
  sheet.addRow(['SKU', 'Parent/Child', 'Parent SKU', 'Item ID', 'Listing ID', 'Category ID', 'Title', 'Qty'])
  const selection: ProductTransferSelection = { productIds: ['p0', 'p1'], listingIds: [], includeShared: false, locales: [] }
  state.store.data.channelConnection.set('ebay-account', { id: 'ebay-account', channelType: 'EBAY', marketplace: null, displayName: 'Seller', isActive: true })
  state.store.data.marketplace.set('EBAY_IT', { id: 'EBAY_IT', channel: 'EBAY', code: 'IT', name: 'Italy', languages: ['it'], isActive: true })
  for (const [i, sourceParent] of ['000000', 'LEGACY-ALT1', 'LEGACY-ALT2'].entries()) {
    const aliasKey = i ? `ebay-alias-${i}` : '', itemId = `25656610142${i}`
    if (i) {
      state.store.data.product.set(`shell-${i}`, { id: `shell-${i}`, sku: sourceParent, parentId: null, deletedAt: new Date() })
      state.store.data.productListingAlias.set(aliasKey, { id: aliasKey, productId: 'p0', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'ebay-account', label: `Renamed listing ${i}`, status: 'ACTIVE', adoptedFromProductId: `shell-${i}` })
    }
    for (const productId of selection.productIds) {
      const product = state.store.data.product.get(productId)!, id = `${productId}-ebay-${i}`
      state.store.data.channelListing.set(id, { ...state.store.data.channelListing.get(`${productId}-account-a`), id, productId, channel: 'EBAY', channelMarket: 'EBAY_IT', marketplace: 'IT', channelConnectionId: 'ebay-account', aliasKey, aliasId: aliasKey || null, externalListingId: itemId, platformAttributes: { categoryId: '177104' } })
      selection.listingIds.push(id)
      sheet.addRow([productId === 'p0' ? sourceParent : product.sku, productId === 'p0' ? 'parent' : 'child', productId === 'p0' ? '' : sourceParent, itemId, '', '177104', `eBay title ${i}`, '0'])
    }
  }
  return { book, sheet, selection }
}

it('imports a legacy eBay workbook through product HTTP review and preserves independently named aliases', async () => {
  const input = ebayInput(), before = structuredClone([...state.store.data.product.values()])
  input.sheet.getCell('I1').value = 'Stile (Style)'
  for (let row = 2; row <= 7; row++) input.sheet.getCell(row, 9).value = `Stile ${Math.floor((row - 2) / 2)}`
  const spec = vi.spyOn(channelSpecs, 'loadEbaySpec').mockResolvedValue(ebaySpecFromCache({ marketplace: 'IT', categoryId: '177104', aspects: [{ id: 'style', label: 'Stile', localizedName: 'Stile', englishName: 'Style' }] }))
  vi.mocked(getFieldCatalogue).mockResolvedValue({ fields: [{ ...fixtureFields[0], fieldKey: 'title' }, { ...fixtureFields[0], fieldKey: 'style', sheetKey: 'style', channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Stile'] } }], masterLocalizableKeys: ['style'], schema: { present: true } } as never)
  try {
    const response = await upload(input.selection, Buffer.from(await input.book.xlsx.writeBuffer()))
    expect(response.statusCode, response.body).toBe(201)
    const job = await review(response.json().jobId)
    expect(job.state, JSON.stringify(job)).toBe('QUEUED')
    expect(job.counts).toMatchObject({ listingsAffected: 6, productsAffected: 0, refused: 0 })
    expect((await apply(job.jobId, job.reviewToken)).statusCode).toBe(202)
    await vi.waitFor(async () => expect((await getJob(job.jobId)).state).toBe('COMPLETED'))
    for (const i of [0, 1, 2]) for (const p of ['p0', 'p1']) {
      expect([...state.store.data.channelListingTranslation.values()].find(t => t.channelListingId === `${p}-ebay-${i}`)).toMatchObject({ language: 'it', name: `eBay title ${i}`, attributes: { style: `Stile ${i}` } })
      expect(state.store.data.channelListing.get(`${p}-ebay-${i}`)?.externalListingId).toBe(`25656610142${i}`)
    }
    expect([...state.store.data.product.values()]).toEqual(before)
    expect(state.store.data.outboundSyncQueue.size).toBe(0)
  } finally {
    spec.mockRestore()
    vi.mocked(getFieldCatalogue).mockResolvedValue({ fields: fixtureFields, schema: { present: true, fetchedAt: '2026-01-01' } } as never)
  }
})

it('blocks the complete eBay import when an alternate has not been adopted into the product group', async () => {
  const input = ebayInput()
  state.store.data.productListingAlias.delete('ebay-alias-2')
  input.selection.listingIds = input.selection.listingIds.filter(id => !id.endsWith('-2'))
  const spec = vi.spyOn(channelSpecs, 'loadEbaySpec').mockResolvedValue(ebaySpecFromCache({ marketplace: 'IT', categoryId: '177104', aspects: [] }))
  vi.mocked(getFieldCatalogue).mockResolvedValue({ fields: [{ ...fixtureFields[0], fieldKey: 'title' }], schema: { present: true } } as never)
  try {
    const response = await upload(input.selection, Buffer.from(await input.book.xlsx.writeBuffer()))
    expect(response.statusCode, response.body).toBe(201)
    const job = await review(response.json().jobId)
    expect(job.state).toBe('INVALID')
    expect((await apply(job.jobId, job.reviewToken)).statusCode).toBe(409)
    expect(state.store.data.channelListingTranslation.size).toBe(0)
    expect(state.store.data.auditLog.size).toBe(0)
  } finally {
    spec.mockRestore()
    vi.mocked(getFieldCatalogue).mockResolvedValue({ fields: fixtureFields, schema: { present: true, fetchedAt: '2026-01-01' } } as never)
  }
})
async function exported(selection: ProductTransferSelection) {
  const response = await app.inject({ method: 'POST', url: `${url}/export`, payload: { market: 'IT', selection } })
  expect(response.statusCode, response.body.slice(0, 200)).toBe(200)
  return response.rawPayload
}
async function apply(id: string, token: string) {
  return app.inject({ method: 'POST', url: `/api/catalog-transfer/jobs/${id}/apply`, payload: { reviewToken: token } })
}

it('exports channel SKU attributes without colliding with product identity and restores both on import', async () => {
  const listing = state.store.data.channelListing.get('p1-account-a')!
  listing.overrideData.sku = 'SELLER-000001'
  vi.mocked(getFieldCatalogue).mockResolvedValueOnce({ fields: [...fixtureFields, { fieldKey: 'sku', label: 'Seller SKU', kind: 'text', editable: true }], schema: { present: true } } as never)
  const bytes = await exported(channel())
  const parsed = await readEditorTransfer(bytes, 'product.xlsx', 'p1', 'owner')
  expect(parsed.issues).toEqual([])
  expect(parsed.rows.find(r => r.field === 'sku')).toMatchObject({ sku: '000001', value: 'SELLER-000001', accountId: 'account-a', version: 8 })
})

it('exports incomplete destinations with guidance while import still requires category definitions', async () => {
  const listing = state.store.data.channelListing.get('p1-account-a')!
  listing.platformAttributes = {}
  vi.mocked(resolveCategoriesForProducts).mockResolvedValueOnce({})
  vi.mocked(getFieldCatalogue).mockResolvedValueOnce({ fields: fixtureFields, schema: { present: false } } as never)
  const bytes = await exported(channel())
  const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as never)
  expect(JSON.stringify(book.getWorksheet('Instructions')!.getSheetValues())).toContain('no category is selected')
  const parsed = await readEditorTransfer(bytes, 'product.xlsx', 'p1', 'owner')
  expect(parsed.issues).toEqual([])
  expect(parsed.rows.find(r => r.field === 'material')).toMatchObject({ value: 'Protected cotton' })
  expect(parsed.rows.find(r => r.field === 'productType')).toMatchObject({ action: 'INHERIT' })
  vi.mocked(getFieldCatalogue).mockResolvedValueOnce({ fields: fixtureFields, schema: { present: false } } as never)
  await expect(transferContracts('IT').channel('AMAZON', 'IT', '')).rejects.toThrow('No cached AMAZON schema')
})

it('offers the actual parent and siblings, not every product using the same attribute family', async () => {
  const response = await app.inject(`${url}/options`), options = response.json()
  expect(response.statusCode).toBe(200)
  expect(response.headers['cache-control']).toBe('no-store')
  expect(options.rootId).toBe('p0'); expect(options.products).toHaveLength(20)
  expect(options.products.some((p: any) => p.id === 'p20')).toBe(false)
  expect(options.listings).toHaveLength(40)
  expect(options.accounts[0]).not.toHaveProperty('credentials')
})
it('rejects forged product and destination selections before creating a job', async () => {
  for (const selection of [shared(['p20']), { ...channel(), listingIds: ['p2-account-a'] }, { ...channel(), locales: ['it'] }, { ...shared(), locales: ['xx'] }]) {
    const response = await uploadRows(selection, [row()])
    expect(response.statusCode).toBe(400)
  }
  expect(state.store.data.bulkOperation.size).toBe(0)
})
it('rejects other SKUs, channels, accounts, markets, aliases and shared languages even on unchanged rows', async () => {
  const listingRow = row({ entity: 'Overrides', channel: 'AMAZON', accountId: 'account-a', marketplace: 'IT', field: 'item_name', version: 8 })
  const attempts: [ProductTransferSelection, TransferRow][] = [
    [shared(), row({ sku: '000002' })], [shared(), row({ locale: 'fr' })], [channel(), row()],
    [channel(), { ...listingRow, accountId: 'account-b' }], [channel(), { ...listingRow, marketplace: 'FR' }],
    [channel(), { ...listingRow, aliasKey: 'another-listing' }], [channel(), { ...listingRow, channel: 'EBAY' }],
  ]
  for (const [selection, item] of attempts) {
    const response = await uploadRows(selection, [item])
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().error).toContain('outside')
  }
  expect(state.store.data.bulkOperation.size).toBe(0); expect(state.store.data.auditLog.size).toBe(0)
  const locale = await uploadRows(channel(), [{ ...listingRow, locale: 'de' }]), job = await review(locale.json().jobId)
  expect(job.state).toBe('INVALID'); expect(job.counts.refused).toBe(1)
  expect((await apply(job.jobId, job.reviewToken)).statusCode).toBe(409)
})
it('round-trips a shared child workbook without pinning inheritance or changing its parent', async () => {
  const bytes = await exported(shared()), parsed = await readEditorTransfer(bytes, 'product.xlsx', 'p1', 'owner')
  expect(parsed.issues).toEqual([])
  expect(parsed.rows.every(r => r.entity === 'Products' && r.sku === '000001' && ['', 'it'].includes(r.locale))).toBe(true)
  expect(parsed.rows.find(r => r.field === 'parentSku')).toMatchObject({ action: 'SET', value: '000000' })
  const response = await upload(shared(), bytes), job = await review(response.json().jobId)
  expect(job.state, JSON.stringify(job)).toBe('QUEUED')
  expect(job.counts).toMatchObject({ changed: 0, refused: 0 })
})
it('exports and edits one wide channel workbook, saving only that SKU, account, market and listing', async () => {
  const before = structuredClone([...state.store.data.product.values()]), other = structuredClone([...state.store.data.channelListing.values()].filter(l => l.id !== 'p1-account-a'))
  const bytes = await exported(channel()), parsed = await readEditorTransfer(bytes, 'product.xlsx', 'p1', 'owner')
  expect(parsed.rows.every(r => r.sku === '000001' && r.entity !== 'Products' && r.accountId === 'account-a' && r.marketplace === 'IT')).toBe(true)
  const unchanged = await upload(channel(), bytes), unchangedJob = await review(unchanged.json().jobId)
  expect(unchangedJob.counts).toMatchObject({ changed: 0, refused: 0 })
  const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as never)
  const sheet = sheetWithKey(book, 'item_name')
  const col = (name: string) => colOf(sheet, name)
  sheet.getCell(FIRST_DATA_ROW, col('item_name')).value = 'Scoped Italy title'; sheet.getCell(FIRST_DATA_ROW, col('action:item_name')).value = 'SET'
  const response = await upload(channel(), Buffer.from(await book.xlsx.writeBuffer())), job = await review(response.json().jobId)
  expect(job.state).toBe('QUEUED'); expect(job.counts.changed).toBe(1)
  expect(job.boundary.listings.map((l: any) => l.id)).toEqual(['p1-account-a'])
  expect((await app.inject({ url: `/api/catalog-transfer/jobs/${job.jobId}`, headers: { 'x-fixture-actor': 'other' } })).statusCode).toBe(404)
  expect((await apply(job.jobId, job.reviewToken)).statusCode).toBe(202)
  await vi.waitFor(async () => expect((await getJob(job.jobId)).state).toBe('COMPLETED'))
  // LX.F2 R-LX-21 — a channel TEXT override is a `ChannelListingTranslation` PIN since LX.3,
  // for that coordinate's own language. The legacy `ChannelListing.title` column and
  // `followMasterTitle` are no longer the destination, and both are asserted to have kept
  // their prior values so a silent return to the legacy store fails here.
  expect(state.store.data.channelListing.get('p1-account-a')).toMatchObject({ title: 'Sync snapshot', followMasterTitle: true, overrideData: { material: 'Protected cotton' } })
  expect([...state.store.data.channelListingTranslation.values()].filter((t: any) => t.channelListingId === 'p1-account-a').map((t: any) => ({ language: t.language, name: t.name })))
    .toEqual([{ language: 'it', name: 'Scoped Italy title' }])
  expect([...state.store.data.product.values()]).toEqual(before)
  expect([...state.store.data.channelListing.values()].filter(l => l.id !== 'p1-account-a')).toEqual(other)
})
it('keeps multiple languages, products and destinations explicit in a single scoped workbook', async () => {
  const selection = { productIds: ['p0', 'p1'], includeShared: true, locales: ['it', 'fr'], listingIds: ['p0-account-a', 'p0-account-b', 'p1-account-a', 'p1-account-b'] }
  const bytes = await exported(selection), parsed = await readEditorTransfer(bytes, 'product.xlsx', 'p1', 'owner')
  expect(new Set(parsed.rows.map(r => r.sku))).toEqual(new Set(['000000', '000001']))
  expect(new Set(parsed.rows.filter(r => r.locale).map(r => r.locale))).toEqual(new Set(['it', 'fr']))
  const response = await upload(selection, bytes), job = await review(response.json().jobId)
  expect(job.counts).toMatchObject({ changed: 0, refused: 0 })
})
it('requires a new review when identities move or a listing is replaced after preview', async () => {
  const response = await uploadRows(channel(), [row({ entity: 'Overrides', channel: 'AMAZON', marketplace: 'IT', accountId: 'account-a', field: 'item_name', version: 8 })]), job = await review(response.json().jobId)
  const old = state.store.data.channelListing.get('p1-account-a')!
  state.store.data.channelListing.delete(old.id); state.store.data.channelListing.set('replacement', { ...old, id: 'replacement' })
  expect((await apply(job.jobId, job.reviewToken)).statusCode).toBe(409)
  expect(state.store.data.auditLog.size).toBe(0)
  const boundary = await resolveProductTransferBoundary('p1', shared())
  state.store.data.product.get('p1')!.parentId = 'p20'
  await expect(checkProductTransferBoundary(boundary)).rejects.toThrow('group changed')
})
it('rechecks the frozen scope inside a recovered write and refuses reparenting during preview', async () => {
  const response = await uploadRows(shared(), [row()]), job = await review(response.json().jobId)
  const stored = state.store.data.bulkOperation.get(job.jobId)!
  stored.status = 'RUNNING'; stored.processed = 0
  state.store.data.product.get('p1')!.parentId = 'p20'
  await runTransferJob(job.jobId)
  expect((await getJob(job.jobId)).state).toBe('PARTIAL')
  expect(state.store.data.product.get('p1')!.name).toBe('Original 1')
  expect(state.store.data.auditLog.size).toBe(0)
  state.store.data.product.get('p1')!.parentId = 'p0'
  const move = await uploadRows(shared(), [row({ field: 'parentSku', value: '000020' })]), moved = await review(move.json().jobId)
  expect(moved.state).toBe('INVALID')
  expect((await apply(moved.jobId, moved.reviewToken)).statusCode).toBe(409)
})
it('retains update-only product scope when retrying a concurrent edit refusal', async () => {
  const response = await uploadRows(shared(), [row()]), job = await review(response.json().jobId)
  const p = state.store.data.product.get('p1')!; p.version++; p.name = 'Edited concurrently'
  expect((await apply(job.jobId, job.reviewToken)).statusCode).toBe(202)
  await vi.waitFor(async () => expect((await getJob(job.jobId)).state).toBe('PARTIAL'))
  const retried = await app.inject({ method: 'POST', url: `/api/catalog-transfer/jobs/${job.jobId}/retry`, payload: {} })
  expect(retried.statusCode).toBe(201)
  const next = await review(retried.json().jobId)
  expect(next.mode).toBe('update'); expect(next.boundary).toEqual(job.boundary); expect(next.state).toBe('QUEUED')
  expect(state.store.data.product.get('p1')!.name).toBe('Edited concurrently')
})

it('round-trips and saves sorted and filtered named aliases independently of the primary listing', async () => {
  const original = state.store.data.channelListing.get('p1-account-a')!
  for (const [id, label] of [['summer', 'Summer listing'], ['outlet', 'Outlet listing']]) {
    state.store.data.productListingAlias.set(id, { id, productId: 'p0', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account-a', status: 'ACTIVE', label })
    state.store.data.channelListing.set(`p1-${id}`, { ...structuredClone(original), id: `p1-${id}`, aliasKey: id, aliasId: id })
  }
  const selection = { ...channel(), listingIds: ['p1-account-a', 'p1-summer', 'p1-outlet'] }
  const before = structuredClone([...state.store.data.channelListing.values()].filter(l => !selection.listingIds.slice(1).includes(l.id)))
  const bytes = await exported(selection)
  const unchanged = await upload(selection, bytes), noChanges = await review(unchanged.json().jobId)
  expect(noChanges.counts).toMatchObject({ changed: 0, refused: 0 })
  const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as never)
  const sheet = sheetWithKey(book, 'item_name')
  const col = (name: string) => colOf(sheet, name)
  const labels: string[] = []
  sheet.eachRow((r, i) => {
    if (i < FIRST_DATA_ROW) return
    const key = r.getCell(col('aliasKey')).text
    labels.push(r.getCell(col('listing')).text)
    if (key) r.getCell(col('item_name')).value = `${key} title`
  })
  expect(labels).toEqual(expect.arrayContaining(['Primary listing', 'Summer listing', 'Outlet listing']))
  // A header sort moves entire rows, including the hidden alias identity/version.
  // Filtering hides a row; it is not an instruction to omit that row's changes.
  const sorted = sheet.getRows(FIRST_DATA_ROW, sheet.rowCount - KEY_ROW)!.map(r => (r.values as any[]).slice()).sort((a, b) => String(a[col('listing')]).localeCompare(String(b[col('listing')])))
  sorted.forEach((values, i) => { sheet.getRow(i + FIRST_DATA_ROW).values = values })
  expect(sheet.getCell(FIRST_DATA_ROW, col('aliasKey')).text).toBe('outlet')
  sheet.getRow(FIRST_DATA_ROW).hidden = true
  // The freeze and the filter follow the two header rows and the four identity columns.
  expect(sheet.views[0]).toMatchObject({ state: 'frozen', xSplit: 4, ySplit: KEY_ROW })
  expect(sheet.autoFilter).toBe(`A${KEY_ROW}:${sheet.getColumn(sheet.columnCount).letter}${sheet.rowCount}`)
  const uploaded = await upload(selection, Buffer.from(await book.xlsx.writeBuffer())), job = await review(uploaded.json().jobId)
  expect(job.counts).toMatchObject({ changed: 2, listingsAffected: 2, productsAffected: 0, refused: 0 })
  expect((await app.inject(`/api/catalog-transfer/jobs/${job.jobId}/outcomes?status=CHANGED`)).json().total).toBe(2)
  const filtered = (await app.inject(`/api/catalog-transfer/jobs/${job.jobId}/outcomes?status=CHANGED&sku=000001&destination=${encodeURIComponent(JSON.stringify(['AMAZON', 'account-a', 'IT', 'summer']))}`)).json()
  expect(filtered.total).toBe(1)
  // LX.F2 R-LX-21 — the provenance word comes from the LX tier vocabulary now ("<language> ·
  // pin"), not the pre-LX "Listing override": the value is the same, its ADDRESS is what
  // changed. Asserted verbatim so the wording cannot drift silently.
  expect(filtered.rows[0].cells.find((c: any) => c.field === 'item_name').effectiveAfter).toMatchObject({ value: 'summer title', source: 'it · pin' })
  expect((await app.inject(`${url}/options`)).json().recentJobs.some((j: any) => j.id === job.jobId)).toBe(true)
  expect((await app.inject({ url: `${url}/options`, headers: { 'x-fixture-actor': 'other' } })).json().recentJobs).toEqual([])
  await apply(job.jobId, job.reviewToken)
  await vi.waitFor(async () => expect((await getJob(job.jobId)).state).toBe('COMPLETED'))
  // LX.F2 R-LX-21 — both alias overrides land on their coordinate's PIN tier (LX.3); the
  // legacy `ChannelListing.title` column keeps its prior value on both, which is asserted so
  // the two stores cannot swap traffic unnoticed.
  expect((await getJob(job.jobId)).receipt).toEqual({ saved: 2, unchanged: 1, failed: 0, excluded: 0, unprocessed: 0 })
  expect(['p1-summer', 'p1-outlet'].map(id => state.store.data.channelListing.get(id)!.title)).toEqual(['Sync snapshot', 'Sync snapshot'])
  expect([...state.store.data.channelListingTranslation.values()].filter((t: any) => ['p1-summer', 'p1-outlet'].includes(t.channelListingId)).map((t: any) => ({ listing: t.channelListingId, language: t.language, name: t.name })))
    .toEqual(expect.arrayContaining([{ listing: 'p1-summer', language: 'it', name: 'summer title' }, { listing: 'p1-outlet', language: 'it', name: 'outlet title' }]))
  expect([...state.store.data.channelListing.values()].filter(l => !selection.listingIds.slice(1).includes(l.id))).toEqual(before)
  const audits = state.store.data.auditLog.size
  await apply(job.jobId, job.reviewToken)
  expect(state.store.data.auditLog.size).toBe(audits)
})

it('preserves a deleted value unless the workbook explicitly requests clearing', async () => {
  state.store.data.product.get('p1')!.description = 'Keep this description'
  const bytes = await exported(shared()), book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as never)
  const sheet = sheetWithKey(book, 'description')
  const col = (name: string) => colOf(sheet, name)
  sheet.getCell(FIRST_DATA_ROW, col('description')).value = null
  const keep = await upload(shared(), Buffer.from(await book.xlsx.writeBuffer()))
  expect((await review(keep.json().jobId)).counts).toMatchObject({ changed: 0, refused: 0 })
  sheet.getCell(FIRST_DATA_ROW, col('action:description')).value = 'INHERIT'
  const inherit = await upload(shared(), Buffer.from(await book.xlsx.writeBuffer()))
  expect((await review(inherit.json().jobId)).counts).toMatchObject({ changed: 1, refused: 0 })
})

it('refuses missing versions in both older and new product workbooks', async () => {
  const legacy = await uploadRows(shared(), [row({ version: undefined })])
  expect((await review(legacy.json().jobId)).state).toBe('INVALID')
  const bytes = await exported(shared()), book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as never)
  const sheet = sheetWithKey(book, 'version')
  sheet.getCell(FIRST_DATA_ROW, colOf(sheet, 'version')).value = null
  const broken = await upload(shared(), Buffer.from(await book.xlsx.writeBuffer()))
  expect((await review(broken.json().jobId)).state).toBe('INVALID')
})

it('refuses an unowned, expired or downgraded editing baseline and replaced records', async () => {
  const bytes = await exported(channel()), book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as never)
  const saved = state.store.data.bulkOperation.get(book.getWorksheet('Nexus workbook')!.getCell('C2').text)!
  const validity = book.getWorksheet('Instructions')!.getSheetValues().flat().join(' ')
  expect(validity).toContain(saved.expiresAt.toISOString())
  expect(validity).toContain(saved.changes.exportedAt)
  expect(saved.changes.expiresAt).toBe(saved.expiresAt.toISOString())
  expect(saved.expiresAt.getTime() - new Date(saved.changes.exportedAt).getTime()).toBe(30 * 24 * 60 * 60_000)
  await expect(readEditorTransfer(bytes, 'product.xlsx', 'p1', 'someone-else')).rejects.toThrow('baseline')
  book.getWorksheet('Nexus workbook')!.getCell('B2').value = 2
  await expect(readEditorTransfer(Buffer.from(await book.xlsx.writeBuffer()), 'product.xlsx', 'p1', 'owner')).rejects.toThrow('version was changed')
  const original = state.store.data.channelListing.get('p1-account-a')!
  state.store.data.channelListing.delete(original.id); state.store.data.channelListing.set('replacement', { ...original, id: 'replacement' })
  await expect(readEditorTransfer(bytes, 'product.xlsx', 'p1', 'owner')).rejects.toThrow('replaced')
  state.store.data.channelListing.delete('replacement'); state.store.data.channelListing.set(original.id, original)
  const id = book.getWorksheet('Nexus workbook')!.getCell('C2').text
  state.store.data.bulkOperation.get(id)!.expiresAt = new Date(0)
  await expect(readEditorTransfer(bytes, 'product.xlsx', 'p1', 'owner')).rejects.toThrow('expired')
})

it('keeps formula-controlled values unchanged and refuses both existing and newly added formulas', async () => {
  const formula = { id: 'formula', productId: 'p1', scope: 'master', channel: '', marketplace: '', locale: 'it', fieldKey: 'name' }
  state.store.data.cellFormula.set('formula', formula)
  const same = await upload(shared(), await exported(shared()))
  expect((await review(same.json().jobId)).counts).toMatchObject({ changed: 0, refused: 0 })
  const changed = await uploadRows(shared(), [row()]), refused = await review(changed.json().jobId)
  expect(refused.state).toBe('INVALID')
  state.store.data.cellFormula.clear()
  const accepted = await uploadRows(shared(), [row()]), planned = await review(accepted.json().jobId)
  state.store.data.cellFormula.set('formula', formula)
  await apply(planned.jobId, planned.reviewToken)
  await vi.waitFor(async () => expect((await getJob(planned.jobId)).state).toBe('PARTIAL'))
  expect(state.store.data.product.get('p1')!.name).toBe('Original 1')
  expect(state.store.data.cellFormula.get('formula')).toEqual(formula)
})

it('refuses formula source edits on both a product and its inheriting variants', async () => {
  state.store.data.cellFormula.set('dependent', { id: 'dependent', productId: 'p2', scope: 'master', channel: '', marketplace: '', locale: 'it', fieldKey: 'description', dependsOn: ['name'] })
  const response = await uploadRows(shared(['p0']), [row({ sku: '000000' })]), job = await review(response.json().jobId)
  expect(job.state).toBe('INVALID')
  const outcomes = (await app.inject(`/api/catalog-transfer/jobs/${job.jobId}/outcomes?status=INVALID`)).json()
  expect(outcomes.rows[0].issues[0].message).toContain('formula depends on this value')
  expect(state.store.data.auditLog.size).toBe(0)
})

it('maps supplier columns directly to named existing listings and refuses destinations outside the selection', async () => {
  const original = state.store.data.channelListing.get('p1-account-a')!
  state.store.data.productListingAlias.set('summer', { id: 'summer', productId: 'p0', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account-a', status: 'ACTIVE', label: 'Summer listing' })
  state.store.data.channelListing.set('p1-summer', { ...original, id: 'p1-summer', aliasKey: 'summer', aliasId: 'summer' })
  const fields = await app.inject('/api/catalog-transfer/source/fields?market=IT&productId=p1&listingId=p1-summer')
  expect(fields.statusCode, fields.body).toBe(200); expect(fields.json().fields.some((f: any) => f.key === 'item_name')).toBe(true)
  const boundary = 'supplier-upload', payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="supplier.csv"\r\nContent-Type: text/csv\r\n\r\nSKU,Title\n000001,Summer coat\r\n--${boundary}--\r\n`
  const source = (await app.inject({ method: 'POST', url: '/api/catalog-transfer/source/inspect', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload })).json()
  const mapping = { kind: 'catalog-source-v1', skuColumn: 'SKU', market: 'IT', mode: 'update', policy: { shared: 'replace', overrides: 'replace' }, bindings: [{ source: 'Title', entity: 'Overrides', field: 'item_name', format: 'text', channel: { value: 'AMAZON' }, marketplace: { value: 'IT' }, accountId: { value: 'account-a' }, aliasKey: { value: 'summer' } }] }
  const staged = await app.inject({ method: 'POST', url: `${url}/source/preview`, payload: { sourceId: source.sourceId, inputHash: source.hash, mapping, selection: { ...channel(), listingIds: ['p1-summer'] } } })
  expect(staged.statusCode, staged.body).toBe(201)
  const job = await review(staged.json().jobId); expect(job.counts.changed).toBe(1)
  const outside = await app.inject({ method: 'POST', url: `${url}/source/preview`, payload: { sourceId: source.sourceId, inputHash: source.hash, mapping, selection: channel() } })
  expect(outside.statusCode).toBe(409)
  await apply(job.jobId, job.reviewToken)
  await vi.waitFor(async () => expect((await getJob(job.jobId)).state).toBe('COMPLETED'))
  // LX.F2 R-LX-21 — the supplier column lands on the PIN tier for the coordinate's language.
  expect(state.store.data.channelListing.get('p1-summer')!.title).toBe('Sync snapshot')
  expect([...state.store.data.channelListingTranslation.values()].filter((t: any) => t.channelListingId === 'p1-summer').map((t: any) => ({ language: t.language, name: t.name })))
    .toEqual([{ language: 'it', name: 'Summer coat' }])
  expect(state.store.data.channelListing.get('p1-account-a')).toEqual(original)
})

it('accepts complete ZIP batches and refuses missing parts or duplicate targets', async () => {
  const one = await exported(shared()), two = await exported(channel())
  const archive = async (parts: Buffer[], omit = false) => {
    const zip = new JSZip()
    const files = parts.map((bytes, i) => { const filename = `part-${i}.xlsx`; if (!omit || i !== 1) zip.file(filename, bytes); return { filename, attributeRows: 1 } })
    zip.file('manifest.json', JSON.stringify({ purpose: 'editing', files }))
    return zip.generateAsync({ type: 'nodebuffer' })
  }
  // Separate exports have separate selections; they must not be combined silently.
  await expect(readEditorTransfer(await archive([one, two]), 'batch.zip', 'p1', 'owner')).rejects.toThrow('different export selections')
  await expect(readEditorTransfer(await archive([one, one], true), 'batch.zip', 'p1', 'owner')).rejects.toThrow('missing')
  await expect(readEditorTransfer(await archive([one, one]), 'batch.zip', 'p1', 'owner')).rejects.toThrow('same product or listing')
  const complete = await readEditorTransfer(await archive([one]), 'batch.zip', 'p1', 'owner')
  expect(complete.issues).toEqual([]); expect(complete.rows.length).toBeGreaterThan(0)
})

it('inspects and previews a complete two-part editing export once, with exact file provenance', async () => {
  const selection = shared(['p1', 'p2']), boundary = await resolveProductTransferBoundary('p1', selection)
  const zip = new JSZip(), files = []
  for (const sku of ['000001', '000002']) {
    const filename = `${sku}.xlsx`
    const scope = { sheet: 'Products', entity: 'Products' as const, channel: '', accountId: '', marketplace: '', locale: '', category: '', fields: [{ field: 'name', label: 'Title', type: 'text' }], rows: [row({ sku, value: `Original ${Number(sku)}` })] }
    const bytes = await writeEditorWorkbook([scope], boundary, 'owner'), book = new ExcelJS.Workbook()
    await book.xlsx.load(bytes as never)
    const sheet = sheetWithKey(book, 'name'), column = colOf(sheet, 'name')
    sheet.getCell(FIRST_DATA_ROW, column).value = `Edited ${sku}`
    zip.file(filename, Buffer.from(await book.xlsx.writeBuffer())); files.push({ filename, attributeRows: 1 })
  }
  zip.file('manifest.json', JSON.stringify({ purpose: 'editing', files }))
  const bytes = await zip.generateAsync({ type: 'nodebuffer' }), multipartBoundary = 'batch-inspection'
  const payload = Buffer.concat([Buffer.from(`--${multipartBoundary}\r\nContent-Disposition: form-data; name="file"; filename="products.zip"\r\nContent-Type: application/zip\r\n\r\n`), bytes, Buffer.from(`\r\n--${multipartBoundary}--\r\n`)])
  const inspected = await app.inject({ method: 'POST', url: `${url}/inspect`, headers: { 'content-type': `multipart/form-data; boundary=${multipartBoundary}` }, payload })
  expect(inspected.statusCode, inspected.body).toBe(201)
  const input = inspected.json()
  expect(input.selection.productIds).toEqual(['p1', 'p2']); expect(input.attributes).toBe(2)
  const staged = await app.inject({ method: 'POST', url: `${url}/preview`, payload: { inputId: input.inputId, selection: input.selection, market: 'IT' } })
  expect(staged.statusCode, staged.body).toBe(201)
  const job = await review(staged.json().jobId)
  expect(job.counts.changed).toBe(2)
  const outcomes = (await app.inject(`/api/catalog-transfer/jobs/${job.jobId}/outcomes?status=CHANGED`)).json()
  expect(outcomes.rows.map((r: any) => r.cells[0].source.file)).toEqual(['000001.xlsx', '000002.xlsx'])
  const unowned = await app.inject({ method: 'POST', url: `${url}/preview`, headers: { 'x-fixture-actor': 'other' }, payload: { inputId: input.inputId, selection: input.selection, market: 'IT' } })
  expect(unowned.statusCode).toBe(409)
})

it.skipIf(process.env.NEXUS_PRODUCT_TRANSFER_BROWSER !== '1')('serves the isolated product transfer browser fixture', async () => {
  const original = state.store.data.channelListing.get('p1-account-a')!
  for (const [id, label] of [['summer', 'Summer listing'], ['outlet', 'Outlet listing']]) {
    state.store.data.productListingAlias.set(id, { id, productId: 'p0', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account-a', status: 'ACTIVE', label })
    state.store.data.channelListing.set(`p1-${id}`, { ...structuredClone(original), id: `p1-${id}`, aliasKey: id, aliasId: id })
  }
  await writeFile('/tmp/nexus-product-transfer-supplier.csv', 'SKU,Summer title,Outlet title\n000001,Summer coat,Outlet coat')
  await app.listen({ host: '127.0.0.1', port: 4108 })
  await writeFile('/tmp/nexus-product-transfer-fixture-ready.json', JSON.stringify({ port: 4108, pid: process.pid }))
  await new Promise<void>(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve) })
}, 3_600_000)

it.skipIf(process.env.NEXUS_PRODUCT_TRANSFER_BENCH !== '1')('measures product editing export, parse, preview and apply at bounded sizes', async () => {
  state.store = importTestStore({ recordQueries: false })
  const metrics = []
  const baseField = fixtureFields[1]
  fixtureFields.push(...Array.from({ length: 48 }, (_, i) => ({ ...baseField, fieldKey: `detail_${i}`, sheetKey: `detail_${i}`, label: `Detail ${i}` })))
  try {
    for (const count of [1, 25, 100, 500]) for (const density of ['sparse', 'dense']) {
      state.store.seed(count)
      for (const p of state.store.data.product.values()) { p.parentId = p.id === 'p0' ? null : 'p0'; p.isParent = p.id === 'p0' }
      for (const alias of ['summer', 'outlet']) {
        state.store.data.productListingAlias.set(alias, { id: alias, productId: 'p0', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account-a', status: 'ACTIVE', label: alias })
        for (const p of state.store.data.product.values()) { const original = state.store.data.channelListing.get(`${p.id}-account-a`)!; state.store.data.channelListing.set(`${p.id}-${alias}`, { ...structuredClone(original), id: `${p.id}-${alias}`, aliasKey: alias, aliasId: alias }) }
      }
      if (density === 'dense') for (const l of state.store.data.channelListing.values()) l.overrideData = { ...l.overrideData, ...Object.fromEntries(Array.from({ length: 48 }, (_, i) => [`detail_${i}`, `Verified detail ${i}`])) }
      const selection = { productIds: [...state.store.data.product.keys()], includeShared: true, locales: [], listingIds: [...state.store.data.channelListing.values()].filter(l => l.marketplace === 'IT').map(l => l.id) }
      let peakRss = process.memoryUsage().rss
      const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 20)
      try {
        let start = performance.now(), q = state.store.queryCount
        const download = await app.inject({ method: 'POST', url: '/api/catalog-transfer/products/p0/export', payload: { market: 'IT', selection, fields: density === 'sparse' ? ['name', 'item_name'] : undefined } })
        expect(download.statusCode, download.body.slice(0, 200)).toBe(200)
        const exportMs = Math.round(performance.now() - start), exportQueries = state.store.queryCount - q
        start = performance.now()
        const parsed = await readEditorTransfer(download.rawPayload, String(download.headers['content-type']).includes('zip') ? 'batch.zip' : 'product.xlsx', 'p0', 'owner')
        expect(parsed.issues).toEqual([])
        const parseMs = Math.round(performance.now() - start)
        const rows = parsed.rows.map(r => r.field === 'item_name' ? { ...r, action: 'SET' as const, value: `Edited ${r.sku} ${r.aliasKey || 'primary'}` } : r)
        const boundary = await resolveProductTransferBoundary('p0', selection)
        start = performance.now(); q = state.store.queryCount
        const job = await stageTransferJob({ rows, issues: [], mode: 'update', market: 'IT', filename: 'benchmark.xlsx', userId: 'owner', boundary })
        const stageMs = Math.round(performance.now() - start)
        const ready = await review(job.jobId), previewMs = Math.round(performance.now() - start), previewQueries = state.store.queryCount - q
        expect(ready.state).toBe('QUEUED'); expect(ready.counts.changed).toBe(count * 3)
        start = performance.now(); q = state.store.queryCount
        await apply(job.jobId, ready.reviewToken)
        await vi.waitFor(async () => expect((await getJob(job.jobId)).state).toBe('COMPLETED'), { timeout: 120_000, interval: 25 })
        metrics.push({ count, density, listings: count * 3, attributes: rows.length, bytes: download.rawPayload.length, exportMs, exportQueries, parseMs, stageMs, previewMs, previewQueries, applyMs: Math.round(performance.now() - start), applyQueries: state.store.queryCount - q, peakProcessRssMiB: Math.round(peakRss / 1024 / 1024) })
      } finally { clearInterval(sample) }
    }
    await writeFile('/tmp/nexus-product-transfer-performance.json', JSON.stringify({ environment: 'Synthetic in-memory Prisma-shaped store; counts database method calls without retaining query payloads. Process RSS is sampled, not production peak memory. One measured run per case.', metrics }, null, 2))
  } finally { fixtureFields.splice(2) }
}, 600_000)
