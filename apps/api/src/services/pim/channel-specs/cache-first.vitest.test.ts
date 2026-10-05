import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ row: vi.fn(), provider: vi.fn(), stampSql: [] as string[] }))
vi.mock('../../../db.js', () => ({ default: { $queryRawUnsafe: async (sql: string) => { mocks.stampSql.push(sql); return [{ stamp: 'cached', n: 1 }] }, categorySchema: { findFirst: mocks.row } } }))
vi.mock('../../../lib/workspace-cache.js', () => ({ WorkspaceCache: Map }))
vi.mock('../../categories/seller-schema.service.js', () => ({ amazonSellerSpec: mocks.provider }))
vi.mock('./amazon.js', () => ({ amazonSpecFromDefinition: (input: { schemaDefinition: unknown }) => ({ ...input, validationSchema: input.schemaDefinition, fields: [] }) }))
import { clearChannelSpecCache, loadAmazonSpec } from './index.js'
beforeEach(() => { clearChannelSpecCache(); vi.clearAllMocks(); mocks.stampSql.length = 0 })
/** The market row for `AMAZON`; no English copy (`AMAZON_EN`) unless a test gives one. */
const marketOnly = (row: unknown) => mocks.row.mockImplementation(async ({ where }: { where: { channel: string } }) => where.channel === 'AMAZON' ? row : null)
it('uses the stored schema with its database date even when an account is selected', async () => {
  const fetchedAt = new Date('2026-08-01T00:00:00Z')
  marketOnly({ schemaDefinition: { properties: {} }, fetchedAt, schemaVersion: 'stored' })
  for (let i = 0; i < 3; i++) expect(await loadAmazonSpec('DE', 'OUTERWEAR', 'account')).toMatchObject({ fetchedAt, schemaVersion: 'stored' })
  expect(mocks.provider).not.toHaveBeenCalled()
  // One read of the market row and one of its English copy (W3 PR-A), then the cache answers.
  expect(mocks.row.mock.calls.map(([args]) => args.where.channel)).toEqual(['AMAZON', 'AMAZON_EN'])
})
it('retains the seller-specific fallback only when the database has no schema', async () => {
  mocks.row.mockResolvedValue(null); mocks.provider.mockResolvedValue({ absent: false })
  expect(await loadAmazonSpec('DE', 'OUTERWEAR', 'account')).toEqual({ absent: false })
  expect(mocks.provider).toHaveBeenCalledWith('account', 'DE', 'OUTERWEAR')
})

/**
 * R-LX-10 — the property is the SCOPE's, not each branch's.
 *
 * LX.6 measured the live arm: Amazon·PL / OUTERWEAR has no active `CategorySchema`
 * row, and a cold Studio page load made 2 provider attempts
 * (`sheet-columns.service.ts:1196` → `seller-schema.service.ts:18` →
 * `getAmazonSpClient`). Inside `withCachedSchemas` the same cache miss answers
 * `absent: true` instead, and the sheet reports it in `meta.schemaMissing`.
 */
it('a cache miss inside withCachedSchemas answers absent instead of calling the provider', async () => {
  const { withCachedSchemas } = await import('../cached-schema-context.js')
  mocks.row.mockResolvedValue(null); mocks.provider.mockResolvedValue({ absent: false })
  const spec = await withCachedSchemas(() => loadAmazonSpec('PL', 'OUTERWEAR', 'account'))
  expect(spec).toMatchObject({ absent: true, fetchedAt: null, fields: [] })
  expect(mocks.provider).not.toHaveBeenCalled()
  // POSITIVE CONTROL, same run, same cache miss: an on-demand caller with an
  // explicit live intent still reaches the provider exactly once.
  clearChannelSpecCache()
  expect(await loadAmazonSpec('PL', 'OUTERWEAR', 'account')).toEqual({ absent: false })
  expect(mocks.provider).toHaveBeenCalledTimes(1)
})

/**
 * W3 PR-A — the English copy (`AMAZON_EN`) is read beside the market row and joined in; its rows count in the cache
 * stamp, so a new copy re-joins. (The join rules themselves: amazon-english.vitest.test.ts.)
 */
it('joins the cached English copy into the market spec, and the stamp counts English copies', async () => {
  const fetchedAt = new Date('2026-08-01T00:00:00Z'), englishAt = new Date('2026-08-02T00:00:00Z')
  const definition = (locale: string) => ({ __schemaProvenance: { locale }, properties: {} })
  mocks.row.mockImplementation(async ({ where }: { where: { channel: string } }) => where.channel === 'AMAZON'
    ? { schemaDefinition: definition('it_IT'), fetchedAt, schemaVersion: 'market' }
    : { schemaDefinition: definition('en_GB'), fetchedAt: englishAt, schemaVersion: 'english' })
  const spec = await loadAmazonSpec('IT', 'OUTERWEAR')
  expect(spec.english).toEqual({ locale: 'en_GB', fetchedAt: englishAt })
  expect(spec).toMatchObject({ schemaVersion: 'market', fetchedAt })
  expect(mocks.row.mock.calls.map(([args]) => args.where)).toEqual([
    { channel: 'AMAZON', marketplace: 'IT', productType: 'OUTERWEAR', isActive: true },
    { channel: 'AMAZON_EN', marketplace: 'IT', productType: 'OUTERWEAR', isActive: true },
  ])
  expect(mocks.stampSql[0]).toContain("channel IN ('AMAZON', 'AMAZON_EN')")
})

it('an English market row needs no English copy: none is read, and the market row names the English', async () => {
  const fetchedAt = new Date('2026-08-01T00:00:00Z')
  marketOnly({ schemaDefinition: { __schemaProvenance: { locale: 'en_GB' }, properties: {} }, fetchedAt, schemaVersion: 'uk' })
  const spec = await loadAmazonSpec('UK', 'OUTERWEAR')
  expect(spec.english).toEqual({ locale: 'en_GB', fetchedAt })
  expect(mocks.row.mock.calls.map(([args]) => args.where.channel)).toEqual(['AMAZON'])
})
