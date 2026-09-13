import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ product: { findMany: vi.fn(), findUniqueOrThrow: vi.fn() }, productTranslation: { findFirstOrThrow: vi.fn(), findFirst: vi.fn(), update: vi.fn() }, marketplace: { findMany: vi.fn() }, bulkOperation: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findFirstOrThrow: vi.fn() }, readinessIndex: { findMany: vi.fn() } }))
const writers = vi.hoisted(() => ({ readiness: vi.fn(), write: vi.fn(), remove: vi.fn() }))
vi.mock('../../db.js', () => ({ default: db }))
vi.mock('../../lib/database-context.js', () => ({ inDatabaseTransaction: async (_: unknown, work: () => unknown) => work() }))
vi.mock('../products/products-grid.contract.js', () => ({ gridRequestToListQuery: () => ({ query: { familyId: 'xavia' }, unsupported: [] }), resolveGridLookups: async () => ({}) }))
vi.mock('../products/list-products.service.js', () => ({ resolveProductsScope: async (query: unknown) => ({ where: query }) }))
vi.mock('./content-write.js', () => ({ writeContent: writers.write }))
vi.mock('./translation-write.js', () => ({ writeTranslation: writers.remove }))
vi.mock('./listing-readiness.service.js', () => ({ listingReadinessWhere: async (query: unknown) => query }))
// LX.F F7 — the revert re-materialises readiness for the family it restored; the
// producer itself is another suite's business (`content-write.vitest.test.ts` runs it
// against a real disposable PostgreSQL), so here it is recorded and counted.
vi.mock('./readiness-index.service.js', () => ({ produceReadiness: writers.readiness }))
import { previewCatalogTranslation, applyCatalogTranslationDrafts, revertCatalogTranslation, requireTranslationGeneration, translationCandidate } from './catalog-translate.js'
import { rateInfoFor } from '../ai/rate-cards.js'
const input = { language: 'de', fields: ['title'], scope: { kind: 'grid', grid: {} } } as any
const product = (id = 'p') => ({ id, name: 'Italian source', version: 1, translations: [] })
beforeEach(() => {
  vi.resetAllMocks()
  db.marketplace.findMany.mockResolvedValue([{ channel: 'AMAZON', code: 'DE', language: 'de', languages: ['de'] }])
  db.product.findMany.mockImplementation(async args => args.select ? [{ id: 'p' }] : [product()])
  db.product.findUniqueOrThrow.mockResolvedValue(product())
  db.bulkOperation.create.mockImplementation(async ({ data }) => ({ id: 'run', ...data }))
  db.bulkOperation.update.mockImplementation(async ({ data }) => ({ id: 'run', ...data }))
})
describe('filter-scoped translation, generation dark', () => {
  it('previews all 3,000 filtered products in bounded reads with rate-card costs and no writes', async () => {
    const ids = Array.from({ length: 3000 }, (_, i) => `p${i}`)
    db.product.findMany.mockImplementation(async args => args.select ? ids.map(id => ({ id })) : args.where.id.in.map((id: string) => product(id)))
    const preview = await previewCatalogTranslation(input)
    expect(preview).toMatchObject({ total: 3000, getDraft: 3000, alreadyHave: 0, skipped: 0, generationEnabled: false })
    expect(db.product.findMany.mock.calls.filter(([args]) => !args.select)).toHaveLength(30)
    for (const estimate of preview.estimates) {
      const rate = rateInfoFor(estimate.provider as any, estimate.model)
      expect(estimate.usd).toBe((estimate.inputTokens * rate.inputPer1M + estimate.outputTokens * rate.outputPer1M) / 1e6)
    }
    expect(preview.reach).toContain('shared German'); expect(db.bulkOperation.create).not.toHaveBeenCalled()
  })
  it('distinguishes inherited language content, absent source, and source language itself', () => {
    const parent = { id: 'root', name: 'Source', translations: [{ language: 'de', name: 'Deutsch', source: 'ai' }] }
    expect(translationCandidate({ ...product(), parentId: 'root', parent }, 'de', ['title']).status).toBe('alreadyHave')
    expect(translationCandidate({ id: 'p', translations: [] }, 'de', ['title']).status).toBe('skipped')
    expect(translationCandidate(product(), 'it', ['title']).status).toBe('skipped')
  })
  it('readiness Translate uses the complete same index predicate across all pages', async () => {
    db.readinessIndex.findMany.mockResolvedValue([{ productId: 'p' }])
    await previewCatalogTranslation({ ...input, scope: { kind: 'readiness', query: { channel: 'AMAZON', market: 'BE', language: 'fr', state: 'blocked', page: '4' } } })
    expect(db.readinessIndex.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ state: 'blocked' }), distinct: ['productId'] }))
    expect(db.readinessIndex.findMany.mock.calls[0][0]).not.toHaveProperty('take')
  })
  it('refuses generation before a job or a provider exists', () => {
    expect(requireTranslationGeneration).toThrow('AI generation is disabled')
    expect(db.bulkOperation.create).not.toHaveBeenCalled(); expect(writers.write).not.toHaveBeenCalled()
  })
  it('invalidates an edited preview and lands supplied synthetic drafts in one operation', async () => {
    const preview = await previewCatalogTranslation(input)
    await expect(applyCatalogTranslationDrafts(input, 'stale', { p: { title: 'Deutsch' } }, null)).rejects.toThrow('Preview again')
    expect(db.bulkOperation.create).not.toHaveBeenCalled()
    db.productTranslation.findFirstOrThrow.mockResolvedValue({ id: 't', productId: 'p', language: 'de', name: 'Deutsch', source: 'ai', version: 1 })
    const result = await applyCatalogTranslationDrafts(input, preview.token, { p: { title: 'Deutsch' } }, null)
    expect(result.status).toBe('COMPLETED'); expect(db.bulkOperation.create).toHaveBeenCalledTimes(1)
    expect(writers.write).toHaveBeenCalledWith(expect.objectContaining({ address: { tier: 'language', language: 'de' }, state: 'draft', values: { title: 'Deutsch' } }))
    expect(db.bulkOperation.update.mock.calls[0][0].data.changes.applied).toHaveLength(1)
  })
  it('reverts the whole run, preserving later edits as explicit partial refusals', async () => {
    const after = { id: 't', name: 'Deutsch', version: 1 }
    db.bulkOperation.findFirstOrThrow.mockResolvedValue({ id: 'run', status: 'COMPLETED', expiresAt: null, changes: { kind: 'catalog-translate', language: 'de', applied: [{ productId: 'p', productVersion: 1, before: null, after }, { productId: 'newer', productVersion: 1, before: null, after }] } })
    db.bulkOperation.updateMany.mockResolvedValue({ count: 1 })
    // PostgreSQL JSONB reorders the persisted checkpoint keys.
    db.productTranslation.findFirst.mockResolvedValueOnce({ version: 1, name: 'Deutsch', id: 't' }).mockResolvedValueOnce({ ...after, name: 'Later edit' })
    const result = await revertCatalogTranslation('run', null)
    expect(result.status).toBe('REVERT_PARTIAL')
    expect(writers.remove).toHaveBeenCalledTimes(1)
    expect(result.errors[0]).toMatchObject({ productId: 'newer', error: expect.stringContaining('newer work preserved') })
    // LX.F F7 — and the readiness index is re-materialised for the product it RESTORED,
    // exactly once, and never for the one it refused. LX.7V measured the index going
    // 0 → 34 rows on apply and STAYING at 34 after the revert (`Not computed` → `Blocked`
    // → `Blocked` for a run that had been undone), because this transaction restores the
    // prior row with a raw update AFTER the routed writer had produced readiness.
    expect(writers.readiness.mock.calls.map(([id]: [string]) => id)).toEqual(['p'])
  })
})
