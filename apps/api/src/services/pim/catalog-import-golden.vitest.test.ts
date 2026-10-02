/**
 * MCP full control P9 — the import wizard's answers, byte for byte, recorded on the code BEFORE P9 touched the import.
 *
 * The Owner allowed P9 exactly two changes to the existing import (2026-10-02, choice A): a "before" record per applied
 * row (so a whole import can be undone), and `import-catalog`, which starts an import through this same wizard.
 * Nothing else may change: the wizard's checks, mapping, matching and messages stay as they were. This file is the
 * proof. Each scenario drives the registered routes (catalog import and the legacy /import-jobs) over the isolated
 * import store, and writes everything the wizard answers and everything it stored into a golden next to this file:
 * every status and body, every review outcome and message, the errors CSV, the catalog it changed, its audit rows,
 * and every column of every import row — except `beforeState`, the one column P9 adds a value to (its own tests are in
 * catalog-import-before-record.vitest.test.ts).
 *
 * The goldens were written by the wizard as it was before P9. Under CI vitest does not write them, so a missing or
 * different golden fails. The clock is fixed (Date only), so stamps and review tokens are the same on every run.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { importTestStore, fixtureColumns, fixtureFields } from './catalog-transfer-test/store.js'
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: vi.fn() } }))
const state = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof importTestStore> }))
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => state.store.db[key as string] }) }))
vi.mock('./sheet-columns.service.js', () => ({ getSheetColumns: async () => ({ columns: fixtureColumns }), clearSheetColumnCache: vi.fn(),
  coordinatesFor: (market: string, markets: { channel: string; code: string; languages?: string[] }[] = []) =>
    markets.filter(m => m.code === market).map(m => ({ channel: m.channel, marketplace: m.code, label: `${m.channel} · ${m.code}`, inMarket: true, languages: m.languages ?? ['it'] })) }))
vi.mock('./mapping/field-catalogue.service.js', () => ({ getFieldCatalogue: async () => ({ fields: fixtureFields, schema: { present: true, fetchedAt: '2026-01-01' } }), clearFieldCatalogueCache: vi.fn() }))
vi.mock('./mapping/category-mapping.service.js', () => ({ resolveCategoriesForProducts: async ({ productIds }: { productIds: string[] }) => Object.fromEntries(productIds.map(id => [id, { channelCategoryId: 'COAT' }])) }))
vi.mock('./catalog-source-fetch.js', () => ({ fetchCatalogSource: async (url: string) => {
  if (url !== 'https://supplier.example.test/golden.csv') throw new Error('The link was refused: only the golden supplier link is served here')
  return { buffer: Buffer.from('SKU,Name\n000002,Fetched golden name\n'), filename: 'golden.csv' }
} }))
import routes from '../../routes/catalog-transfer.routes.js'
import legacyRoutes from '../../routes/import-wizard.routes.js'

const NOW = new Date('2026-09-15T10:00:00.000Z')
const app = Fastify()
const GOLDEN = './__golden__'

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  await app.register(multipart)
  app.addHook('onRequest', async request => { (request as any).authUser = { id: request.headers['x-fixture-actor'] ?? 'owner' } })
  await app.register(routes, { prefix: '/api' }); await app.register(legacyRoutes, { prefix: '/api' })
  await app.ready()
})
afterAll(async () => { await app.close(); vi.useRealTimers() })
// A fresh store per scenario: its ids (fixture-1, …) then do not depend on which scenarios ran before.
beforeEach(() => { state.store = importTestStore({ recordQueries: false }); state.store.seed(3) })

/** Everything one scenario saw, in order: written to its golden at the end. */
function transcript() {
  const steps: Array<{ step: string; status?: number; type?: string; body: unknown }> = []
  return {
    steps,
    async call(step: string, request: Parameters<typeof app.inject>[0]) {
      const response = await app.inject(request)
      const type = String(response.headers['content-type'] ?? '')
      steps.push({ step, status: response.statusCode, type: type.split(';')[0], body: type.includes('json') ? response.json() : response.body })
      return response
    },
    note(step: string, body: unknown) { steps.push({ step, body }) },
  }
}

const upload = (filename: string, csv: string, fields: Record<string, string> = {}) => {
  const boundary = 'p9-golden-boundary'
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('')
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`,
  }
}
/**
 * Wait for a job to reach one of `states`. Not vi.waitFor: with Date faked it moves the clock on every check, and the
 * number of checks — so every later stamp and review token — would depend on how fast the machine is.
 */
const finished = async (path: string, states: string[]) => {
  for (let tries = 0; tries < 3_000; tries++) {
    const body = (await app.inject({ url: path })).json()
    if (states.includes(body.state)) return body
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`${path} did not reach ${states.join(' / ')}`)
}

/** What the wizard stored: the catalog it touched, its audit rows, its jobs, and every import-row column but `beforeState`. */
function stored() {
  const rows = (model: string) => [...state.store.data[model].values()]
  return {
    products: rows('product').map(p => ({ id: p.id, sku: p.sku, name: p.name, description: p.description, version: p.version, parentId: p.parentId, isParent: p.isParent, basePrice: p.basePrice, totalStock: p.totalStock, status: p.status ?? null, updatedAt: p.updatedAt })),
    listings: rows('channelListing').map(l => ({ id: l.id, productId: l.productId, channel: l.channel, marketplace: l.marketplace, account: l.channelConnectionId, version: l.version, title: l.title, overrideData: l.overrideData, platformAttributes: l.platformAttributes, updatedAt: l.updatedAt })),
    listingTranslations: rows('channelListingTranslation'),
    productTranslations: rows('productTranslation'),
    audit: rows('auditLog'),
    bulkOperations: rows('bulkOperation'),
    importJobs: rows('importJob'),
    importRows: rows('importJobRow').map(({ beforeState: _beforeState, ...row }) => row),
    outbound: rows('outboundSyncQueue'),
  }
}
const SOURCE_MAPPING = { kind: 'catalog-source-v1', market: 'IT', mode: 'update', skuColumn: 'SKU', policy: { shared: 'replace', overrides: 'replace' },
  bindings: [{ source: 'Name', entity: 'Products', field: 'name', format: 'text' }, { source: 'Amazon A', entity: 'Overrides', field: 'item_name', format: 'text', channel: { value: 'AMAZON' }, accountId: { value: 'account-a' }, marketplace: { value: 'IT' } }] }

it('a source file: inspect, mapping checks, a review with refused, excluded and unchanged rows, a ready-only apply, the legacy routes', async () => {
  const t = transcript()
  const csv = 'SKU,Name,Amazon A,Notes\n000000,Golden shared,Golden title,n1\n000001,,Golden variant title,n2\n,No SKU,,\n999999,Unknown,,\n000002,Original 2,,'
  const inspect = await t.call('inspect', { method: 'POST', url: '/api/catalog-transfer/source/inspect', ...upload('golden-source.csv', csv) })
  const source = inspect.json()
  await t.call('preview: a mapping with no policy', { method: 'POST', url: '/api/catalog-transfer/source/preview', payload: { sourceId: source.sourceId, inputHash: source.hash, mapping: { ...SOURCE_MAPPING, policy: undefined } } })
  await t.call('preview: a mapping naming a missing column', { method: 'POST', url: '/api/catalog-transfer/source/preview', payload: { sourceId: source.sourceId, inputHash: source.hash, mapping: { ...SOURCE_MAPPING, skuColumn: 'Code' } } })
  await t.call('preview: a changed source hash', { method: 'POST', url: '/api/catalog-transfer/source/preview', payload: { sourceId: source.sourceId, inputHash: 'changed', mapping: SOURCE_MAPPING } })
  await t.call('preview: another person', { method: 'POST', url: '/api/catalog-transfer/source/preview', headers: { 'x-fixture-actor': 'another-user' }, payload: { sourceId: source.sourceId, inputHash: source.hash, mapping: SOURCE_MAPPING } })
  const staged = await t.call('preview', { method: 'POST', url: '/api/catalog-transfer/source/preview', payload: { sourceId: source.sourceId, inputHash: source.hash, mapping: SOURCE_MAPPING } })
  const path = `/api/catalog-transfer/jobs/${staged.json().jobId}`
  const review = await finished(path, ['QUEUED', 'INVALID'])
  await t.call('review', { url: path })
  for (const filter of ['', '?status=INVALID', '?status=EXCLUDED', '?status=CHANGED', '?status=UNCHANGED', '?sku=000000', '?status=NOPE']) await t.call(`outcomes${filter}`, { url: `${path}/outcomes${filter}` })
  await t.call('errors csv', { url: `${path}/errors` })
  await t.call('apply: an invalid review', { method: 'POST', url: `${path}/apply`, payload: { reviewToken: review.reviewToken } })
  await t.call('apply: a changed token', { method: 'POST', url: `${path}/apply`, payload: { reviewToken: 'changed', readyOnly: true } })
  await t.call('apply: another person', { method: 'POST', url: `${path}/apply`, headers: { 'x-fixture-actor': 'another-user' }, payload: { reviewToken: review.reviewToken, readyOnly: true } })
  await t.call('apply: the ready records', { method: 'POST', url: `${path}/apply`, payload: { reviewToken: review.reviewToken, readyOnly: true } })
  await finished(path, ['COMPLETED', 'PARTIAL', 'FAILED'])
  await t.call('after apply', { url: path })
  await t.call('outcomes after apply', { url: `${path}/outcomes` })
  await t.call('errors csv after apply', { url: `${path}/errors` })
  await t.call('apply again', { method: 'POST', url: `${path}/apply`, payload: { reviewToken: review.reviewToken, readyOnly: true } })
  const jobId = staged.json().jobId
  await t.call('legacy: list', { url: '/api/import-jobs' })
  await t.call('legacy: job', { url: `/api/import-jobs/${jobId}` })
  const legacyRows = await app.inject({ url: `/api/import-jobs/${jobId}/rows` })
  t.note('legacy: rows (every column but beforeState)', { status: legacyRows.statusCode, rows: legacyRows.json().rows.map(({ beforeState: _b, ...row }: Record<string, unknown>) => row) })
  await t.call('legacy: rollback', { method: 'POST', url: `/api/import-jobs/${jobId}/rollback` })
  await t.call('legacy: apply', { method: 'POST', url: `/api/import-jobs/${jobId}/apply`, payload: { reviewToken: review.reviewToken } })
  await t.call('legacy: preview without a mapping', { method: 'POST', url: '/api/import-jobs/preview', payload: {} })
  const retried = await t.call('legacy: retry the refused rows', { method: 'POST', url: `/api/import-jobs/${jobId}/retry-failed` })
  // The retry's review runs on its own: what it stored is part of the record once it has finished.
  await finished(`/api/catalog-transfer/jobs/${retried.json().job.id}`, ['QUEUED', 'INVALID', 'FAILED'])
  await t.call('legacy: the retry\'s review', { url: `/api/catalog-transfer/jobs/${retried.json().job.id}` })
  t.note('stored', stored())
  await expect(JSON.stringify(t.steps, null, 1)).toMatchFileSnapshot(`${GOLDEN}/import-wizard-source.txt`)
})

it('an upsert source creates a product and updates another; a link source is inspected; a record that moved after review fails with its reason', { timeout: 60_000 }, async () => {
  const t = transcript()
  const csv = 'SKU,Name,Family\n000777,Golden new product,coats\n000001,Golden variant name,coats'
  const inspect = await t.call('inspect', { method: 'POST', url: '/api/catalog-transfer/source/inspect', ...upload('golden-upsert.csv', csv) })
  const source = inspect.json()
  const mapping = { ...SOURCE_MAPPING, mode: 'upsert', bindings: [SOURCE_MAPPING.bindings[0], { source: 'Family', entity: 'Products', field: 'family', format: 'text' }] }
  const staged = await t.call('preview', { method: 'POST', url: '/api/catalog-transfer/source/preview', payload: { sourceId: source.sourceId, inputHash: source.hash, mapping } })
  const path = `/api/catalog-transfer/jobs/${staged.json().jobId}`
  const review = await finished(path, ['QUEUED', 'INVALID'])
  await t.call('review', { url: path })
  await t.call('outcomes', { url: `${path}/outcomes` })
  // Someone saves the variant between review and apply: its record must fail, by name, and the new product still lands.
  const moved = state.store.data.product.get('p1')!
  state.store.data.product.set('p1', { ...moved, name: 'Saved meanwhile', version: moved.version + 1, updatedAt: new Date(NOW.getTime() + 1) })
  await t.call('apply', { method: 'POST', url: `${path}/apply`, payload: { reviewToken: review.reviewToken, readyOnly: review.state === 'INVALID' } })
  await finished(path, ['COMPLETED', 'PARTIAL', 'FAILED'])
  await t.call('after apply', { url: path })
  await t.call('outcomes after apply', { url: `${path}/outcomes` })
  await t.call('errors csv after apply', { url: `${path}/errors` })
  const retry = await t.call('retry', { method: 'POST', url: `${path}/retry` })
  await finished(`/api/catalog-transfer/jobs/${retry.json().jobId}`, ['QUEUED', 'INVALID', 'FAILED'])
  await t.call('retry review', { url: `/api/catalog-transfer/jobs/${retry.json().jobId}` })
  await t.call('fetch: the supplier link', { method: 'POST', url: '/api/catalog-transfer/source/fetch', payload: { url: 'https://supplier.example.test/golden.csv' } })
  await t.call('fetch: a refused link', { method: 'POST', url: '/api/catalog-transfer/source/fetch', payload: { url: 'https://127.0.0.1/golden.csv' } })
  await t.call('fetch: no link', { method: 'POST', url: '/api/catalog-transfer/source/fetch', payload: {} })
  t.note('stored', stored())
  await expect(JSON.stringify(t.steps, null, 1)).toMatchFileSnapshot(`${GOLDEN}/import-wizard-upsert.txt`)
})

it('an editing file (the catalog format) through the catalog import: review and apply', async () => {
  const t = transcript()
  const csv = 'entity,sku,channel,accountId,marketplace,aliasKey,locale,field,action,format,value,version\nProducts,000002,,,,,,description,SET,text,Golden description,\nOverrides,000000,AMAZON,account-a,IT,,,material,SET,text,Golden wool,\nProducts,000001,,,,,,name,CLEAR,text,,'
  const staged = await t.call('preview', { method: 'POST', url: '/api/catalog-transfer/preview', ...upload('golden-editing.csv', csv, { mode: 'update', market: 'IT' }) })
  const path = `/api/catalog-transfer/jobs/${staged.json().jobId}`
  const review = await finished(path, ['QUEUED', 'INVALID'])
  await t.call('review', { url: path })
  await t.call('outcomes', { url: `${path}/outcomes` })
  await t.call('apply', { method: 'POST', url: `${path}/apply`, payload: { reviewToken: review.reviewToken, readyOnly: review.state === 'INVALID' } })
  await finished(path, ['COMPLETED', 'PARTIAL', 'FAILED'])
  await t.call('after apply', { url: path })
  await t.call('outcomes after apply', { url: `${path}/outcomes` })
  t.note('stored', stored())
  await expect(JSON.stringify(t.steps, null, 1)).toMatchFileSnapshot(`${GOLDEN}/import-wizard-editing.txt`)
})
