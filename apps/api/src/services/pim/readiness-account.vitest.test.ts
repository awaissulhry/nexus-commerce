/**
 * Account-specific scope readiness, against the SHIPPED reader.
 *
 * LX.F R-LX-13 rewrote these four arms. They asserted what `getStudioSheet` was
 * called with, per coordinate — the pre-LX.5 reader built a sheet for every
 * scope. LX.5 made the reader **index-only**: `scope-readiness.service.ts` reads
 * `ReadinessIndex`, `Product` and `Marketplace` and nothing else, so the old
 * assertions measured a call that must no longer happen. The BEHAVIOURS the file
 * exists for are unchanged and are measured here through the index instead:
 * which account a scope is summarised from, that Shared readiness resolves no
 * destination, and that one unavailable destination does not discard the others.
 *
 * `getStudioSheet` is still mocked — as the arm that must NOT fire.
 */
vi.mock('./family-account.js', () => ({ readFamilyAccountId: async (_id: string, channel: string) => `account-${channel}` }))
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ sheet: vi.fn(), destination: vi.fn(), index: vi.fn(), family: vi.fn() }))
vi.mock('../../db.js', () => ({ default: {
  marketplace: { findMany: async () => [
    { channel: 'AMAZON', code: 'IT', name: 'Amazon Italy', languages: ['it'], language: 'it' },
    { channel: 'EBAY', code: 'IT', name: 'eBay Italy', languages: ['it'], language: 'it' },
  ] },
  product: { findFirstOrThrow: async () => ({ id: 'p', parentId: null }) },
  readinessIndex: { findMany: (...args: unknown[]) => mocks.index(...args) },
} }))
vi.mock('./workspace-destination.js', () => ({ resolveWorkspaceDestination: mocks.destination }))
vi.mock('./studio-sheet.service.js', () => ({ getStudioSheet: mocks.sheet }))
import { getProductReadiness } from './scope-readiness.service.js'

const row = (patch: Record<string, unknown>) => ({
  productId: 'p', coordinateKey: '[]', channel: null, market: null, accountId: null, aliasId: null, language: 'it',
  label: 'Shared product', pct: 100, state: 'ready', requiredFilled: 1, requiredTotal: 1, missing: [], note: null,
  mappingRules: 1, computedAt: new Date('2026-09-13T00:00:00Z'), ...patch,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.destination.mockImplementation(async (input: { accountId?: string }) => ({ accountId: input.accountId, aliasKey: null }))
  mocks.index.mockResolvedValue([
    row({}),
    // eBay·IT is computed for TWO accounts; only the selected one may score the chip.
    row({ channel: 'EBAY', market: 'IT', accountId: 'store-b', coordinateKey: '["EBAY","IT","store-b",null]', label: 'eBay · IT', pct: 100, state: 'ready' }),
    row({ channel: 'EBAY', market: 'IT', accountId: 'store-a', coordinateKey: '["EBAY","IT","store-a",null]', label: 'eBay · IT', pct: 0, state: 'blocked', requiredFilled: 0, requiredTotal: 4 }),
    row({ channel: 'AMAZON', market: 'IT', accountId: 'account-AMAZON', coordinateKey: '["AMAZON","IT","account-AMAZON",null]', label: 'Amazon · IT', pct: 50, state: 'warn', requiredFilled: 1, requiredTotal: 2 }),
  ])
})

describe('account-specific scope readiness', () => {
  it('summarises the selected channel from the listing-derived account only', async () => {
    mocks.destination.mockResolvedValue({ accountId: 'store-b', aliasKey: null })
    const result = await getProductReadiness({ productId: 'p', market: 'IT', channel: 'EBAY', listingId: 'b-primary', selectedOnly: true })
    expect(mocks.destination).toHaveBeenCalledWith(expect.objectContaining({ listingId: 'b-primary', channel: 'EBAY' }))
    // store-b's row (ready, 100) scores it; store-a's blocked row must not reach it.
    expect(result.scopes.find(scope => scope.id === 'EBAY')).toMatchObject({ pct: 100, state: 'ready' })
    // The arm that must NOT fire: LX.5's reader constructs no sheet.
    expect(mocks.sheet).not.toHaveBeenCalled()
  })

  it('does not resolve any channel destination for Shared workspace readiness', async () => {
    const result = await getProductReadiness({ productId: 'p', market: 'IT', selectedOnly: true })
    expect(mocks.destination).not.toHaveBeenCalled()
    expect(result.scopes.some(scope => scope.id === 'master')).toBe(true)
    expect(mocks.sheet).not.toHaveBeenCalled()
  })

  it('scores the selected account on its channel and the family account elsewhere', async () => {
    const result = await getProductReadiness({ productId: 'p', market: 'IT', channel: 'EBAY', accountId: 'store-b' })
    expect(result.scopes.find(scope => scope.id === 'EBAY')).toMatchObject({ pct: 100, state: 'ready' })
    // Amazon is not the selected channel, so its account comes from the family
    // (`readFamilyAccountId` → `account-AMAZON`) and its own index row scores it.
    expect(result.scopes.find(scope => scope.id === 'AMAZON')).toMatchObject({ pct: 50, state: 'warn' })
  })

  it('reports an unavailable destination without discarding other scopes', async () => {
    vi.resetModules()
    vi.doMock('./family-account.js', () => ({ readFamilyAccountId: async (_id: string, channel: string) => {
      if (channel === 'AMAZON') throw new Error('Choose an Amazon account')
      return `account-${channel}`
    } }))
    const { getProductReadiness: read } = await import('./scope-readiness.service.js')
    const result = await read({ productId: 'p', market: 'IT', channel: 'EBAY', accountId: 'store-b' })
    expect(result.scopes.find(scope => scope.id === 'AMAZON')).toMatchObject({ pct: null, state: 'absent', note: 'Choose an Amazon account' })
    expect(result.scopes.find(scope => scope.id === 'EBAY')).toMatchObject({ pct: 100, state: 'ready' })
    expect(result.scopes.some(scope => scope.id === 'master')).toBe(true)
  })
})
