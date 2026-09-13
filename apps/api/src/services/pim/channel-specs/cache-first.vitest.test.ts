import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ row: vi.fn(), provider: vi.fn() }))
vi.mock('../../../db.js', () => ({ default: { $queryRawUnsafe: async () => [{ stamp: 'cached', n: 1 }], categorySchema: { findFirst: mocks.row } } }))
vi.mock('../../../lib/workspace-cache.js', () => ({ WorkspaceCache: Map }))
vi.mock('../../categories/seller-schema.service.js', () => ({ amazonSellerSpec: mocks.provider }))
vi.mock('./amazon.js', () => ({ amazonSpecFromDefinition: (input: unknown) => input }))
import { clearChannelSpecCache, loadAmazonSpec } from './index.js'
beforeEach(() => { clearChannelSpecCache(); vi.clearAllMocks() })
it('uses the stored schema with its database date even when an account is selected', async () => {
  const fetchedAt = new Date('2026-08-01T00:00:00Z')
  mocks.row.mockResolvedValue({ schemaDefinition: { properties: {} }, fetchedAt, schemaVersion: 'stored' })
  for (let i = 0; i < 3; i++) expect(await loadAmazonSpec('DE', 'OUTERWEAR', 'account')).toMatchObject({ fetchedAt, schemaVersion: 'stored' })
  expect(mocks.provider).not.toHaveBeenCalled()
  expect(mocks.row).toHaveBeenCalledTimes(1)
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
