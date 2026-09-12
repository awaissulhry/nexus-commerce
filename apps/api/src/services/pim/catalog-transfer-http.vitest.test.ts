/** Real registered import routes with an isolated store; optional local browser fixture. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { writeFile } from 'node:fs/promises'
import { importTestStore, fixtureColumns, fixtureFields } from './catalog-transfer-test/store.js'
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: vi.fn() } }))
const state = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof importTestStore> }))
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => state.store.db[key as string] }) }))
vi.mock('./sheet-columns.service.js', () => ({ getSheetColumns: async () => ({ columns: fixtureColumns }), clearSheetColumnCache: vi.fn() }))
vi.mock('./mapping/field-catalogue.service.js', () => ({ getFieldCatalogue: async () => ({ fields: fixtureFields, schema: { present: true, fetchedAt: '2026-01-01' } }), clearFieldCatalogueCache: vi.fn() }))
vi.mock('./mapping/category-mapping.service.js', () => ({ resolveCategoriesForProducts: async ({ productIds }: { productIds: string[] }) => Object.fromEntries(productIds.map(id => [id, { channelCategoryId: 'COAT' }])) }))
vi.mock('./catalog-source-fetch.js', () => ({ fetchCatalogSource: async (url: string) => {
  if (url !== 'https://supplier.example/session-two.csv') throw new Error('Isolated fixture permits only the documented supplier URL')
  return { buffer: Buffer.from('SKU,Name,Amazon A\n000000,Imported shared title,Imported Italy title\n000001,Imported variant title,'), filename: 'session-two.csv' }
} }))
import routes from '../../routes/catalog-transfer.routes.js'
import schedules from '../../routes/scheduled-imports.routes.js'
import legacyRoutes from '../../routes/import-wizard.routes.js'
import { writeCatalogWorkbook, type WorkbookScope } from './catalog-workbook.js'
const app = Fastify()
beforeAll(async () => {
  state.store = importTestStore(); state.store.seed(2500)
  await app.register(multipart)
  app.addHook('onRequest', async request => { (request as any).authUser = { id: request.headers['x-fixture-actor'] ?? 'owner' } })
  await app.register(routes, { prefix: '/api' }); await app.register(schedules, { prefix: '/api' }); await app.register(legacyRoutes, { prefix: '/api' })
  app.get('/api/auth/csrf', async () => ({ csrfToken: 'isolated-fixture' }))
  app.get('/api/auth/me', async () => ({ user: { id: 'owner', displayName: 'Session 2 fixture', email: 'fixture@example.test', roleKeys: ['owner'] }, isOwner: true, permissions: ['products.import', 'products.view'] }))
  app.get('/api/fixture/evidence', async () => ({ products: [...state.store.data.product.values()].slice(0, 2), listings: [...state.store.data.channelListing.values()].slice(0, 4), audits: [...state.store.data.auditLog.values()] }))
  app.setNotFoundHandler(async request => ({ fixture: true, path: request.url, data: [], items: [], profiles: [], connections: [], alerts: [], count: 0, total: 0 }))
  await app.ready()
})
afterAll(() => app.close())
const get = async (url: string) => (await app.inject({ url })).json()
it('serves lightweight readiness choices and refuses ambiguous or unowned reviews over HTTP', async () => {
  const before = state.store.queries.length
  const options = await app.inject('/api/catalog-transfer/readiness/options')
  expect(options.statusCode).toBe(200)
  expect(options.json()).toMatchObject({ families: expect.any(Array), accounts: expect.any(Array), markets: expect.any(Array) })
  expect(options.json()).not.toHaveProperty('channelCategories')
  expect(state.store.queries.slice(before).every(q => ['productFamily', 'channelConnection', 'marketplace'].includes(q.model))).toBe(true)
  const invalid = await app.inject('/api/catalog-transfer/readiness?familyId=f1&productIds=p1')
  expect(invalid.statusCode).toBe(400)
  expect(invalid.headers['cache-control']).toBe('no-store')
  const missing = await app.inject({ url: '/api/catalog-transfer/readiness?job=missing', headers: { 'x-fixture-actor': 'another-user' } })
  expect(missing.statusCode).toBe(400)
  expect(missing.json().error).toBe('Import job not found')
})
it('runs multipart upload, source mapping, complete paginated HTTP review and apply through registered routes', async () => {
  const boundary = 'session-two-isolated-boundary'
  const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.csv"\r\nContent-Type: text/csv\r\n\r\nSKU,Name,Amazon A\n000000,HTTP shared,HTTP title\r\n--${boundary}--\r\n`
  const upload = await app.inject({ method: 'POST', url: '/api/catalog-transfer/source/inspect', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload })
  expect(upload.statusCode).toBe(201)
  const source = upload.json()
  const mapping = { kind: 'catalog-source-v1', market: 'IT', mode: 'update', skuColumn: 'SKU', policy: { shared: 'replace', overrides: 'replace' }, bindings: [{ source: 'Name', entity: 'Products', field: 'name', format: 'text' }, { source: 'Amazon A', entity: 'Overrides', field: 'item_name', format: 'text', channel: { value: 'AMAZON' }, accountId: { value: 'account-a' }, marketplace: { value: 'IT' } }] }
  const staged = await app.inject({ method: 'POST', url: '/api/catalog-transfer/source/preview', payload: { sourceId: source.sourceId, inputHash: source.hash, mapping } })
  expect(staged.statusCode).toBe(201)
  const path = `/api/catalog-transfer/jobs/${staged.json().jobId}`
  let review: any
  await vi.waitFor(async () => { review = await get(path); expect(review.state).toBe('QUEUED') })
  expect((await get(`${path}/outcomes`)).total).toBe(2)
  expect((await app.inject({ url: path, headers: { 'x-fixture-actor': 'another-user' } })).statusCode).toBe(404)
  expect((await app.inject({ method: 'POST', url: `${path}/apply`, payload: { reviewToken: 'changed' } })).statusCode).toBe(409)
  expect((await app.inject({ method: 'POST', url: `${path}/apply`, payload: { reviewToken: review.reviewToken } })).statusCode).toBe(202)
  await vi.waitFor(async () => { expect((await get(path)).state).toBe('COMPLETED') })
  expect(state.store.data.product.get('p0')).toMatchObject({ name: 'HTTP shared', totalStock: 17, basePrice: 25 })
  expect(state.store.data.channelListing.get('p0-account-a')).toMatchObject({ title: 'HTTP title', overrideData: { material: 'Protected cotton' } })
  expect((await get(`${path}/outcomes`)).rows.every((r: any) => r.status === 'SUCCESS')).toBe(true)
  expect((await app.inject({ url: `${path}/errors` })).headers['content-type']).toContain('text/csv')
})
it.skipIf(process.env.NEXUS_SESSION_TWO_BROWSER !== '1')('serves the isolated browser fixture on port 4102', async () => {
  state.store.seed(2500)
  await writeFile('/tmp/nexus-session-two-browser-source.csv', 'SKU,Name,Amazon A\n000000,Imported shared title,Imported Italy title\n000001,Imported variant title,')
  await app.listen({ host: '127.0.0.1', port: 4102 })
  await writeFile('/tmp/nexus-session-two-fixture-ready.json', JSON.stringify({ port: 4102, pid: process.pid, products: 2500, listings: 5000 }))
  await new Promise<void>(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve) })
}, 3_600_000)

it('applies one wide workbook to independent languages, accounts and marketplaces through the real HTTP workflow', async () => {
  const stored = state.store.data.product.get('p1')!
  const scopes: WorkbookScope[] = ['it', 'de'].map(locale => ({ sheet: `Content ${locale}`, entity: 'Products', channel: '', accountId: '', marketplace: '', locale, category: '',
    fields: [{ field: 'name', label: 'Title', type: 'text' }], rows: [{ row: 2, entity: 'Products', sku: stored.sku, channel: '', accountId: '', marketplace: '', aliasKey: '', locale, field: 'name', action: 'SET', value: locale === 'it' ? 'Giacca italiana' : 'Deutsche Jacke', version: stored.version }] }))
  for (const [accountId, marketplace, value] of [['account-a', 'IT', 'Titolo Amazon'], ['account-b', 'FR', 'Titre Amazon']]) {
    const listing = state.store.data.channelListing.get(`p1-${accountId}`)!
    scopes.push({ sheet: `Amazon ${marketplace}`, entity: 'Overrides', channel: 'AMAZON', accountId, marketplace, locale: '', category: '', fields: [{ field: 'item_name', label: 'Title', type: 'text' }],
      rows: [{ row: 2, entity: 'Overrides', sku: stored.sku, channel: 'AMAZON', accountId, marketplace, aliasKey: '', locale: '', field: 'item_name', action: 'SET', value, version: listing.version }] })
  }
  const bytes = await writeCatalogWorkbook(scopes), boundary = 'wide-catalog-fixture'
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\nupdate\r\n--${boundary}\r\nContent-Disposition: form-data; name="market"\r\n\r\nIT\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="multi.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)])
  const preview = await app.inject({ method: 'POST', url: '/api/catalog-transfer/preview', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload })
  expect(preview.statusCode).toBe(201)
  const path = `/api/catalog-transfer/jobs/${preview.json().jobId}`
  let review: any
  await vi.waitFor(async () => { review = await get(path); expect(review.state).toBe('QUEUED') })
  expect(review.counts.changed).toBe(4)
  expect((await app.inject({ method: 'POST', url: `${path}/apply`, payload: { reviewToken: review.reviewToken } })).statusCode).toBe(202)
  await vi.waitFor(async () => expect((await get(path)).state).toBe('COMPLETED'))
  expect(state.store.data.product.get('p1')).toMatchObject({ name: stored.name, localizedContent: { it: { title: 'Giacca italiana' }, de: { title: 'Deutsche Jacke' } }, basePrice: 25, totalStock: 17 })
  expect(state.store.data.channelListing.get('p1-account-a')?.title).toBe('Titolo Amazon')
  expect(state.store.data.channelListing.get('p1-account-b')?.title).toBe('Titre Amazon')
  // Reusing the old workbook cannot overwrite these newer record versions.
  const stale = await app.inject({ method: 'POST', url: '/api/catalog-transfer/preview', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload })
  await vi.waitFor(async () => expect((await get(`/api/catalog-transfer/jobs/${stale.json().jobId}`)).state).toBe('INVALID'))
})
