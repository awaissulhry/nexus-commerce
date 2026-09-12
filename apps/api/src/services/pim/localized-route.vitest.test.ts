import Fastify from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ marketplace: { findMany: vi.fn() }, product: { findUnique: vi.fn(), updateMany: vi.fn() }, auditLog: { createMany: vi.fn() }, productTranslation: { updateMany: vi.fn() }, $transaction: vi.fn() }))
vi.mock('../../db.js', () => ({ default: db }))
vi.mock('../master-content.service.js', () => ({ masterContentService: { update: vi.fn() } }))
vi.mock('./apply-mapping.service.js', () => ({ applyCatalogCascade: vi.fn() }))
vi.mock('./master-schema.service.js', () => ({ getMasterAttributeSchema: vi.fn() }))
vi.mock('./reverse-mapping.service.js', () => ({ proposeImportFromChannel: vi.fn(), proposeImportFromFlatFile: vi.fn() }))
vi.mock('./master-completeness.service.js', () => ({ getMasterCompleteness: vi.fn() }))
vi.mock('./master-ai-fill.service.js', () => ({ suggestMasterAttributes: vi.fn() }))
vi.mock('./family-sheet-schema.js', () => ({ familySheetFields: async () => [] }))
import routes from '../../routes/pim-global.routes.js'

let app: ReturnType<typeof Fastify>
beforeEach(async () => {
  vi.clearAllMocks()
  db.marketplace.findMany.mockResolvedValue([{ channel: 'AMAZON', code: 'UK', languages: ['en'], language: 'en' }])
  db.product.findUnique.mockResolvedValue({ id: 'p', name: 'Fonte', version: 7, parentId: null, familyId: null, parent: null, translations: [{ language: 'de', name: 'Tabellentitel' }], localizedContent: { de: { title: 'Legacy', bulletPoints: ['a', 'b', 'c'] }, it: { title: 'Titolo' } }, categoryAttributes: {} })
  db.product.updateMany.mockResolvedValue({ count: 1 })
  db.$transaction.mockImplementation(async work => work(db))
  app = Fastify(); await app.register(routes)
})
afterEach(async () => { await app.close() })
it('GET loads table translations and excludes legacy JSON from the returned values', async () => {
  const response = await app.inject({ method: 'GET', url: '/products/p/global' })
  expect(response.statusCode).toBe(200)
  expect(db.product.findUnique).toHaveBeenCalledWith({ where: { id: 'p' }, include: { translations: true } })
  expect(response.json().locales).toMatchObject({ de: { title: 'Tabellentitel' }, it: { title: 'Fonte' }, en: { title: 'Fonte' } })
  expect(db.product.updateMany).not.toHaveBeenCalled()
})
it.each([
  { patch: { de: { 'bulletPoints[2]': 'neu' } } },
  { patch: {}, reset: { de: ['bulletPoints'] } },
  { patch: { it: { title: 'New source through legacy JSON' } } },
  { patch: { de: { title: 'New text' }, identifiers: { brand: 'Must stay unchanged' } } },
  { dryRun: true, patch: { de: { title: 'Preview cannot offer a forbidden write' } } },
])('refuses legacy localized writes atomically: %j', async payload => {
  const response = await app.inject({ method: 'PATCH', url: '/products/p/global', payload })
  expect(response.statusCode).toBe(409)
  expect(response.json()).toMatchObject({ field: 'localizedContent', error: expect.stringContaining('legacy and read-only') })
  expect(db.product.findUnique).not.toHaveBeenCalled()
  expect(db.$transaction).not.toHaveBeenCalled()
  expect(db.product.updateMany).not.toHaveBeenCalled()
  expect(db.productTranslation.updateMany).not.toHaveBeenCalled()
  expect(db.auditLog.createMany).not.toHaveBeenCalled()
})
it('retains optimistic conflicts on permitted technical fields', async () => {
  const response = await app.inject({ method: 'PATCH', url: '/products/p/global', payload: { expectedVersion: 6, patch: { technical: { material: 'cotton' } } } })
  expect(response.statusCode).toBe(409)
  expect(db.product.updateMany).not.toHaveBeenCalled()
})
it('reports unsupported patch keys instead of silently ignoring them', async () => {
  const response = await app.inject({ method: 'PATCH', url: '/products/p/global', payload: { patch: { unknownField: 'x' } } })
  expect(response.statusCode).toBe(400)
  expect(db.product.updateMany).not.toHaveBeenCalled()
})
it('keeps permitted physical-field previews available without writing', async () => {
  const response = await app.inject({ method: 'PATCH', url: '/products/p/global', payload: { dryRun: true, patch: { physical: { weightValue: 12 } } } })
  expect(response.statusCode).toBe(200)
  expect(db.product.updateMany).not.toHaveBeenCalled()
})
it('returns 404 when the requested product does not exist', async () => {
  db.product.findUnique.mockResolvedValue(null)
  expect((await app.inject({ method: 'GET', url: '/products/absent/global' })).statusCode).toBe(404)
})
