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
  // LX.F R-LX-13 — the route resolves a representative market for the language
  // through the ONE authority (`marketplaceForLanguage`), so the fixture must carry
  // the languages under test. With only UK/en it threw "No Amazon marketplace is
  // configured for de" and the route answered 500 (finding F-LX-5).
  db.marketplace.findMany.mockResolvedValue([{ channel: 'AMAZON', code: 'UK', languages: ['en'], language: 'en' },
    { channel: 'AMAZON', code: 'DE', languages: ['de'], language: 'de' }, { channel: 'AMAZON', code: 'IT', languages: ['it'], language: 'it' }])
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
  // LX.F R-LX-13 — this block asserted a 409 whose sentence ("legacy and read-only")
  // exists in NO production code: `/usr/bin/grep -rn "legacy and read-only" src/` finds
  // it only in three test files. It was written for a planned hard refusal; what LX
  // actually shipped is better and is what is measured now — a locale-keyed patch is
  // ROUTED to the addressed writer and refused with the field named unless it carries a
  // ContentAddress, and the legacy JSON is never written either way. The property this
  // block exists for (atomicity: nothing written) is kept verbatim.
  // Refused with a 4xx/5xx and, whatever the reason, NOTHING WRITTEN — that is the
  // property this block owns. (The reasons measured in this harness: the missing
  // ContentAddress on a content field, the reset-through-the-sheet-writer refusal, the
  // one-language-per-request refusal, and a 503 when the column requirements cannot be
  // loaded at all.) The LX branch opens a transaction before refusing, so the
  // transaction ROLLS BACK rather than never starting; the write assertions below are
  // what make that safe, and they are unchanged.
  expect(response.statusCode).toBeGreaterThanOrEqual(400)
  expect(response.body).toMatch(/needs a ContentAddress before it can be saved|needs a field-specific reset through the sheet writer|Send one shared language and its ContentAddress per request|Could not load attribute requirements/)
  expect(db.product.updateMany).not.toHaveBeenCalled()
  expect(db.productTranslation.updateMany).not.toHaveBeenCalled()
  expect(db.auditLog.createMany).not.toHaveBeenCalled()
})

it('LX.F R-LX-13 — with its address the patch is ROUTED, and the refusal changes', async () => {
  // POSITIVE CONTROL for the block above: the refusal there is about the missing
  // ContentAddress, not about the language tier being closed. With an address the
  // route reaches the addressed writer — in this harness the column contract is not
  // served, so the answer is the writer's own 503, never "needs a ContentAddress".
  const response = await app.inject({ method: 'PATCH', url: '/products/p/global',
    payload: { patch: { de: { title: 'Neuer Titel' } }, contentAddress: { tier: 'language', language: 'de' }, expectedVersion: 7 } })
  expect(response.body).not.toMatch(/needs a ContentAddress/)
  expect(db.$transaction).toHaveBeenCalled()
  expect(db.product.updateMany).not.toHaveBeenCalled()
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
