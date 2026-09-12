vi.mock('./family-account.js', () => ({ readFamilyAccountId: async (_id: string, channel: string) => `account-${channel}` }))
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ sheet: vi.fn(), destination: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { marketplace: { findMany: async () => [] } } }))
vi.mock('./workspace-destination.js', () => ({ resolveWorkspaceDestination: mocks.destination }))
vi.mock('./studio-sheet.service.js', () => ({ getStudioSheet: mocks.sheet }))
vi.mock('./studio-columns.js', () => ({ getStudioColumns: async () => ({ coordinates: [
  { channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT' }, { channel: 'EBAY', marketplace: 'IT', label: 'eBay · IT' },
] }) }))
import { getProductReadiness } from './scope-readiness.service.js'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.destination.mockImplementation(async input => ({ accountId: input.accountId, aliasKey: null }))
  mocks.sheet.mockImplementation(async input => ({ scope: { kind: input.scope, channel: input.scope === 'master' ? null : input.channel, marketplace: 'IT', label: input.channel ?? 'Shared' },
    schema: { locale: 'it' }, rows: [{ productType: 'OUTERWEAR', completeness: { required: { filled: 1, total: 1 } }, readiness: { issues: [] } }], aliases: [], meta: { schemaMissing: [], mapping: { skippedReason: null, missingProductIds: [] } } }))
})
describe('account-specific scope readiness', () => {
  it('uses the listing-derived account and selected channel for workspace readiness', async () => {
    mocks.destination.mockResolvedValue({ accountId: 'store-b', aliasKey: '' })
    await getProductReadiness({ productId: 'p', market: 'IT', channel: 'EBAY', listingId: 'b-primary', selectedOnly: true })
    const reads = mocks.sheet.mock.calls.map(([input]) => input).filter(input => input.scope === 'channel')
    expect(reads).toEqual([{ productId: 'p', market: 'IT', scope: 'channel', channel: 'EBAY', accountId: 'store-b', locale: undefined }])
  })
  it('does not query any channel accounts for Shared workspace readiness', async () => {
    await getProductReadiness({ productId: 'p', market: 'IT', selectedOnly: true })
    expect(mocks.sheet.mock.calls.every(([input]) => input.scope === 'master')).toBe(true)
    expect(mocks.destination).not.toHaveBeenCalled()
  })
  it('scores the selected account on its channel without sending it to other channels', async () => {
    await getProductReadiness({ productId: 'p', market: 'IT', channel: 'EBAY', accountId: 'store-b' })
    const inputs = mocks.sheet.mock.calls.map(([input]) => input)
    expect(inputs.find(input => input.scope === 'channel' && input.channel === 'EBAY').accountId).toBe('store-b')
    expect(inputs.find(input => input.scope === 'channel' && input.channel === 'AMAZON').accountId).toBe('account-AMAZON')
  })
  it('reports an unavailable destination without discarding other scopes', async () => {
    const read = mocks.sheet.getMockImplementation()!
    mocks.sheet.mockImplementation(async input => {
      if (input.scope === 'channel' && input.channel === 'AMAZON') throw new Error('Choose an Amazon account')
      return read(input)
    })
    const result = await getProductReadiness({ productId: 'p', market: 'IT', channel: 'EBAY', accountId: 'store-b' })
    expect(result.scopes.find(scope => scope.id === 'AMAZON')).toMatchObject({ pct: null, state: 'absent', note: 'Choose an Amazon account' })
    expect(result.scopes.find(scope => scope.id === 'EBAY')).toMatchObject({ pct: 100, state: 'ready' })
    expect(result.scopes.some(scope => scope.id === 'master')).toBe(true)
  })
})
