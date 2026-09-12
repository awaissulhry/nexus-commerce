vi.mock('./family-account.js', () => ({ readFamilyAccountId: async (_id: string, channel: string) => `account-${channel}` }))
import { describe, expect, it, vi } from 'vitest'
vi.mock('./studio-sheet.service.js', () => ({ getStudioSheet: vi.fn() }))
vi.mock('./studio-columns.js', () => ({ getStudioColumns: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { marketplace: { findMany: async () => [] } } }))
import { getProductReadiness, readinessFromSheet } from './scope-readiness.service.js'
import { getStudioSheet } from './studio-sheet.service.js'
import { getStudioColumns } from './studio-columns.js'
const sheet = (mapping: unknown): any => ({
  schema: { locale: 'it' },
  scope: { kind: 'channel', channel: 'AMAZON', label: 'Amazon · IT' }, aliases: [],
  rows: [{ completeness: { required: { filled: 1, total: 1 } }, readiness: { issues: [] } }],
  meta: { schemaMissing: [], mapping },
})

it('reads store readiness at GLOBAL even while the shared sheet uses a country market', async () => {
  vi.mocked(getStudioColumns).mockResolvedValue({ coordinates: [{ channel: 'SHOPIFY', marketplace: 'GLOBAL', label: 'Shopify · GLOBAL' }] } as never)
  vi.mocked(getStudioSheet).mockImplementation(async input => ({ ...sheet({ skippedReason: null, missingProductIds: [] }), scope: { kind: input.scope, channel: input.channel, label: 'Shopify · GLOBAL', marketplace: input.market } }) as never)
  const result = await getProductReadiness({ productId: 'p', market: 'IT' })
  expect(getStudioSheet).toHaveBeenCalledWith(expect.objectContaining({ channel: 'SHOPIFY', market: 'GLOBAL' }))
  expect(result.scopes.find(s => s.id === 'SHOPIFY')?.note).toContain('required values filled')
})
describe('scope readiness uses verified effective channel values', () => {
  it('does not claim readiness when mapping failed or did not run', () => {
    for (const mapping of [null, { skippedReason: 'Timed out', missingProductIds: [] }, { skippedReason: null, missingProductIds: ['p'] }]) {
      expect(readinessFromSheet(sheet(mapping), 1)).toMatchObject({ pct: null, state: 'warn' })
    }
  })
  it('shows readiness after the mapping run completed', () => {
    expect(readinessFromSheet(sheet({ skippedReason: null, missingProductIds: [] }), 1)).toMatchObject({ pct: 100, state: 'ready' })
  })
  it('keeps filled-but-invalid effective values blocked', () => {
    const input = sheet({ skippedReason: null, missingProductIds: [] })
    input.rows[0].readiness.issues = [{ severity: 'error', message: 'Title too long' }]
    expect(readinessFromSheet(input, 1)).toMatchObject({ pct: 100, state: 'blocked' })
  })
})
