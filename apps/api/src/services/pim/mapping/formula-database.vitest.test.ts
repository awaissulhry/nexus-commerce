import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { createSession } from '../../../lib/auth/session.js'
import { sessionCookieName } from '../../../lib/auth/cookies.js'
import { rbacHook } from '../../../lib/auth/rbac-hook.js'
const fixture = vi.hoisted(() => ({ database: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  fixture.database = await formulaDatabase()
  return { default: fixture.database.client }
})
// External queues are outside this disposable database. The product writer and events stay real.
vi.mock('../../../lib/queue.js', () => ({ addJobSafely: vi.fn(), outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: null }))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {} }))
import prisma from '../../../db.js'
import productRoutes from '../../../routes/products.routes.js'
import formulaRoutes from '../../../routes/cell-formula.routes.js'
import globalRoutes from '../../../routes/pim-global.routes.js'
import { inDatabaseTransaction, afterDatabaseCommit } from '../../../lib/database-context.js'
const app = Fastify()
const coordinate = { scope: 'master', market: 'IT', locale: 'it', fieldKey: 'manufacturer' }
const post = async (path: string, payload?: any) => { const response = await app.inject({ method: 'POST', url: `/api/pim/formulas/bulk/${path}`, ...(payload ? { payload } : {}) }); expect(response.statusCode, response.body).toBe(200); return response.json() }
const get = async (path: string) => { const response = await app.inject({ method: 'GET', url: `/api/pim/formulas/bulk${path}` }); expect(response.statusCode, response.body).toBe(200); return response.json() }
const preview = async (ids = ['one'], expr = '$brand', fieldKey = 'manufacturer') => post('preview', { ...coordinate, fieldKey, expr, mode: 'once', rows: ids.map(productId => ({ productId })) })
const apply = async (ids = ['one'], expr = '$brand', extra = {}) => {
  const checked = await preview(ids, expr)
  expect(checked.rows.every((row: any) => row.ok), JSON.stringify(checked)).toBe(true)
  const input = { ...coordinate, expr, mode: 'once', operationId: crypto.randomUUID(), rows: checked.rows.map((row: any) => ({ productId: row.productId, expectedState: row.expectedState, expectedValue: row.value })), ...extra }
  return { input, result: await post('apply', input) }
}
beforeAll(async () => { await app.register(cookie); app.addHook('preHandler', rbacHook); if (process.env.FORMULA_BROWSER_FIXTURE === '1') await app.register(import('@fastify/cors'), { origin: 'http://localhost:3101', credentials: true }); await prisma.marketplace.create({ data: { id: 'fixture-market', channel: 'AMAZON', code: 'IT', name: 'Fixture Italy', region: 'EU', currency: 'EUR', language: 'it' } }); await app.register(productRoutes, { prefix: '/api' }); await app.register(globalRoutes, { prefix: '/api' }); await app.register(formulaRoutes, { prefix: '/api' }); await app.ready() }, 60_000)
beforeEach(async () => {
  await prisma.auditLog.deleteMany(); await prisma.cellFormula.deleteMany(); await prisma.bulkOperation.deleteMany()
  await prisma.productTranslation.deleteMany(); await prisma.productEvent.deleteMany(); await prisma.channelListing.deleteMany(); await prisma.product.deleteMany()
  await prisma.product.createMany({ data: ['one', 'two'].map(id => ({ id, sku: `fixture-${id}`, name: `${id} jacket`, basePrice: 10, brand: 'Nexus', manufacturer: 'Original' })) })
})
afterAll(async () => {
  if (process.env.FORMULA_BROWSER_FIXTURE === '1') {
    // Opt-in watch-mode fixture uses only this disposable database and disabled external queues.
    await app.listen({ port: 4115, host: '127.0.0.1' })
    process.stdout.write('Disposable formula browser API ready on http://127.0.0.1:4115\n')
    await new Promise<void>(resolve => process.once('SIGINT', resolve))
  }
  await app.close(); await fixture.database.close()
}, process.env.FORMULA_BROWSER_FIXTURE === '1' ? 3_600_000 : 30_000)

describe('formula recovery through the real product API and PostgreSQL', () => {
  it('applies once, replays a lost response, reloads history and restores values', async () => {
    const { input, result } = await apply()
    expect(result.status).toBe('SUCCESS')
    expect((await prisma.product.findUniqueOrThrow({ where: { id: 'one' } })).manufacturer).toBe('Nexus')
    const version = (await prisma.product.findUniqueOrThrow({ where: { id: 'one' } })).version
    await post('apply', input)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: 'one' } })).version).toBe(version)
    const history = await get('?familyProductId=one&scope=master&market=IT&locale=it')
    expect(history.operations[0].operationId).toBe(result.operationId)
    expect((await get(`/${result.operationId}`)).rows[0].status).toBe('applied')
    const undone = await post(`${result.operationId}/undo`)
    expect(undone.status).toBe('UNDONE')
    expect((await prisma.product.findUniqueOrThrow({ where: { id: 'one' } })).manufacturer).toBe('Original')
    await post(`${result.operationId}/undo`)
    expect(await prisma.auditLog.count({ where: { entityType: 'FormulaOperation', action: 'formula.bulk.restored' } })).toBe(1)
  })
  it('rolls the value, formula and audit back if recording the result fails', async () => {
    await fixture.database.db.exec(`CREATE FUNCTION reject_formula_receipt() RETURNS trigger AS $$ BEGIN IF NEW."action" = 'formula.bulk.applied' THEN RAISE EXCEPTION 'receipt unavailable'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql; CREATE TRIGGER reject_formula_receipt BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION reject_formula_receipt();`)
    try {
      const { result } = await apply(['one'], '$brand', { mode: 'linked' })
      expect(result.status).toBe('FAILED')
      expect((await prisma.product.findUniqueOrThrow({ where: { id: 'one' } })).manufacturer).toBe('Original')
      expect(await prisma.cellFormula.count()).toBe(0)
      expect(await prisma.auditLog.count({ where: { action: 'formula.set' } })).toBe(0)
    } finally { await fixture.database.db.exec('DROP TRIGGER reject_formula_receipt ON "AuditLog"; DROP FUNCTION reject_formula_receipt();') }
  })
  it('keeps unrelated edits during undo and refuses a newer target value', async () => {
    const { result } = await apply(['one', 'two'])
    expect(result.status, JSON.stringify(result)).toBe('SUCCESS')
    await prisma.product.update({ where: { id: 'one' }, data: { description: 'Keep this newer note' } })
    await prisma.product.update({ where: { id: 'two' }, data: { manufacturer: 'Newer brand' } })
    expect((await post(`${result.operationId}/undo`)).status).toBe('UNDO_PARTIAL')
    expect(await prisma.product.findUniqueOrThrow({ where: { id: 'one' } })).toMatchObject({ manufacturer: 'Original', description: 'Keep this newer note' })
    expect((await prisma.product.findUniqueOrThrow({ where: { id: 'two' } })).manufacturer).toBe('Newer brand')
  })
  it('restores inherited storage and the original linked expression', async () => {
    await prisma.product.update({ where: { id: 'two' }, data: { parentId: 'one', manufacturer: null, cascadedFields: ['manufacturer'] } })
    const { result } = await apply(['two'])
    await post(`${result.operationId}/undo`)
    expect(await prisma.product.findUniqueOrThrow({ where: { id: 'two' } })).toMatchObject({ manufacturer: null, cascadedFields: ['manufacturer'] })
    const set = await app.inject({ method: 'PUT', url: '/api/pim/formulas/product/one', payload: { ...coordinate, expr: 'upper($brand)' } })
    expect(set.json().ok, set.body).toBe(true)
    const next = await apply()
    await post(`${next.result.operationId}/undo`)
    expect((await prisma.cellFormula.findFirstOrThrow()).expr).toBe('upper($brand)')
    expect((await prisma.product.findUniqueOrThrow({ where: { id: 'one' } })).manufacturer).toBe('NEXUS')
  })
  it('re-evaluates a restored linked formula against newer source values', async () => {
    const saved = await app.inject({ method: 'PUT', url: '/api/pim/formulas/product/one', payload: { ...coordinate, expr: 'upper($brand)' } })
    expect(saved.json().ok, saved.body).toBe(true)
    const { result } = await apply()
    await prisma.product.update({ where: { id: 'one' }, data: { brand: 'Changed source' } })
    expect((await post(`${result.operationId}/undo`)).status).toBe('UNDONE')
    expect((await prisma.product.findUniqueOrThrow({ where: { id: 'one' } })).manufacturer).toBe('CHANGED SOURCE')
  })
  it('previews content without changing inherited products or channel snapshots', async () => {
    await prisma.product.update({ where: { id: 'one' }, data: { description: 'Original parent description' } })
    await prisma.product.update({ where: { id: 'two' }, data: { parentId: 'one', description: null, cascadedFields: ['description'] } })
    await prisma.channelListing.create({ data: { id: 'inherited-description', productId: 'two', channelMarket: 'AMAZON_IT', channel: 'AMAZON', region: 'EU', marketplace: 'IT', aliasKey: '', masterDescription: 'Original parent description', followMasterDescription: true } })
    const checked = (await preview(['two'], '"Temporary description"', 'description')).rows[0]
    expect(checked).toMatchObject({ ok: true, value: 'Temporary description', error: null })
    expect(await prisma.product.findUniqueOrThrow({ where: { id: 'two' } })).toMatchObject({ description: null, cascadedFields: ['description'] })
    expect((await prisma.product.findUniqueOrThrow({ where: { id: 'one' } })).description).toBe('Original parent description')
    expect((await prisma.channelListing.findUniqueOrThrow({ where: { id: 'inherited-description' } })).masterDescription).toBe('Original parent description')
    expect(await prisma.cellFormula.count()).toBe(0)
    expect(await prisma.bulkOperation.count()).toBe(0)
  })
  it('resumes an interrupted batch, handles duplicate clients, and finishes interrupted undo', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `bulk-${i}`)
    await prisma.product.createMany({ data: ids.map(id => ({ id, sku: id, name: id, basePrice: 10, brand: 'Nexus', manufacturer: 'Original', parentId: 'one' })) })
    const { input, result } = await apply(ids)
    expect(result.status).toBe('APPLYING'); expect(result.processed).toBe(5)
    expect((await get(`/${result.operationId}`)).rows.filter((row: any) => row.status === 'pending')).toHaveLength(7)
    await Promise.all([post('apply', input), post(`${result.operationId}/continue`)])
    const completed = await get(`/${result.operationId}`)
    expect(completed.status).toBe('SUCCESS')
    expect(await prisma.auditLog.count({ where: { entityType: 'FormulaOperation', action: 'formula.bulk.applied' } })).toBe(12)
    expect((await post(`${result.operationId}/undo`)).status).toBe('UNDOING')
    await post(`${result.operationId}/continue`)
    expect((await post(`${result.operationId}/continue`)).status).toBe('UNDONE')
    expect(await prisma.product.count({ where: { id: { in: ids }, manufacturer: 'Original' } })).toBe(12)
  })
  it('undo stops pending application and never reports unattempted products as restored', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `pending-${i}`)
    await prisma.product.createMany({ data: ids.map(id => ({ id, sku: id, name: id, basePrice: 10, brand: 'Nexus', manufacturer: 'Original' })) })
    const { input, result } = await apply(ids)
    await post(`${result.operationId}/undo`)
    await post('apply', input)
    const final = await get(`/${result.operationId}`)
    expect(final.status).toBe('UNDONE')
    expect(final.rows.filter((row: any) => row.status === 'restored')).toHaveLength(5)
    expect(final.rows.filter((row: any) => row.status === 'not-applied')).toHaveLength(2)
  })
  it('refuses stale previews and reused IDs with a different recipe', async () => {
    const checked = await preview(['one', 'two'])
    await prisma.product.update({ where: { id: 'one' }, data: { brand: 'Newer source' } })
    const input = { ...coordinate, expr: '$brand', mode: 'once', operationId: crypto.randomUUID(), rows: checked.rows.map((row: any) => ({ productId: row.productId, expectedState: row.expectedState, expectedValue: row.value })) }
    const result = await post('apply', input)
    expect(result.status).toBe('PARTIAL')
    expect(result.rows[0]).toMatchObject({ ok: false, status: 'failed' })
    const replay = await app.inject({ method: 'POST', url: '/api/pim/formulas/bulk/apply', payload: { ...input, expr: '"Different"' } })
    expect(replay.statusCode).toBe(400)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: 'one' } })).manufacturer).toBe('Original')
  })
  it('processes a large selection in bounded requests with one receipt per product', async () => {
    const count = process.env.FORMULA_BENCHMARK === '1' ? 1000 : 100
    const ids = Array.from({ length: count }, (_, i) => `scale-${i}`)
    await prisma.product.createMany({ data: ids.map(id => ({ id, sku: id, name: id, basePrice: 10, brand: 'Nexus', manufacturer: 'Original' })) })
    const started = performance.now()
    const checked = await preview(ids)
    const previewMs = performance.now() - started
    const input = { ...coordinate, expr: '$brand', mode: 'once', operationId: crypto.randomUUID(), rows: checked.rows.map((row: any) => ({ productId: row.productId, expectedState: row.expectedState, expectedValue: row.value })) }
    let result = await post('apply', input)
    while (result.status === 'APPLYING') { expect(result.rows.length).toBeLessThanOrEqual(5); result = await post(`${result.operationId}/continue`) }
    expect(result.status).toBe('SUCCESS')
    expect(await prisma.auditLog.count({ where: { entityType: 'FormulaOperation', action: 'formula.bulk.applied' } })).toBe(count)
    expect(await prisma.product.count({ where: { id: { in: ids }, manufacturer: 'Nexus' } })).toBe(count)
    if (process.env.FORMULA_BENCHMARK === '1') await (await import('node:fs/promises')).writeFile('/tmp/nexus-formula-benchmark.json', JSON.stringify({ products: count, previewMs: Math.round(previewMs), applyMs: Math.round(performance.now() - started - previewMs) }))
    console.info(JSON.stringify({ formulaBenchmark: { products: count, previewMs: Math.round(previewMs), applyMs: Math.round(performance.now() - started - previewMs) } }))
  }, 120_000)
  it('applies and undoes a channel title without touching another alias or the master', async () => {
    const definition = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../channel-specs/__tests__/fixtures/amazon-it-outerwear.trimmed.json', import.meta.url), 'utf8'))
    await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType: 'OUTERWEAR', schemaVersion: 'formula-fixture', schemaDefinition: definition, expiresAt: new Date('2099-01-01') } })
    await prisma.product.update({ where: { id: 'one' }, data: { productType: 'OUTERWEAR' } })
    await prisma.channelConnection.create({ data: { id: 'formula-amazon', channelType: 'AMAZON', isActive: true } as any })
    await prisma.channelListing.createMany({ data: [
      { id: 'primary-title', productId: 'one', channelMarket: 'AMAZON_IT', channel: 'AMAZON', channelConnectionId: 'formula-amazon', region: 'EU', marketplace: 'IT', aliasKey: '', title: 'Synced title', titleOverride: null, followMasterTitle: true },
      { id: 'alias-title', productId: 'one', channelMarket: 'AMAZON_IT', channel: 'AMAZON', channelConnectionId: 'formula-amazon', region: 'EU', marketplace: 'IT', aliasKey: 'another-alias', title: 'Alias title', titleOverride: 'Alias title', followMasterTitle: false },
    ] })
    const scope = { contentAddress: { tier: 'pin', language: 'it', coordinate: { channel: 'AMAZON', market: 'IT', accountId: 'formula-amazon' } }, contentAcknowledged: true, channelConnectionId: 'formula-amazon', scope: 'channel', channel: 'AMAZON', marketplace: 'IT', market: 'IT', locale: 'it', fieldKey: 'name' }
    const checked = (await post('preview', { ...scope, expr: '"Channel title"', mode: 'once', rows: [{ productId: 'one' }] })).rows[0]
    expect(checked.ok, JSON.stringify(checked)).toBe(true)
    const input = { ...scope, expr: '"Channel title"', mode: 'once', operationId: crypto.randomUUID(), rows: [{ productId: 'one', expectedState: checked.expectedState, expectedValue: checked.value }] }
    const rejected = await app.inject({ method: 'POST', url: '/api/pim/formulas/bulk/apply', payload: { ...input, operationId: crypto.randomUUID(), aliasKey: 'another-alias' } })
    expect(rejected.statusCode, rejected.body).toBe(200)
    expect(rejected.json(), rejected.body).toMatchObject({ status: 'FAILED', rows: [expect.objectContaining({ ok: false })] })
    const result = await post('apply', input)
    expect(result.status, JSON.stringify(result)).toBe('SUCCESS')
    expect(await prisma.channelListingTranslation.findFirstOrThrow({ where: { channelListingId: 'primary-title', language: 'it' } })).toMatchObject({ name: 'Channel title', follows: [] })
    expect((await prisma.channelListing.findUniqueOrThrow({ where: { id: 'alias-title' } })).titleOverride).toBe('Alias title')
    expect((await prisma.product.findUniqueOrThrow({ where: { id: 'one' } })).name).toBe('one jacket')
    expect((await post(`${result.operationId}/undo`)).status).toBe('UNDONE')
    expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: 'primary-title' } })).toMatchObject({ title: 'Synced title', titleOverride: null, followMasterTitle: true })
  })
  it('requires an address to save translated formulas and preserves legacy storage', async () => {
    const legacyContent = { de: { description: 'Vorher' }, it: { description: 'Italiano' } }
    await prisma.product.update({ where: { id: 'one' }, data: { localizedContent: legacyContent } })
    const input = { scope: 'master', market: 'IT', locale: 'de', fieldKey: 'description', expr: 'upper($brand)' }
    const checked = await app.inject({ method: 'POST', url: '/api/pim/formulas/preview', payload: { ...input, productId: 'one' } })
    expect(checked.json()).toMatchObject({ ok: true, value: 'NEXUS' })
    const saved = await app.inject({ method: 'PUT', url: '/api/pim/formulas/product/one', payload: input })
    expect(saved.json()).toMatchObject({ error: expect.stringContaining('ContentAddress') })
    const product = await prisma.product.findUniqueOrThrow({ where: { id: 'one' } })
    expect(product.localizedContent).toEqual(legacyContent)
    expect(product.description).toBeNull()
    const changed = await app.inject({ method: 'PATCH', url: '/api/products/bulk', payload: { changes: [{ id: 'one', field: 'brand', value: 'New brand' }] } })
    expect(changed.statusCode, changed.body).toBe(200)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: 'one' } })).localizedContent).toEqual(legacyContent)
    expect(await prisma.productTranslation.count()).toBe(0)
  })
  it('keeps two accounts, three listings and two languages independent through formula save and reload', async () => {
    await prisma.marketplace.upsert({ where: { channel_code: { channel: 'ETSY', code: 'GLOBAL' } } as any,
      create: { id: 'etsy-market', channel: 'ETSY', code: 'GLOBAL', name: 'Etsy', region: 'GLOBAL', currency: 'EUR', language: 'en', languages: ['en', 'de'] }, update: { languages: ['en', 'de'] } })
    await prisma.channelConnection.createMany({ data: ['etsy-a', 'etsy-b'].map(id => ({ id, channelType: 'ETSY', isActive: true, isPrimary: id === 'etsy-a' })) })
    const targets = []
    for (const account of ['etsy-a', 'etsy-b']) {
      for (const position of [0, 1, 2]) {
        const aliasKey = position ? `${account}-alias-${position}` : ''
        if (aliasKey) await prisma.productListingAlias.create({ data: { id: aliasKey, productId: 'one', channel: 'ETSY', marketplace: 'GLOBAL', channelConnectionId: account, label: `Listing ${position}`, position } })
        await prisma.channelListing.create({ data: { id: `${account}-${position}`, productId: 'one', channel: 'ETSY', channelMarket: 'ETSY_GLOBAL', marketplace: 'GLOBAL', region: 'GLOBAL', channelConnectionId: account, aliasId: aliasKey || null, aliasKey, platformAttributes: { language: 'en', title: 'Remote title', taxonomy_id: 1 } } })
        for (const locale of ['en', 'de']) {
          const title = `${account} listing ${position} ${locale}`
          const coordinate = { scope: 'channel', channel: 'ETSY', marketplace: 'GLOBAL', market: 'GLOBAL', channelConnectionId: account, aliasKey, locale, fieldKey: 'name' }
          const response = await app.inject({ method: 'PUT', url: '/api/pim/formulas/product/one', payload: { ...coordinate, contentAddress: { tier: 'pin', language: locale, coordinate: { channel: 'ETSY', market: 'GLOBAL', accountId: account, ...(aliasKey ? { aliasId: aliasKey } : {}) } }, contentAcknowledged: true, expr: JSON.stringify(title) } })
          expect(response.json().ok, `${JSON.stringify(coordinate)}: ${response.body}`).toBe(true)
          targets.push({ coordinate, title, listingId: `${account}-${position}` })
        }
      }
    }
    expect(await prisma.cellFormula.count()).toBe(12)
    for (const { coordinate, title, listingId } of targets) {
      const response = await app.inject({ method: 'POST', url: '/api/pim/formulas/batch', payload: { ...coordinate, productIds: ['one'] } })
      expect(JSON.stringify(response.json())).toContain(title)
      const listing = await prisma.channelListing.findUniqueOrThrow({ where: { id: listingId } })
      expect(await prisma.channelListingTranslation.findFirstOrThrow({ where: { channelListingId: listingId, language: coordinate.locale } })).toMatchObject({ name: title })
      expect((listing.platformAttributes as any).title).toBe('Remote title')
    }
    expect(await prisma.product.count()).toBe(2)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: 'one' } })).name).toBe('one jacket')
  })
  it('retains authentication through the ordinary writer and records the real actor', async () => {
    await prisma.userProfile.create({ data: { id: 'formula-owner', email: 'formula-owner@example.test', displayName: 'Formula owner', status: 'active' } })
    await prisma.role.create({ data: { id: 'formula-owner-role', key: 'OWNER', name: 'Owner' } })
    await prisma.userRole.create({ data: { userId: 'formula-owner', roleId: 'formula-owner-role' } })
    const session = await createSession({ userId: 'formula-owner' })
    const headers = { cookie: `${sessionCookieName()}=${session.rawToken}` }
    const prior = process.env.NEXUS_RBAC_MODE
    process.env.NEXUS_RBAC_MODE = 'enforce'
    try {
      const response = await app.inject({ method: 'POST', url: '/api/pim/formulas/bulk/preview', headers, payload: { ...coordinate, expr: '$brand', mode: 'once', rows: [{ productId: 'one' }] } })
      expect(response.statusCode, response.body).toBe(200)
      const checked = response.json().rows[0]
      expect(checked.ok, JSON.stringify(checked)).toBe(true)
      const saved = await app.inject({ method: 'POST', url: '/api/pim/formulas/bulk/apply', headers, payload: { ...coordinate, expr: '$brand', mode: 'once', operationId: crypto.randomUUID(), rows: [{ productId: 'one', expectedState: checked.expectedState, expectedValue: checked.value }] } })
      expect(saved.json().status, saved.body).toBe('SUCCESS')
      expect(await prisma.auditLog.count({ where: { entityId: 'one', userId: 'formula-owner' } })).toBeGreaterThan(0)
      expect((await prisma.bulkOperation.findUniqueOrThrow({ where: { id: saved.json().operationId } })).userId).toBe('formula-owner')
      const anonymous = await app.inject({ method: 'PATCH', url: '/api/products/bulk', headers: { 'x-nexus-formula-write': 'forged-handle' }, payload: { changes: [{ id: 'one', field: 'manufacturer', value: 'No access' }] } })
      expect(anonymous.statusCode).toBe(401)
    } finally { if (prior === undefined) delete process.env.NEXUS_RBAC_MODE; else process.env.NEXUS_RBAC_MODE = prior }
  })
  it('defers refreshes until commit and drops them on rollback', async () => {
    const effect = vi.fn()
    await expect(inDatabaseTransaction(prisma, async () => { await afterDatabaseCommit('fixture', effect); await prisma.product.update({ where: { id: 'one' }, data: { brand: 'Rolled back' } }); throw new Error('Stop') })).rejects.toThrow('Stop')
    expect(effect).not.toHaveBeenCalled()
    expect((await prisma.product.findUniqueOrThrow({ where: { id: 'one' } })).brand).toBe('Nexus')
    await inDatabaseTransaction(prisma, async () => { await afterDatabaseCommit('fixture', effect); await afterDatabaseCommit('fixture', effect); expect(effect).not.toHaveBeenCalled() })
    expect(effect).toHaveBeenCalledTimes(1)
  })
})
